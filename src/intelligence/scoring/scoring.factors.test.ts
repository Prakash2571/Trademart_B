/**
 * The eight factor scorers, tested individually.
 *
 * These tests are mostly about the REFUSALS. Getting a band lookup right is arithmetic;
 * the behaviour that actually protects the operator's money is each scorer declining to
 * produce a number when it has no business producing one:
 *
 *   - a missing signal returns null, never 0
 *   - a signal about a different country is DISCARDED, not down-weighted
 *   - an unknown supplier cost blocks profitability rather than flattering it
 *   - a four-order fulfillment sample is reported but not scored
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { scoreCompetition } from './competition.score';
import { scoreDemand } from './demand.score';
import { MINIMUM_FULFILLMENT_SAMPLE, scoreFulfillmentQuality } from './fulfillmentQuality.score';
import { scoreProfitability } from './profitability.score';
import { scoreSeasonality } from './seasonality.score';
import { scoreShipping } from './shipping.score';
import { scoreStoreFit } from './storeFit.score';
import { scoreTrend } from './trend.score';
import { matchGeography, validateWeights, DEFAULT_SCORE_WEIGHTS, type ScoringInput } from './scoring.types';

const NOW = new Date('2026-06-15T12:00:00.000Z');
const OBSERVED = '2026-06-15T00:00:00.000Z';

/** An input with every signal absent. Tests switch on only what they need. */
function emptyInput(overrides: Partial<ScoringInput> = {}): ScoringInput {
  return {
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
    category: 'Home',
    now: NOW,
    ...overrides,
  };
}

const HERE = { countryCode: 'GB', region: null };

function meta(geography = HERE) {
  return { source: 'Test source', geography, observedAt: OBSERVED, fetchedAt: OBSERVED };
}

/* ===========================================================================
 * Geography, which every market-data scorer depends on
 * ======================================================================== */

describe('matchGeography classifies signal coverage', () => {
  it('recognises an exact regional match', () => {
    assert.equal(
      matchGeography(
        { countryCode: 'IN', region: 'Jharkhand' },
        { countryCode: 'IN', region: 'Jharkhand', horizonDays: 30 },
      ),
      'REGION_EXACT',
    );
  });

  it('treats country-level data as country-only when a region was asked about', () => {
    assert.equal(
      matchGeography(
        { countryCode: 'IN', region: null },
        { countryCode: 'IN', region: 'Jharkhand', horizonDays: 30 },
      ),
      'COUNTRY_ONLY',
    );
  });

  it('treats a DIFFERENT region of the right country as country-only, not exact', () => {
    assert.equal(
      matchGeography(
        { countryCode: 'IN', region: 'Kerala' },
        { countryCode: 'IN', region: 'Jharkhand', horizonDays: 30 },
      ),
      'COUNTRY_ONLY',
    );
  });

  it('flags a different country as a mismatch', () => {
    assert.equal(
      matchGeography(
        { countryCode: 'US', region: null },
        { countryCode: 'IN', region: null, horizonDays: 30 },
      ),
      'MISMATCH',
    );
  });

  it('is case and whitespace insensitive', () => {
    assert.equal(
      matchGeography(
        { countryCode: ' gb ', region: ' London ' },
        { countryCode: 'GB', region: 'london', horizonDays: 30 },
      ),
      'REGION_EXACT',
    );
  });
});

/* ===========================================================================
 * Demand
 * ======================================================================== */

describe('scoreDemand', () => {
  it('returns null rather than zero when no source is available', () => {
    const score = scoreDemand(emptyInput());
    assert.equal(score.value, null);
    assert.notEqual(score.value, 0);
    assert.equal(score.confidence, 'UNKNOWN');
    assert.ok(score.risks.length > 0, 'an unmeasured factor must still raise a risk');
  });

  it('scores from search volume and cites the figure as evidence', () => {
    const score = scoreDemand(
      emptyInput({ demand: { ...meta(), averageMonthlySearches: 12_000 } }),
    );
    assert.equal(score.value, 75);
    assert.equal(score.confidence, 'KNOWN');
    assert.equal(score.evidence.length, 1);
    assert.equal(score.evidence[0]?.code, 'SEARCH_VOLUME');
    assert.ok(score.reasons.some((reason) => reason.includes('12,000')));
  });

  it('DISCARDS a figure for a different country instead of down-weighting it', () => {
    const score = scoreDemand(
      emptyInput({
        market: { countryCode: 'IN', region: null, horizonDays: 30 },
        demand: {
          ...meta({ countryCode: 'US', region: null }),
          averageMonthlySearches: 900_000,
        },
      }),
    );
    // 900,000 US searches must not produce a 95 for India.
    assert.equal(score.value, null);
    assert.equal(score.evidence.length, 0);
    assert.ok(score.risks.some((risk) => risk.includes('no evidence')));
  });

  it('uses national data for a regional question but downgrades confidence and warns', () => {
    const score = scoreDemand(
      emptyInput({
        market: { countryCode: 'IN', region: 'Jharkhand', horizonDays: 30 },
        demand: {
          ...meta({ countryCode: 'IN', region: null }),
          averageMonthlySearches: 30_000,
        },
      }),
    );
    assert.equal(score.value, 88);
    assert.equal(score.confidence, 'ESTIMATED');
    assert.ok(score.risks.some((risk) => risk.includes('Jharkhand')));
  });

  it('does not score when the source replies with no volume', () => {
    const score = scoreDemand(
      emptyInput({ demand: { ...meta(), averageMonthlySearches: null } }),
    );
    assert.equal(score.value, null);
  });

  it('warns that low volume means paid acquisition', () => {
    const score = scoreDemand(emptyInput({ demand: { ...meta(), averageMonthlySearches: 600 } }));
    assert.equal(score.value, 42);
    assert.ok(score.risks.some((risk) => risk.includes('paid acquisition')));
  });
});

/* ===========================================================================
 * Trend
 * ======================================================================== */

describe('scoreTrend', () => {
  it('reports no data as null, NOT as flat', () => {
    const score = scoreTrend(emptyInput());
    assert.equal(score.value, null);
    // 50 is the "flat" score. A missing source must not land there.
    assert.notEqual(score.value, 50);
  });

  it('scores growth above flat and flat above decline', () => {
    const growing = scoreTrend(
      emptyInput({ trend: { ...meta(), momentumPercentage: 45, accelerationPercentage: null } }),
    );
    const flat = scoreTrend(
      emptyInput({ trend: { ...meta(), momentumPercentage: 0, accelerationPercentage: null } }),
    );
    const declining = scoreTrend(
      emptyInput({ trend: { ...meta(), momentumPercentage: -25, accelerationPercentage: null } }),
    );

    assert.equal(growing.value, 90);
    assert.equal(flat.value, 50);
    assert.equal(declining.value, 18);
  });

  it('punishes decline harder than it rewards the mirrored growth', () => {
    const up = scoreTrend(
      emptyInput({ trend: { ...meta(), momentumPercentage: 20, accelerationPercentage: null } }),
    );
    const down = scoreTrend(
      emptyInput({ trend: { ...meta(), momentumPercentage: -20, accelerationPercentage: null } }),
    );
    assert.ok(up.value !== null && down.value !== null);
    // Entering a shrinking market is the worse mistake, so the asymmetry is intentional.
    assert.ok(50 - (down.value as number) > (up.value as number) - 50);
  });

  it('flags decelerating growth as a risk without changing the score', () => {
    const plain = scoreTrend(
      emptyInput({ trend: { ...meta(), momentumPercentage: 30, accelerationPercentage: null } }),
    );
    const slowing = scoreTrend(
      emptyInput({ trend: { ...meta(), momentumPercentage: 30, accelerationPercentage: -12 } }),
    );
    assert.equal(slowing.value, plain.value);
    assert.ok(slowing.risks.some((risk) => risk.includes('slowing')));
  });
});

/* ===========================================================================
 * Competition
 * ======================================================================== */

describe('scoreCompetition', () => {
  it('inverts the index so less competition scores higher', () => {
    const light = scoreCompetition(
      emptyInput({
        competition: { ...meta(), competitionIndex: 15, competitorCount: null },
      }),
    );
    const heavy = scoreCompetition(
      emptyInput({
        competition: { ...meta(), competitionIndex: 75, competitorCount: null },
      }),
    );
    assert.equal(light.value, 95);
    assert.equal(heavy.value, 40);
  });

  it('never scores zero, because a crowded market is a proven market', () => {
    const saturated = scoreCompetition(
      emptyInput({
        competition: { ...meta(), competitionIndex: 100, competitorCount: 500 },
      }),
    );
    // A veto-strength competition factor would let one crowded keyword sink a
    // candidate that is strong on every other measure.
    assert.equal(saturated.value, 25);
  });

  it('warns that high competition means higher advertising cost', () => {
    const score = scoreCompetition(
      emptyInput({ competition: { ...meta(), competitionIndex: 70, competitorCount: null } }),
    );
    assert.ok(score.risks.some((risk) => risk.includes('advertising')));
  });
});

/* ===========================================================================
 * Profitability - the most important refusal in the module
 * ======================================================================== */

describe('scoreProfitability', () => {
  it('refuses to score when the margin is unknown, and does NOT use zero', () => {
    const score = scoreProfitability(
      emptyInput({
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
    assert.equal(score.value, null);
    assert.notEqual(score.value, 0);
    assert.ok(
      score.risks.some((risk) => risk.includes('not a zero cost')),
      'the operator must be told an unknown cost is not a cheap cost',
    );
  });

  it('reports a blocked calculation verbatim so the fix is visible', () => {
    const score = scoreProfitability(
      emptyInput({
        economics: {
          marginPercentage: null,
          contribution: null,
          currencyCode: null,
          costIsManual: false,
          shippingUnknown: false,
          blockedReason:
            'CURRENCY_MISMATCH: supplier cost is in USD but the selling price is in GBP.',
          costObservedAt: null,
        },
      }),
    );
    assert.equal(score.value, null);
    assert.ok(score.reasons.some((reason) => reason.includes('CURRENCY_MISMATCH')));
    assert.ok(score.risks.some((risk) => risk.includes('CURRENCY_MISMATCH')));
  });

  it('scores a healthy margin and keeps data quality in confidence, not the score', () => {
    const observed = scoreProfitability(
      emptyInput({
        economics: {
          marginPercentage: 40,
          contribution: 8,
          currencyCode: 'GBP',
          costIsManual: false,
          shippingUnknown: false,
          blockedReason: null,
          costObservedAt: OBSERVED,
        },
      }),
    );
    const handTyped = scoreProfitability(
      emptyInput({
        economics: {
          marginPercentage: 40,
          contribution: 8,
          currencyCode: 'GBP',
          costIsManual: true,
          shippingUnknown: false,
          blockedReason: null,
          costObservedAt: OBSERVED,
        },
      }),
    );

    // Same margin, same score. The uncertainty is about the INPUT, so it belongs in
    // confidence - deducting it from the score too would penalise it twice.
    assert.equal(observed.value, 78);
    assert.equal(handTyped.value, 78);
    assert.equal(observed.confidence, 'KNOWN');
    assert.equal(handTyped.confidence, 'ESTIMATED');
  });

  it('says the real margin is lower when supplier shipping is unrecorded', () => {
    const score = scoreProfitability(
      emptyInput({
        economics: {
          marginPercentage: 50,
          contribution: 12,
          currencyCode: 'GBP',
          costIsManual: false,
          shippingUnknown: true,
          blockedReason: null,
          costObservedAt: OBSERVED,
        },
      }),
    );
    assert.equal(score.confidence, 'ESTIMATED');
    assert.ok(score.risks.some((risk) => risk.includes('LOWER')));
  });

  it('flags a loss-making product as unpushable rather than merely low-scoring', () => {
    const score = scoreProfitability(
      emptyInput({
        economics: {
          marginPercentage: -12,
          contribution: -3,
          currencyCode: 'GBP',
          costIsManual: false,
          shippingUnknown: false,
          blockedReason: null,
          costObservedAt: OBSERVED,
        },
      }),
    );
    assert.equal(score.value, 2);
    assert.ok(score.risks.some((risk) => risk.includes('loses money')));
  });
});

/* ===========================================================================
 * Shipping
 * ======================================================================== */

describe('scoreShipping', () => {
  it('leaves an unrecorded transit time unscored', () => {
    const score = scoreShipping(emptyInput());
    assert.equal(score.value, null);
    assert.ok(score.risks.some((risk) => risk.includes('Delivery time is unknown')));
  });

  it('scores faster shipping higher', () => {
    assert.equal(scoreShipping(emptyInput({ shippingDays: 3 })).value, 98);
    assert.equal(scoreShipping(emptyInput({ shippingDays: 12 })).value, 58);
    assert.equal(scoreShipping(emptyInput({ shippingDays: 45 })).value, 8);
  });

  it('is never more than ESTIMATED, because a quote is not a delivery', () => {
    const score = scoreShipping(emptyInput({ shippingDays: 3 }));
    assert.equal(score.confidence, 'ESTIMATED');
    assert.ok(score.reasons.some((reason) => reason.includes('not a measured delivery time')));
  });

  it('warns about chargebacks past three weeks', () => {
    const score = scoreShipping(emptyInput({ shippingDays: 28 }));
    assert.ok(score.risks.some((risk) => risk.includes('chargeback')));
  });

  it('rejects a negative transit time instead of scoring it', () => {
    assert.equal(scoreShipping(emptyInput({ shippingDays: -4 })).value, null);
  });
});

/* ===========================================================================
 * Seasonality
 * ======================================================================== */

describe('scoreSeasonality', () => {
  it('scores EARLY above PEAK', () => {
    const early = scoreSeasonality(
      emptyInput({ seasonality: { ...meta(), state: 'EARLY', peakMonths: null } }),
    );
    const peak = scoreSeasonality(
      emptyInput({ seasonality: { ...meta(), state: 'PEAK', peakMonths: null } }),
    );
    // Arriving at peak means listing as demand begins to fall.
    assert.ok((early.value as number) > (peak.value as number));
    assert.equal(early.value, 95);
    assert.equal(peak.value, 70);
  });

  it('does not score an UNKNOWN season state as bad timing', () => {
    const score = scoreSeasonality(
      emptyInput({ seasonality: { ...meta(), state: 'UNKNOWN', peakMonths: null } }),
    );
    assert.equal(score.value, null);
  });

  it('mentions hemispheres when the only pattern is for another country', () => {
    const score = scoreSeasonality(
      emptyInput({
        market: { countryCode: 'AU', region: null, horizonDays: 30 },
        seasonality: {
          ...meta({ countryCode: 'GB', region: null }),
          state: 'PEAK',
          peakMonths: [12],
        },
      }),
    );
    assert.equal(score.value, null);
    assert.ok(score.risks.some((risk) => risk.includes('hemisphere')));
  });

  it('names the peak months when known', () => {
    const score = scoreSeasonality(
      emptyInput({ seasonality: { ...meta(), state: 'RISING', peakMonths: [11, 12] } }),
    );
    assert.ok(score.reasons.some((reason) => reason.includes('November, December')));
  });
});

/* ===========================================================================
 * Fulfillment quality - the measured feedback loop
 * ======================================================================== */

describe('scoreFulfillmentQuality', () => {
  it('does not score a store with no history, rather than scoring it badly', () => {
    const score = scoreFulfillmentQuality(emptyInput());
    assert.equal(score.value, null);
    // A new store has not demonstrated bad fulfillment; zero would say it has.
    assert.notEqual(score.value, 0);
  });

  it('refuses to compute a rate from too small a sample', () => {
    const score = scoreFulfillmentQuality(
      emptyInput({
        fulfillmentHistory: {
          ...meta(),
          sampleSize: MINIMUM_FULFILLMENT_SAMPLE - 1,
          delayRatePercentage: 75,
          refundRatePercentage: 50,
          noTrackingRatePercentage: null,
          averageDeliveryDays: null,
        },
      }),
    );
    assert.equal(score.value, null);
    assert.ok(score.risks.some((risk) => risk.includes('too few orders')));
  });

  it('scores good measured performance as KNOWN - the strongest evidence available', () => {
    const score = scoreFulfillmentQuality(
      emptyInput({
        fulfillmentHistory: {
          ...meta(),
          sampleSize: 120,
          delayRatePercentage: 4,
          refundRatePercentage: 2,
          noTrackingRatePercentage: 1,
          averageDeliveryDays: 7,
        },
      }),
    );
    assert.equal(score.value, 88);
    assert.equal(score.confidence, 'KNOWN');
  });

  it('exposes the gap between the quoted and the measured delivery time', () => {
    const score = scoreFulfillmentQuality(
      emptyInput({
        shippingDays: 7,
        fulfillmentHistory: {
          ...meta(),
          sampleSize: 60,
          delayRatePercentage: 22,
          refundRatePercentage: 4,
          noTrackingRatePercentage: 30,
          averageDeliveryDays: 19,
        },
      }),
    );
    assert.ok(
      score.risks.some((risk) => risk.includes('Plan on the measured figure')),
      'the measured-versus-promised gap is the most useful line here',
    );
    assert.ok(score.risks.some((risk) => risk.includes('never got a tracking number')));
  });
});

/* ===========================================================================
 * Store fit - and the fulfillment penalty it applies
 * ======================================================================== */

const STORE = {
  ...meta(),
  categoryProductCount: 5,
  categoryUnitsSold: 40,
  typicalSellingPriceMin: 10,
  typicalSellingPriceMax: 30,
  priceCurrency: 'GBP',
  categoryRefundRatePercentage: 2,
};

const ECONOMICS = {
  marginPercentage: 40,
  contribution: 8,
  currencyCode: 'GBP',
  costIsManual: false,
  shippingUnknown: false,
  blockedReason: null,
  costObservedAt: OBSERVED,
};

describe('scoreStoreFit', () => {
  it('is not scored without Shopify history', () => {
    const score = scoreStoreFit(emptyInput());
    assert.equal(score.value, null);
    assert.ok(score.risks.some((risk) => risk.includes('this particular store')));
  });

  it('scores a proven category at an in-band price highly', () => {
    const score = scoreStoreFit(
      emptyInput({ storePerformance: STORE, economics: ECONOMICS, expectedSellingPrice: 20 }),
    );
    assert.equal(score.value, 90);
    assert.equal(score.confidence, 'KNOWN');
    assert.ok(score.reasons.some((reason) => reason.includes('inside the store')));
  });

  it('treats a brand-new category as a strategy choice, not a defect', () => {
    const score = scoreStoreFit(
      emptyInput({
        storePerformance: { ...STORE, categoryProductCount: 0, categoryUnitsSold: 0 },
        economics: ECONOMICS,
        expectedSellingPrice: 20,
      }),
    );
    assert.ok(score.value !== null && score.value > 40, 'a new category is not a failure');
    assert.ok(score.risks.some((risk) => risk.includes('strategy choice')));
  });

  it('penalises a price far outside the band the store trades in', () => {
    const inBand = scoreStoreFit(
      emptyInput({ storePerformance: STORE, economics: ECONOMICS, expectedSellingPrice: 20 }),
    );
    const wayAbove = scoreStoreFit(
      emptyInput({ storePerformance: STORE, economics: ECONOMICS, expectedSellingPrice: 180 }),
    );
    assert.ok((wayAbove.value as number) < (inBand.value as number));
    assert.ok(wayAbove.risks.some((risk) => risk.includes('dearer')));
  });

  it('refuses to compare prices across currencies instead of guessing a rate', () => {
    const score = scoreStoreFit(
      emptyInput({
        storePerformance: { ...STORE, priceCurrency: 'INR' },
        economics: ECONOMICS,
        expectedSellingPrice: 20,
      }),
    );
    assert.ok(score.reasons.some((reason) => reason.includes('no exchange rate is configured')));
    assert.ok(score.risks.some((risk) => risk.includes('unassessed rather than guessed')));
  });

  it('leaves price fit unassessed when no price has been chosen', () => {
    const score = scoreStoreFit(
      emptyInput({ storePerformance: STORE, economics: ECONOMICS, expectedSellingPrice: null }),
    );
    assert.ok(score.reasons.some((reason) => reason.includes('No intended selling price')));
  });

  it('LOWERS store fit when comparable products actually deliver badly', () => {
    const clean = scoreStoreFit(
      emptyInput({ storePerformance: STORE, economics: ECONOMICS, expectedSellingPrice: 20 }),
    );
    const bad = scoreStoreFit(
      emptyInput({
        storePerformance: STORE,
        economics: ECONOMICS,
        expectedSellingPrice: 20,
        fulfillmentHistory: {
          ...meta(),
          sampleSize: 40,
          delayRatePercentage: 30,
          refundRatePercentage: 15,
          noTrackingRatePercentage: null,
          averageDeliveryDays: null,
        },
      }),
    );

    // A product this store cannot deliver well does not fit this store, however good
    // the market looks. The penalty is capped at 30 points.
    assert.equal(clean.value, 90);
    assert.equal(bad.value, 60);
    assert.ok(bad.risks.some((risk) => risk.includes('measurably struggled')));
  });

  it('applies no fulfillment penalty below the minimum sample', () => {
    const score = scoreStoreFit(
      emptyInput({
        storePerformance: STORE,
        economics: ECONOMICS,
        expectedSellingPrice: 20,
        fulfillmentHistory: {
          ...meta(),
          sampleSize: 4,
          delayRatePercentage: 100,
          refundRatePercentage: 100,
          noTrackingRatePercentage: null,
          averageDeliveryDays: null,
        },
      }),
    );
    // Four orders cannot be allowed to erase a proven category fit.
    assert.equal(score.value, 90);
  });

  it('inherits a category refund problem as a stated risk', () => {
    const score = scoreStoreFit(
      emptyInput({
        storePerformance: { ...STORE, categoryRefundRatePercentage: 14 },
        economics: ECONOMICS,
        expectedSellingPrice: 20,
      }),
    );
    assert.ok(score.risks.some((risk) => risk.includes('inherits that problem')));
  });
});

/* ===========================================================================
 * Weight validation
 * ======================================================================== */

describe('validateWeights', () => {
  it('accepts the shipped defaults', () => {
    assert.deepEqual(validateWeights({ ...DEFAULT_SCORE_WEIGHTS }), []);
  });

  it('has the seven weighted factors sum to 100, with fulfillmentQuality reported only', () => {
    const total = Object.values(DEFAULT_SCORE_WEIGHTS).reduce((sum, weight) => sum + weight, 0);
    assert.equal(total, 100);
    // Zero because storeFit applies the fulfillment penalty; weighting it here as well
    // would count the same evidence twice.
    assert.equal(DEFAULT_SCORE_WEIGHTS.fulfillmentQuality, 0);
  });

  it('rejects negative and non-finite weights, reporting every problem at once', () => {
    const problems = validateWeights({
      ...DEFAULT_SCORE_WEIGHTS,
      demand: -1,
      trend: Number.NaN,
    });
    assert.equal(problems.length, 2);
    assert.ok(problems.some((problem) => problem.includes('demand')));
    assert.ok(problems.some((problem) => problem.includes('trend')));
  });

  it('rejects an all-zero weight set, which could score nothing', () => {
    const zeroed = Object.fromEntries(
      Object.keys(DEFAULT_SCORE_WEIGHTS).map((factor) => [factor, 0]),
    ) as typeof DEFAULT_SCORE_WEIGHTS;
    assert.ok(validateWeights({ ...zeroed }).length > 0);
  });
});
