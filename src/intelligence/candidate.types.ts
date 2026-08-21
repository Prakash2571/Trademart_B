/**
 * Product research candidate: a product Trademart is CONSIDERING, not selling.
 *
 * THE CENTRAL DISTINCTION
 * ----------------------
 * A candidate is a hypothesis. Nothing here is on the storefront, nothing here has
 * been bought, and a high score is an argument rather than a decision. The status
 * ladder ends at PUSHED_TO_SHOPIFY - a DRAFT product - because publishing is a
 * commercial commitment a human makes, never a consequence of a number rising.
 *
 * TWO SCORES, NEVER ONE
 * ---------------------
 *   overallScore     how good the OPPORTUNITY looks
 *   confidenceScore  how much the DATA behind it can be trusted
 *
 * They must stay separate. A candidate scoring 89 on hand-typed costs with no trend
 * source is not the same proposition as one scoring 89 on observed data, and a
 * single blended number would hide exactly the difference that decides whether to
 * spend money. Collapsing them would make the whole module dishonest.
 *
 * Pure types plus pure helpers - no config, no database, no clock read internally.
 */

import type {
  DataConfidence,
  EvidenceItem,
  Freshness,
} from '../common/dataQuality';

/* ===========================================================================
 * Provenance
 * ======================================================================== */

/**
 * Where a candidate came from.
 *
 * TRADELLE is listed because the operator researches there, NOT because Trademart
 * has an interface to it. See TradelleProviderMode.
 */
export type CandidateSource =
  /** An operator typed it in, from anywhere. */
  | 'MANUAL'
  /** Researched on Tradelle and entered by hand. */
  | 'TRADELLE'
  /** Derived from the store's own Shopify performance. */
  | 'SHOPIFY_PERFORMANCE'
  | 'GOOGLE_ADS'
  | 'GOOGLE_TRENDS';

/**
 * How Trademart can reach Tradelle, stated honestly.
 *
 *   SHOPIFY_BRIDGE          Tradelle pushes products and fulfils orders THROUGH
 *                           Shopify. This is real and is how production works.
 *   MANUAL                  an operator reads Tradelle and types values in.
 *   DIRECT_API_UNAVAILABLE  there is no documented Tradelle API and none is
 *                           configured. Reported so the UI can say so plainly
 *                           instead of implying an integration exists.
 *
 * There is deliberately no DIRECT_API mode. Adding one before a documented,
 * credentialed interface exists would let the rest of the system start assuming
 * capabilities that are not there.
 */
export type TradelleProviderMode = 'SHOPIFY_BRIDGE' | 'MANUAL' | 'DIRECT_API_UNAVAILABLE';

/* ===========================================================================
 * Recommendation and status
 * ======================================================================== */

export type Recommendation =
  | 'STRONG_CANDIDATE'
  | 'GOOD_CANDIDATE'
  | 'WATCH'
  | 'WEAK'
  | 'REJECT';

export type CandidateStatus =
  | 'NEW'
  | 'WATCHING'
  | 'SELECTED'
  /** A Shopify DRAFT exists. NOT published - that stays a human action. */
  | 'PUSHED_TO_SHOPIFY'
  | 'REJECTED';

/**
 * Score bands.
 *
 * Thresholds are deliberately blunt and published rather than tuned in private: an
 * operator who can see the bands can argue with them, and a recommendation nobody
 * can argue with is not explainable.
 */
export const RECOMMENDATION_BANDS: readonly {
  atLeast: number;
  recommendation: Recommendation;
}[] = Object.freeze([
  { atLeast: 80, recommendation: 'STRONG_CANDIDATE' },
  { atLeast: 65, recommendation: 'GOOD_CANDIDATE' },
  { atLeast: 50, recommendation: 'WATCH' },
  { atLeast: 35, recommendation: 'WEAK' },
  { atLeast: 0, recommendation: 'REJECT' },
]);

/**
 * Maps a score to a band, and DOWNGRADES when the data is too thin to trust.
 *
 * This is the mechanism that stops the module recommending a purchase on the
 * strength of numbers nobody observed. A candidate scoring 88 on guesses is not a
 * STRONG_CANDIDATE; it is something to look into, which is what WATCH means.
 *
 * The downgrade is capped at WATCH rather than pushed to REJECT: thin data is not
 * evidence AGAINST a product, and treating it as such would discard good
 * opportunities for the crime of being new.
 */
export function bandFor(
  overallScore: number,
  confidenceScore: number,
  minimumConfidenceForStrong = 60,
): { recommendation: Recommendation; downgraded: boolean; reason: string | null } {
  const base =
    RECOMMENDATION_BANDS.find((band) => overallScore >= band.atLeast)?.recommendation ??
    'REJECT';

  const isPositive = base === 'STRONG_CANDIDATE' || base === 'GOOD_CANDIDATE';
  if (isPositive && confidenceScore < minimumConfidenceForStrong) {
    return {
      recommendation: 'WATCH',
      downgraded: true,
      reason: `The opportunity scores ${Math.round(overallScore)}, but data confidence is only ${Math.round(confidenceScore)}. Held at WATCH rather than recommended: the score rests on values nobody has observed, and thin data is a reason to look closer, not a reason to buy.`,
    };
  }

  return { recommendation: base, downgraded: false, reason: null };
}

/* ===========================================================================
 * Scores
 * ======================================================================== */

/** The eight factors. Named so a weight map cannot silently miss one. */
export type ScoreFactor =
  | 'demand'
  | 'trend'
  | 'profitability'
  | 'storeFit'
  | 'competition'
  | 'shipping'
  | 'seasonality'
  | 'fulfillmentQuality';

/**
 * One factor's result.
 *
 * `value` may be null. A factor with no data does not score zero - zero means "bad",
 * and "unknown" is not bad. A null factor is excluded from the weighted total and
 * costs confidence instead, which is the honest treatment.
 */
export interface FactorScore {
  factor: ScoreFactor;
  /** 0-100, or null when there is nothing to judge. */
  value: number | null;
  confidence: DataConfidence;
  /** Why it scored what it did. Always populated, even at null. */
  reasons: string[];
  /** What could go wrong. May be empty. */
  risks: string[];
  evidence: EvidenceItem[];
}

/** Seasonality is a separate axis from short-term trend. */
export type SeasonState = 'EARLY' | 'RISING' | 'PEAK' | 'FALLING' | 'OFF_SEASON' | 'UNKNOWN';

/* ===========================================================================
 * Geography
 * ======================================================================== */

/**
 * The market a candidate is being judged for.
 *
 * Region is optional because plenty of data is only national. A regional CLAIM must
 * never be made from national data - see the region-isolation rule in scoring.
 */
export interface TargetMarket {
  /** ISO 3166-1 alpha-2, uppercase. */
  countryCode: string;
  /** Free-text region/state name as the operator entered it, or null. */
  region: string | null;
  /** Days of history the judgement covers. */
  horizonDays: number;
}

export const SUPPORTED_HORIZONS: readonly number[] = Object.freeze([7, 30, 90]);

/* ===========================================================================
 * Commercial inputs
 * ======================================================================== */

/**
 * What a candidate is expected to cost and sell for.
 *
 * Every money field is nullable, and null means UNKNOWN. It never means zero, and
 * nothing downstream may substitute zero for it - a free product is a completely
 * different proposition from a product whose cost nobody has looked up.
 *
 * Currencies are recorded PER FIELD because a hand-entered shipping cost genuinely
 * can be in a different currency from a supplier cost, and silently adding them is
 * the mistake PART 18 exists to prevent.
 */
export interface CandidateCommercials {
  supplierCost: number | null;
  supplierCurrency: string | null;
  shippingCost: number | null;
  shippingCurrency: string | null;
  /** Supplier's quoted transit time. Null when unknown. */
  shippingDays: number | null;
  /** Operator's intended price, when they have one in mind. */
  expectedSellingPrice: number | null;
  expectedSellingCurrency: string | null;
  /** When these values were last touched, for freshness. */
  costObservedAt: string | null;
}

/* ===========================================================================
 * The candidate
 * ======================================================================== */

export interface ScoreHistoryEntry {
  at: string;
  overallScore: number;
  confidenceScore: number;
  recommendation: Recommendation;
  /** Why it moved, when it moved. */
  note: string | null;
}

export interface ProductCandidate {
  id: string;
  source: CandidateSource;
  /** The supplier's own identifier, when the operator supplied one. */
  sourceProductId: string | null;
  sourceUrl: string | null;

  title: string;
  category: string | null;
  imageUrl: string | null;
  /** Search terms this candidate is judged on. Drives demand and trend. */
  keywords: string[];

  market: TargetMarket;
  commercials: CandidateCommercials;

  /** Per-factor detail. Absent factors are genuinely absent, not zero. */
  factors: FactorScore[];
  overallScore: number | null;
  confidenceScore: number | null;
  recommendation: Recommendation | null;
  seasonState: SeasonState;

  reasons: string[];
  risks: string[];
  evidence: EvidenceItem[];
  /** Worst freshness across the evidence, so staleness is visible at a glance. */
  freshness: Freshness;

  status: CandidateStatus;
  /** Set once a DRAFT exists in Shopify. Never implies it is published. */
  pushedShopifyProductId: string | null;
  /** When a watch expires, so a watchlist does not grow forever. */
  watchUntil: string | null;

  scoreHistory: ScoreHistoryEntry[];

  notes: string | null;
  createdAt: string;
  analyzedAt: string | null;
  updatedAt: string;
}

/** Statuses from which a candidate may still be pushed to Shopify. */
export const PUSHABLE_STATUSES: readonly CandidateStatus[] = Object.freeze([
  'NEW',
  'WATCHING',
  'SELECTED',
]);

/**
 * Whether a candidate can be pushed, and why not.
 *
 * REJECTED is blocked because pushing a rejected candidate is almost always a
 * mis-click, and PUSHED_TO_SHOPIFY is blocked because a second push would create a
 * duplicate product - the thing PART 21 exists to prevent.
 */
export function canPush(candidate: Pick<ProductCandidate, 'status' | 'pushedShopifyProductId'>): {
  allowed: boolean;
  reason: string | null;
} {
  if (candidate.pushedShopifyProductId !== null) {
    return {
      allowed: false,
      reason: `This candidate has already been pushed to Shopify as ${candidate.pushedShopifyProductId}. Pushing again would create a duplicate product; edit the existing draft instead.`,
    };
  }
  if (!PUSHABLE_STATUSES.includes(candidate.status)) {
    return {
      allowed: false,
      reason:
        candidate.status === 'REJECTED'
          ? 'This candidate was rejected. Re-open it before pushing, so the decision is deliberate.'
          : `A candidate with status ${candidate.status} cannot be pushed.`,
    };
  }
  return { allowed: true, reason: null };
}
