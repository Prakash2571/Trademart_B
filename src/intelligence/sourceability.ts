/**
 * Whether a candidate can actually be SOURCED, kept strictly apart from whether it is a
 * good market opportunity.
 *
 * THE INVARIANT THIS MODULE EXISTS FOR
 * ------------------------------------
 * A product is not sellable merely because the market looks good. It must also be
 * obtainable from a real supplier. So Trademart answers two different questions and never
 * collapses them:
 *
 *   opportunityScore   does this look like a good product to sell?
 *   sourceability      can this store actually source and fulfil it?
 *
 * The opportunity score is untouched by anything here. Sourceability is a separate,
 * deterministic assessment that acts as an ELIGIBILITY GATE on the final recommendation:
 * no amount of demand overrides a confirmed inability to source, and an UNKNOWN supplier
 * caps a strong opportunity at WATCH rather than letting it read STRONG_CANDIDATE.
 *
 * AVAILABILITY IS NOT PROFITABILITY, AND NOT FULFILLMENT QUALITY
 * -------------------------------------------------------------
 * Three separate facts, deliberately never conflated:
 *   - availability: can the supplier provide it at all?
 *   - cost: what does it cost? (may be UNKNOWN even when AVAILABLE)
 *   - fulfillment quality: does the supplier deliver it WELL? (a scoring factor)
 * A product can be AVAILABLE with an UNKNOWN cost (sourceable, profitability unknown), and
 * a supplier that delivers badly is still AVAILABLE. Cost being known never implies
 * availability, and availability never implies a known cost.
 *
 * Pure: no config singleton, no database, no clock read internally. `now` is a parameter.
 */

import { resolveFreshness, type Freshness } from '../common/dataQuality';
import type { Recommendation } from './candidate.types';

/* ===========================================================================
 * The recorded supplier verification
 * ======================================================================== */

export type SupplierAvailability = 'AVAILABLE' | 'UNAVAILABLE' | 'UNKNOWN';

/**
 * How the availability was established.
 *
 *   SHOPIFY_BRIDGE  inferred from the evidence on a Shopify product the supplier's own
 *                   app imported (Tradelle's or DeoDap's)
 *   MANUAL          an operator verified it inside Tradelle or DeoDap and recorded it
 *   DIRECT_API      a documented supplier API said so. NOT AVAILABLE today - neither
 *                   supplier has one, and nothing may set this until one is configured.
 */
export type SupplierAvailabilitySource = 'SHOPIFY_BRIDGE' | 'MANUAL' | 'DIRECT_API';

/** Mirrors SupplierClassification in suppliers/supplier.types.ts. */
export type SupplierProvider = 'TRADELLE' | 'DEODAP' | 'OTHER' | 'UNKNOWN';

export type VariantCoverage = 'FULL' | 'PARTIAL' | 'NONE' | 'UNKNOWN';

/** One supplier-side variant's availability. */
export interface SupplierVariantAvailability {
  supplierVariantId: string | null;
  sku: string | null;
  title: string;
  optionValues: Record<string, string>;
  availability: SupplierAvailability;
  /** True only when the supplier actually reports stock. Distinct from AVAILABLE. */
  stockKnown: boolean;
  cost: number | null;
  currencyCode: string | null;
  checkedAt: string | null;
}

/** A single piece of evidence for the supplier classification (e.g. a Shopify vendor). */
export interface SupplierEvidence {
  source: string;
  value: string;
}

/**
 * The supplier verification stored on a candidate.
 *
 * This is EVIDENCE, recorded by an operator (MANUAL) or inferred from Shopify
 * (SHOPIFY_BRIDGE). It is never fetched live - there is no Tradelle API - so `checkedAt`
 * means a genuine verification actually happened at that time, and is the anchor freshness
 * ages from.
 */
export interface SupplierInfo {
  provider: SupplierProvider;
  supplierProductId: string | null;
  sourceUrl: string | null;
  availability: SupplierAvailability;
  availabilitySource: SupplierAvailabilitySource;
  /** When a genuine verification happened. NEVER bumped by merely opening a page. */
  checkedAt: string | null;
  /** When the operator observed the figures, if different from checkedAt. */
  observedAt: string | null;
  note: string | null;
  stockKnown: boolean;
  productAvailable: boolean | null;
  productCost: number | null;
  productCurrency: string | null;
  shippingCost: number | null;
  shippingCurrency: string | null;
  shippingDays: number | null;
  variants: SupplierVariantAvailability[];
  /** Machine-readable provenance, e.g. [{source:'SHOPIFY_VENDOR', value:'Tradelle'}]. */
  evidence: SupplierEvidence[];
}

/** A candidate that has never had supplier verification recorded. */
export const EMPTY_SUPPLIER_INFO: Readonly<SupplierInfo> = Object.freeze({
  provider: 'UNKNOWN',
  supplierProductId: null,
  sourceUrl: null,
  availability: 'UNKNOWN',
  availabilitySource: 'MANUAL',
  checkedAt: null,
  observedAt: null,
  note: null,
  stockKnown: false,
  productAvailable: null,
  productCost: null,
  productCurrency: null,
  shippingCost: null,
  shippingCurrency: null,
  shippingDays: null,
  variants: Object.freeze([]) as unknown as SupplierVariantAvailability[],
  evidence: Object.freeze([]) as unknown as SupplierEvidence[],
});

/* ===========================================================================
 * Config
 * ======================================================================== */

export interface SourceabilityConfig {
  /**
   * How long a manual availability check stays FRESH. After this it AGES; after twice
   * this it is STALE and a push is refused until re-verification.
   *
   * A default, not a fact - the number an operator should argue about if it nags.
   */
  manualAvailabilityFreshHours: number;
}

export const DEFAULT_SOURCEABILITY_CONFIG: Readonly<SourceabilityConfig> = Object.freeze({
  manualAvailabilityFreshHours: 72,
});

/* ===========================================================================
 * Reasons
 * ======================================================================== */

export type SourceabilityReason =
  | 'SUPPLIER_AVAILABLE'
  | 'SUPPLIER_UNAVAILABLE'
  | 'SUPPLIER_AVAILABILITY_UNKNOWN'
  | 'SUPPLIER_AVAILABILITY_STALE'
  | 'SUPPLIER_VARIANTS_FULLY_AVAILABLE'
  | 'SUPPLIER_VARIANTS_PARTIALLY_AVAILABLE'
  | 'SUPPLIER_VARIANTS_UNAVAILABLE'
  | 'SUPPLIER_VARIANT_AVAILABILITY_UNKNOWN'
  | 'SUPPLIER_COST_UNKNOWN'
  | 'SUPPLIER_SHIPPING_UNKNOWN'
  | 'SUPPLIER_CHECK_REQUIRED';

/**
 * The current, freshness-aware sourceability verdict.
 *
 *   SOURCEABLE            AVAILABLE, fresh, and variants are fine
 *   PARTIALLY_SOURCEABLE  AVAILABLE but some variants are unavailable/unknown
 *   NEEDS_RECHECK         was AVAILABLE, but the check is now STALE
 *   NOT_SOURCEABLE        the supplier said UNAVAILABLE
 *   UNVERIFIED            nobody has established availability yet (UNKNOWN)
 */
export type CurrentSourceability =
  | 'SOURCEABLE'
  | 'PARTIALLY_SOURCEABLE'
  | 'NEEDS_RECHECK'
  | 'NOT_SOURCEABLE'
  | 'UNVERIFIED';

/** Why a push is refused on sourceability grounds. Null when a push may proceed. */
export type SourceabilityBlock =
  | 'SUPPLIER_UNAVAILABLE'
  | 'SUPPLIER_AVAILABILITY_UNKNOWN'
  | 'SUPPLIER_AVAILABILITY_STALE'
  | null;

export interface SourceabilityResult {
  provider: SupplierProvider;
  /** Historically recorded availability. AVAILABLE here does NOT mean current - read `current`. */
  availability: SupplierAvailability;
  availabilitySource: SupplierAvailabilitySource;
  checkedAt: string | null;
  /** Freshness of the check itself. */
  freshness: Freshness;
  /** The freshness-aware verdict. This is what the gate and the UI act on. */
  current: CurrentSourceability;
  variantCoverage: VariantCoverage;
  stockKnown: boolean;
  supplierProductId: string | null;
  sourceUrl: string | null;
  productCost: number | null;
  productCurrency: string | null;
  shippingCost: number | null;
  shippingCurrency: string | null;
  shippingDays: number | null;
  variants: SupplierVariantAvailability[];
  reasons: SourceabilityReason[];
  /** True when a push is allowed on sourceability grounds alone. */
  pushEligible: boolean;
  /** Set when pushEligible is false. */
  block: SourceabilityBlock;
  /** How much sourceability uncertainty should reduce confidence. 0 when clean. */
  confidencePenalty: number;
}

/* ===========================================================================
 * Variant coverage
 * ======================================================================== */

export function variantCoverageOf(
  variants: readonly SupplierVariantAvailability[],
): VariantCoverage {
  if (variants.length === 0) return 'UNKNOWN';
  const anyUnknown = variants.some((v) => v.availability === 'UNKNOWN');
  const available = variants.filter((v) => v.availability === 'AVAILABLE');
  const unavailable = variants.filter((v) => v.availability === 'UNAVAILABLE');

  if (available.length === variants.length) return 'FULL';
  if (available.length === 0 && !anyUnknown && unavailable.length > 0) return 'NONE';
  // A mix, or any unknowns alongside some availables: neither fully covered nor fully out.
  return 'PARTIAL';
}

/* ===========================================================================
 * Compute
 * ======================================================================== */

/**
 * The confidence penalties, as a table so they are visible and testable.
 *
 * Deliberately blunt. Sourceability uncertainty is a real reason to trust a recommendation
 * less, and these say how much. UNAVAILABLE carries no penalty because the recommendation
 * is rejected outright - penalising confidence on top would be double-counting.
 */
const CONFIDENCE_PENALTY = Object.freeze({
  unknown: 25,
  stale: 25,
  agingManual: 5,
  variantPartialOrUnknown: 10,
});

/**
 * Turns a stored supplier verification into the current, freshness-aware verdict.
 *
 * Pure and deterministic given `now`. Never mutates checkedAt - freshness is derived, so
 * "someone checked six months ago" can never read as current.
 */
export function computeSourceability(
  supplier: SupplierInfo | null,
  now: Date,
  config: SourceabilityConfig = DEFAULT_SOURCEABILITY_CONFIG,
): SourceabilityResult {
  const info = supplier ?? EMPTY_SUPPLIER_INFO;
  const reasons: SourceabilityReason[] = [];

  const variantCoverage = variantCoverageOf(info.variants);

  // Freshness of the availability check, using the configurable threshold.
  const { freshness } = resolveFreshness(info.checkedAt, now, {
    freshWithinHours: config.manualAvailabilityFreshHours,
    agingWithinHours: config.manualAvailabilityFreshHours * 2,
  });

  // Cost / shipping notes are independent of availability - a product can be AVAILABLE
  // with an unknown cost (sourceable, profitability unknown).
  if (info.productCost === null) reasons.push('SUPPLIER_COST_UNKNOWN');
  if (info.shippingCost === null) reasons.push('SUPPLIER_SHIPPING_UNKNOWN');

  // Variant reasons.
  if (info.variants.length > 0) {
    if (variantCoverage === 'FULL') reasons.push('SUPPLIER_VARIANTS_FULLY_AVAILABLE');
    else if (variantCoverage === 'NONE') reasons.push('SUPPLIER_VARIANTS_UNAVAILABLE');
    else {
      reasons.push('SUPPLIER_VARIANTS_PARTIALLY_AVAILABLE');
      if (info.variants.some((v) => v.availability === 'UNKNOWN')) {
        reasons.push('SUPPLIER_VARIANT_AVAILABILITY_UNKNOWN');
      }
    }
  }

  let current: CurrentSourceability;
  let pushEligible: boolean;
  let block: SourceabilityBlock;
  let confidencePenalty = 0;

  if (info.availability === 'UNAVAILABLE') {
    reasons.unshift('SUPPLIER_UNAVAILABLE');
    current = 'NOT_SOURCEABLE';
    pushEligible = false;
    block = 'SUPPLIER_UNAVAILABLE';
  } else if (info.availability === 'UNKNOWN') {
    reasons.unshift('SUPPLIER_AVAILABILITY_UNKNOWN', 'SUPPLIER_CHECK_REQUIRED');
    current = 'UNVERIFIED';
    pushEligible = false;
    block = 'SUPPLIER_AVAILABILITY_UNKNOWN';
    confidencePenalty += CONFIDENCE_PENALTY.unknown;
  } else {
    // Recorded AVAILABLE. Freshness now decides whether it is CURRENTLY sourceable.
    if (freshness === 'STALE') {
      reasons.unshift('SUPPLIER_AVAILABILITY_STALE', 'SUPPLIER_CHECK_REQUIRED');
      current = 'NEEDS_RECHECK';
      pushEligible = false;
      block = 'SUPPLIER_AVAILABILITY_STALE';
      confidencePenalty += CONFIDENCE_PENALTY.stale;
    } else {
      reasons.unshift('SUPPLIER_AVAILABLE');
      // Variants can downgrade an otherwise-available product to partial.
      if (variantCoverage === 'NONE') {
        current = 'NOT_SOURCEABLE';
        pushEligible = false;
        block = 'SUPPLIER_UNAVAILABLE';
      } else if (variantCoverage === 'PARTIAL') {
        current = 'PARTIALLY_SOURCEABLE';
        // A push is still possible, but only for the available variants - the orchestrator
        // resolves that. Not blocked here.
        pushEligible = true;
        block = null;
        confidencePenalty += CONFIDENCE_PENALTY.variantPartialOrUnknown;
      } else {
        current = 'SOURCEABLE';
        pushEligible = true;
        block = null;
      }
      // A fresh-but-aging MANUAL check is real but worth a small confidence dent.
      if (freshness === 'AGING' && info.availabilitySource === 'MANUAL') {
        confidencePenalty += CONFIDENCE_PENALTY.agingManual;
      }
    }
  }

  return {
    provider: info.provider,
    availability: info.availability,
    availabilitySource: info.availabilitySource,
    checkedAt: info.checkedAt,
    freshness,
    current,
    variantCoverage,
    stockKnown: info.stockKnown,
    supplierProductId: info.supplierProductId,
    sourceUrl: info.sourceUrl,
    productCost: info.productCost,
    productCurrency: info.productCurrency,
    shippingCost: info.shippingCost,
    shippingCurrency: info.shippingCurrency,
    shippingDays: info.shippingDays,
    variants: info.variants,
    reasons: dedupeReasons(reasons),
    pushEligible,
    block,
    confidencePenalty,
  };
}

/* ===========================================================================
 * The gate on the final recommendation
 * ======================================================================== */

const RECOMMENDATION_RANK: Readonly<Record<Recommendation, number>> = Object.freeze({
  STRONG_CANDIDATE: 4,
  GOOD_CANDIDATE: 3,
  WATCH: 2,
  WEAK: 1,
  REJECT: 0,
});

/** The lower (more cautious) of two recommendations. */
function capAt(rec: Recommendation, cap: Recommendation): Recommendation {
  return RECOMMENDATION_RANK[rec] <= RECOMMENDATION_RANK[cap] ? rec : cap;
}

export interface FinalRecommendation {
  /** The recommendation after the sourceability gate. */
  recommendation: Recommendation | null;
  /** The opportunity recommendation before the gate, for explainability. */
  opportunityRecommendation: Recommendation | null;
  /** Confidence after any sourceability penalty. */
  confidenceScore: number;
  /** Machine reason the gate changed (or upheld) the recommendation. */
  reason: string | null;
  /** Whether sourceability changed the recommendation. */
  gated: boolean;
}

/**
 * Applies the sourceability gate to an opportunity recommendation.
 *
 * The opportunity score is NEVER overwritten - only the recommendation and the confidence
 * are adjusted, and both adjustments are explained. This is deliberately more honest than
 * folding a fake "supplier score" of 0 into the weighted average, which would hide the
 * actual reason behind a lower number.
 */
export function applySourceabilityGate(
  opportunity: {
    recommendation: Recommendation | null;
    confidenceScore: number;
  },
  sourceability: SourceabilityResult,
): FinalRecommendation {
  const opportunityRecommendation = opportunity.recommendation;
  const confidenceScore = Math.max(
    0,
    Math.min(100, Math.round(opportunity.confidenceScore - sourceability.confidencePenalty)),
  );

  const base: Omit<FinalRecommendation, 'recommendation' | 'reason' | 'gated'> = {
    opportunityRecommendation,
    confidenceScore,
  };

  // Nothing to gate if there is no opportunity verdict at all.
  if (opportunityRecommendation === null) {
    return { ...base, recommendation: null, reason: null, gated: false };
  }

  switch (sourceability.current) {
    case 'NOT_SOURCEABLE':
      return {
        ...base,
        recommendation: 'REJECT',
        reason:
          sourceability.block === 'SUPPLIER_UNAVAILABLE' &&
          sourceability.variantCoverage === 'NONE'
            ? 'Rejected: the supplier offers this product but none of its variants are available.'
            : 'Rejected: the supplier has this product marked as unavailable. No market opportunity overrides an inability to source it.',
        gated: true,
      };

    case 'UNVERIFIED': {
      const capped = capAt(opportunityRecommendation, 'WATCH');
      return {
        ...base,
        recommendation: capped,
        reason:
          capped === opportunityRecommendation
            ? null
            : 'Held at WATCH: strong market signals, but this product has not been verified as sourceable from the supplier. Verify availability before pushing.',
        gated: capped !== opportunityRecommendation,
      };
    }

    case 'NEEDS_RECHECK': {
      const capped = capAt(opportunityRecommendation, 'WATCH');
      return {
        ...base,
        recommendation: capped,
        reason:
          'Supplier availability was confirmed once but the check is now stale. Re-verify before pushing; held at WATCH until then.',
        gated: true,
      };
    }

    case 'PARTIALLY_SOURCEABLE':
      // Still recommendable - it can be pushed with the available variants - but the
      // partial coverage is called out and dents confidence (handled above).
      return {
        ...base,
        recommendation: opportunityRecommendation,
        reason:
          'Sourceable, but some variants are unavailable or unverified. The push will let you choose which variants to create.',
        gated: false,
      };

    case 'SOURCEABLE':
    default:
      return {
        ...base,
        recommendation: opportunityRecommendation,
        reason: null,
        gated: false,
      };
  }
}

/* ===========================================================================
 * Helpers
 * ======================================================================== */

function dedupeReasons(reasons: SourceabilityReason[]): SourceabilityReason[] {
  const seen = new Set<SourceabilityReason>();
  const out: SourceabilityReason[] = [];
  for (const reason of reasons) {
    if (seen.has(reason)) continue;
    seen.add(reason);
    out.push(reason);
  }
  return out;
}
