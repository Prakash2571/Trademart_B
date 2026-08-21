/**
 * Push as Draft: a candidate becomes a Shopify DRAFT product.
 *
 * IT NEVER PUBLISHES. NOT EVEN OPTIONALLY.
 * ---------------------------------------
 * There is no `publish` parameter on this module's surface, and there is no
 * [Auto Publish] anywhere behind it. createProduct() is always called with
 * status DRAFT and publish false, and that is asserted rather than merely intended -
 * see assertDraftOnly(). A research module that could publish would let a scored
 * guess reach customers without a human ever looking at the listing.
 *
 * Publishing remains a separate, deliberate action through the existing
 * publications module, performed by an operator who has read the draft.
 *
 * IT REUSES THE EXISTING CREATE PATH
 * ----------------------------------
 * products.create.service.createProduct() is called unchanged. That function already
 * knows how to build a product, attach media, create variants, and - importantly - how
 * to leave a safe DRAFT behind when variant creation fails rather than orphaning a
 * half-built product. Re-implementing product creation here would mean two code paths
 * writing products to Shopify, which is exactly what the brief forbids and exactly how
 * one of them ends up missing a safety check the other has.
 *
 * IT CLOSES THE COST LOOP
 * -----------------------
 * The candidate's hand-entered supplier cost is written to the created variant through
 * upsertManualCost(), so the moment the draft exists the order view, the margin
 * calculation and the automation engine all see the same cost the research decision was
 * made on. Without this the operator would have to type the cost in twice, and the two
 * copies would diverge.
 */

import { AppError } from '../common/errors';
import { logger } from '../common/logger';
import { recordAudit } from '../audit/audit.service';
import { config } from '../config';
import { getDatabaseStatus } from '../database/mongo';
import { ProductCandidateModel } from '../database/models/ProductCandidate';
import type { PricingScenarioName } from '../pricing/recommendation';
import { createProduct, type ProductCreateResult } from '../products/products.create.service';
import { listProducts } from '../shopify/shopify.service';
import { upsertManualCost } from '../suppliers/manualCost.service';
import { canPush, type ProductCandidate } from './candidate.types';
import {
  detectDuplicates,
  type DuplicateReport,
  type ExistingCandidateRef,
  type ExistingProductRef,
} from './duplicate.detection';
import { analyzeCandidate, getCandidate, listCandidates } from './intelligence.service';
import {
  assertDraftOnly,
  buildDraftRequest,
  resolveListingPrice,
  type ResolvedListingPrice,
} from './push.draft';

/** Shopify's hard page limit. One page: duplicate detection is advisory, not exhaustive. */
const CATALOGUE_PAGE_SIZE = 250;

/* ===========================================================================
 * Duplicate check
 * ======================================================================== */

/**
 * Checks a candidate for duplicates without pushing anything.
 *
 * Exposed separately so the UI can warn BEFORE the operator clicks push. A duplicate
 * warning that only appears after the product exists is useless.
 */
export async function checkForDuplicates(candidateId: string): Promise<DuplicateReport> {
  const candidate = await getCandidate(candidateId);
  return duplicateReportFor(candidate);
}

async function duplicateReportFor(candidate: ProductCandidate): Promise<DuplicateReport> {
  let products: ExistingProductRef[] = [];

  try {
    const page = await listProducts({ first: CATALOGUE_PAGE_SIZE });
    products = page.items.map((product) => ({
      shopifyProductId: product.shopifyProductId,
      title: product.title,
      status: product.status,
      tags: product.tags,
    }));
  } catch (error) {
    // Degrades to candidate-only checking. Refusing the whole push because the catalogue
    // could not be read would block legitimate work over an advisory check - but the
    // reduced coverage is reported, not hidden.
    logger.warn('Could not read the Shopify catalogue for duplicate detection.', {
      reason: error instanceof Error ? error.message : 'unknown',
    });
  }

  const others: ExistingCandidateRef[] = (await listCandidates({ limit: 200 })).map(
    (other) => ({
      candidateId: other.id,
      title: other.title,
      status: other.status,
      sourceProductId: other.sourceProductId,
      pushedShopifyProductId: other.pushedShopifyProductId,
    }),
  );

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

  if (products.length === 0) {
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

  return report;
}

/* ===========================================================================
 * Push
 * ======================================================================== */

export interface PushAsDraftInput {
  /** Which price scenario to list at. Defaults to the recommended one. */
  scenario?: PricingScenarioName;
  /** An explicit price, overriding the scenario entirely. */
  price?: number;
  /**
   * Proceed despite an exact duplicate.
   *
   * Required to be explicit. The block exists to catch a mis-click, and a flag the
   * operator has to set is the difference between a considered decision and an accident.
   */
  allowDuplicate?: boolean;
  now?: Date;
}

export interface PushAsDraftResult {
  candidate: ProductCandidate;
  product: ProductCreateResult;
  duplicates: DuplicateReport;
  /** The price the draft was listed at, and where it came from. */
  listedPrice: ResolvedListingPrice;
  /** True when the candidate's supplier cost was recorded against the new variant. */
  costRecorded: boolean;
  warnings: string[];
}

/**
 * Creates a DRAFT Shopify product from a candidate.
 *
 * Refusals, in order, because each one is cheaper to hit than the next:
 *   1. no database          - the candidate could not be marked as pushed, so a retry
 *                            would create a second product
 *   2. not pushable         - already pushed, or rejected
 *   3. exact duplicate      - unless explicitly overridden
 *   4. no price             - a product with no price cannot be sold, and guessing one
 *                            is worse than refusing
 */
export async function pushCandidateAsDraft(
  candidateId: string,
  input: PushAsDraftInput = {},
): Promise<PushAsDraftResult> {
  if (getDatabaseStatus().status !== 'connected') {
    // Checked FIRST. Creating the product and then failing to record that it exists
    // would leave the candidate looking unpushed, and the next click would create a
    // second draft - the exact duplicate this module is built to prevent.
    throw new AppError(
      'DATABASE_UNAVAILABLE',
      'Pushing a candidate needs MongoDB, so the candidate can be marked as pushed. Without it a retry would create a second Shopify product.',
    );
  }

  const now = input.now ?? new Date();
  const candidate = await getCandidate(candidateId);

  const eligibility = canPush(candidate);
  if (!eligibility.allowed) {
    throw new AppError('VALIDATION_ERROR', eligibility.reason ?? 'This candidate cannot be pushed.');
  }

  // ---- duplicates ---------------------------------------------------------
  const duplicates = await duplicateReportFor(candidate);
  if (duplicates.blocking.length > 0 && input.allowDuplicate !== true) {
    throw new AppError(
      'VALIDATION_ERROR',
      `This candidate looks like a duplicate and has not been pushed. ${duplicates.blocking.map((match) => match.reason).join(' ')} Set allowDuplicate to proceed anyway.`,
      { details: { duplicates: duplicates.blocking } },
    );
  }

  // ---- price --------------------------------------------------------------
  //
  // Re-analysed rather than read from the stored score, because the stored price was
  // computed against whatever the settings and costs were at the time. Listing at a
  // stale price is how a product goes live below the current margin floor.
  const analysis = await analyzeCandidate(candidateId, { now });
  const listedPrice = resolveListingPrice(candidate, analysis.pricing, {
    ...(input.scenario === undefined ? {} : { scenario: input.scenario }),
    ...(input.price === undefined ? {} : { price: input.price }),
  });

  const warnings: string[] = [...analysis.warnings];

  const scenario = analysis.pricing.scenarios.find(
    (entry) => entry.name === (input.scenario ?? analysis.pricing.recommended),
  );
  if (scenario !== undefined && !scenario.viable) {
    // Not a refusal: the operator may have a reason. But it must be recorded, and it
    // must appear in the audit trail alongside the push.
    warnings.push(
      `Listed at a price that breaches your own floors: it ${scenario.guardBreaches.join(' and it ')}. The draft was created because you asked for it, but it is not profitable on your current settings.`,
    );
  }

  // ---- create -------------------------------------------------------------
  const request = buildDraftRequest(candidate, listedPrice.amount);
  assertDraftOnly(request);

  let product: ProductCreateResult;
  try {
    product = await createProduct(request);
  } catch (error) {
    await recordAudit({
      action: 'RESEARCH_PUSH_DRAFT',
      resourceType: 'RESEARCH_CANDIDATE',
      resourceId: candidateId,
      error,
      metadata: { title: candidate.title, listedPrice: listedPrice.amount },
    });
    throw error;
  }

  // A second, independent check on the way OUT. The create service can leave a product
  // DRAFT for its own reasons, and a future change to it must not be able to publish
  // something research pushed.
  if (product.published || product.visibleToCustomers) {
    logger.error('A research push resulted in a visible product. This should be impossible.', {
      shopifyProductId: product.shopifyProductId,
    });
    warnings.push(
      'This product appears to be visible to customers, which a research push must never produce. Check it in Shopify and unpublish it if so.',
    );
  }

  warnings.push(...product.warnings);

  // ---- record the cost against the real variant ---------------------------
  const costRecorded = await recordSupplierCost(
    candidate,
    product,
    listedPrice.currencyCode,
    warnings,
  );

  // ---- mark the candidate -------------------------------------------------
  await ProductCandidateModel.updateOne(
    { shopDomain: config.shopify.storeDomain, candidateId },
    {
      $set: {
        status: 'PUSHED_TO_SHOPIFY',
        pushedShopifyProductId: product.shopifyProductId,
        pushedAt: now.toISOString(),
      },
    },
  );

  await recordAudit({
    action: 'RESEARCH_PUSH_DRAFT',
    resourceType: 'RESEARCH_CANDIDATE',
    resourceId: candidateId,
    after: {
      shopifyProductId: product.shopifyProductId,
      // Recorded explicitly so the trail proves what was created, rather than leaving it
      // to be inferred from the absence of a publish entry.
      status: product.status,
      published: product.published,
      visibleToCustomers: product.visibleToCustomers,
      listedPrice: listedPrice.amount,
      priceSource: listedPrice.source,
      costRecorded,
    },
    result: product.partialSuccess || warnings.length > 0 ? 'PARTIAL' : 'SUCCESS',
    metadata: {
      title: candidate.title,
      overallScore: candidate.overallScore,
      confidenceScore: candidate.confidenceScore,
      recommendation: candidate.recommendation,
      duplicatesFound: duplicates.matches.length,
      duplicateOverridden: duplicates.blocking.length > 0 && input.allowDuplicate === true,
    },
  });

  return {
    candidate: await getCandidate(candidateId),
    product,
    duplicates,
    listedPrice,
    costRecorded,
    warnings: dedupe(warnings),
  };
}

/* ===========================================================================
 * Cost
 * ======================================================================== */

/**
 * Writes the candidate's supplier cost against the created variant.
 *
 * Best-effort: a failure here does not undo the product, because the draft is still
 * useful and deleting it would be a worse outcome than a missing cost. But it IS
 * reported, because a draft with no recorded cost will show an unknown margin in the
 * order view - and the operator needs to know to enter it.
 */
async function recordSupplierCost(
  candidate: ProductCandidate,
  product: ProductCreateResult,
  fallbackCurrency: string | null,
  warnings: string[],
): Promise<boolean> {
  const cost = candidate.commercials.supplierCost;
  if (cost === null) {
    warnings.push(
      'No supplier cost was recorded on this candidate, so the new draft has no cost either. Its margin will show as unknown until you enter one.',
    );
    return false;
  }

  const variant = product.variants[0];
  if (variant === undefined) {
    warnings.push(
      'The draft was created but no variant id came back, so the supplier cost could not be attached. Enter it against the variant in Trademart.',
    );
    return false;
  }

  // A stored cost MUST carry a currency: an amount with no currency is the input that
  // makes a later margin calculation meaningless, and CURRENCY_MISMATCH detection relies
  // on every amount being labelled. Falls back to the price's currency, then refuses.
  const currencyCode = candidate.commercials.supplierCurrency ?? fallbackCurrency;
  if (currencyCode === null) {
    warnings.push(
      'The supplier cost has no currency recorded, so it was NOT saved against the draft - an unlabelled amount cannot be used in a margin calculation. Set the cost currency on the candidate and enter it against the variant.',
    );
    return false;
  }

  try {
    await upsertManualCost({
      shopifyProductId: product.shopifyProductId,
      shopifyVariantId: variant.shopifyVariantId,
      provider: candidate.source === 'TRADELLE' ? 'TRADELLE' : 'OTHER',
      supplierProductCost: cost,
      supplierShippingCost: candidate.commercials.shippingCost,
      currencyCode,
      // Marked as an override so it wins over Shopify's empty cost-per-item field, which
      // is what a brand-new product has.
      override: true,
      note: `Recorded from Trademart research candidate ${candidate.id} on push.`,
    });
    return true;
  } catch (error) {
    logger.warn('Could not record the supplier cost for a pushed candidate.', {
      shopifyProductId: product.shopifyProductId,
      reason: error instanceof Error ? error.message : 'unknown',
    });
    warnings.push(
      'The draft was created but its supplier cost could not be saved. Enter it in Trademart, or the margin will show as unknown.',
    );
    return false;
  }
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
