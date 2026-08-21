/**
 * GET /api/intelligence/capabilities        - what research can and cannot measure
 * GET /api/intelligence/candidates          - the research shortlist
 * GET /api/intelligence/candidates/:id      - one candidate with its full score
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
import { getCandidate, listCandidates } from './intelligence.service';
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
      // Stated rather than left for the UI to work out, because a score computed against
      // costs that have since changed is the thing most likely to mislead.
      scoreIsStale:
        candidate.analyzedAt !== null && candidate.updatedAt > candidate.analyzedAt,
      note:
        candidate.analyzedAt === null
          ? 'This candidate has never been analysed, so it has no score. That is not a low score.'
          : null,
    });
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
