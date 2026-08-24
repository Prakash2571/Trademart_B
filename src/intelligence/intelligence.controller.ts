/**
 * GET /api/intelligence/capabilities        - what research can and cannot measure
 * GET /api/intelligence/candidates          - the research shortlist
 * GET /api/intelligence/candidates/:id      - one candidate with its full score
 * GET /api/intelligence/candidates/:id/decision   - the current decision + its hash
 * GET /api/intelligence/candidates/:id/duplicates - duplicate check before a push
 *
 * READ-ONLY. Every write - create, analyse, watch, reject, push - lives on
 * intelligenceWriteRouter behind requireOperatorForWrites, because a router mounted
 * behind requireOperatorForReads is world-writable whenever OPERATOR_PROTECT_READS is
 * false.
 *
 * Mounted at /api, so paths here start with /intelligence. (publicationsRouter once
 * carried its own /shopify prefix on top of an /api/shopify mount and every route 404'd
 * silently, because CI only typechecks and builds. The convention is worth restating.)
 */

import { Router } from 'express';

import { asyncHandler, sendSuccess } from '../common/http';
import { parseIntParam, parseStringParam } from '../common/validate';
import { AppError } from '../common/errors';
import { scoreIsStale } from './candidate.revision';
import { allowedActions } from './candidate.transitions';
import {
  getCandidate,
  listCandidates,
  prepareCandidateAnalysis,
} from './intelligence.service';
import { describeResearchSupport } from './providers/registry';
import { TRADELLE_DOCUMENTATION, TRADELLE_MODES, tradelleResearchMode } from './providers/tradelle.provider';
import {
  GOOGLE_ADS_RESEARCH_DESCRIPTOR,
  GOOGLE_TRENDS_RESEARCH_DESCRIPTOR,
} from './providers/unavailable.providers';
import { checkForDuplicates } from './push.service';
import type { CandidateStatus } from './candidate.types';

export const intelligenceRouter = Router();

const STATUSES: readonly CandidateStatus[] = [
  'NEW',
  'ANALYZED',
  'WATCHING',
  'SELECTED',
  'PUSHED_TO_SHOPIFY',
  'REJECTED',
];

/**
 * What this module can actually measure.
 *
 * The most important read here, and the reason it exists as a route rather than a comment:
 * four of the six gatherable signals come from figures an operator typed in, and two
 * cannot be measured at all. A UI that did not say so would imply live market data, and
 * an operator would trust a score built on a number they half-remember entering.
 */
intelligenceRouter.get(
  '/intelligence/capabilities',
  asyncHandler(async (_req, res) => {
    sendSuccess(
      res,
      {
        capabilities: describeResearchSupport(),
        tradelle: {
          mode: tradelleResearchMode(),
          modes: TRADELLE_MODES,
          documentation: TRADELLE_DOCUMENTATION,
        },
        unbuiltIntegrations: [
          GOOGLE_ADS_RESEARCH_DESCRIPTOR,
          GOOGLE_TRENDS_RESEARCH_DESCRIPTOR,
        ],
      },
      {
        note: 'Store performance and fulfillment history are read from Shopify. Demand, trend, competition and seasonality come only from figures an operator records by hand, because Tradelle publishes no API and the keyword integrations are not built.',
      },
    );
  }),
);

/**
 * The shortlist.
 *
 * Sorted by score descending by default, since that is what a shortlist is for. Degrades
 * to an empty list without a database rather than failing the page - a Shopify-only
 * deployment has no research, which is different from being broken.
 */
intelligenceRouter.get(
  '/intelligence/candidates',
  asyncHandler(async (req, res) => {
    const limit = parseIntParam(req.query['limit'], 'limit', {
      min: 1,
      max: 200,
      fallback: 50,
    });
    const status = parseStringParam(req.query['status'], 'status', { maxLength: 40 });
    const sort = parseStringParam(req.query['sort'], 'sort', { maxLength: 10 });

    if (status !== undefined && !STATUSES.includes(status as CandidateStatus)) {
      throw new AppError(
        'VALIDATION_ERROR',
        `status must be one of ${STATUSES.join(', ')}.`,
      );
    }
    if (sort !== undefined && sort !== 'score' && sort !== 'recent') {
      throw new AppError('VALIDATION_ERROR', "sort must be 'score' or 'recent'.");
    }

    const candidates = await listCandidates({
      limit,
      ...(status === undefined ? {} : { status: status as CandidateStatus }),
      ...(sort === undefined ? {} : { sort: sort as 'score' | 'recent' }),
    });

    sendSuccess(res, candidates, {
      count: candidates.length,
      /*
       * What may be done to each candidate, computed from the backend's own transition
       * table and keyed by candidate id.
       *
       * Sent so the UI does not keep a second copy of the rules. A copy would drift, and
       * the visible symptom of drift is an enabled button that the route then refuses -
       * or worse, a Push button offered on a candidate whose push is already running.
       * The routes remain authoritative; this only decides what is offered.
       */
      actions: Object.fromEntries(
        candidates.map((candidate) => [candidate.id, allowedActions(candidate)]),
      ),
      // Surfaced at list level because these are the two states an operator needs to see
      // without opening each row.
      pushing: candidates.filter((candidate) => candidate.pushState === 'IN_PROGRESS').length,
      needsSafetyReview: candidates.filter(
        (candidate) => candidate.pushState === 'SAFETY_INCIDENT',
      ).length,
      // Counted here so a list header can show it without a second request, and so
      // "3 of 12 have never been scored" is visible rather than having to be inferred
      // from a null.
      unscored: candidates.filter((candidate) => candidate.overallScore === null).length,
      lowConfidence: candidates.filter(
        (candidate) => candidate.confidenceScore !== null && candidate.confidenceScore < 60,
      ).length,
    });
  }),
);

/**
 * One candidate, in full.
 *
 * Includes every factor, its reasons, its risks and its evidence. The detail is the point:
 * an operator disagreeing with a score needs to see the figure that drove it, not just the
 * verdict.
 */
intelligenceRouter.get(
  '/intelligence/candidates/:id',
  asyncHandler(async (req, res) => {
    const candidate = await getCandidate(req.params.id ?? '');
    sendSuccess(res, candidate, {
      /*
       * Computed from the input REVISION, not from a timestamp comparison.
       *
       * The previous `candidate.updatedAt > candidate.analyzedAt` was wrong in both
       * directions: Mongoose bumps updatedAt during the analysis write itself, so a
       * freshly analysed candidate reported stale, and watching or adding a note bumped
       * it without touching any scoring input. See candidate.revision.ts.
       */
      scoreIsStale: scoreIsStale(candidate),
      inputRevision: candidate.inputRevision,
      analyzedInputRevision: candidate.analyzedInputRevision,
      // See the list route: one source of truth for what may be done.
      actions: allowedActions(candidate),
      note:
        candidate.analyzedAt === null
          ? 'This candidate has never been analysed, so it has no score. That is not a low score.'
          : null,
      /*
       * SAFETY_INCIDENT is the one state that needs a human, so the reason travels with
       * the read rather than living only in the audit log.
       */
      pushSafetyReason: candidate.pushSafetyReason,
    });
  }),
);

/**
 * The decision as it stands RIGHT NOW, and the hash that binds it.
 *
 * Read immediately before a push. It computes a full analysis - store history, providers,
 * pricing, scoring - and PERSISTS NOTHING, so opening a confirmation dialog cannot move
 * the stored score out from under the operator.
 *
 * Why it is a separate route rather than part of GET /:id: this is the expensive read. The
 * list would run it N times, and a page that merely displays a candidate does not need
 * live Shopify history. Why it is not simply POST /analyze: analyse WRITES, and the last
 * thing a confirmation dialog should do is change the row it is asking about.
 *
 * The summary and the hash come from the same prepared analysis, so the numbers the
 * operator confirms are provably the numbers the hash covers. Showing a summary fetched
 * separately from the hash would recreate the exact bug the hash exists to close.
 */
intelligenceRouter.get(
  '/intelligence/candidates/:id/decision',
  asyncHandler(async (req, res) => {
    const prepared = await prepareCandidateAnalysis(req.params.id ?? '');
    const { score } = prepared.analysis;

    sendSuccess(
      res,
      {
        decisionHash: prepared.decisionHash,
        // The post-analysis candidate, never the stored one: the stored row may carry an
        // older score, and confirming against it is what Part 3 forbids.
        candidate: prepared.freshCandidate,
        recommendation: score.recommendation,
        overallScore: score.overallScore,
        confidenceScore: score.confidenceScore,
        recommendationDowngraded: score.recommendationDowngraded,
        pricing: prepared.analysis.pricing,
        policy: prepared.policy,
        warnings: prepared.analysis.warnings,
        actions: allowedActions(prepared.freshCandidate),
      },
      {
        /*
         * Whether the stored score differs from this one. If it does, the screen the
         * operator was reading is already out of date and the dialog must show these
         * numbers, not the ones behind it.
         */
        storedScoreDiffers:
          prepared.storedCandidate.overallScore !== prepared.freshCandidate.overallScore ||
          prepared.storedCandidate.recommendation !== prepared.freshCandidate.recommendation,
        persisted: false,
        note: 'Nothing was saved by this read. Send decisionHash back with the push - if the numbers have moved by then the push is refused rather than created on a decision nobody approved.',
      },
    );
  }),
);

/**
 * Duplicate check, WITHOUT pushing.
 *
 * Separate from the push so the UI can warn before the click. A duplicate warning that
 * only appears after the product exists in Shopify is useless.
 */
intelligenceRouter.get(
  '/intelligence/candidates/:id/duplicates',
  asyncHandler(async (req, res) => {
    const report = await checkForDuplicates(req.params.id ?? '');
    sendSuccess(res, report, {
      wouldBlockPush: report.blocking.length > 0,
      note: 'Only exact matches block a push, and an archived product never does. Everything else is a warning to check.',
    });
  }),
);
