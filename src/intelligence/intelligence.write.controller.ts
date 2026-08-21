/**
 * POST  /api/intelligence/candidates              - record a candidate
 * PATCH /api/intelligence/candidates/:id          - edit its inputs
 * POST  /api/intelligence/candidates/:id/analyze  - score it
 * POST  /api/intelligence/candidates/:id/watch    - watch it
 * POST  /api/intelligence/candidates/:id/reject   - reject it
 * POST  /api/intelligence/candidates/:id/push     - create a Shopify DRAFT
 *
 * A SEPARATE ROUTER from intelligence.controller.ts, mounted behind
 * requireOperatorForWrites. Putting these on the read router would make them
 * world-writable whenever OPERATOR_PROTECT_READS is false, which is exactly the hole
 * operator auth closes. auth.wiring.test.ts asserts the mount.
 *
 * THERE IS NO PUBLISH ROUTE, AND THERE WILL NOT BE ONE.
 * The push route creates a DRAFT. Publishing stays in the publications module, performed
 * by an operator who has read the listing. A research module that could publish would let
 * a scored guess reach customers with nobody having looked at it.
 *
 * Mounted at /api, so paths start with /intelligence.
 */

import { Router } from 'express';

import { recordAudit } from '../audit/audit.service';
import { AppError } from '../common/errors';
import { asyncHandler, sendSuccess } from '../common/http';
import type { PricingScenarioName } from '../pricing/recommendation';
import {
  analyzeCandidate,
  createCandidate,
  setCandidateStatus,
  updateCandidate,
  type CreateCandidateInput,
  type UpdateCandidateInput,
} from './intelligence.service';
import { pushCandidateAsDraft } from './push.service';

export const intelligenceWriteRouter = Router();

const SCENARIOS: readonly PricingScenarioName[] = ['CONSERVATIVE', 'BALANCED', 'PREMIUM'];

function body(req: { body?: unknown }): Record<string, unknown> {
  const raw = req.body;
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AppError('VALIDATION_ERROR', 'The request body must be a JSON object.');
  }
  return raw as Record<string, unknown>;
}

function requireId(raw: string | undefined): string {
  const id = (raw ?? '').trim();
  if (id === '') throw new AppError('VALIDATION_ERROR', 'A candidate id is required.');
  return id;
}

/**
 * Records a candidate. Does NOT analyse it.
 *
 * Kept separate so creating and scoring are two visible steps. An operator half-way
 * through entering figures should not get a score built on the half they have entered -
 * that score would look like a verdict on the product rather than on the data.
 */
intelligenceWriteRouter.post(
  '/intelligence/candidates',
  asyncHandler(async (req, res) => {
    const input = body(req) as unknown as CreateCandidateInput;
    const candidate = await createCandidate(input);

    await recordAudit({
      action: 'RESEARCH_CANDIDATE_CREATE',
      resourceType: 'RESEARCH_CANDIDATE',
      resourceId: candidate.id,
      after: {
        title: candidate.title,
        category: candidate.category,
        market: candidate.market,
        supplierCost: candidate.commercials.supplierCost,
      },
    });

    res.status(201);
    sendSuccess(res, candidate, {
      note: 'Recorded but not scored. Call analyze to produce a score.',
    });
  }),
);

/**
 * Edits a candidate's inputs.
 *
 * Deliberately does not re-analyse. Changing a cost invalidates the stored score, but
 * recomputing silently would mean the figures an operator just saved and the score they
 * are looking at could diverge without anyone asking. The read route reports
 * `scoreIsStale` instead.
 */
intelligenceWriteRouter.patch(
  '/intelligence/candidates/:id',
  asyncHandler(async (req, res) => {
    const id = requireId(req.params.id);
    const patch = body(req) as unknown as UpdateCandidateInput;
    const candidate = await updateCandidate(id, patch);

    await recordAudit({
      action: 'RESEARCH_CANDIDATE_UPDATE',
      resourceType: 'RESEARCH_CANDIDATE',
      resourceId: id,
      after: {
        title: candidate.title,
        commercials: candidate.commercials,
        manualResearch: candidate.manualResearch,
      },
    });

    sendSuccess(res, candidate, {
      scoreIsStale: candidate.analyzedAt !== null,
      note:
        candidate.analyzedAt === null
          ? null
          : 'The stored score was computed before this change. Re-analyse to update it.',
    });
  }),
);

/**
 * Scores the candidate.
 *
 * A POST because it writes: it stores the score, appends to the score history and can move
 * NEW to ANALYZED. Modelling it as a GET would let a browser prefetch rewrite the record.
 */
intelligenceWriteRouter.post(
  '/intelligence/candidates/:id/analyze',
  asyncHandler(async (req, res) => {
    const id = requireId(req.params.id);
    const payload = body(req);

    const scenario = payload['scenario'];
    if (scenario !== undefined && !SCENARIOS.includes(scenario as PricingScenarioName)) {
      throw new AppError('VALIDATION_ERROR', `scenario must be one of ${SCENARIOS.join(', ')}.`);
    }

    const result = await analyzeCandidate(id, {
      ...(scenario === undefined
        ? {}
        : { pricingScenario: scenario as PricingScenarioName }),
    });

    await recordAudit({
      action: 'RESEARCH_ANALYZE',
      resourceType: 'RESEARCH_CANDIDATE',
      resourceId: id,
      after: {
        overallScore: result.candidate.overallScore,
        confidenceScore: result.candidate.confidenceScore,
        recommendation: result.candidate.recommendation,
        unavailable: result.unavailable,
      },
      // PARTIAL when signals were missing: the score is real but incomplete, and calling
      // that a clean success would hide the gap from anyone reading the trail later.
      result: result.unavailable.length > 0 ? 'PARTIAL' : 'SUCCESS',
    });

    sendSuccess(res, result, {
      note: 'Two separate scores: overallScore is how good the opportunity looks, confidenceScore is how much the data behind it can be trusted. They are never blended.',
    });
  }),
);

/**
 * Watch it.
 *
 * `watchUntil` is required rather than optional, so a watchlist cannot grow forever. An
 * item watched indefinitely is an item nobody looks at again.
 */
intelligenceWriteRouter.post(
  '/intelligence/candidates/:id/watch',
  asyncHandler(async (req, res) => {
    const id = requireId(req.params.id);
    const payload = body(req);

    const until = payload['watchUntil'];
    if (typeof until !== 'string' || Number.isNaN(new Date(until).getTime())) {
      throw new AppError(
        'VALIDATION_ERROR',
        'watchUntil must be an ISO date. A watch with no end date becomes a list nobody revisits.',
      );
    }

    const note = payload['note'];
    const candidate = await setCandidateStatus(id, 'WATCHING', {
      watchUntil: until,
      ...(typeof note === 'string' ? { note } : {}),
    });

    await recordAudit({
      action: 'RESEARCH_WATCH',
      resourceType: 'RESEARCH_CANDIDATE',
      resourceId: id,
      after: { status: candidate.status, watchUntil: candidate.watchUntil },
    });

    sendSuccess(res, candidate);
  }),
);

/**
 * Reject it.
 *
 * The reason is required. A rejected candidate with no reason is one somebody will
 * research again in six months, which is the duplicated work the module exists to stop.
 */
intelligenceWriteRouter.post(
  '/intelligence/candidates/:id/reject',
  asyncHandler(async (req, res) => {
    const id = requireId(req.params.id);
    const payload = body(req);

    const reason = payload['reason'];
    if (typeof reason !== 'string' || reason.trim() === '') {
      throw new AppError(
        'VALIDATION_ERROR',
        'A reason is required to reject a candidate, so nobody researches it again in six months without knowing why it was dropped.',
      );
    }

    const candidate = await setCandidateStatus(id, 'REJECTED', { note: reason.trim() });

    await recordAudit({
      action: 'RESEARCH_REJECT',
      resourceType: 'RESEARCH_CANDIDATE',
      resourceId: id,
      after: { status: candidate.status, reason: reason.trim() },
    });

    sendSuccess(res, candidate);
  }),
);

/**
 * Create a Shopify DRAFT from the candidate.
 *
 * Named `push` and not `publish`, and it cannot publish: see push.draft.ts, where DRAFT and
 * publish false are hard-coded and asserted. The response says so explicitly rather than
 * leaving the UI to infer it.
 */
intelligenceWriteRouter.post(
  '/intelligence/candidates/:id/push',
  asyncHandler(async (req, res) => {
    const id = requireId(req.params.id);
    const payload = body(req);

    const scenario = payload['scenario'];
    if (scenario !== undefined && !SCENARIOS.includes(scenario as PricingScenarioName)) {
      throw new AppError('VALIDATION_ERROR', `scenario must be one of ${SCENARIOS.join(', ')}.`);
    }

    const price = payload['price'];
    if (price !== undefined && (typeof price !== 'number' || !Number.isFinite(price))) {
      throw new AppError('VALIDATION_ERROR', 'price must be a number when supplied.');
    }

    // Must be exactly true. A truthy string from a form would otherwise silently override
    // a duplicate block, and the whole point of the flag is that overriding is deliberate.
    const allowDuplicate = payload['allowDuplicate'] === true;

    const result = await pushCandidateAsDraft(id, {
      ...(scenario === undefined ? {} : { scenario: scenario as PricingScenarioName }),
      ...(price === undefined ? {} : { price: price as number }),
      allowDuplicate,
    });

    // The audit entry is written inside pushCandidateAsDraft, where the failure paths are,
    // so a refused push is recorded too - an attempt that was blocked is often the more
    // interesting entry.
    res.status(201);
    sendSuccess(res, result, {
      published: false,
      visibleToCustomers: result.product.visibleToCustomers,
      note: 'A DRAFT was created. Nothing has been published - review the listing in Shopify and publish it there when you are ready.',
    });
  }),
);
