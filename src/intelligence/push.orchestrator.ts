/**
 * The Push-as-Draft decision sequence.
 *
 * Extracted from push.service.ts behind an explicit port interface for one reason: this
 * is the code where a mistake creates a duplicate Shopify product or puts a scored guess
 * in front of customers, and push.service imports the config singleton (which calls
 * process.exit(1) at import) so nothing in it can be unit tested. The orchestration now
 * lives here, takes its outside world as an argument, and the tests assert CALL COUNTS
 * AND ORDER - "createProduct was called exactly once" is the only form of proof that
 * actually means anything here.
 *
 * ORDER IS THE DESIGN
 * -------------------
 * Every refusal happens before the first Shopify write, and the sequence is ordered so
 * the cheapest and most certain refusals come first:
 *
 *    1. eligibility          status / pushState / already-pushed
 *    2. currency labelling   an amount with no unit cannot price anything
 *    3. CLAIM                atomic, so only one operation proceeds
 *    4. reconcile            does a product for this candidate already exist in Shopify?
 *    5. fresh analysis       computed, NOT persisted
 *    6. decision hash        does it still match what the operator approved?
 *    7. duplicates           unless explicitly overridden
 *    8. price + guards       unless explicitly overridden
 *    9. createProduct        <-- the first and only Shopify creation
 *   10. verify draft-only    repair and escalate if it is somehow visible
 *   11. record cost, persist analysis, mark succeeded, audit
 *
 * Steps 1-8 guarantee ZERO Shopify writes on failure. Step 4 is what makes the atomic
 * claim in step 3 sufficient: a claim alone cannot survive a crash between step 9 and
 * step 11, so recovery relies on being able to FIND the product again by a deterministic
 * identity rather than on the claim having been released.
 */

import { AppError } from '../common/errors';
import { assertLabelledCurrencies } from '../common/money';
import type { PricingScenarioName } from '../pricing/recommendation';
import { pricingGuardBreaches } from '../pricing/pricing.service';
import type { ProductCandidate } from './candidate.types';
import { canPushCandidate, claimIsRecoverable } from './candidate.transitions';
import {
  detectDuplicates,
  type DuplicateReport,
  type ExistingCandidateRef,
  type ExistingProductRef,
} from './duplicate.detection';
import {
  assertDraftOnly,
  buildDraftRequest,
  researchIdentityTag,
  resolveListingPrice,
  type ResolvedListingPrice,
} from './push.draft';
import type { PreparedAnalysis } from './push.ports';
import type {
  PushAuditFacts,
  PushIntent,
  PushPorts,
  ShopifyProductState,
} from './push.ports';
import type { SourceabilityResult } from './sourceability';
import {
  buildSupplierVariantPlan,
  buildVariantPlanFromSupplierVariants,
  mapCreatedVariants,
  type PushedVariantMapping,
} from './variant.mapping';

/**
 * How long a push claim is honoured before another operation may take it over.
 *
 * Long enough to cover a slow Shopify create plus the follow-up writes, short enough that
 * a crashed process does not wedge a candidate for an afternoon. Recovery is only safe
 * because step 4 looks the candidate up in Shopify first - without that, taking over an
 * expired claim would be a licence to duplicate.
 */
export const PUSH_CLAIM_LEASE_MS = 2 * 60_000;

export interface PushAsDraftInput {
  /** Which price scenario to list at. Defaults to the recommended one. */
  scenario?: PricingScenarioName;
  /** An explicit price, overriding the scenario entirely. Still guard-checked. */
  price?: number;
  /**
   * The decision the operator approved.
   *
   * Optional at the type level so an internal caller can push without one, but the
   * controller requires it: without it there is nothing to compare and the whole
   * stale-recommendation gate is decorative.
   */
  expectedDecisionHash?: string;
  /** Proceed despite an exact duplicate. Must be a deliberate, explicit true. */
  allowDuplicate?: boolean;
  /**
   * Proceed despite the chosen price breaching a configured commercial floor.
   *
   * A separate acknowledgement from allowDuplicate on purpose: they are different
   * decisions with different consequences, and one checkbox covering both would let an
   * operator who meant to accept a duplicate also silently accept a loss-making price.
   */
  acknowledgeGuardBreach?: boolean;
  /**
   * Proceed despite PARTIAL supplier variant coverage, creating the draft for the
   * available coverage only. Explicit and separate, like acknowledgeGuardBreach - it is a
   * different decision, and the unavailable variants are never created regardless.
   */
  acknowledgePartialVariants?: boolean;
  /**
   * Identifies this logical push. Sourced from the Idempotency-Key header when present.
   *
   * The same operation may re-enter its own claim; a different one may not.
   */
  operationId: string;
}

export type PushOutcome =
  /** A new Shopify DRAFT was created. */
  | 'CREATED'
  /**
   * A product for this candidate already existed in Shopify and was adopted.
   *
   * The crash-recovery path. Reported distinctly from CREATED so the operator knows
   * nothing new was made and the audit trail records a reconciliation rather than a
   * second creation.
   */
  | 'RECONCILED';

export interface PushAsDraftResult {
  candidate: ProductCandidate;
  outcome: PushOutcome;
  shopifyProductId: string;
  /** The verified Shopify state. `visibleToCustomers` is the only field that means live. */
  productState: ShopifyProductState;
  duplicates: DuplicateReport;
  listedPrice: ResolvedListingPrice | null;
  costRecorded: boolean;
  /** Set when the product could not be verified hidden. Never an ordinary success. */
  safetyIncident: string | null;
  warnings: string[];
}

/* ===========================================================================
 * Entry point
 * ======================================================================== */

export async function pushCandidateAsDraft(
  ports: PushPorts,
  candidateId: string,
  input: PushAsDraftInput,
): Promise<PushAsDraftResult> {
  const now = ports.now();

  // ---- 1. eligibility ------------------------------------------------------
  //
  // Read before claiming so the common refusals cost nothing and produce a specific
  // message. The claim re-checks the same conditions atomically, because anything decided
  // from a read can be stale by the time it is acted on.
  const existing = await ports.candidates.load(candidateId);
  const eligibility = canPushCandidate(existing);
  if (!eligibility.allowed && !claimIsOwnedOrExpired(existing, input.operationId, now)) {
    /*
     * Refuse here only for the PERMANENT conditions - already pushed, terminal, or a
     * safety incident awaiting a human. An IN_PROGRESS claim that THIS operation already
     * owns (a transport retry) or whose lease has expired (a crashed predecessor) is not a
     * real refusal: the atomic claim in step 3 can still grant it, and it is the authority.
     *
     * If this refused on IN_PROGRESS unconditionally, the claim's own recovery filter
     * (same operationId, or expired lease) would be unreachable dead code, and a push that
     * created a Shopify product but died before recording it could never be reconciled -
     * the candidate would be wedged IN_PROGRESS forever with an orphaned product.
     */
    throw refusal(existing, eligibility.reason);
  }

  // ---- 2. currency labelling ----------------------------------------------
  //
  // Before the claim, because it can never become allowed by waiting. An amount with no
  // currency cannot take part in a price, and the selling currency must never be borrowed
  // to label a supplier cost.
  assertLabelledCurrencies(
    [
      {
        amount: existing.commercials.supplierCost,
        currencyCode: existing.commercials.supplierCurrency,
        label: 'supplier cost',
      },
      {
        amount: existing.commercials.shippingCost,
        currencyCode: existing.commercials.shippingCurrency,
        label: 'supplier shipping',
      },
      {
        amount: existing.commercials.expectedSellingPrice,
        currencyCode: existing.commercials.expectedSellingCurrency,
        label: 'intended selling price',
      },
    ],
    'push this candidate to Shopify',
  );

  // ---- 3. the atomic claim -------------------------------------------------
  const claimed = await ports.candidates.claim({
    candidateId,
    operationId: input.operationId,
    now,
    leaseMs: PUSH_CLAIM_LEASE_MS,
  });

  if (claimed === null) {
    // The claim is the authority, not the earlier read. Re-read to say WHY precisely -
    // "already pushed" and "another push is running" need different actions.
    const current = await ports.candidates.load(candidateId);
    throw refusal(current, canPushCandidate(current).reason);
  }

  let shopifyProductId: string | null = null;

  try {
    return await pushWithClaim(ports, claimed, input, now, (id) => {
      shopifyProductId = id;
    });
  } catch (error) {
    /*
     * Releasing the claim is conditional on whether a product exists.
     *
     * No product: release, so the operator can fix the problem and retry immediately.
     * Product exists: do NOT release. The candidate keeps its claim (or its incident
     * state) so a naive retry cannot race, and the product id is preserved in the error
     * details so a human can find what was created.
     */
    if (shopifyProductId === null) {
      await ports.candidates.release({ candidateId, operationId: input.operationId });
    }

    await ports.audit({
      candidateId,
      operationId: input.operationId,
      expectedDecisionHash: input.expectedDecisionHash ?? null,
      actualDecisionHash: null,
      shopifyProductId,
      outcome: null,
      error,
      ...auditDefaults(input),
    });

    if (shopifyProductId !== null && error instanceof AppError) {
      // Re-thrown with the product id attached. An error that hides the fact a product
      // was created is how a duplicate gets made by the next click.
      throw new AppError(error.code, error.message, {
        status: error.status,
        details: { ...(asRecord(error.details) ?? {}), shopifyProductId },
      });
    }
    throw error;
  }
}

/* ===========================================================================
 * Inside the claim
 * ======================================================================== */

async function pushWithClaim(
  ports: PushPorts,
  claimed: ProductCandidate,
  input: PushAsDraftInput,
  now: Date,
  recordProductId: (id: string) => void,
): Promise<PushAsDraftResult> {
  const candidateId = claimed.id;
  const warnings: string[] = [];

  // ---- 4. reconcile against Shopify ---------------------------------------
  //
  // THE STEP THAT MAKES CRASH RECOVERY SAFE.
  //
  // A claim cannot survive the window between createProduct succeeding and the candidate
  // being updated: if the process dies there, Mongo still says IN_PROGRESS and knows no
  // product id. So instead of relying on the claim, every push first asks Shopify whether
  // a product carrying THIS candidate's research identity already exists.
  //
  // The lookup is an exact tag query, not a title scan of the first page - a fuzzy match
  // would either miss the product (and duplicate it) or match the wrong one.
  const already = await ports.shopify.findByResearchTag(candidateId);
  if (already !== null) {
    recordProductId(already.shopifyProductId);
    return reconcileExisting(ports, claimed, input, already, now, warnings);
  }

  // ---- 5. fresh analysis, NOT persisted -----------------------------------
  //
  // Recomputed rather than read: a stored score was computed against whatever the costs
  // and settings were at the time, and listing at a stale price is how a product goes
  // live under the current margin floor. Nothing is written yet, so a refusal below
  // leaves the candidate exactly as the operator last saw it.
  const prepared = await ports.analysis.prepare(candidateId, {
    ...(input.scenario === undefined ? {} : { pricingScenario: input.scenario }),
    now,
  });

  // Everything downstream uses the FRESH candidate. The old code built the draft from the
  // pre-analysis object, so a fresh GOOD_CANDIDATE / 82 could be listed with a
  // description and tag reading WATCH / 61.
  const candidate = prepared.freshCandidate;

  // ---- 6. the decision the operator approved ------------------------------
  if (
    input.expectedDecisionHash !== undefined &&
    input.expectedDecisionHash !== prepared.decisionHash
  ) {
    throw new AppError(
      'RECOMMENDATION_CHANGED',
      'The analysis changed since you reviewed it, so nothing was created in Shopify. Review the updated recommendation and price, then push again - Trademart will not substitute a decision you have not seen.',
      {
        details: {
          candidateId,
          expectedDecisionHash: input.expectedDecisionHash,
          actualDecisionHash: prepared.decisionHash,
          recommendation: candidate.recommendation,
          overallScore: candidate.overallScore,
          confidenceScore: candidate.confidenceScore,
        },
      },
    );
  }

  // ---- 6b. supplier sourceability gate ------------------------------------
  //
  // A product is not sellable merely because the market looks good; it must be SOURCEABLE.
  // This gate runs before any Shopify write, so a refusal creates nothing. Tradelle is
  // MANUAL/SHOPIFY_BRIDGE only - there is no live API to re-poll here - so the gate relies
  // on the recorded verification and its freshness, exactly as computed into the decision
  // hash above (a stale or changed verdict already fails the hash check for a reviewing
  // operator; this gate also catches an internal caller that sent no hash).
  const sourceability = prepared.sourceability;
  if (sourceability.block === 'SUPPLIER_UNAVAILABLE') {
    throw new AppError(
      'RESEARCH_SUPPLIER_UNAVAILABLE',
      sourceability.variantCoverage === 'NONE'
        ? 'The supplier offers this product but none of its variants are available, so nothing was created. It cannot be sourced right now.'
        : 'The supplier has this product marked as unavailable, so nothing was created. A product that cannot be sourced is never pushed, however strong the market looks.',
      { details: { candidateId, reasons: sourceability.reasons } },
    );
  }
  if (sourceability.block === 'SUPPLIER_AVAILABILITY_UNKNOWN') {
    throw new AppError(
      'RESEARCH_SUPPLIER_UNVERIFIED',
      'This product has not been verified as sourceable from the supplier, so nothing was created. Record a supplier verification (confirm availability in Tradelle or DeoDap) before pushing.',
      { details: { candidateId, reasons: sourceability.reasons } },
    );
  }
  if (sourceability.block === 'SUPPLIER_AVAILABILITY_STALE') {
    throw new AppError(
      'RESEARCH_SUPPLIER_STALE',
      `Supplier availability was verified once but the check is now stale (${sourceability.freshness}), so nothing was created. Re-verify the product is currently available from the supplier before pushing.`,
      { details: { candidateId, checkedAt: sourceability.checkedAt, reasons: sourceability.reasons } },
    );
  }
  /*
   * Partial variant coverage never creates unavailable/unknown variants silently. The
   * draft builder makes a single default variant, so "resolving" the selection here is an
   * explicit acknowledgement that the operator has chosen to proceed with the available
   * coverage; without it the push is blocked for review.
   */
  if (sourceability.variantCoverage === 'PARTIAL' && input.acknowledgePartialVariants !== true) {
    throw new AppError(
      'RESEARCH_SUPPLIER_VARIANTS',
      'Some of this product\u2019s variants are unavailable or unverified at the supplier, so nothing was created. Review the variant coverage and acknowledge it to proceed with the available variants only.',
      {
        details: {
          candidateId,
          variantCoverage: sourceability.variantCoverage,
          variants: sourceability.variants,
          reasons: sourceability.reasons,
        },
      },
    );
  }
  if (sourceability.variantCoverage === 'PARTIAL') {
    warnings.push(
      'Some supplier variants are unavailable or unverified. You acknowledged this, and the draft was created for the available coverage only - it does not advertise the unavailable variants.',
    );
  }

  // ---- 7. duplicates ------------------------------------------------------
  const duplicates = await checkDuplicates(ports, candidate);
  if (duplicates.blocking.length > 0 && input.allowDuplicate !== true) {
    throw new AppError(
      'VALIDATION_ERROR',
      `This candidate looks like a duplicate and nothing was created. ${duplicates.blocking
        .map((match) => match.reason)
        .join(' ')} Set allowDuplicate to proceed anyway.`,
      { details: { candidateId, duplicates: duplicates.blocking } },
    );
  }

  // ---- 8. price and commercial guards ------------------------------------
  const listedPrice = resolveListingPrice(candidate, prepared.analysis.pricing, {
    ...(input.scenario === undefined ? {} : { scenario: input.scenario }),
    ...(input.price === undefined ? {} : { price: input.price }),
  });

  const breaches = guardBreachesFor(prepared, listedPrice, candidate);
  if (breaches.length > 0 && input.acknowledgeGuardBreach !== true) {
    /*
     * A breach no longer proceeds quietly "because the operator may have a reason".
     *
     * They may well have one, and they can still say so - but it has to be said. The
     * previous behaviour recorded a warning and created the product anyway, which meant
     * the most consequential decision on the screen was the one nobody had to confirm.
     */
    throw new AppError(
      'VALIDATION_ERROR',
      `The price ${listedPrice.amount.toFixed(2)} breaches your configured commercial floors, so nothing was created. It ${breaches.join(
        ' and it ',
      )}. Set acknowledgeGuardBreach to list it anyway - the override is recorded in the audit trail.`,
      {
        details: {
          candidateId,
          listedPrice: listedPrice.amount,
          priceSource: listedPrice.source,
          breaches,
          minimumMarginPercentage: prepared.policy.minimumMarginPercentage,
          minimumProfitAmount: prepared.policy.minimumProfitAmount,
        },
      },
    );
  }
  if (breaches.length > 0) {
    warnings.push(
      `Listed at a price that breaches your own floors: it ${breaches.join(' and it ')}. You acknowledged this, and the override is recorded in the audit trail.`,
    );
  }

  warnings.push(...prepared.analysis.warnings);

  // ---- 8b. freeze the intent AND renew/assert ownership -------------------
  //
  // Written after every refusal gate passes but BEFORE the first Shopify write. Two jobs
  // in one atomic conditional write:
  //
  //   1. It freezes the exact decision - price, hash, score, supplier cost - so that a
  //      crash between the create below and the bookkeeping at step 11 can be recovered
  //      from real figures rather than nulls (see reconcileExisting).
  //   2. It RENEWS the lease and ASSERTS ownership. If this operation's lease expired and
  //      another operation took the claim over, the conditional write matches nothing and
  //      returns false. This is the gate that closes the lease-expiry race: operation A,
  //      resuming after B took over, cannot create a product because it no longer owns the
  //      claim.
  // A FRESH clock read for the lease renewal. Using the operation-start `now` here was a
  // bug: if the analysis and gates above took longer than the lease, the "renewed" lease
  // would already be expired the instant it was written. The renewal must be stamped with
  // the time it actually happens.
  const renewalNow = ports.now();
  const intent = buildPushIntent(input, candidate, listedPrice, prepared, renewalNow);
  const stillOwned = await ports.candidates.recordIntent({
    candidateId,
    operationId: input.operationId,
    now: renewalNow,
    leaseMs: PUSH_CLAIM_LEASE_MS,
    intent,
  });
  if (!stillOwned) {
    // ZERO Shopify writes. Another operation owns the claim now; it will create (or has
    // created) the product, and this one must not race it.
    throw new AppError(
      'PUSH_CLAIM_LOST',
      'Another push or recovery operation took ownership of this candidate before this one could create the draft, so nothing was created here. Refresh the candidate to see its current state before retrying.',
      { details: { candidateId, operationId: input.operationId } },
    );
  }

  // ---- 8c. FINAL identity reconciliation ----------------------------------
  //
  // One last exact lookup, immediately before the create. Between the step-4 lookup and
  // here we ran a fresh analysis and several gates; a concurrent operation (or a previous
  // attempt) could have created the product in that window. Ownership alone does not rule
  // this out - an operation can hold the claim yet a product from an earlier lease can
  // exist - so we look again and reconcile rather than create a second one.
  const raceWinner = await ports.shopify.findByResearchTag(candidateId);
  if (raceWinner !== null) {
    recordProductId(raceWinner.shopifyProductId);
    return reconcileExisting(ports, claimed, input, raceWinner, now, warnings);
  }

  // ---- 9. create ----------------------------------------------------------
  const variantPlan = buildSupplierVariantPlan(candidate, listedPrice.amount);
  const request = buildDraftRequest(candidate, listedPrice.amount);
  // Belt and braces over buildDraftRequest, which hard-codes both fields. A property this
  // important should be enforced by a check rather than by everyone remembering.
  assertDraftOnly(request);

  const product = await ports.shopify.createProduct(request);
  recordProductId(product.shopifyProductId);
  warnings.push(...product.warnings);

  const variantMapping = mapCreatedVariants(
    candidateId,
    variantPlan.sources,
    product.variants,
    ports.now(),
  );
  warnings.push(...variantMapping.warnings);

  // ---- 10. draft-only is a POSTCONDITION ----------------------------------
  const safety = await enforceHidden(ports, product.shopifyProductId, product, warnings);

  // ---- 11. persist --------------------------------------------------------
  const costRecorded = await recordCost(
    ports,
    candidate,
    // The id from the create call, NOT candidate.pushedShopifyProductId - the candidate
    // here is the freshly analysed object and its pushed id is still null at this point,
    // so reading it would file the cost against an empty product id.
    product.shopifyProductId,
    product.variants,
    warnings,
  );

  // The analysis that actually produced this draft is persisted now, so the stored score
  // matches the description and tag on the product. Persisting before the Shopify write
  // would have left a score history entry for a push that then failed.
  await ports.analysis.persist(prepared);

  // A fresh clock read: completion happened now, after the Shopify create and the
  // bookkeeping, not at operation start. pushedAt should record when the product was
  // actually finalised.
  const completionNow = ports.now();

  if (safety.incident === null) {
    const owned = await ports.candidates.markSucceeded({
      candidateId,
      operationId: input.operationId,
      shopifyProductId: product.shopifyProductId,
      variantMappings: variantMapping.mappings,
      now: completionNow,
    });
    if (!owned) {
      /*
       * Ownership was lost between the create and here. The product EXISTS, so it is not
       * released or hidden - the operation that took the claim over will find it by its
       * identity tag and reconcile it. This one fails loudly with the product id preserved
       * (the outer catch attaches it), never reporting a success it did not own.
       */
      throw new AppError(
        'PUSH_CLAIM_LOST',
        'This push created a Shopify product but another operation had taken ownership of the candidate by the time it finished, so it could not record completion. The product exists and will be reconciled by the operation that now owns the candidate.',
        { details: { candidateId, operationId: input.operationId, shopifyProductId: product.shopifyProductId } },
      );
    }
  } else {
    await ports.candidates.markSafetyIncident({
      candidateId,
      operationId: input.operationId,
      shopifyProductId: product.shopifyProductId,
      variantMappings: variantMapping.mappings,
      reason: safety.incident,
      now: completionNow,
    });
  }

  await ports.audit({
    candidateId,
    operationId: input.operationId,
    expectedDecisionHash: input.expectedDecisionHash ?? null,
    actualDecisionHash: prepared.decisionHash,
    shopifyProductId: product.shopifyProductId,
    outcome: 'CREATED',
    analyzedAt: candidate.analyzedAt,
    overallScore: candidate.overallScore,
    confidenceScore: candidate.confidenceScore,
    recommendation: candidate.recommendation,
    listedPrice: listedPrice.amount,
    priceSource: listedPrice.source,
    currencyCode: listedPrice.currencyCode,
    supplierCost: candidate.commercials.supplierCost,
    supplierCurrency: candidate.commercials.supplierCurrency,
    shippingCost: candidate.commercials.shippingCost,
    shippingCurrency: candidate.commercials.shippingCurrency,
    duplicateMatches: duplicates.matches.length,
    ...supplierAuditFacts(sourceability),
    productState: safety.state,
    costRecorded,
    safetyIncident: safety.incident,
    ...auditDefaults(input),
  });

  if (safety.incident !== null) {
    // NEVER an ordinary success. The product exists, so the id is preserved, but the
    // caller is told loudly that it could not be verified hidden.
    throw new AppError('RESEARCH_PUSH_SAFETY', safety.incident, {
      details: {
        candidateId,
        shopifyProductId: product.shopifyProductId,
        productState: safety.state,
        warnings,
      },
    });
  }

  return {
    candidate: await ports.candidates.load(candidateId),
    outcome: 'CREATED',
    shopifyProductId: product.shopifyProductId,
    productState: safety.state,
    duplicates,
    listedPrice,
    costRecorded,
    safetyIncident: null,
    warnings: dedupe(warnings),
  };
}

/* ===========================================================================
 * Reconciliation
 * ======================================================================== */

/**
 * Adopts a Shopify product that already carries this candidate's research identity.
 *
 * Reached when a previous attempt created the product but died before recording it. The
 * only correct response is to finish the bookkeeping, NOT to create a second product -
 * and certainly not to ask the operator to decide, because they have no way of knowing
 * a half-completed push happened.
 *
 * The visibility postcondition is enforced here too: the earlier attempt may have died
 * before checking it.
 */
async function reconcileExisting(
  ports: PushPorts,
  claimed: ProductCandidate,
  input: PushAsDraftInput,
  found: {
    shopifyProductId: string;
    shopifyVariantId: string | null;
    variants?: readonly { shopifyVariantId: string; sku?: string | null; optionValues?: readonly { name: string; value: string }[] }[];
    state: ShopifyProductState;
  },
  now: Date,
  warnings: string[],
): Promise<PushAsDraftResult> {
  const candidateId = claimed.id;

  // The decision the ORIGINAL push froze before it created this product. This is what
  // makes recovery complete rather than a shrug: the listed price, the decision hash, the
  // score and the supplier cost all come from here, not from a fresh recomputation that
  // would misrepresent what the draft was actually made with.
  const intent = await ports.candidates.loadIntent(candidateId);

  warnings.push(
    `A Shopify product for this candidate already existed (${found.shopifyProductId}), so nothing new was created. It was almost certainly made by an earlier attempt that did not finish recording itself.`,
  );

  const safety = await enforceHidden(ports, found.shopifyProductId, found.state, warnings);

  // Restore the supplier cost from the original intent. upsertManualCost is idempotent, so
  // re-recording a cost the crashed attempt already saved is harmless; the point is to
  // cover the case where it crashed BEFORE saving it.
  let costRecorded = false;
  let variantMappings: PushedVariantMapping[] = [];
  if (intent === null) {
    // Conservative reconcile: the product exists but its original commercial intent is
    // gone. Nothing is invented - the price, hash and cost are reported as unknown.
    warnings.push(
      'The original push intent for this product could not be found, so its listed price, decision hash and supplier cost cannot be reconstructed. The product has been reconciled and hidden, but these historical values are recorded as unknown rather than guessed. Check the draft in Shopify and re-enter its supplier cost if needed.',
    );
  } else {
    costRecorded = await recordCostFromIntent(
      ports,
      candidateId,
      intent,
      found.shopifyProductId,
      found.shopifyVariantId,
      warnings,
    );

    try {
      const recoveredPlan = buildVariantPlanFromSupplierVariants(
        intent.supplierVariantSnapshot,
        intent.listedPrice,
      );
      const recovered = mapCreatedVariants(
        candidateId,
        recoveredPlan.sources,
        found.variants ?? [],
        now,
      );
      variantMappings = recovered.mappings;
      warnings.push(...recovered.warnings);
    } catch (error) {
      warnings.push(
        `The original supplier-to-Shopify variant mapping could not be reconstructed (${error instanceof Error ? error.message : 'unknown error'}). Unmapped variants remain unavailable to the storefront.`,
      );
    }
  }

  if (safety.incident === null) {
    const owned = await ports.candidates.markSucceeded({
      candidateId,
      operationId: input.operationId,
      shopifyProductId: found.shopifyProductId,
      variantMappings,
      now,
    });
    if (!owned) {
      throw new AppError(
        'PUSH_CLAIM_LOST',
        'Reconciled an existing Shopify product but another operation had taken ownership of the candidate by the time this one finished, so it could not record completion. The product exists and the owning operation will reconcile it.',
        { details: { candidateId, operationId: input.operationId, shopifyProductId: found.shopifyProductId } },
      );
    }
  } else {
    await ports.candidates.markSafetyIncident({
      candidateId,
      operationId: input.operationId,
      shopifyProductId: found.shopifyProductId,
      variantMappings,
      reason: safety.incident,
      now,
    });
  }

  await ports.audit({
    candidateId,
    operationId: input.operationId,
    // From the ORIGINAL intent, so the audit trail records the decision that actually
    // created the product rather than a row of nulls.
    expectedDecisionHash: input.expectedDecisionHash ?? intent?.expectedDecisionHash ?? null,
    actualDecisionHash: intent?.actualDecisionHash ?? null,
    shopifyProductId: found.shopifyProductId,
    outcome: 'RECONCILED',
    overallScore: intent?.overallScore ?? null,
    confidenceScore: intent?.confidenceScore ?? null,
    recommendation: intent?.recommendation ?? null,
    listedPrice: intent?.listedPrice ?? null,
    priceSource: intent === null ? null : 'Recovered from the original push intent',
    currencyCode: intent?.sellingCurrency ?? null,
    supplierCost: intent?.supplierCost ?? null,
    supplierCurrency: intent?.supplierCurrency ?? null,
    shippingCost: intent?.shippingCost ?? null,
    shippingCurrency: intent?.shippingCurrency ?? null,
    // Supplier facts from the ORIGINAL frozen intent, not recomputed now - recovery must
    // record why the product was believed sourceable when it was created.
    supplierProvider: intent?.supplierProvider ?? null,
    supplierProductId: intent?.supplierProductId ?? null,
    supplierAvailability: intent?.supplierAvailability ?? null,
    supplierAvailabilitySource: intent?.supplierAvailabilitySource ?? null,
    supplierCheckedAt: intent?.supplierAvailabilityCheckedAt ?? null,
    productState: safety.state,
    costRecorded,
    safetyIncident: safety.incident,
    ...auditDefaults(input),
  });

  if (safety.incident !== null) {
    throw new AppError('RESEARCH_PUSH_SAFETY', safety.incident, {
      details: {
        candidateId,
        shopifyProductId: found.shopifyProductId,
        productState: safety.state,
      },
    });
  }

  return {
    candidate: await ports.candidates.load(candidateId),
    outcome: 'RECONCILED',
    shopifyProductId: found.shopifyProductId,
    productState: safety.state,
    duplicates: { matches: [], blocking: [], summary: null },
    // The recovered price, so the UI shows what the draft was actually listed at rather
    // than null. Null only when the intent genuinely could not be found.
    listedPrice:
      intent === null
        ? null
        : {
            amount: intent.listedPrice,
            currencyCode: intent.sellingCurrency,
            source: 'Recovered from the original push intent',
          },
    costRecorded,
    safetyIncident: null,
    warnings: dedupe(warnings),
  };
}

/**
 * Builds the immutable push-intent snapshot from the validated decision.
 *
 * Everything here has already passed its gate: currency labelling, the decision-hash
 * match, the duplicate and guard checks. Freezing it now means recovery reads a decision
 * that was real, not a reconstruction.
 */
function buildPushIntent(
  input: PushAsDraftInput,
  candidate: ProductCandidate,
  listedPrice: ResolvedListingPrice,
  prepared: PreparedAnalysis,
  now: Date,
): PushIntent {
  return {
    operationId: input.operationId,
    expectedDecisionHash: input.expectedDecisionHash ?? null,
    actualDecisionHash: prepared.decisionHash,
    scenario: input.scenario ?? null,
    listedPrice: listedPrice.amount,
    sellingCurrency: listedPrice.currencyCode,
    supplierCost: candidate.commercials.supplierCost,
    supplierCurrency: candidate.commercials.supplierCurrency,
    shippingCost: candidate.commercials.shippingCost,
    shippingCurrency: candidate.commercials.shippingCurrency,
    overallScore: candidate.overallScore,
    confidenceScore: candidate.confidenceScore,
    recommendation: candidate.recommendation,
    analyzedInputRevision: candidate.analyzedInputRevision,
    // Why Trademart believed this product was sourceable at create time. Frozen so
    // recovery reports the real basis rather than recomputing a later verdict.
    supplierProvider: prepared.sourceability.provider,
    supplierProductId: prepared.sourceability.supplierProductId,
    supplierAvailability: prepared.sourceability.availability,
    supplierAvailabilitySource: prepared.sourceability.availabilitySource,
    supplierAvailabilityCheckedAt: prepared.sourceability.checkedAt,
    supplierVariantSnapshot: prepared.sourceability.variants,
    createdAt: now.toISOString(),
  };
}

/**
 * Restores the supplier cost recorded in a push intent, against a reconciled product.
 *
 * No currency fallback and no invention: an intent whose supplier cost has no currency, or
 * a product with no readable variant, is reported rather than guessed. upsertManualCost is
 * idempotent, so this is safe to run whether or not the crashed attempt got as far as
 * saving the cost.
 */
async function recordCostFromIntent(
  ports: PushPorts,
  candidateId: string,
  intent: PushIntent,
  shopifyProductId: string,
  shopifyVariantId: string | null,
  warnings: string[],
): Promise<boolean> {
  if (intent.supplierCost === null) {
    warnings.push(
      'The original push recorded no supplier cost, so the reconciled draft has none either. Its margin will show as unknown until you enter one.',
    );
    return false;
  }
  if (intent.supplierCurrency === null) {
    warnings.push(
      'The original supplier cost had no currency recorded, so it was NOT restored. An unlabelled amount cannot be used in a margin calculation.',
    );
    return false;
  }
  if (shopifyVariantId === null) {
    warnings.push(
      'The reconciled product exposes no variant id, so the original supplier cost could not be attached. Enter it against the variant in Trademart.',
    );
    return false;
  }

  try {
    await ports.costs.record({
      shopifyProductId,
      shopifyVariantId,
      supplierProductCost: intent.supplierCost,
      supplierShippingCost: intent.shippingCost,
      currencyCode: intent.supplierCurrency,
      provider: 'OTHER',
      note: `Restored from the original push intent for research candidate ${candidateId} during reconciliation.`,
    });
    return true;
  } catch {
    warnings.push(
      'The product was reconciled but its original supplier cost could not be saved. Enter it in Trademart, or the margin will show as unknown.',
    );
    return false;
  }
}

/* ===========================================================================
 * The draft-only postcondition
 * ======================================================================== */

/**
 * Verifies the product is hidden, and repairs it if not.
 *
 * The old code logged a warning if Shopify reported the product published or visible and
 * then returned an ordinary success. That reduced the module's single most important
 * invariant to a log line nobody reads.
 *
 * The repair uses the EXISTING hide primitives - set status DRAFT and remove sales-channel
 * publications - and deliberately adds no capability that could publish. An emergency
 * unpublish is not a publish capability, and the direction of the operation is what makes
 * that true rather than a naming convention.
 */
async function enforceHidden(
  ports: PushPorts,
  shopifyProductId: string,
  observed: ShopifyProductState,
  warnings: string[],
): Promise<{ state: ShopifyProductState; incident: string | null }> {
  if (!observed.published && !observed.visibleToCustomers) {
    return { state: observed, incident: null };
  }

  warnings.push(
    'Shopify reported this product as visible, which a research push must never produce. Trademart is forcing it back to a hidden draft.',
  );

  let repaired: ShopifyProductState;
  try {
    repaired = await ports.shopify.forceHidden(shopifyProductId);
  } catch (error) {
    // The repair itself failed. The product exists and may be visible, which is exactly
    // the state that must never be reported as a success.
    return {
      state: observed,
      incident: `Product ${shopifyProductId} was created and Shopify reported it visible to customers. Trademart tried to force it back to a hidden draft and the attempt FAILED (${
        error instanceof Error ? error.message : 'unknown error'
      }). Open it in Shopify and unpublish it now.`,
    };
  }

  if (repaired.published || repaired.visibleToCustomers) {
    return {
      state: repaired,
      incident: `Product ${shopifyProductId} was created and is STILL reported visible to customers after Trademart tried to hide it. Open it in Shopify and unpublish it now.`,
    };
  }

  warnings.push(
    `Product ${shopifyProductId} was verified hidden after the correction. Check it in Shopify if this recurs, because a research push should never have produced a visible product.`,
  );
  return { state: repaired, incident: null };
}

/* ===========================================================================
 * Helpers
 * ======================================================================== */

/**
 * Turns a refusal reason into the right error code.
 *
 * The distinction matters to the client: ALREADY_PUSHED is permanent and the UI should
 * stop offering Push, whereas IN_PROGRESS resolves on its own and the UI should wait.
 */
/**
 * Whether an IN_PROGRESS claim may be taken to the atomic claim rather than refused now.
 *
 * True in exactly two cases, both of which the atomic claim can legitimately grant: this
 * operation already owns the claim (a retry of the same logical push), or the lease has
 * expired (the previous owner died). A product id being present means a product already
 * exists, so it is never recoverable here - that is a reconcile, decided after the claim.
 */
function claimIsOwnedOrExpired(
  candidate: ProductCandidate,
  operationId: string,
  now: Date,
): boolean {
  if (candidate.pushState !== 'IN_PROGRESS') return false;
  if (candidate.pushedShopifyProductId !== null) return false;
  if (candidate.pushOperationId === operationId) return true;
  return claimIsRecoverable(candidate, now, PUSH_CLAIM_LEASE_MS);
}

function refusal(candidate: ProductCandidate, reason: string | null): AppError {
  const message = reason ?? 'This candidate cannot be pushed.';
  const details = {
    candidateId: candidate.id,
    status: candidate.status,
    pushState: candidate.pushState,
    shopifyProductId: candidate.pushedShopifyProductId,
  };

  if (candidate.pushedShopifyProductId !== null || candidate.status === 'PUSHED_TO_SHOPIFY') {
    return new AppError('RESEARCH_ALREADY_PUSHED', message, { details });
  }
  if (candidate.pushState === 'IN_PROGRESS') {
    return new AppError('RESEARCH_PUSH_IN_PROGRESS', message, { details });
  }
  if (candidate.pushState === 'SAFETY_INCIDENT') {
    return new AppError('RESEARCH_PUSH_SAFETY', message, { details });
  }
  return new AppError('VALIDATION_ERROR', message, { details });
}

async function checkDuplicates(
  ports: PushPorts,
  candidate: ProductCandidate,
): Promise<DuplicateReport> {
  let products: ExistingProductRef[] = [];
  let catalogueRead = true;
  try {
    products = await ports.shopify.listCatalogue();
  } catch {
    // Advisory check. Refusing the whole push because the catalogue could not be read
    // would block legitimate work, but the reduced coverage is reported rather than
    // hidden. The EXACT identity lookup in step 4 is what actually prevents duplicates.
    catalogueRead = false;
  }

  const candidates: ExistingCandidateRef[] = await ports.candidates.listForDuplicates();

  const report = detectDuplicates({
    subject: {
      candidateId: candidate.id,
      title: candidate.title,
      keywords: candidate.keywords,
      sourceProductId: candidate.sourceProductId,
    },
    products,
    candidates,
  });

  if (catalogueRead) return report;

  return {
    ...report,
    summary: [
      report.summary,
      'The Shopify catalogue could not be read, so this check covered other research candidates only.',
    ]
      .filter((part): part is string => part !== null)
      .join(' '),
  };
}

/**
 * The commercial floors, evaluated against the price that will ACTUALLY be listed.
 *
 * An explicit custom price goes through the same guard as a scenario. Previously a
 * hand-typed price bypassed the floors entirely, which made the floors advisory for
 * exactly the case most likely to breach them.
 */
function guardBreachesFor(
  prepared: PreparedAnalysis,
  listedPrice: ResolvedListingPrice,
  candidate: ProductCandidate,
): string[] {
  const scenario = prepared.analysis.pricing.scenarios.find(
    (entry) => entry.price === listedPrice.amount,
  );
  // A scenario price is already evaluated by the pricing engine, so its verdict is reused
  // rather than recomputed - two implementations of the same check would eventually
  // disagree about whether a price is acceptable.
  if (scenario !== undefined) return scenario.guardBreaches;

  const evaluation = prepared.evaluatePrice?.(listedPrice.amount);
  if (evaluation === undefined || evaluation === null) return [];

  return pricingGuardBreaches(
    evaluation,
    prepared.policy.minimumMarginPercentage,
    prepared.policy.minimumProfitAmount,
  );
}

async function recordCost(
  ports: PushPorts,
  candidate: ProductCandidate,
  shopifyProductId: string,
  variants: readonly { shopifyVariantId: string }[],
  warnings: string[],
): Promise<boolean> {
  const cost = candidate.commercials.supplierCost;
  if (cost === null) {
    warnings.push(
      'No supplier cost was recorded on this candidate, so the new draft has no cost either. Its margin will show as unknown until you enter one.',
    );
    return false;
  }

  const variant = variants[0];
  if (variant === undefined) {
    warnings.push(
      'The draft was created but no variant id came back, so the supplier cost could not be attached. Enter it against the variant in Trademart.',
    );
    return false;
  }

  /*
   * NO FALLBACK. This used to be:
   *
   *     candidate.commercials.supplierCurrency ?? fallbackCurrency
   *
   * where fallbackCurrency came from the LISTING price. That silently relabelled an
   * unlabelled supplier cost as the selling currency - a 10 USD cost stored as 10 INR,
   * reporting a margin of about 99% that looked entirely normal.
   *
   * It cannot happen now for two reasons: the push refuses an unlabelled amount in step 2,
   * and there is no fallback here to reach for even if it somehow got this far.
   */
  const currencyCode = candidate.commercials.supplierCurrency;
  if (currencyCode === null) {
    warnings.push(
      'The supplier cost has no currency recorded, so it was NOT saved against the draft. An unlabelled amount cannot be used in a margin calculation, and Trademart will not assume it matches the selling price.',
    );
    return false;
  }

  try {
    await ports.costs.record({
      shopifyProductId,
      shopifyVariantId: variant.shopifyVariantId,
      supplierProductCost: cost,
      supplierShippingCost: candidate.commercials.shippingCost,
      currencyCode,
      // Researched on a supplier Trademart can identify: record the cost against it,
      // so the pricing and dropshipping views attribute it to the right supplier.
      provider:
        candidate.source === 'TRADELLE' || candidate.source === 'DEODAP'
          ? candidate.source
          : 'OTHER',
      note: `Recorded from Trademart research candidate ${candidate.id} on push.`,
    });
    return true;
  } catch {
    // Best effort: a draft with a missing cost beats a deleted draft. But it IS reported,
    // because the margin will show as unknown until somebody enters it.
    warnings.push(
      'The draft was created but its supplier cost could not be saved. Enter it in Trademart, or the margin will show as unknown.',
    );
    return false;
  }
}

function auditDefaults(input: PushAsDraftInput): Pick<
  PushAuditFacts,
  | 'selectedScenario'
  | 'duplicateOverridden'
  | 'guardBreachOverridden'
  | 'partialVariantsOverridden'
> {
  return {
    selectedScenario: input.scenario ?? null,
    duplicateOverridden: input.allowDuplicate === true,
    guardBreachOverridden: input.acknowledgeGuardBreach === true,
    partialVariantsOverridden: input.acknowledgePartialVariants === true,
  };
}

/** The supplier facts for the audit trail, from a sourceability verdict. */
function supplierAuditFacts(
  sourceability: SourceabilityResult,
): Pick<
  PushAuditFacts,
  | 'supplierProvider'
  | 'supplierProductId'
  | 'supplierAvailability'
  | 'supplierAvailabilitySource'
  | 'supplierCheckedAt'
  | 'supplierFreshness'
  | 'supplierVariantCoverage'
> {
  return {
    supplierProvider: sourceability.provider,
    supplierProductId: sourceability.supplierProductId,
    supplierAvailability: sourceability.availability,
    supplierAvailabilitySource: sourceability.availabilitySource,
    supplierCheckedAt: sourceability.checkedAt,
    supplierFreshness: sourceability.freshness,
    supplierVariantCoverage: sourceability.variantCoverage,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

export { researchIdentityTag };
