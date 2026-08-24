/**
 * Store fit: does this suit THIS store?
 *
 * The factor that distinguishes Trademart from a generic product-research tool. A
 * portable neck fan can be globally trending and still be wrong for a store that sells
 * office stationery at £4 a unit.
 *
 * Built from three comparisons against the store's own Shopify history:
 *   1. does the store already trade in this category, and does that category sell?
 *   2. does the intended price sit inside the band this store's customers accept?
 *   3. does the category refund at an acceptable rate?
 *
 * AND THEN MODIFIED BY MEASURED FULFILLMENT (PART 11)
 * --------------------------------------------------
 * Poor real-world delivery on comparable products LOWERS store fit, because a product
 * this store cannot deliver well does not fit this store however attractive the market
 * looks. This is the feedback loop closing: Research -> push -> sell -> fulfil ->
 * measure -> better Research.
 *
 * The penalty is applied HERE rather than by weighting fulfillmentQuality, so the same
 * evidence is not counted twice. fulfillmentQuality is reported separately for
 * visibility with a default weight of zero.
 */

import type { FactorScore } from '../candidate.types';
import { assessGeography, clampScore, signalEvidence, unscored } from './score.helpers';
import { MINIMUM_FULFILLMENT_SAMPLE } from './fulfillmentQuality.score';
import type { ScoringInput } from './scoring.types';

/** Largest deduction measured fulfillment problems may apply, in points. */
const MAX_FULFILLMENT_PENALTY = 30;

export function scoreStoreFit(input: ScoringInput): FactorScore {
  const signal = input.storePerformance;

  if (signal === null) {
    return unscored(
      'storeFit',
      'No Shopify performance data is available, so store fit has not been scored. It is excluded rather than assumed neutral.',
      [
        'Whether this product suits this particular store is unknown. A globally popular product can still be wrong for this catalogue and this price point.',
      ],
    );
  }

  const geography = assessGeography(signal.geography, input.market);
  const reasons: string[] = [];
  const risks: string[] = [];
  const parts: { score: number; weight: number }[] = [];

  // ---- 1. category presence and traction --------------------------------
  const categoryProducts = signal.categoryProductCount;
  const categoryUnits = signal.categoryUnitsSold;

  if (categoryProducts === null) {
    reasons.push('The store\u2019s category history is unavailable, so catalogue fit was not assessed.');
  } else if (categoryProducts === 0) {
    // Not a penalty. A new category is a strategy decision, not a defect - but it is a
    // different proposition from extending a proven line, and the operator should know
    // which one they are doing.
    parts.push({ score: 45, weight: 2 });
    reasons.push(
      `This store sells nothing in ${input.category ?? 'this category'} yet, so this would open a new line rather than extend a proven one.`,
    );
    risks.push(
      'A new category has no existing audience, no proven price point and no comparable performance to learn from. That is a strategy choice rather than a defect, but it carries more uncertainty than extending a category that already sells.',
    );
  } else {
    const traction = categoryUnits ?? 0;
    const score = traction >= 100 ? 95 : traction >= 30 ? 85 : traction >= 5 ? 70 : 55;
    parts.push({ score, weight: 2 });
    reasons.push(
      categoryUnits === null
        ? `The store already sells ${categoryProducts} product(s) in ${input.category ?? 'this category'}.`
        : `The store sells ${categoryProducts} product(s) in ${input.category ?? 'this category'}, moving ${categoryUnits} unit(s) in the analysis window.`,
    );
    if (categoryUnits !== null && categoryUnits === 0) {
      risks.push(
        `The store lists ${categoryProducts} product(s) in this category but sold none of them in the window. The category is present but not proven.`,
      );
    }
  }

  // ---- 2. price band ------------------------------------------------------
  const priceMin = signal.typicalSellingPriceMin;
  const priceMax = signal.typicalSellingPriceMax;
  const expected = expectedPriceOf(input);

  if (expected !== null && priceMin !== null && priceMax !== null) {
    // Currency must match before comparing. Comparing a 1,399 INR price against a
    // 4-40 GBP band would produce a confident and meaningless answer.
    const bandCurrency = signal.priceCurrency?.trim().toUpperCase() ?? null;
    const priceCurrency = expected.currencyCode?.trim().toUpperCase() ?? null;

    if (bandCurrency !== null && priceCurrency !== null && bandCurrency !== priceCurrency) {
      reasons.push(
        `Price fit was not assessed: the intended price is in ${priceCurrency} but the store\u2019s price band is in ${bandCurrency}, and no exchange rate is configured.`,
      );
      risks.push(
        `Cannot compare a ${priceCurrency} price against a ${bandCurrency} price band without an exchange rate. Price fit is unassessed rather than guessed.`,
      );
    } else if (expected.amount >= priceMin && expected.amount <= priceMax) {
      parts.push({ score: 92, weight: 2 });
      reasons.push(
        `The intended price ${expected.amount.toFixed(2)} sits inside the store\u2019s usual ${priceMin.toFixed(2)}-${priceMax.toFixed(2)} band.`,
      );
    } else {
      // Distance outside the band, as a multiple of the band's own width, so the
      // judgement scales with how tightly the store trades rather than with currency size.
      const width = Math.max(priceMax - priceMin, 1);
      const distance =
        expected.amount < priceMin
          ? (priceMin - expected.amount) / width
          : (expected.amount - priceMax) / width;
      const score = distance <= 0.5 ? 72 : distance <= 1.5 ? 50 : 28;
      parts.push({ score, weight: 2 });
      const direction = expected.amount < priceMin ? 'below' : 'above';
      reasons.push(
        `The intended price ${expected.amount.toFixed(2)} is ${direction} the store\u2019s usual ${priceMin.toFixed(2)}-${priceMax.toFixed(2)} band.`,
      );
      risks.push(
        direction === 'above'
          ? `At ${expected.amount.toFixed(2)} this is dearer than what this store\u2019s customers normally buy. Conversion is likely to be lower than the category average.`
          : `At ${expected.amount.toFixed(2)} this is cheaper than this store\u2019s usual range, which can work but tends to attract a different, more price-sensitive customer.`,
      );
    }
  } else if (expected === null) {
    reasons.push('No intended selling price is set, so price fit was not assessed.');
  }

  // ---- 3. category refund rate -------------------------------------------
  const refundRate = signal.categoryRefundRatePercentage;
  if (refundRate !== null) {
    const score = refundRate <= 2 ? 95 : refundRate <= 5 ? 82 : refundRate <= 10 ? 60 : 35;
    parts.push({ score, weight: 1 });
    reasons.push(`Category refund rate is ${refundRate.toFixed(1)}%.`);
    if (refundRate > 8) {
      risks.push(
        `This category already refunds at ${refundRate.toFixed(0)}% for this store. Adding another product to it inherits that problem.`,
      );
    }
  }

  if (parts.length === 0) {
    return unscored(
      'storeFit',
      'Shopify performance data was returned but contained nothing comparable, so store fit was not scored.',
      risks,
    );
  }

  const totalWeight = parts.reduce((sum, part) => sum + part.weight, 0);
  const base = parts.reduce((sum, part) => sum + part.score * part.weight, 0) / totalWeight;

  // ---- 4. measured fulfillment modifies the result (PART 11) -------------
  const { penalty, penaltyReasons, penaltyRisks } = fulfillmentPenalty(input);
  const value = clampScore(base - penalty);

  reasons.push(...penaltyReasons);
  risks.push(...penaltyRisks);

  const evidence = [
    signalEvidence({
      code: 'STORE_CATEGORY_PERFORMANCE',
      label: 'Store performance in this category',
      source: signal.source,
      observedAt: signal.observedAt,
      fetchedAt: signal.fetchedAt,
      value:
        categoryProducts === null
          ? null
          : `${categoryProducts} product(s), ${categoryUnits ?? 'unknown'} unit(s) sold`,
      confidence: geography.usable ? 'KNOWN' : 'ESTIMATED',
      kind: 'STORE_PERFORMANCE',
      now: input.now,
    }),
  ];

  return {
    factor: 'storeFit',
    value,
    // Measured from the store's own trading history, so KNOWN - unless the fit had to
    // be assessed on partial comparisons.
    confidence: parts.length >= 2 ? 'KNOWN' : 'ESTIMATED',
    reasons,
    risks,
    evidence,
  };
}

/** The intended selling price, when one is known. */
function expectedPriceOf(
  input: ScoringInput,
): { amount: number; currencyCode: string | null } | null {
  const price = input.expectedSellingPrice;
  if (price === null || !Number.isFinite(price)) return null;
  // Currency comes from the economics block when present; without it the price is
  // still usable, but the caller must then treat the band comparison as unverified.
  return { amount: price, currencyCode: input.economics?.currencyCode ?? null };
}

/**
 * Deduction for measured fulfillment problems on comparable products.
 *
 * Capped, and only applied on a meaningful sample. An uncapped penalty would let one
 * bad month erase a genuinely good category fit, and a penalty from four orders would
 * be noise.
 */
function fulfillmentPenalty(input: ScoringInput): {
  penalty: number;
  penaltyReasons: string[];
  penaltyRisks: string[];
} {
  const history = input.fulfillmentHistory;
  if (history === null) return { penalty: 0, penaltyReasons: [], penaltyRisks: [] };

  const sample = history.sampleSize ?? 0;
  if (sample < MINIMUM_FULFILLMENT_SAMPLE) {
    return { penalty: 0, penaltyReasons: [], penaltyRisks: [] };
  }

  const delayRate = history.delayRatePercentage ?? 0;
  const refundRate = history.refundRatePercentage ?? 0;

  // Thresholds below which performance is considered acceptable and no deduction
  // applies. Above them the deduction scales with how bad it is.
  const delayExcess = Math.max(0, delayRate - 10);
  const refundExcess = Math.max(0, refundRate - 5);
  const raw = delayExcess * 0.8 + refundExcess * 1.6;
  const penalty = Math.min(MAX_FULFILLMENT_PENALTY, Math.round(raw));

  if (penalty === 0) {
    return {
      penalty: 0,
      penaltyReasons: [
        `Measured fulfillment on ${sample} comparable order(s) is acceptable (${delayRate.toFixed(1)}% late, ${refundRate.toFixed(1)}% refunded), so no penalty applies.`,
      ],
      penaltyRisks: [],
    };
  }

  return {
    penalty,
    penaltyReasons: [
      `Store fit reduced by ${penalty} point(s) because comparable products actually deliver badly: ${delayRate.toFixed(1)}% late and ${refundRate.toFixed(1)}% refunded across ${sample} order(s).`,
    ],
    penaltyRisks: [
      `This store has measurably struggled to deliver similar products (${delayRate.toFixed(0)}% late, ${refundRate.toFixed(0)}% refunded). A product this store cannot fulfil well does not fit this store, however good the market looks.`,
    ],
  };
}
