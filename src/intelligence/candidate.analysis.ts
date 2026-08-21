/**
 * Turning a candidate plus its signals into a score.
 *
 * The composition layer: it wires the pricing engine's economics into the scoring
 * engine's input and calls scoreCandidate. Deliberately PURE and deliberately separate
 * from intelligence.service.ts, because src/config/index.ts calls process.exit(1) at
 * import time - anything importing the config singleton cannot be unit tested, and this
 * is the logic most worth testing.
 *
 * WHY THE ECONOMICS ADAPTER LIVES HERE
 * -----------------------------------
 * scoreProfitability needs a margin. The pricing engine produces one. Neither module
 * should know about the other: pricing must not depend on intelligence (it is used by
 * automation and the order view too), and scoring must not depend on pricing (it is
 * pure arithmetic over stated inputs). So the join happens here, in the module that
 * already depends on both.
 *
 * The adapter's job is mostly to preserve REFUSALS across the boundary. When
 * recommendPrice declines - unknown cost, currency mismatch - that refusal must arrive
 * at the scorer as a blockedReason, not as a missing margin that looks like a provider
 * outage. The two are different problems and they read differently to an operator.
 */

import { worstConfidence, type DataConfidence } from '../common/dataQuality';
import {
  recommendPrice,
  type PriceRecommendation,
  type PricingPolicy,
  type PricingScenarioName,
} from '../pricing/recommendation';
import type { ManualResearchEntry, ProductCandidate, TargetMarket } from './candidate.types';
import type { ResearchSignals } from './providers/provider.types';
import { scoreCandidate, type CandidateScore, type ScoringOptions } from './scoring/scoring.service';
import type { ScoringInput } from './scoring/scoring.types';

/* ===========================================================================
 * Economics
 * ======================================================================== */

/**
 * The scoring engine's economics block, derived from a price recommendation.
 *
 * `scenario` selects which of the three prices the margin describes. Balanced by
 * default, because that is the operator's configured target and scoring against the
 * Premium price would flatter every candidate.
 */
export function economicsForScoring(
  recommendation: PriceRecommendation,
  commercials: ProductCandidate['commercials'],
  scenario: PricingScenarioName = 'BALANCED',
): ScoringInput['economics'] {
  // A blocked recommendation carries the reason forward verbatim. The scorer reports it
  // as a specific refusal the operator can act on, rather than a generic "unknown".
  if (recommendation.blockedReason !== null) {
    return {
      marginPercentage: null,
      contribution: null,
      currencyCode: recommendation.currencyCode,
      costIsManual: commercials.supplierCost !== null,
      shippingUnknown: commercials.shippingCost === null,
      blockedReason: recommendation.blockedReason,
      costObservedAt: commercials.costObservedAt,
    };
  }

  const chosen =
    recommendation.scenarios.find((entry) => entry.name === scenario) ??
    recommendation.scenarios.find((entry) => entry.name === 'BALANCED') ??
    null;

  if (chosen === null) {
    return {
      marginPercentage: null,
      contribution: null,
      currencyCode: recommendation.currencyCode,
      costIsManual: commercials.supplierCost !== null,
      shippingUnknown: !recommendation.shippingIncluded,
      blockedReason: 'No pricing scenario could be computed for this candidate.',
      costObservedAt: commercials.costObservedAt,
    };
  }

  return {
    marginPercentage: chosen.marginPercentage,
    contribution: chosen.contribution,
    currencyCode: recommendation.currencyCode,
    // Every cost in Research is hand-entered today: there is no supplier API to observe
    // one from. Saying so drops profitability's confidence to ESTIMATED, which is the
    // truth - the margin is exactly as good as the number the operator typed.
    costIsManual: true,
    shippingUnknown: !recommendation.shippingIncluded,
    blockedReason: null,
    costObservedAt: commercials.costObservedAt,
  };
}

/* ===========================================================================
 * Analysis
 * ======================================================================== */

export interface AnalyseCandidateInput {
  /** The candidate's own fields. Only what analysis needs. */
  candidate: Pick<
    ProductCandidate,
    'title' | 'category' | 'keywords' | 'market' | 'commercials' | 'manualResearch'
  >;
  signals: ResearchSignals;
  policy?: PricingPolicy;
  policyOverride?: Partial<PricingPolicy> | null;
  scoring?: ScoringOptions;
  /** Which scenario's margin the profitability factor is judged on. */
  pricingScenario?: PricingScenarioName;
  now: Date;
}

export interface CandidateAnalysis {
  score: CandidateScore;
  pricing: PriceRecommendation;
  /** The exact input the score was computed from, for reproducibility. */
  scoringInput: ScoringInput;
  /**
   * Everything the operator should read before acting, gathered from both engines.
   *
   * Pricing warnings are included because a margin that excludes unrecorded shipping is
   * a caveat about the SCORE, not merely about the price - and an operator who only
   * reads the score would otherwise never see it.
   */
  warnings: string[];
  /** Worst confidence across the score and the pricing inputs. */
  confidence: DataConfidence;
}

/**
 * Scores one candidate.
 *
 * Order matters: price first, because profitability is scored from the resulting
 * margin. Everything is pure, so the same candidate and the same signals always produce
 * the same analysis - which is what makes a stored score meaningful later.
 */
export function analyseCandidate(input: AnalyseCandidateInput): CandidateAnalysis {
  const { candidate, signals } = input;
  const commercials = candidate.commercials;

  const pricing = recommendPrice({
    supplierCost: commercials.supplierCost,
    supplierCurrency: commercials.supplierCurrency,
    shippingCost: commercials.shippingCost,
    shippingCurrency: commercials.shippingCurrency,
    sellingCurrency: commercials.expectedSellingCurrency,
    policy: input.policy,
    policyOverride: input.policyOverride,
  });

  const economics = economicsForScoring(pricing, commercials, input.pricingScenario);

  // The price the store-fit factor compares against the store's own price band: the
  // operator's stated intention when they have one, otherwise the recommended scenario.
  // Their intention comes first because store fit is about whether THEIR plan suits
  // this store, not whether our recommendation does.
  const recommendedPrice =
    pricing.scenarios.find((entry) => entry.name === (pricing.recommended ?? 'BALANCED'))?.price ??
    null;
  const expectedSellingPrice = commercials.expectedSellingPrice ?? recommendedPrice;

  const scoringInput: ScoringInput = {
    market: candidate.market,
    demand: signals.demand,
    trend: signals.trend,
    competition: signals.competition,
    seasonality: signals.seasonality,
    storePerformance: signals.storePerformance,
    fulfillmentHistory: signals.fulfillmentHistory,
    economics,
    shippingDays: commercials.shippingDays,
    shippingDaysObservedAt: commercials.costObservedAt,
    expectedSellingPrice,
    category: candidate.category,
    now: input.now,
  };

  const score = scoreCandidate(scoringInput, input.scoring);

  const warnings = dedupe([
    ...pricing.warnings,
    ...unavailableWarnings(signals),
  ]);

  return {
    score,
    pricing,
    scoringInput,
    warnings,
    confidence: worstConfidence(score.confidence, confidenceOfCost(commercials)),
  };
}

/**
 * A candidate's cost confidence.
 *
 * Never KNOWN: every cost in Research is typed in by hand, because no supplier API
 * exists to observe one from. Claiming KNOWN would be the single most expensive lie
 * available here, since the margin decides whether money is spent.
 */
function confidenceOfCost(commercials: ProductCandidate['commercials']): DataConfidence {
  if (commercials.supplierCost === null) return 'UNKNOWN';
  return 'ESTIMATED';
}

/**
 * Turns a missing capability into a sentence an operator can act on.
 *
 * Only for the capabilities whose absence changes what the score MEANS. A missing
 * seasonality signal costs 5% of the weighting and is reported by the score itself; a
 * missing store-performance signal means the score says nothing about whether the
 * product suits this store at all, which is a different order of gap.
 */
function unavailableWarnings(signals: ResearchSignals): string[] {
  const warnings: string[] = [];

  if (signals.unavailable.includes('storePerformance')) {
    warnings.push(
      'The store\u2019s own trading history could not be read, so this score says nothing about whether the product suits THIS store. It is a judgement about the market only.',
    );
  }
  if (signals.unavailable.includes('fulfillmentHistory')) {
    warnings.push(
      'There is no measured delivery performance for comparable products, so the supplier\u2019s quoted transit time is a promise rather than a result.',
    );
  }
  if (signals.unavailable.includes('demand') && signals.unavailable.includes('trend')) {
    warnings.push(
      'Neither demand nor trend could be established. Nothing here indicates whether anyone is looking for this product - record the figures from your research tool to get a meaningful score.',
    );
  }

  return warnings;
}

/**
 * Builds the request providers see.
 *
 * Small, but it exists so the narrowing is done in ONE place: a caller assembling this
 * inline would eventually pass the whole candidate, and a provider would start reading
 * the previous score and feeding it back into itself.
 */
export function researchRequestFor(
  candidate: Pick<ProductCandidate, 'title' | 'category' | 'keywords' | 'market'>,
  manualResearch: ManualResearchEntry,
  now: Date,
): {
  market: TargetMarket;
  keywords: readonly string[];
  title: string;
  category: string | null;
  manualResearch: ManualResearchEntry;
  now: Date;
} {
  return {
    market: candidate.market,
    keywords: candidate.keywords,
    title: candidate.title,
    category: candidate.category,
    manualResearch,
    now,
  };
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
