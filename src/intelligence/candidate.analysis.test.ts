/**
 * The join between pricing and scoring.
 *
 * This is where a refusal is most likely to be lost. recommendPrice() declines to price
 * an unknown cost or a currency mismatch; if that arrives at the scorer as merely a
 * missing margin, the operator sees "profitability not scored - no data" instead of
 * "your supplier cost is in USD and your price is in GBP". Same score, completely
 * different action.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEFAULT_PRICING_POLICY, type PricingPolicy } from '../pricing/recommendation';
import { analyseCandidate, economicsForScoring, researchRequestFor } from './candidate.analysis';
import {
  EMPTY_MANUAL_RESEARCH,
  type ManualResearchEntry,
  type ProductCandidate,
} from './candidate.types';
import { gatherSignals, type ResearchSignals } from './providers/provider.types';
import { staticResearchProviders } from './providers/registry';

const NOW = new Date('2026-06-15T12:00:00.000Z');
const OBSERVED = '2026-06-14T00:00:00.000Z';

type AnalysableCandidate = Pick<
  ProductCandidate,
  'title' | 'category' | 'keywords' | 'market' | 'commercials' | 'manualResearch'
>;

function manual(overrides: Partial<ManualResearchEntry> = {}): ManualResearchEntry {
  return {
    ...EMPTY_MANUAL_RESEARCH,
    averageMonthlySearches: 12_000,
    momentumPercentage: 20,
    competitionIndex: 40,
    seasonState: 'RISING',
    observedAt: OBSERVED,
    geography: { countryCode: 'GB', region: null },
    ...overrides,
  };
}

function candidate(overrides: Partial<AnalysableCandidate> = {}): AnalysableCandidate {
  return {
    title: 'Portable neck fan',
    category: 'Home',
    keywords: ['neck fan'],
    market: { countryCode: 'GB', region: null, horizonDays: 30 },
    commercials: {
      supplierCost: 10,
      supplierCurrency: 'GBP',
      shippingCost: 2,
      shippingCurrency: 'GBP',
      shippingDays: 8,
      expectedSellingPrice: null,
      expectedSellingCurrency: 'GBP',
      costObservedAt: OBSERVED,
    },
    manualResearch: manual(),
    ...overrides,
  };
}

/** Signals as the real providers would produce them from the manual entry. */
function signalsFor(entry: ManualResearchEntry): ResearchSignals {
  return gatherSignals(staticResearchProviders, {
    market: { countryCode: 'GB', region: null, horizonDays: 30 },
    keywords: ['neck fan'],
    title: 'Portable neck fan',
    category: 'Home',
    manualResearch: entry,
    now: NOW,
  });
}

function analyse(overrides: Partial<AnalysableCandidate> = {}, policy?: PricingPolicy) {
  const subject = candidate(overrides);
  return analyseCandidate({
    candidate: subject,
    signals: signalsFor(subject.manualResearch),
    ...(policy === undefined ? {} : { policy }),
    now: NOW,
  });
}

/* ===========================================================================
 * End to end
 * ======================================================================== */

describe('analyseCandidate', () => {
  it('scores a candidate from operator figures plus a recommended price', () => {
    const result = analyse();

    assert.ok(result.score.overallScore !== null);
    assert.ok(result.pricing.blockedReason === null);
    // Priced from a 12.00 landed cost, exactly as the pricing tests establish.
    assert.equal(result.pricing.landedCost, 12);
    assert.equal(result.score.recommendation !== null, true);
  });

  it('is deterministic', () => {
    assert.deepEqual(analyse(), analyse());
  });

  it('prices FIRST, then scores profitability from the resulting margin', () => {
    const result = analyse();
    const profitability = result.score.factors.find(
      (factor) => factor.factor === 'profitability',
    );
    const balanced = result.pricing.scenarios.find((entry) => entry.name === 'BALANCED');

    assert.ok(profitability?.value !== null);
    assert.ok(
      profitability?.reasons.some((reason) =>
        reason.includes(`${(balanced?.marginPercentage as number).toFixed(1)}%`),
      ),
      'the scored margin must be the one the price actually achieves',
    );
  });

  it('never claims a cost was observed, because every cost here is typed in', () => {
    const result = analyse();
    const profitability = result.score.factors.find(
      (factor) => factor.factor === 'profitability',
    );
    // ESTIMATED, not KNOWN. The margin is exactly as good as the number the operator
    // typed, and the margin decides whether money is spent.
    assert.equal(profitability?.confidence, 'ESTIMATED');
    assert.equal(result.confidence, 'ESTIMATED');
    assert.ok(
      profitability?.risks.some((risk) => risk.includes('entered by hand')),
    );
  });

  it('carries pricing warnings up to the analysis', () => {
    const result = analyse({
      commercials: { ...candidate().commercials, shippingCost: null, shippingCurrency: null },
    });
    // An operator reading only the score would otherwise never learn the margin
    // excludes shipping.
    assert.ok(result.warnings.some((warning) => warning.includes('upper bound')));
  });
});

/* ===========================================================================
 * Refusals crossing the boundary
 * ======================================================================== */

describe('refusals survive the pricing-to-scoring boundary', () => {
  it('reports an unknown supplier cost as a specific refusal, not a missing factor', () => {
    const result = analyse({
      commercials: { ...candidate().commercials, supplierCost: null, supplierCurrency: null },
    });

    const profitability = result.score.factors.find(
      (factor) => factor.factor === 'profitability',
    );
    assert.equal(profitability?.value, null);
    assert.ok(
      profitability?.reasons.some((reason) => reason.includes('not a zero cost')),
      'the reason must name the actual problem',
    );
    // And the rest of the candidate is still judged.
    assert.ok(result.score.overallScore !== null);
  });

  it('propagates CURRENCY_MISMATCH into the score\u2019s reasons', () => {
    const result = analyse({
      commercials: {
        ...candidate().commercials,
        supplierCurrency: 'USD',
        shippingCurrency: 'USD',
        expectedSellingCurrency: 'GBP',
      },
    });

    assert.ok(result.pricing.blockedReason?.includes('CURRENCY_MISMATCH'));
    const profitability = result.score.factors.find(
      (factor) => factor.factor === 'profitability',
    );
    assert.equal(profitability?.value, null);
    assert.ok(profitability?.reasons.some((reason) => reason.includes('CURRENCY_MISMATCH')));
    assert.ok(result.score.risks.some((risk) => risk.includes('CURRENCY_MISMATCH')));
  });

  it('never turns an unknown cost into a zero-scored factor', () => {
    const known = analyse();
    const unknown = analyse({
      commercials: { ...candidate().commercials, supplierCost: null, supplierCurrency: null },
    });

    const factor = unknown.score.factors.find((entry) => entry.factor === 'profitability');
    assert.notEqual(factor?.value, 0);
    // Excluded, so the overall score barely moves rather than dropping ~16 points.
    assert.ok(
      Math.abs((unknown.score.overallScore as number) - (known.score.overallScore as number)) < 6,
    );
    // The cost is paid in confidence, which is the honest place for it.
    assert.ok(unknown.score.confidenceScore < known.score.confidenceScore);
  });
});

/* ===========================================================================
 * economicsForScoring
 * ======================================================================== */

describe('economicsForScoring', () => {
  const commercials = candidate().commercials;

  it('reports shipping as unknown when it was not included', () => {
    const result = analyse({
      commercials: { ...commercials, shippingCost: null, shippingCurrency: null },
    });
    const economics = result.scoringInput.economics;
    assert.equal(economics?.shippingUnknown, true);
  });

  it('carries the cost observation date through, so the margin can age', () => {
    const result = analyse();
    // Without this the profitability evidence would always be UNKNOWN freshness, and a
    // six-month-old cost would look as current as one recorded today.
    assert.equal(result.scoringInput.economics?.costObservedAt, OBSERVED);
    const evidence = result.score.evidence.find((item) => item.code === 'CONTRIBUTION_MARGIN');
    assert.equal(evidence?.freshness, 'FRESH');
  });

  it('scores the Balanced scenario by default, not the flattering Premium one', () => {
    const result = analyse();
    const balanced = result.pricing.scenarios.find((entry) => entry.name === 'BALANCED');
    assert.equal(result.scoringInput.economics?.marginPercentage, balanced?.marginPercentage);
  });

  it('can be pointed at another scenario deliberately', () => {
    const subject = candidate();
    const premium = analyseCandidate({
      candidate: subject,
      signals: signalsFor(subject.manualResearch),
      pricingScenario: 'PREMIUM',
      now: NOW,
    });
    const premiumScenario = premium.pricing.scenarios.find((entry) => entry.name === 'PREMIUM');
    assert.equal(
      premium.scoringInput.economics?.marginPercentage,
      premiumScenario?.marginPercentage,
    );
  });

  it('surfaces a blocked recommendation verbatim rather than as a null margin', () => {
    const economics = economicsForScoring(
      {
        currencyCode: 'GBP',
        landedCost: null,
        shippingIncluded: false,
        policy: { ...DEFAULT_PRICING_POLICY },
        scenarios: [],
        recommended: null,
        blockedReason: 'CURRENCY_MISMATCH: costs are in USD.',
        warnings: [],
        notes: [],
      },
      commercials,
    );
    assert.equal(economics?.blockedReason, 'CURRENCY_MISMATCH: costs are in USD.');
    assert.equal(economics?.marginPercentage, null);
  });
});

/* ===========================================================================
 * Store fit price
 * ======================================================================== */

describe('the price store fit is judged against', () => {
  it('prefers the operator\u2019s intended price over the recommendation', () => {
    const result = analyse({
      commercials: { ...candidate().commercials, expectedSellingPrice: 34.99 },
    });
    // Store fit asks whether THEIR plan suits this store, not whether ours does.
    assert.equal(result.scoringInput.expectedSellingPrice, 34.99);
  });

  it('falls back to the recommended scenario when they have no price in mind', () => {
    const result = analyse();
    const recommended = result.pricing.scenarios.find(
      (entry) => entry.name === result.pricing.recommended,
    );
    assert.equal(result.scoringInput.expectedSellingPrice, recommended?.price);
  });

  it('leaves it null when nothing could be priced at all', () => {
    const result = analyse({
      commercials: { ...candidate().commercials, supplierCost: null, supplierCurrency: null },
    });
    assert.equal(result.scoringInput.expectedSellingPrice, null);
  });
});

/* ===========================================================================
 * Missing-capability warnings
 * ======================================================================== */

describe('warnings about what could not be measured', () => {
  it('says the score is about the market only when store history is missing', () => {
    const result = analyse();
    // No Shopify provider was registered in these tests, so store fit is unscored.
    assert.ok(result.score.unscoredFactors.includes('storeFit'));
    assert.ok(
      result.warnings.some((warning) => warning.includes('says nothing about whether the product suits THIS store')),
    );
  });

  it('says a quoted transit time is a promise when there is no delivery record', () => {
    const result = analyse();
    assert.ok(result.warnings.some((warning) => warning.includes('promise rather than a result')));
  });

  it('warns loudly when neither demand nor trend could be established', () => {
    const result = analyse({ manualResearch: { ...EMPTY_MANUAL_RESEARCH } });
    assert.ok(
      result.warnings.some((warning) =>
        warning.includes('Nothing here indicates whether anyone is looking for this product'),
      ),
    );
  });

  it('does not duplicate a warning that both engines raise', () => {
    const result = analyse({
      commercials: { ...candidate().commercials, shippingCost: null, shippingCurrency: null },
    });
    assert.equal(new Set(result.warnings).size, result.warnings.length);
  });
});

/* ===========================================================================
 * Request narrowing
 * ======================================================================== */

describe('researchRequestFor', () => {
  it('passes providers only what they need', () => {
    const subject = candidate();
    const request = researchRequestFor(subject, subject.manualResearch, NOW);

    assert.deepEqual(Object.keys(request).sort(), [
      'category',
      'keywords',
      'manualResearch',
      'market',
      'now',
      'title',
    ]);
    // Notably absent: the previous score. A provider that could read it could feed a
    // score back into itself.
    assert.ok(!Object.prototype.hasOwnProperty.call(request, 'overallScore'));
    assert.ok(!Object.prototype.hasOwnProperty.call(request, 'commercials'));
  });
});
