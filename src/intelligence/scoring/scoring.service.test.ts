/**
 * Combining factors into a verdict.
 *
 * The properties under test are the ones the brief calls out as non-negotiable:
 *
 *   - the same input always produces the same output (no randomness, no clock read)
 *   - a missing factor is EXCLUDED and the remaining weights renormalise to 100
 *   - a missing factor never becomes a zero
 *   - opportunity and data confidence are separate numbers, never blended
 *   - a strong score on thin data is held at WATCH, and never pushed to REJECT
 *   - data about another country cannot influence this market's score
 *   - stale evidence is visible as staleness, not silently trusted
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FACTOR_ORDER, scoreCandidate } from './scoring.service';
import { DEFAULT_SCORE_WEIGHTS, type ScoreWeights, type ScoringInput } from './scoring.types';

const NOW = new Date('2026-06-15T12:00:00.000Z');
const OBSERVED = '2026-06-15T06:00:00.000Z';

const HERE = { countryCode: 'GB', region: null };

function meta(geography = HERE, observedAt: string | null = OBSERVED) {
  return { source: 'Test source', geography, observedAt, fetchedAt: OBSERVED };
}

/** Every signal present and healthy. Tests remove pieces to see what happens. */
function completeInput(overrides: Partial<ScoringInput> = {}): ScoringInput {
  return {
    market: { countryCode: 'GB', region: null, horizonDays: 30 },
    demand: { ...meta(), averageMonthlySearches: 12_000 },
    trend: { ...meta(), momentumPercentage: 20, accelerationPercentage: 4 },
    competition: { ...meta(), competitionIndex: 40, competitorCount: 18 },
    seasonality: { ...meta(), state: 'RISING', peakMonths: [11, 12] },
    storePerformance: {
      ...meta(),
      categoryProductCount: 5,
      categoryUnitsSold: 40,
      typicalSellingPriceMin: 10,
      typicalSellingPriceMax: 30,
      priceCurrency: 'GBP',
      categoryRefundRatePercentage: 2,
    },
    fulfillmentHistory: {
      ...meta(),
      sampleSize: 60,
      delayRatePercentage: 4,
      refundRatePercentage: 2,
      noTrackingRatePercentage: 1,
      averageDeliveryDays: 7,
    },
    economics: {
      marginPercentage: 40,
      contribution: 8,
      currencyCode: 'GBP',
      costIsManual: false,
      shippingUnknown: false,
      blockedReason: null,
      costObservedAt: OBSERVED,
    },
    shippingDays: 8,
    shippingDaysObservedAt: OBSERVED,
    expectedSellingPrice: 20,
    category: 'Home',
    now: NOW,
    ...overrides,
  };
}

/** Only the weights named are non-zero, so a test can isolate the arithmetic. */
function onlyWeights(named: Partial<ScoreWeights>): ScoreWeights {
  const zeroed = Object.fromEntries(
    FACTOR_ORDER.map((factor) => [factor, 0]),
  ) as ScoreWeights;
  return { ...zeroed, ...named };
}

/* ===========================================================================
 * Determinism
 * ======================================================================== */

describe('scoreCandidate is deterministic', () => {
  it('produces byte-identical results for the same input', () => {
    const first = scoreCandidate(completeInput());
    const second = scoreCandidate(completeInput());
    assert.deepEqual(first, second);
  });

  it('reports all eight factors in a fixed order', () => {
    const result = scoreCandidate(completeInput());
    assert.deepEqual(
      result.factors.map((factor) => factor.factor),
      [...FACTOR_ORDER],
    );
  });

  it('scores a healthy candidate as a real recommendation with high confidence', () => {
    const result = scoreCandidate(completeInput());
    assert.equal(result.overallScore, 79);
    assert.ok(result.confidenceScore >= 85, `confidence was ${result.confidenceScore}`);
    assert.equal(result.recommendation, 'GOOD_CANDIDATE');
    assert.equal(result.recommendationDowngraded, false);
    assert.equal(result.freshness, 'FRESH');
    assert.equal(result.seasonState, 'RISING');
  });
});

/* ===========================================================================
 * Weight normalisation
 * ======================================================================== */

describe('weight normalisation', () => {
  it('renormalises to 100% across the factors that have data', () => {
    const result = scoreCandidate(completeInput({ trend: null }), {
      weights: onlyWeights({ demand: 50, trend: 50 }),
    });

    // Trend is gone, so demand carries the whole score rather than half of it.
    assert.equal(result.overallScore, 75);

    const demand = result.weights.find((weight) => weight.factor === 'demand');
    const trend = result.weights.find((weight) => weight.factor === 'trend');
    assert.equal(demand?.configured, 50);
    assert.equal(demand?.effective, 100);
    assert.equal(demand?.included, true);
    assert.equal(trend?.effective, 0);
    assert.equal(trend?.included, false);
  });

  it('computes the weighted average exactly, from the configured proportions', () => {
    const result = scoreCandidate(completeInput(), {
      weights: onlyWeights({ demand: 30, trend: 10 }),
    });
    // demand 75 at 75%, trend 78 at 25% => (75*30 + 78*10) / 40 = 75.75 => 76
    assert.equal(result.overallScore, 76);
    assert.equal(result.weights.find((weight) => weight.factor === 'demand')?.effective, 75);
    assert.equal(result.weights.find((weight) => weight.factor === 'trend')?.effective, 25);
  });

  it('effective weights of the included factors sum to 100', () => {
    const result = scoreCandidate(
      completeInput({ trend: null, competition: null, seasonality: null }),
    );
    const total = result.weights
      .filter((weight) => weight.included)
      .reduce((sum, weight) => sum + weight.effective, 0);
    assert.ok(Math.abs(total - 100) < 0.05, `effective weights summed to ${total}`);
  });

  it('excludes a scored-but-unweighted factor from the total while still reporting it', () => {
    const result = scoreCandidate(completeInput());
    const fulfillment = result.factors.find((factor) => factor.factor === 'fulfillmentQuality');
    const weight = result.weights.find((entry) => entry.factor === 'fulfillmentQuality');

    assert.ok(fulfillment?.value !== null, 'it is measured');
    assert.equal(weight?.configured, 0);
    assert.equal(weight?.included, false, 'but it does not move the total - storeFit does');
    assert.ok(result.reasons.some((reason) => reason.includes('reported, not weighted')));
  });

  it('refuses invalid weights rather than silently correcting them', () => {
    assert.throws(
      () => scoreCandidate(completeInput(), { weights: onlyWeights({ demand: -5 }) }),
      /Invalid scoring weights/,
    );
  });

  it('returns null, not zero, when no weighted factor has data', () => {
    const bare = scoreCandidate(
      completeInput({ demand: null }),
      { weights: onlyWeights({ demand: 100 }) },
    );
    assert.equal(bare.overallScore, null);
    assert.equal(bare.recommendation, null);
    assert.equal(bare.confidenceScore, 0);
    assert.ok(bare.reasons.some((reason) => reason.includes('absence of evidence')));
  });
});

/* ===========================================================================
 * UNKNOWN never becomes zero
 * ======================================================================== */

describe('unknown data is excluded, never zeroed', () => {
  it('does not let an unknown supplier cost drag the score down like a zero would', () => {
    const known = scoreCandidate(completeInput());
    const unknownCost = scoreCandidate(
      completeInput({
        economics: {
          marginPercentage: null,
          contribution: null,
          currencyCode: 'GBP',
          costIsManual: false,
          shippingUnknown: true,
          blockedReason: null,
          costObservedAt: null,
        },
      }),
    );

    const profitability = unknownCost.factors.find(
      (factor) => factor.factor === 'profitability',
    );
    assert.equal(profitability?.value, null);
    assert.ok(unknownCost.unscoredFactors.includes('profitability'));

    // Had profitability been scored 0, a 20% weight would have removed roughly 16
    // points. Because it is excluded instead, the score barely moves.
    assert.ok(
      Math.abs((unknownCost.overallScore as number) - (known.overallScore as number)) < 5,
      `score moved from ${known.overallScore} to ${unknownCost.overallScore}`,
    );

    // The cost of not knowing is paid in CONFIDENCE, which is the honest place for it.
    assert.ok(unknownCost.confidenceScore < known.confidenceScore);
  });

  it('never reports zero for a factor it has no data for', () => {
    const nothing = scoreCandidate({
      market: { countryCode: 'GB', region: null, horizonDays: 30 },
      demand: null,
      trend: null,
      competition: null,
      seasonality: null,
      storePerformance: null,
      fulfillmentHistory: null,
      economics: null,
      shippingDays: null,
      shippingDaysObservedAt: null,
      expectedSellingPrice: null,
      category: null,
      now: NOW,
    });

    assert.equal(nothing.overallScore, null);
    assert.equal(nothing.unscoredFactors.length, FACTOR_ORDER.length);
    for (const factor of nothing.factors) {
      assert.equal(factor.value, null, `${factor.factor} must be null, not 0`);
    }
  });
});

/* ===========================================================================
 * Two separate numbers
 * ======================================================================== */

describe('opportunity and confidence are separate', () => {
  it('holds a high score at WATCH when confidence is low, and says why', () => {
    // Strong on the factors we have, but almost nothing is known.
    const thin = scoreCandidate(
      completeInput({
        demand: { ...meta(), averageMonthlySearches: 200_000 },
        trend: { ...meta(), momentumPercentage: 90, accelerationPercentage: null },
        competition: null,
        seasonality: null,
        storePerformance: null,
        fulfillmentHistory: null,
        economics: null,
        shippingDays: null,
        shippingDaysObservedAt: null,
      }),
    );

    assert.ok((thin.overallScore as number) >= 80, `score was ${thin.overallScore}`);
    assert.ok(thin.confidenceScore < 60, `confidence was ${thin.confidenceScore}`);
    assert.equal(thin.recommendation, 'WATCH');
    assert.equal(thin.recommendationDowngraded, true);
    assert.ok(thin.reasons.some((reason) => reason.includes('thin data')));
  });

  it('caps the downgrade at WATCH and never pushes it to REJECT', () => {
    const thin = scoreCandidate(
      completeInput({
        demand: { ...meta(), averageMonthlySearches: 200_000 },
        trend: null,
        competition: null,
        seasonality: null,
        storePerformance: null,
        fulfillmentHistory: null,
        economics: null,
        shippingDays: null,
        shippingDaysObservedAt: null,
      }),
    );
    // Thin data is a reason to look closer, not evidence AGAINST the product.
    assert.notEqual(thin.recommendation, 'REJECT');
    assert.notEqual(thin.recommendation, 'WEAK');
    assert.equal(thin.recommendation, 'WATCH');
  });

  it('does not blend the two numbers together', () => {
    const result = scoreCandidate(completeInput());
    assert.notEqual(result.overallScore, result.confidenceScore);
    assert.ok(result.reasons.some((reason) => reason.includes('data confidence')));
  });

  it('lists what was missing so a partial assessment cannot look complete', () => {
    const result = scoreCandidate(completeInput({ trend: null, competition: null }));
    assert.deepEqual(result.unscoredFactors, ['trend', 'competition']);
    assert.ok(
      result.reasons.some((reason) => reason.includes('partial assessment')),
      'a score built on five of eight factors must say so',
    );
  });
});

/* ===========================================================================
 * Region isolation
 * ======================================================================== */

describe('region isolation', () => {
  it('gives an identical score whether foreign data is supplied or absent', () => {
    const withoutForeign = scoreCandidate(
      completeInput({
        market: { countryCode: 'IN', region: 'Jharkhand', horizonDays: 30 },
        demand: null,
        trend: null,
        competition: null,
        seasonality: null,
        storePerformance: null,
        fulfillmentHistory: null,
      }),
    );

    const withForeign = scoreCandidate(
      completeInput({
        market: { countryCode: 'IN', region: 'Jharkhand', horizonDays: 30 },
        demand: {
          ...meta({ countryCode: 'US', region: null }),
          averageMonthlySearches: 500_000,
        },
        trend: {
          ...meta({ countryCode: 'US', region: null }),
          momentumPercentage: 120,
          accelerationPercentage: 40,
        },
        competition: null,
        seasonality: null,
        storePerformance: null,
        fulfillmentHistory: null,
      }),
    );

    // Half a million US searches and 120% US growth must move the Indian score by
    // exactly nothing. Down-weighting rather than discarding would fail this.
    assert.equal(withForeign.overallScore, withoutForeign.overallScore);
    assert.ok(withForeign.unscoredFactors.includes('demand'));
    assert.ok(withForeign.unscoredFactors.includes('trend'));
    assert.ok(withForeign.risks.some((risk) => risk.includes('no evidence')));
  });

  it('accepts national data for a regional question but says it is not regional', () => {
    const result = scoreCandidate(
      completeInput({
        market: { countryCode: 'GB', region: 'Scotland', horizonDays: 30 },
      }),
    );
    const demand = result.factors.find((factor) => factor.factor === 'demand');
    assert.equal(demand?.confidence, 'ESTIMATED');
    assert.equal(result.confidence, 'ESTIMATED');
    assert.ok(result.risks.some((risk) => risk.includes('not Scotland')));
    // Usable, and lower confidence than the same data answering a national question.
    const national = scoreCandidate(completeInput());
    assert.ok(result.confidenceScore < national.confidenceScore);
  });
});

/* ===========================================================================
 * Freshness
 * ======================================================================== */

describe('freshness', () => {
  it('surfaces stale evidence rather than trusting it silently', () => {
    const stale = '2025-01-05T00:00:00.000Z';
    const result = scoreCandidate(
      completeInput({
        demand: { ...meta(HERE, stale), averageMonthlySearches: 12_000 },
        trend: { ...meta(HERE, stale), momentumPercentage: 20, accelerationPercentage: 4 },
      }),
    );

    assert.equal(result.freshness, 'STALE');
    const demandEvidence = result.evidence.find((item) => item.code === 'SEARCH_VOLUME');
    assert.equal(demandEvidence?.freshness, 'STALE');

    // The opportunity score is unchanged - the numbers are what they are - but our
    // confidence in them is not.
    const fresh = scoreCandidate(completeInput());
    assert.equal(result.overallScore, fresh.overallScore);
    assert.ok(result.confidenceScore < fresh.confidenceScore);
  });

  it('reports UNKNOWN freshness when nothing carries a timestamp', () => {
    const result = scoreCandidate(
      completeInput({
        demand: { ...meta(HERE, null), averageMonthlySearches: 12_000 },
        trend: { ...meta(HERE, null), momentumPercentage: 20, accelerationPercentage: null },
        competition: { ...meta(HERE, null), competitionIndex: 40, competitorCount: null },
        seasonality: { ...meta(HERE, null), state: 'RISING', peakMonths: null },
        storePerformance: null,
        fulfillmentHistory: null,
        economics: null,
        shippingDaysObservedAt: null,
      }),
    );
    // A missing timestamp is a plumbing gap, not an old figure. Different fix.
    assert.equal(result.freshness, 'UNKNOWN');
  });
});

/* ===========================================================================
 * Currency safety
 * ======================================================================== */

describe('currency safety', () => {
  it('propagates a blocked currency calculation instead of scoring a guess', () => {
    const result = scoreCandidate(
      completeInput({
        economics: {
          marginPercentage: null,
          contribution: null,
          currencyCode: null,
          costIsManual: false,
          shippingUnknown: false,
          blockedReason:
            'CURRENCY_MISMATCH: cannot compute a margin from a USD cost and a GBP price without an exchange rate.',
          costObservedAt: null,
        },
      }),
    );

    assert.ok(result.unscoredFactors.includes('profitability'));
    assert.ok(result.risks.some((risk) => risk.includes('CURRENCY_MISMATCH')));
    // Still produces a verdict from the other factors rather than failing entirely.
    assert.ok(result.overallScore !== null);
  });

  it('does not compare a price against a band in another currency', () => {
    const result = scoreCandidate(
      completeInput({
        storePerformance: {
          ...meta(),
          categoryProductCount: 5,
          categoryUnitsSold: 40,
          typicalSellingPriceMin: 800,
          typicalSellingPriceMax: 2_400,
          priceCurrency: 'INR',
          categoryRefundRatePercentage: 2,
        },
      }),
    );
    assert.ok(result.risks.some((risk) => risk.includes('unassessed rather than guessed')));
  });
});

/* ===========================================================================
 * The fulfillment feedback loop, end to end
 * ======================================================================== */

describe('measured fulfillment feeds back into the verdict', () => {
  it('lowers both fulfillmentQuality and storeFit when delivery is genuinely bad', () => {
    const good = scoreCandidate(completeInput());
    const bad = scoreCandidate(
      completeInput({
        fulfillmentHistory: {
          ...meta(),
          sampleSize: 60,
          delayRatePercentage: 30,
          refundRatePercentage: 15,
          noTrackingRatePercentage: 25,
          averageDeliveryDays: 24,
        },
      }),
    );

    const goodFit = good.factors.find((factor) => factor.factor === 'storeFit')?.value;
    const badFit = bad.factors.find((factor) => factor.factor === 'storeFit')?.value;
    const goodQuality = good.factors.find(
      (factor) => factor.factor === 'fulfillmentQuality',
    )?.value;
    const badQuality = bad.factors.find(
      (factor) => factor.factor === 'fulfillmentQuality',
    )?.value;

    assert.ok((badQuality as number) < (goodQuality as number));
    assert.ok((badFit as number) < (goodFit as number));
    assert.ok((bad.overallScore as number) < (good.overallScore as number));
    assert.ok(bad.risks.some((risk) => risk.includes('measurably struggled')));
  });

  it('lowers confidence when fulfillment history is missing rather than inventing one', () => {
    const measured = scoreCandidate(completeInput());
    const noHistory = scoreCandidate(completeInput({ fulfillmentHistory: null }));

    const quality = noHistory.factors.find(
      (factor) => factor.factor === 'fulfillmentQuality',
    );
    assert.equal(quality?.value, null, 'no history must not become a delivery statistic');
    assert.ok(
      noHistory.confidenceScore < measured.confidenceScore,
      'a factor weighted 0 must still cost confidence when it is missing',
    );

    // And storeFit is not penalised for an absence - a new store has not demonstrated
    // bad fulfillment.
    assert.equal(
      noHistory.factors.find((factor) => factor.factor === 'storeFit')?.value,
      measured.factors.find((factor) => factor.factor === 'storeFit')?.value,
    );
  });
});

/* ===========================================================================
 * Aggregation
 * ======================================================================== */

describe('aggregated explanation', () => {
  it('gathers every factor risk without duplicates', () => {
    const result = scoreCandidate(completeInput({ shippingDays: 30 }));
    const unique = new Set(result.risks);
    assert.equal(unique.size, result.risks.length);
    assert.ok(result.risks.some((risk) => risk.includes('where is my order?')));
  });

  it('collects evidence from every scored factor', () => {
    const result = scoreCandidate(completeInput());
    const codes = result.evidence.map((item) => item.code);
    for (const expected of [
      'SEARCH_VOLUME',
      'TREND_MOMENTUM',
      'COMPETITION_INDEX',
      'SEASON_STATE',
      'STORE_CATEGORY_PERFORMANCE',
      'CONTRIBUTION_MARGIN',
      'SUPPLIER_TRANSIT_DAYS',
      'FULFILLMENT_HISTORY',
    ]) {
      assert.ok(codes.includes(expected), `missing evidence ${expected}`);
    }
  });

  it('reports the worst confidence across scored factors, not an average', () => {
    const result = scoreCandidate(completeInput());
    // shipping is a quote, so ESTIMATED, and one ESTIMATED factor makes the whole
    // verdict ESTIMATED. Averaging would let a single soft number hide.
    assert.equal(result.confidence, 'ESTIMATED');
  });

  it('names each unscored factor as excluded rather than zero', () => {
    const result = scoreCandidate(completeInput({ seasonality: null }));
    assert.ok(
      result.reasons.some(
        (reason) => reason.includes('Seasonality') && reason.includes('not counted as zero'),
      ),
    );
  });

  it('uses the default weights when none are supplied', () => {
    const explicit = scoreCandidate(completeInput(), { weights: { ...DEFAULT_SCORE_WEIGHTS } });
    const implicit = scoreCandidate(completeInput());
    assert.equal(implicit.overallScore, explicit.overallScore);
    assert.equal(implicit.confidenceScore, explicit.confidenceScore);
  });
});
