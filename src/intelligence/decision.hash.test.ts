/**
 * The decision hash.
 *
 * Two failure modes, both bad in opposite directions:
 *
 *   TOO SENSITIVE  the hash moves when nothing material changed, so the operator gets
 *                  RECOMMENDATION_CHANGED on a candidate nobody touched, learns the
 *                  refusal is noise, and starts clicking through it.
 *   TOO BLUNT      the hash stays put when the recommendation or the price moved, so a
 *                  product is created on a decision nobody approved. This is the one
 *                  that costs money.
 *
 * Almost every test here is therefore of the form "this must change the hash" or "this
 * must NOT change the hash".
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEFAULT_PRICING_POLICY, recommendPrice, type PricingPolicy } from '../pricing/recommendation';
import {
  EMPTY_MANUAL_RESEARCH,
  type ProductCandidate,
} from './candidate.types';
import {
  DECISION_HASH_VERSION,
  computeDecisionHash,
  decisionMaterial,
  type DecisionHashInput,
} from './decision.hash';
import { scoreCandidate, type CandidateScore } from './scoring/scoring.service';
import type { ScoringInput } from './scoring/scoring.types';

const NOW = new Date('2026-06-15T12:00:00.000Z');
const OBSERVED = '2026-06-14T00:00:00.000Z';

function candidate(overrides: Partial<ProductCandidate> = {}): ProductCandidate {
  return {
    id: 'cand-1',
    source: 'MANUAL',
    sourceProductId: 'TRD-1',
    sourceUrl: null,
    title: 'Portable neck fan',
    category: 'Home',
    imageUrl: null,
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
    manualResearch: {
      ...EMPTY_MANUAL_RESEARCH,
      averageMonthlySearches: 12_000,
      momentumPercentage: 20,
      observedAt: OBSERVED,
      geography: { countryCode: 'GB', region: null },
    },
    factors: [],
    overallScore: null,
    confidenceScore: null,
    recommendation: null,
    seasonState: 'UNKNOWN',
    reasons: [],
    risks: [],
    evidence: [],
    freshness: 'UNKNOWN',
    status: 'ANALYZED',
    pushState: 'IDLE',
    pushOperationId: null,
    pushClaimedAt: null,
    pushSafetyReason: null,
    pushedShopifyProductId: null,
    watchUntil: null,
    scoreHistory: [],
    notes: null,
    createdAt: OBSERVED,
    analyzedAt: OBSERVED,
    updatedAt: OBSERVED,
    inputRevision: 3,
    analyzedInputRevision: 3,
    ...overrides,
  };
}

/** A real score, from the real engine, so the hashed shape is the real shape. */
function scoreFor(subject: ProductCandidate, now: Date = NOW): CandidateScore {
  const input: ScoringInput = {
    market: subject.market,
    demand:
      subject.manualResearch.averageMonthlySearches === null
        ? null
        : {
            source: 'Operator entry',
            geography: subject.manualResearch.geography,
            observedAt: subject.manualResearch.observedAt,
            fetchedAt: null,
            averageMonthlySearches: subject.manualResearch.averageMonthlySearches,
          },
    trend: null,
    competition: null,
    seasonality: null,
    storePerformance: null,
    fulfillmentHistory: null,
    economics: {
      marginPercentage: 44.89,
      contribution: 10.32,
      currencyCode: 'GBP',
      costIsManual: true,
      shippingUnknown: false,
      blockedReason: null,
      costObservedAt: subject.commercials.costObservedAt,
    },
    shippingDays: subject.commercials.shippingDays,
    shippingDaysObservedAt: subject.commercials.costObservedAt,
    expectedSellingPrice: 22.99,
    category: subject.category,
    now,
  };
  return scoreCandidate(input);
}

function pricingFor(subject: ProductCandidate, policy: PricingPolicy = DEFAULT_PRICING_POLICY) {
  return recommendPrice({
    supplierCost: subject.commercials.supplierCost,
    supplierCurrency: subject.commercials.supplierCurrency,
    shippingCost: subject.commercials.shippingCost,
    shippingCurrency: subject.commercials.shippingCurrency,
    sellingCurrency: subject.commercials.expectedSellingCurrency,
    policy,
  });
}

function decision(
  subject: ProductCandidate = candidate(),
  policy: PricingPolicy = DEFAULT_PRICING_POLICY,
  now: Date = NOW,
): DecisionHashInput {
  return {
    candidate: subject,
    score: scoreFor(subject, now),
    pricing: pricingFor(subject, policy),
    policy,
  };
}

/* ===========================================================================
 * Determinism
 * ======================================================================== */

describe('the hash is deterministic', () => {
  it('is stable across calls with identical input', () => {
    assert.equal(computeDecisionHash(decision()), computeDecisionHash(decision()));
  });

  it('is a sha256 hex digest', () => {
    assert.match(computeDecisionHash(decision()), /^[0-9a-f]{64}$/);
  });

  it('does not depend on object property ORDER', () => {
    // stableStringify rather than JSON.stringify. Property order is not a difference,
    // and an unstable serialisation would produce mismatches depending on how the
    // objects happened to be built.
    const base = decision();
    const reordered: DecisionHashInput = {
      policy: base.policy,
      pricing: base.pricing,
      score: base.score,
      candidate: base.candidate,
    };
    assert.equal(computeDecisionHash(base), computeDecisionHash(reordered));
  });

  it('records the hash version, so a change to the hashed SET is traceable', () => {
    // Without a version, adding a field to the hash would invalidate every hash a client
    // is holding and the operator would see an unexplained 409.
    assert.equal(decisionMaterial(decision())['v'], DECISION_HASH_VERSION);
  });
});

/* ===========================================================================
 * The load-bearing exclusion
 * ======================================================================== */

describe('time alone does not change the decision', () => {
  it('is unchanged when only `now` moves within a freshness band', () => {
    /*
     * The exclusion that makes the whole mechanism usable. profitability stamps its
     * evidence with `fetchedAt: now`, so hashing fetchedAt would change the hash on every
     * single call and EVERY push would fail with RECOMMENDATION_CHANGED.
     *
     * Two minutes later, same data, same freshness band: same decision.
     */
    const early = computeDecisionHash(decision(candidate(), DEFAULT_PRICING_POLICY, NOW));
    const later = computeDecisionHash(
      decision(candidate(), DEFAULT_PRICING_POLICY, new Date(NOW.getTime() + 120_000)),
    );
    assert.equal(early, later);
  });

  it('DOES change when ageing crosses a freshness boundary', () => {
    // Not a false positive: crossing a boundary genuinely lowers the confidence score, so
    // the decision really did move and refusing is correct. KEYWORD_METRICS ages to
    // AGING after 7 days and STALE after 30.
    const fresh = computeDecisionHash(decision(candidate(), DEFAULT_PRICING_POLICY, NOW));
    const stale = computeDecisionHash(
      decision(
        candidate(),
        DEFAULT_PRICING_POLICY,
        new Date(NOW.getTime() + 60 * 24 * 3_600_000),
      ),
    );
    assert.notEqual(fresh, stale);
  });
});

/* ===========================================================================
 * Must change the hash
 * ======================================================================== */

describe('material changes move the hash', () => {
  const base = computeDecisionHash(decision());

  it('a supplier cost change', () => {
    const subject = candidate();
    assert.notEqual(
      computeDecisionHash(
        decision({ ...subject, commercials: { ...subject.commercials, supplierCost: 14 } }),
      ),
      base,
    );
  });

  it('a supplier CURRENCY change', () => {
    const subject = candidate();
    assert.notEqual(
      computeDecisionHash(
        decision({
          ...subject,
          commercials: { ...subject.commercials, supplierCurrency: 'USD' },
        }),
      ),
      base,
    );
  });

  it('a manual demand figure change', () => {
    const subject = candidate();
    assert.notEqual(
      computeDecisionHash(
        decision({
          ...subject,
          manualResearch: { ...subject.manualResearch, averageMonthlySearches: 900 },
        }),
      ),
      base,
    );
  });

  it('a target market change', () => {
    const subject = candidate();
    assert.notEqual(
      computeDecisionHash(
        decision({ ...subject, market: { ...subject.market, countryCode: 'IN' } }),
      ),
      base,
    );
  });

  it('a MINIMUM MARGIN change, with the candidate untouched', () => {
    /*
     * The case candidate.inputRevision cannot see at all. The operator changed the store
     * settings, not the candidate, so nothing on the candidate row moved - but a price
     * they approved may now breach the floor. This is why the push gate is a decision
     * hash and not a revision comparison.
     */
    assert.notEqual(
      computeDecisionHash(
        decision(candidate(), { ...DEFAULT_PRICING_POLICY, minimumMarginPercentage: 40 }),
      ),
      base,
    );
  });

  it('a target margin change, which moves every scenario price', () => {
    assert.notEqual(
      computeDecisionHash(
        decision(candidate(), { ...DEFAULT_PRICING_POLICY, targetMarginPercentage: 55 }),
      ),
      base,
    );
  });

  it('a pricing STRATEGY change', () => {
    assert.notEqual(
      computeDecisionHash(
        decision(candidate(), { ...DEFAULT_PRICING_POLICY, strategy: 'MARKUP_MULTIPLIER' }),
      ),
      base,
    );
  });

  it('a rounding change, because it changes the listed price', () => {
    assert.notEqual(
      computeDecisionHash(decision(candidate(), { ...DEFAULT_PRICING_POLICY, rounding: 'integer' })),
      base,
    );
  });

  it('an advertising allowance change', () => {
    assert.notEqual(
      computeDecisionHash(
        decision(candidate(), { ...DEFAULT_PRICING_POLICY, advertisingAllowancePercentage: 15 }),
      ),
      base,
    );
  });

  it('a changed SCORE, even at an identical candidate and policy', () => {
    // Simulates store-derived signals moving: same inputs, different result.
    const material = decision();
    const bumped: DecisionHashInput = {
      ...material,
      score: { ...material.score, overallScore: 91 },
    };
    assert.notEqual(computeDecisionHash(bumped), base);
  });

  it('a changed RECOMMENDATION', () => {
    const material = decision();
    // Derived rather than hard-coded: asserting a change to a literal only works if the
    // fixture does not already hold that literal, and this one did.
    const other = material.score.recommendation === 'WATCH' ? 'STRONG_CANDIDATE' : 'WATCH';
    const bumped: DecisionHashInput = {
      ...material,
      score: { ...material.score, recommendation: other },
    };
    assert.notEqual(material.score.recommendation, other, 'the fixture must actually change');
    assert.notEqual(computeDecisionHash(bumped), base);
  });

  it('a changed CONFIDENCE score', () => {
    const material = decision();
    const bumped: DecisionHashInput = {
      ...material,
      score: { ...material.score, confidenceScore: 12 },
    };
    assert.notEqual(computeDecisionHash(bumped), base);
  });

  it('a recommendation that was DOWNGRADED rather than reached directly', () => {
    // Different decision: it tells the operator the score was held back for low
    // confidence, which is exactly what they are being asked to approve.
    const material = decision();
    const bumped: DecisionHashInput = {
      ...material,
      // Flipped, not set: the fixture already scores low enough to be downgraded.
      score: {
        ...material.score,
        recommendationDowngraded: !material.score.recommendationDowngraded,
      },
    };
    assert.notEqual(computeDecisionHash(bumped), base);
  });

  it('a changed EVIDENCE VALUE - this is how live store history is caught', () => {
    /*
     * The store's category sales or delivery record changing does not touch the candidate
     * row, and would be invisible to any candidate-side revision. It surfaces as a
     * different evidence VALUE, which is why evidence values are hashed.
     */
    const material = decision();
    const first = material.score.evidence[0];
    if (first === undefined) throw new Error('expected evidence to hash');
    const bumped: DecisionHashInput = {
      ...material,
      score: {
        ...material.score,
        evidence: [{ ...first, value: '40 unit(s) sold' }, ...material.score.evidence.slice(1)],
      },
    };
    assert.notEqual(computeDecisionHash(bumped), base);
  });

  it('a factor becoming unscored', () => {
    const material = decision();
    const bumped: DecisionHashInput = {
      ...material,
      score: {
        ...material.score,
        factors: material.score.factors.map((factor) =>
          factor.factor === 'demand' ? { ...factor, value: null } : factor,
        ),
      },
    };
    assert.notEqual(computeDecisionHash(bumped), base);
  });
});

/* ===========================================================================
 * Must NOT change the hash
 * ======================================================================== */

describe('cosmetic and bookkeeping changes leave the hash alone', () => {
  const base = computeDecisionHash(decision());

  it('a note', () => {
    assert.equal(computeDecisionHash(decision(candidate({ notes: 'call supplier' }))), base);
  });

  it('a watch date and a status change', () => {
    assert.equal(
      computeDecisionHash(
        decision(candidate({ status: 'WATCHING', watchUntil: '2026-09-01T00:00:00.000Z' })),
      ),
      base,
    );
  });

  it('an image or source URL', () => {
    assert.equal(
      computeDecisionHash(
        decision(
          candidate({ imageUrl: 'https://example.test/a.jpg', sourceUrl: 'https://x.test' }),
        ),
      ),
      base,
    );
  });

  it('timestamps and score history', () => {
    assert.equal(
      computeDecisionHash(
        decision(
          candidate({
            updatedAt: '2027-01-01T00:00:00.000Z',
            scoreHistory: [
              {
                at: '2026-01-01T00:00:00.000Z',
                overallScore: 50,
                confidenceScore: 50,
                recommendation: 'WATCH',
                note: null,
              },
            ],
          }),
        ),
      ),
      base,
    );
  });

  it('reworded reasons and risks', () => {
    // Prose generated FROM the numbers. Rewording a sentence in a future release must not
    // invalidate every decision hash in flight.
    const material = decision();
    const reworded: DecisionHashInput = {
      ...material,
      score: {
        ...material.score,
        reasons: ['completely different wording'],
        risks: ['also different'],
      },
    };
    assert.equal(computeDecisionHash(reworded), base);
  });

  it('a reworded scenario intent or pricing note', () => {
    const material = decision();
    const reworded: DecisionHashInput = {
      ...material,
      pricing: {
        ...material.pricing,
        notes: ['different note'],
        warnings: ['different warning'],
        scenarios: material.pricing.scenarios.map((scenario) => ({
          ...scenario,
          intent: 'reworded intent',
          reasons: ['reworded'],
          label: scenario.label,
        })),
      },
    };
    assert.equal(computeDecisionHash(reworded), base);
  });

  it('keyword reordering and case', () => {
    assert.equal(
      computeDecisionHash(decision(candidate({ keywords: ['NECK FAN'] }))),
      base,
    );
  });

  it('evidence ORDER', () => {
    // Providers are gathered in a fixed order today, but a future reorder or a paginated
    // read must not read as a changed decision.
    const material = decision();
    const reversed: DecisionHashInput = {
      ...material,
      score: { ...material.score, evidence: [...material.score.evidence].reverse() },
    };
    assert.equal(computeDecisionHash(reversed), base);
  });

  it('scenario ORDER', () => {
    const material = decision();
    const reversed: DecisionHashInput = {
      ...material,
      pricing: { ...material.pricing, scenarios: [...material.pricing.scenarios].reverse() },
    };
    assert.equal(computeDecisionHash(reversed), base);
  });

  it('float noise in a price', () => {
    // Money is hashed as a fixed-precision string, so 22.99 and 22.990000000000002 are
    // the same price. A hash that disagreed would produce a 409 nobody could explain.
    const material = decision();
    const noisy: DecisionHashInput = {
      ...material,
      pricing: {
        ...material.pricing,
        scenarios: material.pricing.scenarios.map((scenario) => ({
          ...scenario,
          price: scenario.price + 0.000000000000002,
        })),
      },
    };
    assert.equal(computeDecisionHash(noisy), base);
  });
});

/* ===========================================================================
 * The canonical form
 * ======================================================================== */

describe('decisionMaterial', () => {
  it('excludes fetchedAt from every evidence entry', () => {
    // Asserted structurally as well as behaviourally: this is the one exclusion whose
    // removal would break every push, so it is worth catching at the shape level too.
    const material = decisionMaterial(decision());
    const evidence = material['ev'] as Record<string, unknown>[];
    assert.ok(evidence.length > 0, 'expected evidence to be hashed at all');
    for (const entry of evidence) {
      assert.ok(!('fetchedAt' in entry));
      // The keys it DOES carry: code, value, confidence, observedAt, freshness.
      assert.deepEqual(Object.keys(entry).sort(), ['c', 'f', 'k', 'o', 'v']);
    }
  });

  it('carries both floors, so tightening one invalidates an approved price', () => {
    const policy = { ...DEFAULT_PRICING_POLICY, minimumMarginPercentage: 22, minimumProfitAmount: 4 };
    const material = decisionMaterial(decision(candidate(), policy));
    const hashedPolicy = material['policy'] as Record<string, unknown>;
    assert.equal(hashedPolicy['fm'], '22.0');
    assert.equal(hashedPolicy['fp'], '4.00');
  });

  it('is JSON-serialisable, so it can be logged when a mismatch surprises someone', () => {
    assert.doesNotThrow(() => JSON.stringify(decisionMaterial(decision())));
  });
});
