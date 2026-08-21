/**
 * Inputs and weights for deterministic candidate scoring.
 *
 * DETERMINISTIC, NOT LEARNED
 * --------------------------
 * Every score here is arithmetic over stated inputs with published thresholds. An
 * operator can reproduce any number by hand, which is the point: this module exists
 * to help someone spend money, and "the model says 87" is not a reason to.
 *
 * REGION ISOLATION
 * ----------------
 * Each signal carries the GEOGRAPHY it actually covers. A national search volume is
 * evidence about the country, not about Jharkhand, and a scorer must never present
 * it as regional. Signals are still USED when only national data exists - refusing
 * to score would be less useful than scoring with a stated caveat - but they lower
 * confidence and add an explicit risk rather than silently standing in for regional
 * evidence.
 *
 * NULL IS NOT ZERO
 * ----------------
 * Every signal is nullable and null means "no data". A factor with no data returns
 * value: null and is EXCLUDED from the weighted average. Scoring it zero would be a
 * statement that the product is bad at that factor, which is a different and
 * unfounded claim.
 *
 * Pure: no config, no database, no clock read internally.
 */

import type { DataConfidence } from '../../common/dataQuality';
import type { ScoreFactor, SeasonState, TargetMarket } from '../candidate.types';

/* ===========================================================================
 * Geography of a signal
 * ======================================================================== */

/**
 * What a signal's numbers actually describe.
 *
 * countryCode null means global; region null means country-wide. This is what makes
 * region isolation checkable rather than assumed.
 */
export interface SignalGeography {
  countryCode: string | null;
  region: string | null;
}

export type GeographyMatch =
  /** The signal covers exactly the requested region. */
  | 'REGION_EXACT'
  /** The signal is country-wide and a region was requested. Usable, not regional. */
  | 'COUNTRY_ONLY'
  /** The signal covers the requested country and no region was requested. */
  | 'COUNTRY_EXACT'
  /** The signal is global. Weakest, but still evidence of general interest. */
  | 'GLOBAL'
  /** The signal describes a DIFFERENT country. Not evidence for this market at all. */
  | 'MISMATCH';

/**
 * Compares a signal's coverage with the market being judged.
 *
 * MISMATCH is the important case: US search volume tells us nothing about demand in
 * India, and using it would be worse than having no data. Callers must discard a
 * mismatched signal rather than down-weighting it.
 */
export function matchGeography(
  signal: SignalGeography,
  market: TargetMarket,
): GeographyMatch {
  const signalCountry = signal.countryCode?.trim().toUpperCase() ?? null;
  const marketCountry = market.countryCode.trim().toUpperCase();

  if (signalCountry === null) return 'GLOBAL';
  if (signalCountry !== marketCountry) return 'MISMATCH';

  const signalRegion = signal.region?.trim().toLowerCase() ?? null;
  const marketRegion = market.region?.trim().toLowerCase() ?? null;

  if (marketRegion === null) {
    // No region requested, so country-level data is exactly right. A signal that
    // happens to be narrower is not a better answer to a national question, but it
    // is still about the right country.
    return 'COUNTRY_EXACT';
  }
  if (signalRegion === marketRegion) return 'REGION_EXACT';
  if (signalRegion === null) return 'COUNTRY_ONLY';

  // A DIFFERENT region of the right country. Treated as country-only evidence: it
  // is real data about the market, but says nothing specific about the target region.
  return 'COUNTRY_ONLY';
}

/** Confidence a geography match can support, at best. */
export function confidenceForGeography(match: GeographyMatch): DataConfidence {
  switch (match) {
    case 'REGION_EXACT':
    case 'COUNTRY_EXACT':
      return 'KNOWN';
    case 'COUNTRY_ONLY':
    case 'GLOBAL':
      // Real data, but standing in for something narrower than it measures.
      return 'ESTIMATED';
    default:
      return 'UNKNOWN';
  }
}

/* ===========================================================================
 * Signals
 * ======================================================================== */

/** Common provenance every signal carries, so evidence is always attributable. */
export interface SignalMeta {
  source: string;
  geography: SignalGeography;
  /** When the underlying fact was true. */
  observedAt: string | null;
  /** When Trademart retrieved it. */
  fetchedAt: string | null;
}

/** Search interest. Drives the demand factor. */
export interface DemandSignal extends SignalMeta {
  /** Average monthly searches across the candidate's keywords. */
  averageMonthlySearches: number | null;
}

/** Direction and speed of change. Drives the trend factor. */
export interface TrendSignal extends SignalMeta {
  /**
   * Percentage change over the market's horizon. +25 means up a quarter.
   * Null when no trend source is available - which is common and must not be
   * mistaken for "flat".
   */
  momentumPercentage: number | null;
  /** Second derivative, when the source provides it. Positive = accelerating. */
  accelerationPercentage: number | null;
}

/** How crowded the market is. Drives the competition factor. */
export interface CompetitionSignal extends SignalMeta {
  /**
   * 0-100 where 100 is most competitive, matching Google Ads' competition index.
   * Higher is WORSE for the candidate, and the scorer inverts it.
   */
  competitionIndex: number | null;
  /** Number of competing offers seen, when known. */
  competitorCount: number | null;
}

/** Where in its season the product is. */
export interface SeasonalitySignal extends SignalMeta {
  state: SeasonState;
  /** Months of the year this product peaks in, 1-12, when known. */
  peakMonths: number[] | null;
}

/**
 * The store's own trading history for comparable products.
 *
 * This is what makes store fit specific to THIS store rather than a general
 * popularity judgement.
 */
export interface StorePerformanceSignal extends SignalMeta {
  /** Products already sold in the same category. */
  categoryProductCount: number | null;
  /** Units sold in the category over the analysis window. */
  categoryUnitsSold: number | null;
  /** Typical selling price band the store actually trades in. */
  typicalSellingPriceMin: number | null;
  typicalSellingPriceMax: number | null;
  priceCurrency: string | null;
  /** Refund rate for the category, 0-100. */
  categoryRefundRatePercentage: number | null;
}

/**
 * Measured fulfillment outcomes for comparable products (PART 11).
 *
 * This is the feedback loop: real delivery performance on products like this one,
 * observed from the store's own Shopify orders.
 */
export interface FulfillmentHistorySignal extends SignalMeta {
  /** Orders the rates below are computed from. Small samples prove little. */
  sampleSize: number | null;
  delayRatePercentage: number | null;
  refundRatePercentage: number | null;
  noTrackingRatePercentage: number | null;
  averageDeliveryDays: number | null;
}

/**
 * Everything a scorer may read.
 *
 * Each signal is independently nullable because providers fail independently: Google
 * Trends being unavailable must not stop demand, profitability and store fit from
 * being scored.
 */
export interface ScoringInput {
  market: TargetMarket;
  demand: DemandSignal | null;
  trend: TrendSignal | null;
  competition: CompetitionSignal | null;
  seasonality: SeasonalitySignal | null;
  storePerformance: StorePerformanceSignal | null;
  fulfillmentHistory: FulfillmentHistorySignal | null;
  /**
   * Pre-computed economics for the candidate, from the pricing module. Kept as a
   * plain shape so scoring does not depend on the pricing service.
   */
  economics: {
    /** Contribution margin as a percentage of the selling price. */
    marginPercentage: number | null;
    /** Absolute contribution per unit. */
    contribution: number | null;
    currencyCode: string | null;
    /** True when a cost was hand-entered rather than observed. */
    costIsManual: boolean;
    /** True when supplier shipping is not recorded. */
    shippingUnknown: boolean;
    /** Set when the figures could not be computed at all. */
    blockedReason: string | null;
    /**
     * When the supplier cost behind these figures was last observed.
     *
     * Carried so profitability evidence can report a real freshness. Without it every
     * margin would age as UNKNOWN, and "we do not know how old this cost is" would be
     * indistinguishable from "this cost is current" - which is the difference between
     * a usable margin and a stale one.
     */
    costObservedAt: string | null;
  } | null;
  /** Supplier transit time in days, when quoted. */
  shippingDays: number | null;
  /** When that transit quote was recorded. */
  shippingDaysObservedAt: string | null;
  /**
   * The price the operator intends to sell at, in economics.currencyCode.
   *
   * Carried separately from `economics` because store fit compares the PRICE against
   * the band this store's customers actually accept, and margin/contribution cannot
   * be turned back into a price without the cost. Null when no price has been chosen
   * yet, in which case price fit is left unassessed rather than guessed.
   */
  expectedSellingPrice: number | null;
  /** Product category, for store-fit comparison. */
  category: string | null;
  now: Date;
}

/* ===========================================================================
 * Weights
 * ======================================================================== */

export type ScoreWeights = Record<ScoreFactor, number>;

/**
 * Default weights, as specified in the product brief.
 *
 * The seven weighted factors sum to 100. fulfillmentQuality is 0 by default and is
 * REPORTED rather than weighted: the brief's design is that fulfillment history
 * "may modify Store Fit", which is what storeFit.score.ts does. Weighting it here as
 * well would count the same evidence twice.
 *
 * An operator with a lot of fulfillment history can raise it - weights are normalised,
 * so any set of non-negative numbers is valid and the total need not be 100.
 */
export const DEFAULT_SCORE_WEIGHTS: Readonly<ScoreWeights> = Object.freeze({
  demand: 20,
  trend: 20,
  profitability: 20,
  storeFit: 15,
  competition: 10,
  shipping: 10,
  seasonality: 5,
  fulfillmentQuality: 0,
});

/**
 * Validates a weight set, returning human-readable problems.
 *
 * Returns a list rather than throwing on the first problem, matching how automation
 * rules are validated elsewhere - a bad configuration should be reported all at once.
 */
export function validateWeights(weights: ScoreWeights): string[] {
  const problems: string[] = [];
  let total = 0;

  for (const [factor, weight] of Object.entries(weights)) {
    if (!Number.isFinite(weight)) {
      problems.push(`${factor} weight must be a finite number.`);
      continue;
    }
    if (weight < 0) {
      problems.push(`${factor} weight must not be negative.`);
      continue;
    }
    total += weight;
  }

  if (total <= 0) {
    problems.push(
      'At least one factor must have a weight above zero, otherwise no candidate can be scored.',
    );
  }
  return problems;
}
