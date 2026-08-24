/**
 * Wiring the push orchestration to the real world.
 *
 * The decision sequence lives in push.orchestrator.ts, which takes its outside world as an
 * argument. This module supplies that world: config, Mongo, Shopify, the audit trail. It
 * contains no ordering decisions and no refusals of its own, which is deliberate - every
 * invariant worth testing is in the orchestrator, where a test can substitute these ports
 * and assert that createProduct was called exactly once.
 *
 * IT STILL CANNOT PUBLISH
 * -----------------------
 * The ports it provides are the specific operations the orchestration needs. There is a
 * `forceHidden` port and there is deliberately NO publish port, so the orchestration
 * cannot make a product visible even by accident. forceHidden is composed from the
 * existing hide primitives - set status DRAFT, remove sales-channel publications - and an
 * emergency unpublish is not a publish capability: the direction of the operation is what
 * makes that true, not the name.
 */

import { recordAudit } from '../audit/audit.service';
import { logger } from '../common/logger';
import { AppError } from '../common/errors';
import { config } from '../config';
import { getDatabaseStatus } from '../database/mongo';
import { ProductCandidateModel } from '../database/models/ProductCandidate';
import { createProduct } from '../products/products.create.service';
import { editProduct } from '../products/products.write.service';
import { getProductVisibility, unpublishProduct } from '../shopify/publications/publications.service';
import { listProducts } from '../shopify/shopify.service';
import { upsertManualCost } from '../suppliers/manualCost.service';
import type { ProductCandidate } from './candidate.types';
import type { DuplicateReport, ExistingProductRef } from './duplicate.detection';
import {
  getCandidate,
  listCandidates,
  persistAnalysis,
  prepareCandidateAnalysis,
} from './intelligence.service';
import { detectDuplicates } from './duplicate.detection';
import { researchIdentityTag } from './push.draft';
import type {
  ClaimRequest,
  CompletionRequest,
  CostRequest,
  ExistingResearchProduct,
  IncidentRequest,
  PushAuditFacts,
  PushIntent,
  PushPorts,
  RecordIntentRequest,
  ShopifyProductState,
} from './push.ports';
import {
  pushCandidateAsDraft as orchestratePush,
  type PushAsDraftInput,
  type PushAsDraftResult,
} from './push.orchestrator';

export type { PushAsDraftInput, PushAsDraftResult } from './push.orchestrator';
export { PUSH_CLAIM_LEASE_MS } from './push.orchestrator';

/** Shopify's hard page limit. One page: the duplicate check is advisory. */
const CATALOGUE_PAGE_SIZE = 250;

function shopDomain(): string {
  return config.shopify.storeDomain;
}

/* ===========================================================================
 * The atomic claim
 * ======================================================================== */

/**
 * Takes the push claim in ONE conditional write.
 *
 * The filter is the mutex. A read-then-write would let two operations both observe IDLE
 * and both proceed to create a product; because the expected state is in the FILTER,
 * exactly one findOneAndUpdate can match and the loser gets null.
 *
 * Three ways to match, and each is deliberate:
 *
 *   IDLE                        the normal case
 *   IN_PROGRESS, same operation the caller is resuming its own work. The idempotency
 *                               middleware deletes its key on a 5xx, so a client retrying
 *                               with the same Idempotency-Key arrives as a fresh request
 *                               with the same operation id and must not be locked out by
 *                               its own previous attempt
 *   IN_PROGRESS, lease expired  the owning process died. Safe ONLY because the
 *                               orchestration then looks the candidate up in Shopify by
 *                               its research tag before creating anything
 *
 * `pushedShopifyProductId: null` is also in the filter, so a candidate that already has a
 * product can never be claimed regardless of what pushState says.
 *
 * This is the same shape as the webhook queue's lease claim, which is the existing
 * crash-recoverable claim in this codebase.
 */
async function claimPush(request: ClaimRequest): Promise<ProductCandidate | null> {
  const leaseCutoff = new Date(request.now.getTime() - request.leaseMs).toISOString();

  const claimed = await ProductCandidateModel.findOneAndUpdate(
    {
      shopDomain: shopDomain(),
      candidateId: request.candidateId,
      pushedShopifyProductId: null,
      $or: [
        { pushState: 'IDLE' },
        { pushState: { $exists: false } },
        { pushState: 'IN_PROGRESS', pushOperationId: request.operationId },
        { pushState: 'IN_PROGRESS', pushClaimedAt: { $lte: leaseCutoff } },
        { pushState: 'IN_PROGRESS', pushClaimedAt: null },
      ],
    },
    {
      $set: {
        pushState: 'IN_PROGRESS',
        pushOperationId: request.operationId,
        pushClaimedAt: request.now.toISOString(),
      },
    },
    { new: true },
  ).lean();

  if (claimed === null) return null;

  logger.info('Research push claim taken.', {
    candidateId: request.candidateId,
    operationId: request.operationId,
  });

  // Re-read through the normal mapping so the orchestration sees the same DTO shape every
  // other caller does, rather than a raw lean row.
  return getCandidate(request.candidateId);
}

/** Releases a claim, only if this operation still owns it. */
async function releaseClaim(request: {
  candidateId: string;
  operationId: string;
}): Promise<void> {
  const result = await ProductCandidateModel.updateOne(
    {
      shopDomain: shopDomain(),
      candidateId: request.candidateId,
      pushState: 'IN_PROGRESS',
      // Guards against releasing a claim that has since been taken over by a recovery
      // operation. Releasing someone else's claim would let a third push start.
      pushOperationId: request.operationId,
    },
    { $set: { pushState: 'IDLE', pushOperationId: null, pushClaimedAt: null } },
  );

  if (result.modifiedCount > 0) {
    logger.info('Research push claim released.', request);
  }
}

/**
 * Freezes the push intent and renews the claim, in ONE ownership-conditional write.
 *
 * The filter is the ownership assertion: this operation must still hold the IN_PROGRESS
 * claim and no product may exist yet. If an expired lease was taken over by another
 * operation between the claim and here, the filter matches nothing and this returns false
 * - which is exactly the gate that stops operation A from creating a product after
 * operation B has taken the claim over.
 *
 * `matchedCount`, not `modifiedCount`: writing an identical pushClaimedAt is theoretically
 * possible within the same millisecond, and ownership must be judged by whether the row
 * matched, not by whether a byte changed.
 */
async function recordIntent(request: RecordIntentRequest): Promise<boolean> {
  const result = await ProductCandidateModel.updateOne(
    {
      shopDomain: shopDomain(),
      candidateId: request.candidateId,
      pushState: 'IN_PROGRESS',
      pushOperationId: request.operationId,
      pushedShopifyProductId: null,
    },
    {
      $set: {
        pushClaimedAt: request.now.toISOString(),
        pushIntent: request.intent,
      },
    },
  );

  return result.matchedCount > 0;
}

/** Reads the frozen push intent for recovery. Null when none was recorded. */
async function loadIntent(candidateId: string): Promise<PushIntent | null> {
  const row = await ProductCandidateModel.findOne(
    { shopDomain: shopDomain(), candidateId },
    { pushIntent: 1 },
  ).lean();
  const intent = (row as { pushIntent?: unknown } | null)?.pushIntent;
  return intent === undefined || intent === null ? null : (intent as PushIntent);
}

/**
 * Marks the push succeeded, ONLY if this operation still owns the claim.
 *
 * Ownership is in the FILTER, so a stale operation whose lease was taken over cannot
 * finalize the candidate - the update matches nothing and returns false. The orchestration
 * treats false as an integrity failure and preserves the product id rather than reporting
 * a success it did not own.
 */
async function markSucceeded(request: CompletionRequest): Promise<boolean> {
  const result = await ProductCandidateModel.updateOne(
    {
      shopDomain: shopDomain(),
      candidateId: request.candidateId,
      pushState: 'IN_PROGRESS',
      pushOperationId: request.operationId,
    },
    {
      $set: {
        status: 'PUSHED_TO_SHOPIFY',
        pushState: 'SUCCEEDED',
        pushClaimedAt: null,
        pushedShopifyProductId: request.shopifyProductId,
        pushedAt: request.now.toISOString(),
      },
    },
  );

  if (result.matchedCount === 0) {
    logger.warn('Research push completion found the claim no longer owned.', {
      candidateId: request.candidateId,
      operationId: request.operationId,
      shopifyProductId: request.shopifyProductId,
    });
    return false;
  }
  return true;
}

/**
 * Records that a product exists in a state Trademart could not verify as hidden.
 *
 * The Shopify product id is written even though this is a failure, because the id is the
 * only thing that stops a retry creating a second product - and it is what a human needs
 * to go and fix it.
 */
async function markSafetyIncident(request: IncidentRequest): Promise<void> {
  logger.error('Research push left a product in an unverified visibility state.', {
    candidateId: request.candidateId,
    shopifyProductId: request.shopifyProductId,
    reason: request.reason,
  });

  await ProductCandidateModel.updateOne(
    { shopDomain: shopDomain(), candidateId: request.candidateId },
    {
      $set: {
        // Status still records that a product exists, so the candidate cannot be pushed
        // again or treated as a pre-product candidate.
        status: 'PUSHED_TO_SHOPIFY',
        pushState: 'SAFETY_INCIDENT',
        pushOperationId: request.operationId,
        pushClaimedAt: null,
        pushedShopifyProductId: request.shopifyProductId,
        pushedAt: request.now.toISOString(),
        pushSafetyReason: request.reason,
      },
    },
  );
}

/* ===========================================================================
 * Shopify
 * ======================================================================== */

/**
 * Finds a product carrying this candidate's research identity tag.
 *
 * An EXACT lookup, in two steps. Shopify's `tag:` search is the fast path, and the tag is
 * then CONFIRMED against the returned product's own tag list - Shopify's search is a
 * search, and adopting a product on a near-match would be worse than duplicating one.
 *
 * `first: 2` so more than one match is detectable. Two products sharing a candidate's
 * identity means an earlier duplicate already happened, and silently picking the first
 * would hide it.
 */
async function findByResearchTag(candidateId: string): Promise<ExistingResearchProduct | null> {
  const tag = researchIdentityTag(candidateId);

  let matches;
  try {
    const page = await listProducts({ first: 2, query: `tag:"${tag}"` });
    matches = page.items.filter((product) => product.tags.includes(tag));
  } catch (error) {
    /*
     * A failed lookup must NOT be read as "no product exists".
     *
     * Continuing would risk creating a duplicate, which is the one outcome this lookup
     * exists to prevent. Refusing the push is the safe direction: the operator retries and
     * nothing was created.
     */
    throw new AppError(
      'SHOPIFY_DEGRADED',
      'Could not check Shopify for an existing draft for this candidate, so nothing was created. Pushing without that check could produce a duplicate product. Retry when Shopify is reachable.',
      { details: { candidateId, reason: error instanceof Error ? error.message : 'unknown' } },
    );
  }

  const first = matches[0];
  if (first === undefined) return null;

  if (matches.length > 1) {
    logger.error('More than one Shopify product carries the same research identity.', {
      candidateId,
      shopifyProductIds: matches.map((product) => product.shopifyProductId),
    });
  }

  const visibility = await getProductVisibility(first.shopifyProductId);
  return {
    shopifyProductId: first.shopifyProductId,
    // The first variant, so a reconciliation can restore the supplier cost against it.
    // Null when Shopify returned no variant - reported rather than guessed downstream.
    shopifyVariantId: first.variants[0]?.shopifyVariantId ?? null,
    state: {
      status: first.status,
      published: visibility.publishedAnywhere,
      visibleToCustomers: visibility.visibleToCustomers,
    },
  };
}

/**
 * Forces a product to a hidden draft, then VERIFIES it.
 *
 * Both halves matter, because visibility is the conjunction of two independent facts: an
 * ACTIVE product with no sales-channel publication is invisible, and a DRAFT that is
 * somehow published is not visible either. Setting DRAFT alone would leave the publication
 * in place; unpublishing alone would leave it ACTIVE. So both are done, and then the real
 * state is read back rather than assumed.
 *
 * `expectedStatus` is deliberately omitted from editProduct: this is an emergency, and a
 * concurrency check that refused the repair with PRODUCT_CHANGED would leave the product
 * visible.
 */
async function forceHidden(shopifyProductId: string): Promise<ShopifyProductState> {
  try {
    await editProduct(shopifyProductId, {
      fields: { status: 'DRAFT' },
      addTags: [],
      removeTags: [],
      variants: [],
    });
  } catch (error) {
    logger.error('Could not set a research product back to DRAFT.', {
      shopifyProductId,
      reason: error instanceof Error ? error.message : 'unknown',
    });
  }

  try {
    await unpublishProduct(shopifyProductId);
  } catch (error) {
    logger.error('Could not unpublish a research product.', {
      shopifyProductId,
      reason: error instanceof Error ? error.message : 'unknown',
    });
  }

  // Read the truth back. Both repair attempts above swallow their errors on purpose: what
  // matters is the VERIFIED end state, not whether either individual call succeeded.
  const visibility = await getProductVisibility(shopifyProductId);
  return {
    status: visibility.status,
    published: visibility.publishedAnywhere,
    visibleToCustomers: visibility.visibleToCustomers,
  };
}

async function listCatalogue(): Promise<ExistingProductRef[]> {
  const page = await listProducts({ first: CATALOGUE_PAGE_SIZE });
  return page.items.map((product) => ({
    shopifyProductId: product.shopifyProductId,
    title: product.title,
    status: product.status,
    tags: product.tags,
  }));
}

/* ===========================================================================
 * The ports
 * ======================================================================== */

function realPorts(): PushPorts {
  return {
    now: () => new Date(),

    candidates: {
      load: getCandidate,
      claim: claimPush,
      release: releaseClaim,
      recordIntent,
      loadIntent,
      markSucceeded,
      markSafetyIncident,
      listForDuplicates: async () =>
        (await listCandidates({ limit: 200 })).map((other) => ({
          candidateId: other.id,
          title: other.title,
          status: other.status,
          sourceProductId: other.sourceProductId,
          pushedShopifyProductId: other.pushedShopifyProductId,
        })),
    },

    analysis: {
      prepare: async (candidateId, options) => prepareCandidateAnalysis(candidateId, options),
      persist: async (prepared) => {
        // The orchestration hands back the same object prepareCandidateAnalysis produced,
        // so this is a straight write of an already-computed analysis.
        await persistAnalysis(prepared as Parameters<typeof persistAnalysis>[0]);
      },
    },

    shopify: {
      findByResearchTag,
      listCatalogue,
      createProduct: async (request) => {
        const created = await createProduct(request);
        return {
          shopifyProductId: created.shopifyProductId,
          status: created.status,
          published: created.published,
          visibleToCustomers: created.visibleToCustomers,
          variants: created.variants,
          warnings: created.warnings,
        };
      },
      forceHidden,
    },

    costs: {
      record: async (request: CostRequest) => {
        await upsertManualCost({
          shopifyProductId: request.shopifyProductId,
          shopifyVariantId: request.shopifyVariantId,
          provider: request.provider,
          supplierProductCost: request.supplierProductCost,
          supplierShippingCost: request.supplierShippingCost,
          currencyCode: request.currencyCode,
          // Marked as an override so it wins over Shopify's empty cost-per-item field,
          // which is what a brand-new product has.
          override: true,
          note: request.note,
        });
      },
    },

    audit: recordPushAudit,
  };
}

/**
 * The push audit entry.
 *
 * Records the decision that ACTUALLY produced the draft, including both hashes so a
 * mismatch is reconstructable, and both override flags so accepting a duplicate or a price
 * below the configured floors is attributable rather than inferred from a warning string.
 *
 * Everything goes through recordAudit's existing sanitisation, so no credential can reach
 * the collection through here.
 */
async function recordPushAudit(facts: PushAuditFacts): Promise<void> {
  const created = facts.shopifyProductId !== null;

  await recordAudit({
    action: 'RESEARCH_PUSH_DRAFT',
    resourceType: 'RESEARCH_CANDIDATE',
    resourceId: facts.candidateId,
    ...(facts.error === undefined ? {} : { error: facts.error }),
    after: {
      outcome: facts.outcome,
      shopifyProductId: facts.shopifyProductId,
      // Recorded explicitly rather than left to be inferred from the absence of a publish
      // entry: the whole point is that a research push produces a hidden draft.
      status: facts.productState?.status ?? null,
      published: facts.productState?.published ?? null,
      visibleToCustomers: facts.productState?.visibleToCustomers ?? null,
      listedPrice: facts.listedPrice ?? null,
      priceSource: facts.priceSource ?? null,
      currencyCode: facts.currencyCode ?? null,
      costRecorded: facts.costRecorded ?? null,
      safetyIncident: facts.safetyIncident ?? null,
    },
    metadata: {
      operationId: facts.operationId,
      // Both hashes: which decision the operator approved, and which one was current.
      expectedDecisionHash: facts.expectedDecisionHash,
      actualDecisionHash: facts.actualDecisionHash,
      decisionHashMatched:
        facts.expectedDecisionHash === null || facts.actualDecisionHash === null
          ? null
          : facts.expectedDecisionHash === facts.actualDecisionHash,
      analyzedAt: facts.analyzedAt ?? null,
      overallScore: facts.overallScore ?? null,
      confidenceScore: facts.confidenceScore ?? null,
      recommendation: facts.recommendation ?? null,
      selectedScenario: facts.selectedScenario,
      supplierCost: facts.supplierCost ?? null,
      supplierCurrency: facts.supplierCurrency ?? null,
      shippingCost: facts.shippingCost ?? null,
      shippingCurrency: facts.shippingCurrency ?? null,
      duplicateMatches: facts.duplicateMatches ?? null,
      duplicateOverridden: facts.duplicateOverridden,
      guardBreachOverridden: facts.guardBreachOverridden,
      partialVariantsOverridden: facts.partialVariantsOverridden,
      // Supplier sourceability: the record of WHY this product was believed sourceable.
      supplierProvider: facts.supplierProvider ?? null,
      supplierProductId: facts.supplierProductId ?? null,
      supplierAvailability: facts.supplierAvailability ?? null,
      supplierAvailabilitySource: facts.supplierAvailabilitySource ?? null,
      supplierCheckedAt: facts.supplierCheckedAt ?? null,
      supplierFreshness: facts.supplierFreshness ?? null,
      supplierVariantCoverage: facts.supplierVariantCoverage ?? null,
    },
    result:
      facts.error !== undefined
        ? 'FAILURE'
        : facts.safetyIncident !== null && facts.safetyIncident !== undefined
          ? 'FAILURE'
          : facts.outcome === 'RECONCILED' || facts.costRecorded === false
            ? // A reconciliation created nothing new, and a missing cost leaves the margin
              // unknown. Neither is a clean success and calling them one would hide the
              // thing worth reading.
              'PARTIAL'
            : created
              ? 'SUCCESS'
              : 'FAILURE',
  });
}

/* ===========================================================================
 * Public surface
 * ======================================================================== */

/**
 * Creates a DRAFT Shopify product from a candidate.
 *
 * A database is required before anything else: the claim cannot be recorded without one,
 * and creating a product that Trademart then cannot remember is precisely how a retry
 * produces a second one.
 */
export async function pushCandidateAsDraft(
  candidateId: string,
  input: PushAsDraftInput,
): Promise<PushAsDraftResult> {
  if (getDatabaseStatus().status !== 'connected') {
    throw new AppError(
      'DATABASE_UNAVAILABLE',
      'Pushing a candidate needs MongoDB, so the push can be claimed and recorded. Without it a retry would create a second Shopify product.',
    );
  }

  return orchestratePush(realPorts(), candidateId, input);
}

/**
 * Checks a candidate for duplicates without pushing anything.
 *
 * Exposed separately so the UI can warn BEFORE the operator clicks. A duplicate warning
 * that only appears after the product exists is useless.
 */
export async function checkForDuplicates(candidateId: string): Promise<DuplicateReport> {
  const candidate = await getCandidate(candidateId);

  let products: ExistingProductRef[] = [];
  let catalogueRead = true;
  try {
    products = await listCatalogue();
  } catch (error) {
    logger.warn('Could not read the Shopify catalogue for duplicate detection.', {
      reason: error instanceof Error ? error.message : 'unknown',
    });
    catalogueRead = false;
  }

  const others = (await listCandidates({ limit: 200 })).map((other) => ({
    candidateId: other.id,
    title: other.title,
    status: other.status,
    sourceProductId: other.sourceProductId,
    pushedShopifyProductId: other.pushedShopifyProductId,
  }));

  const report = detectDuplicates({
    subject: {
      candidateId: candidate.id,
      title: candidate.title,
      keywords: candidate.keywords,
      sourceProductId: candidate.sourceProductId,
    },
    products,
    candidates: others,
  });

  if (catalogueRead) return report;

  return {
    ...report,
    summary: [
      report.summary,
      'The Shopify catalogue could not be read, so this check covered other research candidates only. A product with this name may already exist.',
    ]
      .filter((part): part is string => part !== null)
      .join(' '),
  };
}
