/**
 * Combines the eight factor scores into a candidate verdict.
 *
 * TWO NUMBERS, NEVER BLENDED
 * --------------------------
 *   overallScore     how good the opportunity looks
 *   confidenceScore  how much the data behind that opinion can be trusted
 *
 * They are kept apart on purpose. A single blended number cannot distinguish "this is
 * a mediocre product" from "this might be a great product but we barely know anything
 * about it", and those two situations call for opposite actions: skip it, or go and
 * find the missing data. Blending them would destroy exactly the information the
 * operator needs.
 *
 * WEIGHT NORMALISATION
 * --------------------
 * A factor with no data returns value: null and is EXCLUDED from the weighted average,
 * then the remaining weights are renormalised to sum to 100. So a candidate scored on
 * five of eight factors is scored honestly on those five, rather than being punished
 * for the absence of a provider it has no control over. What it is NOT is silently
 * treated as a complete assessment - the missing factors are listed, and they cost
 * confidence.
 *
 * Pure: the clock is supplied on the input, nothing is read from config or the
 * database, and the same input always produces the same output.
 */

import {
  worstConfidence,
  worstFreshness,
  type DataConfidence,
  type EvidenceItem,
  type Freshness,
} from '../../common/dataQuality';
import {
  bandFor,
  type FactorScore,
  type Recommendation,
  type ScoreFactor,
  type SeasonState,
} from '../candidate.types';
import { scoreCompetition } from './competition.score';
import { scoreDemand } from './demand.score';
import { scoreFulfillmentQuality } from './fulfillmentQuality.score';
import { scoreProfitability } from './profitability.score';
import { scoreSeasonality } from './seasonality.score';
import { scoreShipping } from './shipping.score';
import { scoreStoreFit } from './storeFit.score';
import { scoreTrend } from './trend.score';
import {
  DEFAULT_SCORE_WEIGHTS,
  validateWeights,
  type ScoreWeights,
  type ScoringInput,
} from './scoring.types';

/**
 * Fixed evaluation order.
 *
 * Explicit rather than derived from Object.keys so the reported factor order, and
 * therefore the aggregated reason and risk order, is stable across Node versions.
 * Determinism is a stated requirement and key order is not something to rely on.
 */
export const FACTOR_ORDER: readonly ScoreFactor[] = Object.freeze([
  'demand',
  'trend',
  'profitability',
  'storeFit',
  'competition',
  'shipping',
  'seasonality',
  'fulfillmentQuality',
]);

export const FACTOR_LABELS: Readonly<Record<ScoreFactor, string>> = Object.freeze({
  demand: 'Demand',
  trend: 'Trend',
  profitability: 'Profitability',
  storeFit: 'Store fit',
  competition: 'Competition',
  shipping: 'Shipping',
  seasonality: 'Seasonality',
  fulfillmentQuality: 'Fulfillment quality',
});

const SCORERS: Readonly<Record<ScoreFactor, (input: ScoringInput) => FactorScore>> =
  Object.freeze({
    demand: scoreDemand,
    trend: scoreTrend,
    profitability: scoreProfitability,
    storeFit: scoreStoreFit,
    competition: scoreCompetition,
    shipping: scoreShipping,
    seasonality: scoreSeasonality,
    fulfillmentQuality: scoreFulfillmentQuality,
  });

/* ===========================================================================
 * Confidence scoring
 * ======================================================================== */

/** How much a factor's own confidence contributes to the confidence score. */
const CONFIDENCE_POINTS: Readonly<Record<DataConfidence, number>> = Object.freeze({
  KNOWN: 100,
  ESTIMATED: 55,
  UNKNOWN: 0,
});

/**
 * How much each freshness state contributes.
 *
 * STALE scores above UNKNOWN because old data is still data - it tells you what was
 * true, which is more than a missing timestamp tells you. Both are problems; they are
 * different problems with different fixes.
 */
const FRESHNESS_POINTS: Readonly<Record<Freshness, number>> = Object.freeze({
  FRESH: 100,
  AGING: 70,
  STALE: 30,
  UNKNOWN: 20,
});

/**
 * Minimum weight a factor carries when measuring DATA COVERAGE, regardless of its
 * scoring weight.
 *
 * Without this, a factor weighted 0 - fulfillmentQuality by default - could be
 * entirely absent without denting confidence, which would be wrong. Missing
 * fulfillment history genuinely means we know less about this candidate, and the
 * honest response is a lower confidence score rather than an invented delivery
 * statistic. The floor keeps that cost visible while still keeping the factor out of
 * the opportunity score.
 */
const CONFIDENCE_COVERAGE_FLOOR = 5;

/**
 * How the QUALITY of the data we did get is mixed. These two sum to 1.
 *
 * Coverage is deliberately NOT in this mix - it multiplies the result instead. See
 * computeConfidenceScore.
 */
const QUALITY_MIX = Object.freeze({
  /** How directly observed the figures were. */
  observation: 0.6,
  /** How current they are. */
  freshness: 0.4,
});

/* ===========================================================================
 * Result
 * ======================================================================== */

export interface AppliedWeight {
  factor: ScoreFactor;
  /** The weight as configured. */
  configured: number;
  /**
   * The weight actually used, renormalised across factors that had data, as a
   * percentage. Zero for factors that were excluded.
   */
  effective: number;
  /** False when the factor had no data and was excluded from the average. */
  included: boolean;
}

export interface CandidateScore {
  /**
   * 0-100, or null when NOTHING could be scored.
   *
   * Null rather than 0 for the same reason a factor is null: zero would be a verdict.
   */
  overallScore: number | null;
  /** 0-100. Always present - "we know nothing" is itself a confident statement. */
  confidenceScore: number;
  recommendation: Recommendation | null;
  /** True when a positive band was held back because confidence was too low. */
  recommendationDowngraded: boolean;
  /** All eight factors, in FACTOR_ORDER, including the unscored ones. */
  factors: FactorScore[];
  weights: AppliedWeight[];
  /** Factors that had no data. Surfaced so the UI can say what is missing. */
  unscoredFactors: ScoreFactor[];
  /** Readable summary lines, one per factor plus any verdict-level notes. */
  reasons: string[];
  /** Deduplicated union of every factor's risks. */
  risks: string[];
  evidence: EvidenceItem[];
  /** Worst freshness across all evidence. */
  freshness: Freshness;
  /** Worst confidence across the factors that were scored. */
  confidence: DataConfidence;
  seasonState: SeasonState;
}

export interface ScoringOptions {
  weights?: ScoreWeights;
  /** Confidence below which STRONG/GOOD is held at WATCH. */
  minimumConfidenceForStrong?: number;
}

/* ===========================================================================
 * Entry point
 * ======================================================================== */

export function scoreCandidate(
  input: ScoringInput,
  options: ScoringOptions = {},
): CandidateScore {
  const weights = options.weights ?? DEFAULT_SCORE_WEIGHTS;

  const problems = validateWeights(weights);
  if (problems.length > 0) {
    // Refusing is right here. Scoring with a silently corrected weight set would
    // produce a number the operator cannot reproduce from the configuration they can
    // see, which defeats the purpose of the module being deterministic.
    throw new Error(`Invalid scoring weights: ${problems.join(' ')}`);
  }

  const factors = FACTOR_ORDER.map((factor) => SCORERS[factor](input));

  const overall = weightedOverall(factors, weights);

  // Confidence is confidence IN THE VERDICT. With no verdict there is nothing to be
  // confident about, so it is zero even if unweighted factors happened to have good
  // data - showing "61% confident" beside "not enough data to score" would be absurd.
  const confidenceScore =
    overall.value === null ? 0 : computeConfidenceScore(factors, weights);

  const band =
    overall.value === null
      ? { recommendation: null, downgraded: false, reason: null }
      : bandFor(overall.value, confidenceScore, options.minimumConfidenceForStrong);

  const evidence = factors.flatMap((factor) => factor.evidence);
  const scored = factors.filter((factor) => factor.value !== null);

  return {
    overallScore: overall.value,
    confidenceScore,
    recommendation: band.recommendation,
    recommendationDowngraded: band.downgraded,
    factors,
    weights: overall.weights,
    unscoredFactors: factors
      .filter((factor) => factor.value === null)
      .map((factor) => factor.factor),
    reasons: buildReasons(factors, overall, confidenceScore, band.reason),
    risks: dedupe(factors.flatMap((factor) => factor.risks)),
    evidence,
    freshness:
      evidence.length === 0
        ? 'UNKNOWN'
        : worstFreshness(...evidence.map((item) => item.freshness)),
    confidence:
      scored.length === 0
        ? 'UNKNOWN'
        : worstConfidence(...scored.map((factor) => factor.confidence)),
    seasonState: input.seasonality?.state ?? 'UNKNOWN',
  };
}

/* ===========================================================================
 * Weighted average over the factors that have data
 * ======================================================================== */

interface OverallResult {
  value: number | null;
  weights: AppliedWeight[];
}

function weightedOverall(factors: FactorScore[], weights: ScoreWeights): OverallResult {
  const participating = factors.filter(
    (factor) => factor.value !== null && weights[factor.factor] > 0,
  );

  const totalWeight = participating.reduce(
    (sum, factor) => sum + weights[factor.factor],
    0,
  );

  const applied: AppliedWeight[] = factors.map((factor) => {
    const configured = weights[factor.factor];
    const included = factor.value !== null && configured > 0 && totalWeight > 0;
    return {
      factor: factor.factor,
      configured,
      // Renormalised so the effective weights of the included factors sum to 100.
      // Reported rather than internal, because "demand was 24% of this score, not the
      // 20% you configured, because trend had no data" is something the operator has
      // to be able to see to trust the number.
      effective: included ? round2((configured / totalWeight) * 100) : 0,
      included,
    };
  });

  if (totalWeight === 0) {
    // Every weighted factor was unscored. Null, not zero: there is no verdict here.
    return { value: null, weights: applied };
  }

  const weighted = participating.reduce(
    (sum, factor) => sum + (factor.value as number) * weights[factor.factor],
    0,
  );

  return { value: Math.round(weighted / totalWeight), weights: applied };
}

/* ===========================================================================
 * Confidence
 * ======================================================================== */

function computeConfidenceScore(factors: FactorScore[], weights: ScoreWeights): number {
  // ---- coverage: how much of the intended assessment we could actually do ----
  let coverageAvailable = 0;
  let coverageTotal = 0;
  // ---- observation: how directly measured the figures we DID get were -------
  let observationWeighted = 0;
  let observationWeight = 0;

  for (const factor of factors) {
    const coverageWeight = Math.max(weights[factor.factor], CONFIDENCE_COVERAGE_FLOOR);
    coverageTotal += coverageWeight;

    if (factor.value === null) continue;

    coverageAvailable += coverageWeight;
    observationWeighted += CONFIDENCE_POINTS[factor.confidence] * coverageWeight;
    observationWeight += coverageWeight;
  }

  if (coverageAvailable === 0) {
    // Nothing was scored, so there is nothing to be confident about. Reported as 0
    // rather than omitted, so the UI has a number to show next to "not enough data".
    return 0;
  }

  const coverageRatio = coverageAvailable / coverageTotal;
  const observation = observationWeight === 0 ? 0 : observationWeighted / observationWeight;

  // ---- freshness: how current the evidence is ------------------------------
  const evidence = factors.flatMap((factor) => factor.evidence);
  const freshness =
    evidence.length === 0
      ? // Scored, but with no dated evidence behind it. That is a real gap, so it
        // scores as poorly as an unknown timestamp rather than being skipped.
        FRESHNESS_POINTS.UNKNOWN
      : evidence.reduce((sum, item) => sum + FRESHNESS_POINTS[item.freshness], 0) /
        evidence.length;

  const quality =
    observation * QUALITY_MIX.observation + freshness * QUALITY_MIX.freshness;

  // MULTIPLICATIVE, not a weighted average with coverage as a third term.
  //
  // Coverage and quality compound: perfect, current, directly-observed data covering
  // a fifth of the intended assessment is still only a fifth of an assessment. An
  // additive mix lets 100% quality on 20% coverage read as "moderately confident",
  // which is precisely the failure this module exists to prevent - one strong signal
  // dressed up as a researched decision. Multiplying means confidence can never
  // exceed the share of the assessment actually performed.
  return Math.max(0, Math.min(100, Math.round(coverageRatio * quality)));
}

/* ===========================================================================
 * Explanation
 * ======================================================================== */

function buildReasons(
  factors: FactorScore[],
  overall: OverallResult,
  confidenceScore: number,
  downgradeReason: string | null,
): string[] {
  const lines: string[] = [];

  if (overall.value === null) {
    lines.push(
      'No overall score could be calculated because none of the weighted factors had any data. This is reported as "not scored" rather than as a low score - an absence of evidence is not evidence of a bad product.',
    );
  } else {
    lines.push(
      `Overall score ${overall.value}/100 with data confidence ${confidenceScore}/100.`,
    );
  }

  const weightByFactor = new Map(overall.weights.map((weight) => [weight.factor, weight]));

  for (const factor of factors) {
    const weight = weightByFactor.get(factor.factor);
    const label = FACTOR_LABELS[factor.factor];

    if (factor.value === null) {
      lines.push(`${label}: not scored (excluded from the average, not counted as zero).`);
      continue;
    }
    if (weight === undefined || !weight.included) {
      // Scored but unweighted - fulfillmentQuality by default. Shown because the
      // operator should see the measurement even though it does not move the total.
      lines.push(`${label}: ${factor.value}/100 (reported, not weighted).`);
      continue;
    }
    lines.push(
      `${label}: ${factor.value}/100 at ${weight.effective}% of the score (configured ${weight.configured}).`,
    );
  }

  const missing = factors.filter((factor) => factor.value === null);
  if (missing.length > 0 && overall.value !== null) {
    lines.push(
      `${missing.length} of ${factors.length} factors had no data (${missing
        .map((factor) => FACTOR_LABELS[factor.factor])
        .join(', ')}). The remaining weights were renormalised to 100%, so this score reflects a partial assessment.`,
    );
  }

  if (downgradeReason !== null) lines.push(downgradeReason);

  return lines;
}

/* ===========================================================================
 * Small helpers
 * ======================================================================== */

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

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
