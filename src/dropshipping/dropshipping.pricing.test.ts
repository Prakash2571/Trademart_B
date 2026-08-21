/**
 * Dropshipping settings read as pricing settings.
 *
 * One property matters more than the rest: a price this adapter produces must never land
 * under the threshold the dashboard alerts on. If Research can recommend 14.99 while the
 * order view flags every resulting order as too thin, the operator has two tools
 * disagreeing about the same number and no way to tell which is right.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEFAULT_PRICING_POLICY, recommendPrice } from '../pricing/recommendation';
import { pricingPolicyFrom } from './dropshipping.pricing';
import { DEFAULT_DROPSHIP_COST_CONFIG, type DropshipCostConfig } from './dropshipping.types';

function costConfig(overrides: Partial<DropshipCostConfig> = {}): DropshipCostConfig {
  return { ...DEFAULT_DROPSHIP_COST_CONFIG, ...overrides };
}

describe('pricingPolicyFrom', () => {
  it('carries the floors across unchanged, so the two modules cannot disagree', () => {
    const policy = pricingPolicyFrom(
      costConfig({ minimumMarginPercentage: 22, minimumProfitAmount: 4 }),
    );
    assert.equal(policy.minimumMarginPercentage, 22);
    assert.equal(policy.minimumProfitAmount, 4);
  });

  it('honours the fee switches, treating an excluded fee as a known zero', () => {
    const included = pricingPolicyFrom(
      costConfig({ includePaymentFees: true, paymentFeePercentage: 2.9 }),
    );
    const excluded = pricingPolicyFrom(
      costConfig({ includePaymentFees: false, paymentFeePercentage: 2.9 }),
    );
    assert.equal(included.paymentFeePercentage, 2.9);
    // Excluded by policy, so it contributes nothing - the same meaning it has in the
    // order view, rather than becoming an unknown.
    assert.equal(excluded.paymentFeePercentage, 0);
  });

  it('honours the advertising switch rather than assuming a budget', () => {
    const off = pricingPolicyFrom(
      costConfig({ includeAdvertisingAllowance: false, advertisingAllowancePercentage: 15 }),
    );
    const on = pricingPolicyFrom(
      costConfig({ includeAdvertisingAllowance: true, advertisingAllowancePercentage: 15 }),
    );

    assert.equal(off.advertisingAllowancePercentage, 0);
    assert.equal(on.advertisingAllowancePercentage, 15);
  });

  it('warns rather than silently pricing without acquisition cost', () => {
    // The default has the allowance off, matching the order view. Consistency plus a
    // visible warning beats this adapter guessing an advertising budget.
    const policy = pricingPolicyFrom(costConfig({ includeAdvertisingAllowance: false }));
    const result = recommendPrice({
      supplierCost: 10,
      supplierCurrency: 'GBP',
      shippingCost: 2,
      shippingCurrency: 'GBP',
      sellingCurrency: 'GBP',
      policy,
    });
    assert.ok(result.warnings.some((warning) => warning.includes('no acquisition cost')));
  });

  it('raises the target above a floor that would otherwise exceed it', () => {
    // A 60% floor against the default 45% target would make every recommendation
    // breach. Raising the target is the safe direction - lowering the floor would
    // weaken a guard the operator set deliberately.
    const policy = pricingPolicyFrom(costConfig({ minimumMarginPercentage: 60 }));
    assert.ok(policy.targetMarginPercentage > 60);
    assert.equal(policy.targetMarginPercentage, 70);
  });

  it('leaves the target alone when it already clears the floor', () => {
    const policy = pricingPolicyFrom(costConfig({ minimumMarginPercentage: 15 }));
    assert.equal(policy.targetMarginPercentage, DEFAULT_PRICING_POLICY.targetMarginPercentage);
  });

  it('keeps all three scenarios viable when the floor is raised', () => {
    // Ten points of headroom exists precisely so Conservative (target minus ten) lands
    // ON the floor rather than under it.
    const policy = pricingPolicyFrom(costConfig({ minimumMarginPercentage: 40 }));
    const result = recommendPrice({
      supplierCost: 10,
      supplierCurrency: 'GBP',
      shippingCost: 2,
      shippingCurrency: 'GBP',
      sellingCurrency: 'GBP',
      policy: { ...policy, rounding: 'none' },
    });

    assert.equal(result.blockedReason, null);
    for (const scenario of result.scenarios) {
      assert.equal(scenario.viable, true, `${scenario.name} should clear a 40% floor`);
    }
  });

  it('produces a price the dashboard would not immediately flag', () => {
    const cost = costConfig({ minimumMarginPercentage: 25, minimumProfitAmount: 3 });
    const result = recommendPrice({
      supplierCost: 10,
      supplierCurrency: 'GBP',
      shippingCost: 2,
      shippingCurrency: 'GBP',
      sellingCurrency: 'GBP',
      policy: pricingPolicyFrom(cost),
    });

    const recommended = result.scenarios.find((entry) => entry.name === result.recommended);
    // A throw rather than assert.ok: it narrows the type, which assert's assertion
    // signature does not do here.
    if (recommended === undefined) throw new Error('a viable scenario must exist');
    assert.ok((recommended.marginPercentage as number) >= cost.minimumMarginPercentage);
    assert.ok(recommended.contribution >= cost.minimumProfitAmount);
  });

  it('lets an override beat the store default', () => {
    const policy = pricingPolicyFrom(costConfig(), { strategy: 'MARKUP_MULTIPLIER' });
    assert.equal(policy.strategy, 'MARKUP_MULTIPLIER');
  });

  it('ignores a null override field rather than erasing a default', () => {
    const policy = pricingPolicyFrom(costConfig(), {
      rounding: null as unknown as undefined,
    });
    assert.equal(policy.rounding, DEFAULT_PRICING_POLICY.rounding);
  });

  it('falls back to documented defaults when given no config', () => {
    const policy = pricingPolicyFrom();
    assert.equal(
      policy.minimumMarginPercentage,
      DEFAULT_DROPSHIP_COST_CONFIG.minimumMarginPercentage,
    );
  });
});
