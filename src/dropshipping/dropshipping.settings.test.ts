/**
 * Dropshipping settings validation and merging.
 *
 * These numbers decide which orders get flagged, what a margin means, and what price
 * Research recommends. A settings screen that accepts nonsense produces figures nobody can
 * reconcile - so the interesting cases here are the combinations, because each half of a
 * broken pair looks perfectly reasonable on its own.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_DROPSHIP_SETTINGS,
  describeDropshipSettingsRisks,
  mergeDropshipSettings,
  validateDropshipSettings,
  type DropshipSettingsRecord,
} from './dropshipping.settings';
import { DEFAULT_DROPSHIP_COST_CONFIG, DEFAULT_SHIPPING_SLA } from './dropshipping.types';

function record(overrides: Partial<DropshipSettingsRecord> = {}): DropshipSettingsRecord {
  return {
    cost: { ...DEFAULT_DROPSHIP_COST_CONFIG },
    sla: { ...DEFAULT_SHIPPING_SLA },
    pricing: {},
    ...overrides,
  };
}

/* ===========================================================================
 * Merging
 * ======================================================================== */

describe('mergeDropshipSettings', () => {
  it('applies only the fields a patch supplies', () => {
    const merged = mergeDropshipSettings(record(), {
      cost: { paymentFeePercentage: 1.5 },
    });
    assert.equal(merged.cost.paymentFeePercentage, 1.5);
    // Untouched, so an operator editing the fee does not have to resend the floors.
    assert.equal(
      merged.cost.minimumMarginPercentage,
      DEFAULT_DROPSHIP_COST_CONFIG.minimumMarginPercentage,
    );
    assert.deepEqual(merged.sla, DEFAULT_SHIPPING_SLA);
  });

  it('keeps a supplied 0, which is a real value', () => {
    // minimumProfitAmount 0 DISABLES the absolute floor. If absence and zero were the
    // same thing an operator could never turn it off.
    const merged = mergeDropshipSettings(
      record({ cost: { ...DEFAULT_DROPSHIP_COST_CONFIG, minimumProfitAmount: 5 } }),
      { cost: { minimumProfitAmount: 0 } },
    );
    assert.equal(merged.cost.minimumProfitAmount, 0);
  });

  it('ignores null and undefined rather than erasing a default', () => {
    const merged = mergeDropshipSettings(record(), {
      cost: { paymentFeePercentage: null as unknown as undefined },
    });
    assert.equal(
      merged.cost.paymentFeePercentage,
      DEFAULT_DROPSHIP_COST_CONFIG.paymentFeePercentage,
    );
  });

  it('keeps false, which is not an absence', () => {
    const merged = mergeDropshipSettings(record(), { cost: { includePaymentFees: false } });
    assert.equal(merged.cost.includePaymentFees, false);
  });

  it('treats pricing: null as an explicit clear, and absent pricing as leave alone', () => {
    const base = record({ pricing: { targetMarginPercentage: 55 } });

    assert.deepEqual(mergeDropshipSettings(base, { pricing: null }).pricing, {});
    assert.deepEqual(mergeDropshipSettings(base, {}).pricing, { targetMarginPercentage: 55 });
  });
});

/* ===========================================================================
 * Validation
 * ======================================================================== */

describe('validateDropshipSettings', () => {
  it('accepts the shipped defaults', () => {
    assert.deepEqual(validateDropshipSettings({ ...DEFAULT_DROPSHIP_SETTINGS }), []);
  });

  it('rejects a negative percentage', () => {
    const problems = validateDropshipSettings(
      record({ cost: { ...DEFAULT_DROPSHIP_COST_CONFIG, paymentFeePercentage: -1 } }),
    );
    assert.ok(problems.some((problem) => problem.includes('cannot be negative')));
  });

  it('rejects a single fee of 100% of revenue', () => {
    const problems = validateDropshipSettings(
      record({ cost: { ...DEFAULT_DROPSHIP_COST_CONFIG, paymentFeePercentage: 100 } }),
    );
    assert.ok(problems.some((problem) => problem.includes('must be below 100')));
  });

  it('catches a COMBINATION that is individually reasonable', () => {
    // 40 + 30 + 35 are each plausible and together leave nothing for the product. This is
    // the case validating each field alone would miss.
    const problems = validateDropshipSettings(
      record({
        cost: {
          ...DEFAULT_DROPSHIP_COST_CONFIG,
          paymentFeePercentage: 40,
          shopifyFeePercentage: 30,
          includeAdvertisingAllowance: true,
          advertisingAllowancePercentage: 35,
        },
      }),
    );
    assert.ok(problems.some((problem) => problem.includes('leaves nothing for the product')));
  });

  it('does not count an excluded advertising allowance toward the total', () => {
    // Excluded means it contributes a known zero, so it cannot make the total impossible.
    const problems = validateDropshipSettings(
      record({
        cost: {
          ...DEFAULT_DROPSHIP_COST_CONFIG,
          paymentFeePercentage: 40,
          shopifyFeePercentage: 30,
          includeAdvertisingAllowance: false,
          advertisingAllowancePercentage: 35,
        },
      }),
    );
    assert.ok(!problems.some((problem) => problem.includes('leaves nothing')));
  });

  it('rejects a non-boolean inclusion switch', () => {
    const problems = validateDropshipSettings(
      record({
        cost: {
          ...DEFAULT_DROPSHIP_COST_CONFIG,
          includePaymentFees: 'yes' as unknown as boolean,
        },
      }),
    );
    assert.ok(problems.some((problem) => problem.includes('must be true or false')));
  });

  it('rejects negative SLA hours', () => {
    const problems = validateDropshipSettings(
      record({ sla: { ...DEFAULT_SHIPPING_SLA, processingWarningHours: -5 } }),
    );
    assert.ok(problems.some((problem) => problem.includes('processingWarningHours')));
  });

  it('reports every problem at once rather than the first', () => {
    const problems = validateDropshipSettings(
      record({
        cost: {
          ...DEFAULT_DROPSHIP_COST_CONFIG,
          paymentFeePercentage: -1,
          minimumProfitAmount: -2,
        },
        sla: { ...DEFAULT_SHIPPING_SLA, trackingWarningHours: -3 },
      }),
    );
    assert.ok(problems.length >= 3, `expected several problems, got ${problems.length}`);
  });

  it('validates the pricing overrides through the pricing engine\u2019s own rules', () => {
    // A target below the floor is checked by validatePricingPolicy, not re-implemented
    // here - two copies of that rule would eventually disagree.
    const problems = validateDropshipSettings(
      record({
        cost: { ...DEFAULT_DROPSHIP_COST_CONFIG, minimumMarginPercentage: 30 },
        pricing: { targetMarginPercentage: 10 },
      }),
    );
    assert.ok(problems.some((problem) => problem.includes('below the minimum margin floor')));
  });

  it('accepts a pricing override that is consistent with the cost settings', () => {
    assert.deepEqual(
      validateDropshipSettings(
        record({
          cost: { ...DEFAULT_DROPSHIP_COST_CONFIG, minimumMarginPercentage: 20 },
          pricing: { targetMarginPercentage: 50, strategy: 'MARKUP_MULTIPLIER' },
        }),
      ),
      [],
    );
  });
});

/* ===========================================================================
 * Risks: valid, but likely to mislead
 * ======================================================================== */

describe('describeDropshipSettingsRisks', () => {
  it('warns that excluding supplier shipping makes every margin an upper bound', () => {
    const risks = describeDropshipSettingsRisks(
      record({ cost: { ...DEFAULT_DROPSHIP_COST_CONFIG, includeSupplierShipping: false } }),
    );
    assert.ok(risks.some((risk) => risk.includes('upper bound')));
  });

  it('warns when no advertising allowance is deducted', () => {
    // True of the shipped default, deliberately - so the default configuration itself
    // carries a visible caveat rather than a silent one.
    const risks = describeDropshipSettingsRisks({ ...DEFAULT_DROPSHIP_SETTINGS });
    assert.ok(risks.some((risk) => risk.includes('no acquisition cost')));
  });

  it('warns that a disabled contribution floor lets thin cheap items through', () => {
    const risks = describeDropshipSettingsRisks(
      record({ cost: { ...DEFAULT_DROPSHIP_COST_CONFIG, minimumProfitAmount: 0 } }),
    );
    assert.ok(risks.some((risk) => risk.includes('45p')));
  });

  it('warns that a delivery grace period overrides the promise made to the customer', () => {
    const risks = describeDropshipSettingsRisks(
      record({ sla: { ...DEFAULT_SHIPPING_SLA, deliveryDelayDays: 3 } }),
    );
    assert.ok(risks.some((risk) => risk.includes('promise made to the customer')));
  });

  it('says nothing about a grace period of zero, which is the honest default', () => {
    const risks = describeDropshipSettingsRisks(
      record({ sla: { ...DEFAULT_SHIPPING_SLA, deliveryDelayDays: 0 } }),
    );
    assert.ok(!risks.some((risk) => risk.includes('promise made to the customer')));
  });

  it('does not block a save - risks are separate from validation', () => {
    const subject = record({
      cost: { ...DEFAULT_DROPSHIP_COST_CONFIG, includeSupplierShipping: false },
    });
    assert.deepEqual(validateDropshipSettings(subject), []);
    assert.ok(describeDropshipSettingsRisks(subject).length > 0);
  });
});
