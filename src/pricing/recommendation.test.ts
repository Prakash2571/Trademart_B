/**
 * Price recommendation.
 *
 * Expected prices below are hand-derived from the published formulas so the tests
 * check the arithmetic rather than merely recording whatever the code produced.
 * Worked example, used throughout: supplier cost 10.00, supplier shipping 2.00,
 * landed cost 12.00, 2.9% payment fees, charm99 rounding.
 *
 *   target margin 45%  ->  12 / (1 - (2.9 + 45)/100) = 12 / 0.521 = 23.03
 *                      ->  charm99 rounds DOWN to 22.99
 *                      ->  at 22.99 the payment fee is 0.67, so cost is 12.67,
 *                          contribution 10.32 and margin 44.89%
 *
 * The rounding-down step is the interesting one: it is why the floors are re-checked
 * after rounding rather than only when the target is solved.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_PRICING_POLICY,
  SCENARIO_ORDER,
  recommendPrice,
  resolvePricingPolicy,
  validatePricingPolicy,
  type PricingPolicy,
  type PricingScenario,
  type PricingScenarioName,
  type PriceRecommendationInput,
} from './recommendation';

/** The worked example. Tests override single fields. */
function input(overrides: Partial<PriceRecommendationInput> = {}): PriceRecommendationInput {
  return {
    supplierCost: 10,
    supplierCurrency: 'GBP',
    shippingCost: 2,
    shippingCurrency: 'GBP',
    sellingCurrency: 'GBP',
    ...overrides,
  };
}

function policy(overrides: Partial<PricingPolicy> = {}): PricingPolicy {
  return { ...DEFAULT_PRICING_POLICY, ...overrides };
}

function scenario(
  result: ReturnType<typeof recommendPrice>,
  name: PricingScenarioName,
): PricingScenario {
  const found = result.scenarios.find((entry) => entry.name === name);
  // A throw rather than assert.ok: it narrows the return type, which assert's
  // assertion signature does not do reliably through a helper's inferred return.
  if (found === undefined) throw new Error(`expected a ${name} scenario`);
  return found;
}

/* ===========================================================================
 * The three scenarios
 * ======================================================================== */

describe('recommendPrice produces three scenarios', () => {
  it('returns Conservative, Balanced and Premium in that order', () => {
    const result = recommendPrice(input());
    assert.deepEqual(
      result.scenarios.map((entry) => entry.name),
      [...SCENARIO_ORDER],
    );
    assert.equal(result.blockedReason, null);
  });

  it('prices them in ascending order, each with a real margin and contribution', () => {
    const result = recommendPrice(input());
    const conservative = scenario(result, 'CONSERVATIVE');
    const balanced = scenario(result, 'BALANCED');
    const premium = scenario(result, 'PREMIUM');

    // Hand-derived: 35% -> 19.32 -> 18.99, 45% -> 23.03 -> 22.99, 57% -> 29.93 -> 28.99
    assert.equal(conservative.price, 18.99);
    assert.equal(balanced.price, 22.99);
    assert.equal(premium.price, 28.99);

    assert.equal(balanced.marginPercentage, 44.89);
    assert.equal(balanced.contribution, 10.32);
    assert.equal(balanced.returnOnCostPercentage, 81.45);

    assert.ok(conservative.price < balanced.price);
    assert.ok(balanced.price < premium.price);
  });

  it('solves for the margin AFTER percentage costs, not before', () => {
    const result = recommendPrice(input());
    const balanced = scenario(result, 'BALANCED');
    // A naive cost/(1 - 0.45) would give 21.82 and a margin under 43% once the
    // payment fee is taken. The engine solves for both at once.
    assert.notEqual(balanced.price, 21.82);
    assert.ok((balanced.marginPercentage as number) > 44);
  });

  it('states the landed cost it priced from', () => {
    const result = recommendPrice(input());
    assert.equal(result.landedCost, 12);
    assert.equal(result.shippingIncluded, true);
    assert.ok(result.notes.some((note) => note.includes('landed cost of 12.00 GBP')));
  });

  it('recommends Balanced when it is viable, without second-guessing the target', () => {
    const result = recommendPrice(input());
    assert.equal(result.recommended, 'BALANCED');
  });

  it('explains each scenario, including what it is for', () => {
    const result = recommendPrice(input());
    const premium = scenario(result, 'PREMIUM');
    assert.ok(premium.intent.includes('margin over volume'));
    assert.ok(premium.reasons.some((reason) => reason.includes('Solved for a 57.0% margin')));
    assert.ok(premium.reasons.some((reason) => reason.includes('Rounded to 28.99 (charm99)')));
  });

  it('is deterministic', () => {
    assert.deepEqual(recommendPrice(input()), recommendPrice(input()));
  });
});

/* ===========================================================================
 * Markup and uplift strategies
 * ======================================================================== */

describe('markup strategy', () => {
  it('applies the multiplier to the landed cost and varies it per scenario', () => {
    const result = recommendPrice(input({ policy: policy({ strategy: 'MARKUP_MULTIPLIER' }) }));
    // 12 x 2.1 = 25.20 -> 24.99, 12 x 2.5 = 30.00 -> 29.99, 12 x 3.1 = 37.20 -> 36.99
    assert.equal(scenario(result, 'CONSERVATIVE').price, 24.99);
    assert.equal(scenario(result, 'BALANCED').price, 29.99);
    assert.equal(scenario(result, 'PREMIUM').price, 36.99);
  });

  it('says plainly that a markup is not a margin', () => {
    const result = recommendPrice(input({ policy: policy({ strategy: 'MARKUP_MULTIPLIER' }) }));
    const balanced = scenario(result, 'BALANCED');
    // 2.5x sounds like 60% and is not: at 29.99 the margin is 57.09% before ads.
    assert.equal(balanced.marginPercentage, 57.09);
    assert.ok(balanced.reasons.some((reason) => reason.includes('A markup is not a margin')));
    assert.ok(result.notes.some((note) => note.includes('A markup is not a margin')));
  });
});

describe('fixed uplift strategy', () => {
  it('adds a flat amount, scaled per scenario', () => {
    const result = recommendPrice(input({ policy: policy({ strategy: 'FIXED_UPLIFT' }) }));
    // 12 + 7.50 = 19.50 -> 18.99, 12 + 10 = 22.00 -> 21.99, 12 + 13.50 = 25.50 -> 24.99
    assert.equal(scenario(result, 'CONSERVATIVE').price, 18.99);
    assert.equal(scenario(result, 'BALANCED').price, 21.99);
    assert.equal(scenario(result, 'PREMIUM').price, 24.99);
  });
});

/* ===========================================================================
 * Floors WARN, they do not silently rewrite
 * ======================================================================== */

describe('profit guards', () => {
  it('reports a scenario that breaches the margin floor instead of raising it quietly', () => {
    // charm99 rounds 21.02 down to 20.99, which yields 39.92% - eight hundredths of a
    // point under a 40% floor. Exactly the case a post-rounding check exists for.
    const result = recommendPrice(input({ policy: policy({ minimumMarginPercentage: 40 }) }));
    const conservative = scenario(result, 'CONSERVATIVE');

    assert.equal(conservative.price, 20.99);
    assert.equal(conservative.marginPercentage, 39.92);
    assert.equal(conservative.viable, false);
    assert.equal(conservative.guardBreaches.length, 1);
    assert.ok(conservative.guardBreaches[0]?.includes('below the 40% floor'));
    assert.ok(
      conservative.reasons.some((reason) => reason.includes('rather than quietly raised')),
    );
  });

  it('raises the Conservative margin to the floor rather than asking for 2%', () => {
    // Target 20, floor 15: Conservative would request 10, which is not a conservative
    // price, it is a broken one.
    const result = recommendPrice(
      input({ policy: policy({ targetMarginPercentage: 20, minimumMarginPercentage: 15 }) }),
    );
    const conservative = scenario(result, 'CONSERVATIVE');
    assert.ok(
      conservative.reasons.some((reason) => reason.includes('below your 15% floor')),
      'the clamp must be stated, not silent',
    );
  });

  it('reports the lowest price that clears both floors', () => {
    const result = recommendPrice(input());
    // 15% floor solves to 14.62; charm99 gives 13.99 which yields only 11.29%, so it
    // steps up through 14.49 to 14.99 (17.08%).
    assert.equal(scenario(result, 'BALANCED').minimumViablePrice, 14.99);
  });

  it('enforces the absolute contribution floor as well as the percentage floor', () => {
    // A 15.00 minimum contribution on a 12.00 cost: only Premium clears it.
    const result = recommendPrice(input({ policy: policy({ minimumProfitAmount: 15 }) }));

    const conservative = scenario(result, 'CONSERVATIVE');
    const balanced = scenario(result, 'BALANCED');
    const premium = scenario(result, 'PREMIUM');

    assert.equal(conservative.viable, false);
    assert.equal(balanced.viable, false);
    assert.equal(premium.viable, true);
    assert.equal(premium.contribution, 16.15);
    assert.ok(balanced.guardBreaches[0]?.includes('below the 15.00 minimum'));

    // Balanced is not viable, so the cheapest viable scenario leads instead.
    assert.equal(result.recommended, 'PREMIUM');
    assert.equal(balanced.minimumViablePrice, 27.99);
  });

  it('does not report an absolute breach when the floor is disabled', () => {
    const result = recommendPrice(input({ policy: policy({ minimumProfitAmount: 0 }) }));
    for (const entry of result.scenarios) {
      assert.ok(
        !entry.guardBreaches.some((breach) => breach.includes('contribution per unit')),
        'a floor of 0 must not generate noise',
      );
    }
  });

  it('warns at the top level when any scenario breaches, naming which', () => {
    const result = recommendPrice(input({ policy: policy({ minimumProfitAmount: 15 }) }));
    assert.ok(
      result.warnings.some(
        (warning) =>
          warning.includes('Conservative and Balanced') && warning.includes('27.99'),
      ),
    );
  });

  it('reports no viable scenario rather than inventing a price', () => {
    // A contribution floor no scenario can reach on this cost base.
    const result = recommendPrice(input({ policy: policy({ minimumProfitAmount: 500 }) }));
    assert.equal(result.recommended, null);
    assert.ok(result.scenarios.every((entry) => !entry.viable));
    // The scenarios are still reported, with the price that WOULD work.
    assert.ok(result.scenarios.length === 3);
    assert.ok((scenario(result, 'BALANCED').minimumViablePrice as number) > 500);
  });
});

/* ===========================================================================
 * Unknown cost: never priced from a guess
 * ======================================================================== */

describe('unknown inputs', () => {
  it('refuses to price at all when the supplier cost is unknown', () => {
    const result = recommendPrice(input({ supplierCost: null }));
    assert.equal(result.blockedReason !== null, true);
    assert.ok(result.blockedReason?.includes('not a zero cost'));
    assert.deepEqual(result.scenarios, []);
    assert.equal(result.recommended, null);
    assert.equal(result.landedCost, null);
  });

  it('excludes unrecorded shipping and says the margin is an upper bound', () => {
    const result = recommendPrice(input({ shippingCost: null, shippingCurrency: null }));

    assert.equal(result.shippingIncluded, false);
    // Priced from 10.00, not from 12.00, and NOT treating shipping as 0 silently.
    assert.equal(result.landedCost, 10);
    assert.equal(scenario(result, 'BALANCED').price, 18.99);
    assert.ok(result.warnings.some((warning) => warning.includes('upper bound')));
    assert.ok(result.warnings.some((warning) => warning.includes('EXCLUDED - not zero')));
  });

  it('warns when no acquisition cost is priced in', () => {
    const result = recommendPrice(input());
    assert.equal(DEFAULT_PRICING_POLICY.advertisingAllowancePercentage, 0);
    assert.ok(result.warnings.some((warning) => warning.includes('no acquisition cost')));
  });

  it('prices the acquisition allowance in when one is configured', () => {
    const withAds = recommendPrice(
      input({ policy: policy({ advertisingAllowancePercentage: 15 }) }),
    );
    const without = recommendPrice(input());

    // 12 / (1 - (2.9 + 15 + 45)/100) = 12 / 0.371 = 32.35 -> charm99 32.35 -> 31.99
    assert.equal(scenario(withAds, 'BALANCED').price, 31.99);
    assert.ok(
      scenario(withAds, 'BALANCED').price > scenario(without, 'BALANCED').price,
      'covering acquisition must raise the price, not lower the margin',
    );
    assert.ok(!withAds.warnings.some((warning) => warning.includes('no acquisition cost')));
    assert.ok(
      withAds.notes.some((note) => note.includes('15% advertising allowance')),
    );
  });

  it('rejects a negative supplier cost rather than pricing from it', () => {
    const result = recommendPrice(input({ supplierCost: -5 }));
    assert.ok(result.blockedReason?.includes('not a usable amount'));
  });
});

/* ===========================================================================
 * Currency safety
 * ======================================================================== */

describe('currency safety', () => {
  it('refuses to add costs denominated in different currencies', () => {
    const result = recommendPrice(
      input({ supplierCurrency: 'USD', shippingCurrency: 'GBP', sellingCurrency: null }),
    );
    assert.ok(result.blockedReason?.startsWith('CURRENCY_MISMATCH'));
    assert.deepEqual(result.scenarios, []);
  });

  it('refuses to price when the cost and the selling currency differ', () => {
    const result = recommendPrice(
      input({ supplierCurrency: 'USD', shippingCurrency: 'USD', sellingCurrency: 'GBP' }),
    );
    assert.ok(result.blockedReason?.includes('costs are in USD'));
    assert.ok(result.blockedReason?.includes('sell in GBP'));
  });

  it('accepts matching currencies case-insensitively', () => {
    const result = recommendPrice(
      input({ supplierCurrency: 'gbp', shippingCurrency: 'GBP', sellingCurrency: ' gbp ' }),
    );
    assert.equal(result.blockedReason, null);
    assert.equal(result.currencyCode, 'GBP');
  });

  it('prices without a currency at all rather than refusing', () => {
    // A missing currency code is a plumbing gap, not a conflict - the arithmetic is
    // still valid, it just cannot be labelled.
    const result = recommendPrice(
      input({ supplierCurrency: null, shippingCurrency: null, sellingCurrency: null }),
    );
    assert.equal(result.blockedReason, null);
    assert.equal(scenario(result, 'BALANCED').price, 22.99);
  });
});

/* ===========================================================================
 * Policy validation and overrides
 * ======================================================================== */

describe('validatePricingPolicy', () => {
  it('accepts the shipped defaults', () => {
    assert.deepEqual(validatePricingPolicy({ ...DEFAULT_PRICING_POLICY }), []);
  });

  it('rejects a target below the floor, because every price would breach', () => {
    const problems = validatePricingPolicy(
      policy({ targetMarginPercentage: 10, minimumMarginPercentage: 25 }),
    );
    assert.ok(problems.some((problem) => problem.includes('below the minimum margin floor')));
  });

  it('rejects a markup at or below 1x', () => {
    assert.ok(
      validatePricingPolicy(policy({ markupMultiplier: 1 })).some((problem) =>
        problem.includes('greater than 1'),
      ),
    );
  });

  it('rejects percentage costs plus target reaching 100%', () => {
    const problems = validatePricingPolicy(
      policy({ targetMarginPercentage: 60, advertisingAllowancePercentage: 40 }),
    );
    assert.ok(problems.some((problem) => problem.includes('exceed 100%')));
  });

  it('reports every problem at once rather than the first', () => {
    const problems = validatePricingPolicy(
      policy({ paymentFeePercentage: -1, markupMultiplier: 0.5, otherCostPerOrder: Number.NaN }),
    );
    assert.ok(problems.length >= 3, `expected several problems, got ${problems.length}`);
  });

  it('blocks the recommendation with the validation message rather than guessing', () => {
    const result = recommendPrice(
      input({ policy: policy({ targetMarginPercentage: 10, minimumMarginPercentage: 25 }) }),
    );
    assert.ok(result.blockedReason?.includes('cannot produce a price'));
    assert.deepEqual(result.scenarios, []);
  });
});

describe('resolvePricingPolicy', () => {
  it('returns the base when there is no override', () => {
    assert.deepEqual(resolvePricingPolicy(DEFAULT_PRICING_POLICY, null), {
      ...DEFAULT_PRICING_POLICY,
    });
  });

  it('applies only the fields the override supplies', () => {
    const resolved = resolvePricingPolicy(DEFAULT_PRICING_POLICY, {
      targetMarginPercentage: 55,
    });
    assert.equal(resolved.targetMarginPercentage, 55);
    assert.equal(resolved.paymentFeePercentage, DEFAULT_PRICING_POLICY.paymentFeePercentage);
  });

  it('keeps an override of 0, which is a real value and not an absence', () => {
    // 0 disables a floor. It must not be mistaken for "not overridden".
    const resolved = resolvePricingPolicy(
      policy({ minimumMarginPercentage: 15 }),
      { minimumMarginPercentage: 0 },
    );
    assert.equal(resolved.minimumMarginPercentage, 0);
  });

  it('ignores null and undefined so a partial JSON body cannot erase a default', () => {
    const resolved = resolvePricingPolicy(DEFAULT_PRICING_POLICY, {
      rounding: null as unknown as undefined,
      targetMarginPercentage: undefined,
    });
    assert.equal(resolved.rounding, DEFAULT_PRICING_POLICY.rounding);
    assert.equal(
      resolved.targetMarginPercentage,
      DEFAULT_PRICING_POLICY.targetMarginPercentage,
    );
  });

  it('drives the recommendation through the override', () => {
    const result = recommendPrice(
      input({ policyOverride: { strategy: 'FIXED_UPLIFT', fixedUplift: 10 } }),
    );
    assert.equal(scenario(result, 'BALANCED').price, 21.99);
    assert.equal(result.policy.strategy, 'FIXED_UPLIFT');
  });

  it('echoes the policy actually used, so a price is reproducible', () => {
    const result = recommendPrice(input({ policyOverride: { targetMarginPercentage: 50 } }));
    assert.equal(result.policy.targetMarginPercentage, 50);
  });
});

/* ===========================================================================
 * Rounding
 * ======================================================================== */

describe('rounding strategies', () => {
  it('rounds to whole units when configured, and re-checks the floor', () => {
    const result = recommendPrice(input({ policy: policy({ rounding: 'integer' }) }));
    const balanced = scenario(result, 'BALANCED');
    assert.equal(balanced.price, 23);
    assert.equal(Number.isInteger(balanced.price), true);
  });

  it('leaves the exact figure alone when rounding is off', () => {
    const result = recommendPrice(input({ policy: policy({ rounding: 'none' }) }));
    assert.equal(scenario(result, 'BALANCED').price, 23.03);
  });

  it('reports the breakdown that produced the margin', () => {
    const result = recommendPrice(input());
    const balanced = scenario(result, 'BALANCED');
    const keys = balanced.breakdown.map((entry) => entry.key);
    assert.ok(keys.includes('supplierProductCost'));
    assert.ok(keys.includes('supplierShippingCost'));
    assert.ok(keys.includes('paymentFee'));

    const payment = balanced.breakdown.find((entry) => entry.key === 'paymentFee');
    // 2.9% of 22.99
    assert.equal(payment?.amount, 0.67);
    assert.equal(payment?.provided, true);
  });
});
