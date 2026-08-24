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

import { randomUUID } from 'node:crypto';

import { recordAudit } from '../audit/audit.service';
import { IDEMPOTENCY_HEADER, idempotent } from '../common/idempotency';
import { AppError } from '../common/errors';
import { asyncHandler, sendSuccess } from '../common/http';
import type { PricingScenarioName } from '../pricing/recommendation';
import {
  analyzeCandidate,
  createCandidate,
  recordSupplierVerification,
  setCandidateStatus,
  updateCandidate,
  type CreateCandidateInput,
  type UpdateCandidateInput,
} from './intelligence.service';
import type { SupplierVerificationInput } from './supplier.validation';
import { scoreIsStale } from './candidate.revision';
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

    /*
     * `scoreIsStale` is computed, not assumed.
     *
     * This used to be `candidate.analyzedAt !== null` - i.e. "if it was ever analysed,
     * the edit invalidated it". That was wrong for a note-only or watch-date edit, which
     * changes no scoring input. The revision comparison answers the real question.
     */
    const stale = scoreIsStale(candidate);
    sendSuccess(res, candidate, {
      scoreIsStale: stale,
      inputRevision: candidate.inputRevision,
      analyzedInputRevision: candidate.analyzedInputRevision,
      note: stale
        ? 'A scoring input changed, so the stored score no longer reflects this candidate. Re-analyse to update it.'
        : candidate.analyzedAt === null
          ? null
          : 'Nothing that affects the score changed, so the stored score is still current.',
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
 * Record a supplier (Tradelle) verification: whether this product can be SOURCED.
 *
 * This is EVIDENCE recorded by a human who looked. `checkedAt` is set server-side to now,
 * so freshness ages from a genuine verification. The supplied URL is stored as evidence and
 * NEVER fetched - the service does no server-side supplier calls.
 *
 * A push consumes this: an UNAVAILABLE product is refused, an UNVERIFIED or STALE one is
 * refused until verified. Recording it here is how an operator makes a strong-but-
 * unverified candidate pushable.
 */
intelligenceWriteRouter.post(
  '/intelligence/candidates/:id/supplier-verification',
  asyncHandler(async (req, res) => {
    const id = requireId(req.params.id);
    const payload = body(req);

    const result = await recordSupplierVerification(id, payload as SupplierVerificationInput);

    await recordAudit({
      action: result.wasUpdate ? 'RESEARCH_SUPPLIER_UPDATE' : 'RESEARCH_SUPPLIER_VERIFY',
      resourceType: 'RESEARCH_CANDIDATE',
      resourceId: id,
      before: result.previousSupplier,
      after: {
        provider: result.sourceability.provider,
        availability: result.sourceability.availability,
        availabilitySource: result.sourceability.availabilitySource,
        checkedAt: result.sourceability.checkedAt,
        current: result.sourceability.current,
        variantCoverage: result.sourceability.variantCoverage,
        supplierProductId: result.sourceability.supplierProductId,
      },
    });

    sendSuccess(res, result.candidate, {
      sourceability: result.sourceability,
      note:
        result.sourceability.current === 'SOURCEABLE'
          ? 'Recorded. This candidate is now verified as sourceable and can be pushed.'
          : 'Recorded. Note the current sourceability verdict - a push is only allowed when the product is currently sourceable.',
    });
  }),
);

/**
 * Create a Shopify DRAFT from the candidate.
 *
 * Named `push` and not `publish`, and it cannot publish: see push.draft.ts, where DRAFT and
 * publish false are hard-coded and asserted. The response says so explicitly rather than
 * leaving the UI to infer it.
 *
 * IDEMPOTENT. Wrapped in the EXISTING idempotency middleware rather than a second
 * mechanism of its own: a repeated Idempotency-Key replays the stored response instead of
 * creating a second product, which is what makes an accidental double-click or a transport
 * retry safe. The middleware is opt-in by header, so the operation id falls back to a
 * generated one when no key is supplied - the atomic claim inside the service is what
 * protects against two DIFFERENT operations, and it does not depend on the header.
 */
intelligenceWriteRouter.post(
  '/intelligence/candidates/:id/push',
  idempotent('POST /api/intelligence/candidates/:id/push'),
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

    /*
     * The decision the operator approved.
     *
     * REQUIRED. Optional at the service's type level so an internal caller can push
     * without one, but a request arriving over HTTP without it would mean the operator
     * clicked Push on a screen whose numbers nobody compared against the current ones -
     * which is the entire failure this gate exists to prevent.
     */
    const expectedDecisionHash = payload['expectedDecisionHash'];
    if (typeof expectedDecisionHash !== 'string' || expectedDecisionHash.trim() === '') {
      throw new AppError(
        'VALIDATION_ERROR',
        'expectedDecisionHash is required. Read the candidate or run an analysis to obtain it, and send back the hash of the decision you actually reviewed - it is what proves the recommendation and price have not moved since you looked.',
      );
    }

    /*
     * Both overrides must be EXACTLY true.
     *
     * A truthy string from a form would otherwise silently accept a duplicate or a
     * loss-making price. They are separate flags on purpose: accepting a duplicate and
     * accepting a price below your own floors are different decisions, and one checkbox
     * covering both would let an operator agree to something they never saw.
     */
    const allowDuplicate = payload['allowDuplicate'] === true;
    const acknowledgeGuardBreach = payload['acknowledgeGuardBreach'] === true;
    // Separate, explicit acknowledgement that the operator accepts PARTIAL supplier variant
    // coverage. The unavailable variants are never created regardless; this only unblocks
    // creating the draft for the available coverage. Must be exactly true.
    const acknowledgePartialVariants = payload['acknowledgePartialVariants'] === true;

    /*
     * One operation id per logical push.
     *
     * The Idempotency-Key when the client sent one, so a transport retry resumes the same
     * operation rather than being locked out by its own claim. A generated id otherwise -
     * the claim still serialises concurrent pushes, it just cannot recognise a retry as
     * the same attempt.
     */
    const operationId = req.header(IDEMPOTENCY_HEADER)?.trim() ?? `push-${randomUUID()}`;

    const result = await pushCandidateAsDraft(id, {
      ...(scenario === undefined ? {} : { scenario: scenario as PricingScenarioName }),
      ...(price === undefined ? {} : { price: price as number }),
      expectedDecisionHash: expectedDecisionHash.trim(),
      allowDuplicate,
      acknowledgeGuardBreach,
      acknowledgePartialVariants,
      operationId,
    });

    // The audit entry is written inside the orchestration, where the failure paths are, so
    // a refused push is recorded too - an attempt that was blocked is often the more
    // interesting entry.
    res.status(201);
    sendSuccess(res, result, {
      // Stated, never inferred. `visibleToCustomers` is the only field that means a
      // customer could see it, and it is read back from Shopify rather than assumed.
      published: result.productState.published,
      visibleToCustomers: result.productState.visibleToCustomers,
      outcome: result.outcome,
      note:
        result.outcome === 'RECONCILED'
          ? 'A Shopify draft for this candidate already existed, so nothing new was created. The candidate has been reconciled with it.'
          : 'A DRAFT was created. Nothing has been published - review the listing in Shopify and publish it there when you are ready.',
    });
  }),
);
