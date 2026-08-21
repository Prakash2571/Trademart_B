/**
 * Order economics.
 *
 * The invariant under test throughout: an unknown cost stays UNKNOWN and never
 * becomes zero. A zero cost produces a beautiful margin and a confident, wrong
 * decision, so almost every case here is a way that could happen.
 *
 * The second theme is the landed / commercial distinction. Landed cost is what the
 * SUPPLIER is owed (and therefore what capital exposure is built from); commercial
 * cost adds fees and allowances and is the basis of contribution. Conflating them
 * overstates supplier exposure by fees the supplier never charges.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { computeOrderEconomics, worstConfidence } from './dropshipping.cost';
import { DEFAULT_DROPSHIP_COST_CONFIG, type DropshipCostConfig } from './dropshipping.types';

function config(overrides: Partial<DropshipCostConfig> = {}): DropshipCostConfig {
  return {
    ...DEFAULT_DROPSHIP_COST_CONFIG,
    // Neutralised so the arithmetic under test is visible; individual tests
    // re-enable what they care about.
    includePaymentFees: false,
    includeShopifyFees: false,
    includeAdvertisingAllowance: false,
    ...overrides,
  };
}

/** A fully-costed order: revenue 1499, product 520, shipping 110. */
function complete(overrides: Partial<Parameters<typeof computeOrderEconomics>[0]> = {}) {
  return computeOrderEconomics({
    currencyCode: 'INR',
    customerRevenue: 1499,
    lines: [{ quantity: 1, unitCost: 520, unitShippingCost: 110, title: 'Neck Fan' }],
    config: config(),
    ...overrides,
  });
}

describe('landed cost is what the supplier is owed', () => {
  it('is product cost plus supplier shipping', () => {
    const economics = complete();
    assert.equal(economics.supplierProductCost.amount, 520);
    assert.equal(economics.supplierShippingCost.amount, 110);
    assert.equal(economics.landedCost.amount, 630);
    assert.equal(economics.landedCost.confidence, 'KNOWN');
  });

  it('multiplies per-unit costs by quantity', () => {
    const economics = complete({
      lines: [{ quantity: 3, unitCost: 520, unitShippingCost: 110 }],
    });
    assert.equal(economics.supplierProductCost.amount, 1560);
    assert.equal(economics.supplierShippingCost.amount, 330);
    assert.equal(economics.landedCost.amount, 1890);
  });

  it('sums several lines exactly, without float drift', () => {
    const economics = complete({
      lines: [
        { quantity: 1, unitCost: 0.1, unitShippingCost: 0 },
        { quantity: 1, unitCost: 0.2, unitShippingCost: 0 },
      ],
    });
    // 0.1 + 0.2 === 0.30000000000000004 in plain doubles.
    assert.equal(economics.supplierProductCost.amount, 0.3);
  });

  it('EXCLUDES fees - they are not owed to the supplier', () => {
    // This is the C6 distinction. If landed cost included fees, capital exposure
    // would be overstated by money the supplier never charges.
    const economics = complete({
      config: config({ includePaymentFees: true, paymentFeePercentage: 10 }),
    });
    assert.equal(economics.landedCost.amount, 630);
    assert.equal(economics.paymentFees.amount, 149.9);
    assert.equal(economics.commercialCost.amount, 779.9);
    assert.ok(/owed to the supplier/.test(economics.landedCost.source));
  });
});

describe('unknown costs stay unknown', () => {
  it('an unrecorded product cost makes landed, commercial and profit UNKNOWN', () => {
    const economics = complete({
      lines: [{ quantity: 1, unitCost: null, unitShippingCost: 110, title: 'Neck Fan' }],
    });

    assert.equal(economics.supplierProductCost.amount, null);
    assert.equal(economics.supplierProductCost.confidence, 'UNKNOWN');
    // Ignorance propagates. Crucially NOT 110 (the known part alone), which would
    // understate cost and overstate profit.
    assert.equal(economics.landedCost.amount, null);
    assert.equal(economics.commercialCost.amount, null);
    assert.equal(economics.estimatedProfit.amount, null);
    assert.equal(economics.estimatedMargin.value, null);
    assert.equal(economics.confidence, 'UNKNOWN');
  });

  it('names the offending line so the gap is actionable', () => {
    const economics = complete({
      lines: [
        { quantity: 1, unitCost: 520, title: 'Priced thing', unitShippingCost: 0 },
        { quantity: 1, unitCost: null, title: 'Neck Fan', unitShippingCost: 0 },
      ],
    });
    assert.ok(
      economics.warnings.some((w) => w.includes('Neck Fan')),
      economics.warnings.join(' | '),
    );
    assert.ok(economics.missingInputs.includes('supplierProductCost'));
  });

  it('does NOT price an order from only the lines that have costs', () => {
    // Three priced lines and one unpriced must not yield a total for three.
    const economics = complete({
      lines: [
        { quantity: 1, unitCost: 100, unitShippingCost: 0 },
        { quantity: 1, unitCost: 100, unitShippingCost: 0 },
        { quantity: 1, unitCost: null, unitShippingCost: 0 },
      ],
    });
    assert.equal(economics.supplierProductCost.amount, null);
    assert.notEqual(economics.supplierProductCost.amount, 200);
  });

  it('unrecorded supplier shipping is UNKNOWN, not free', () => {
    const economics = complete({
      lines: [{ quantity: 1, unitCost: 520, unitShippingCost: null }],
    });
    assert.equal(economics.supplierShippingCost.amount, null);
    assert.equal(economics.landedCost.amount, null);
    assert.ok(
      economics.warnings.some((w) => /not free/.test(w)),
      economics.warnings.join(' | '),
    );
  });

  it('an unknown order total makes profit unknown, not equal to revenue', () => {
    const economics = complete({ customerRevenue: null });
    assert.equal(economics.customerRevenue.amount, null);
    assert.equal(economics.estimatedProfit.amount, null);
    assert.ok(/not the revenue/.test(economics.estimatedProfit.source));
  });

  it('explains WHY a total is unknown rather than leaving a bare dash', () => {
    const economics = complete({
      lines: [{ quantity: 1, unitCost: null, unitShippingCost: null }],
    });
    assert.match(economics.landedCost.source, /unknown/i);
    assert.match(economics.landedCost.source, /overstate profit/);
  });

  it('an order with no line items cannot be costed', () => {
    const economics = complete({ lines: [] });
    assert.equal(economics.supplierProductCost.confidence, 'UNKNOWN');
    assert.equal(economics.landedCost.amount, null);
  });
});

describe('excluded is NOT the same as unknown', () => {
  it('an excluded fee contributes a KNOWN zero', () => {
    const economics = complete({ config: config({ includePaymentFees: false }) });
    assert.equal(economics.paymentFees.amount, 0);
    assert.equal(economics.paymentFees.confidence, 'KNOWN');
    assert.match(economics.paymentFees.source, /Excluded by configuration/);
    // And so the totals remain computable.
    assert.equal(economics.commercialCost.confidence, 'KNOWN');
  });

  it('excluding supplier shipping still allows a landed cost', () => {
    // Contrast with the unknown-shipping case above, which makes landed unknown.
    const economics = complete({
      lines: [{ quantity: 1, unitCost: 520, unitShippingCost: null }],
      config: config({ includeSupplierShipping: false }),
    });
    assert.equal(economics.supplierShippingCost.amount, 0);
    assert.equal(economics.landedCost.amount, 520);
    assert.equal(economics.landedCost.confidence, 'KNOWN');
  });

  it('an unknown fee makes the commercial cost unknown, unlike an excluded one', () => {
    const economics = complete({
      customerRevenue: null,
      config: config({ includePaymentFees: true }),
    });
    assert.equal(economics.paymentFees.confidence, 'UNKNOWN');
    assert.equal(economics.commercialCost.amount, null);
  });
});

describe('fees and allowances are ESTIMATED, never KNOWN', () => {
  it('a payment fee derived from a percentage is ESTIMATED', () => {
    // It is a modelled rate, not the processor's actual charge. Presenting it as
    // observed would dress a guess up as a fact.
    const economics = complete({
      config: config({ includePaymentFees: true, paymentFeePercentage: 2.9 }),
    });
    assert.equal(economics.paymentFees.confidence, 'ESTIMATED');
    assert.equal(economics.paymentFees.amount, 43.47);
    assert.match(economics.paymentFees.source, /Not the processor's actual charge/);
  });

  it('one estimated component makes the whole total ESTIMATED', () => {
    const economics = complete({ config: config({ includePaymentFees: true }) });
    // Landed cost is still fully KNOWN...
    assert.equal(economics.landedCost.confidence, 'KNOWN');
    // ...but contribution rests on an estimate, and says so.
    assert.equal(economics.commercialCost.confidence, 'ESTIMATED');
    assert.equal(economics.estimatedProfit.confidence, 'ESTIMATED');
    assert.equal(economics.confidence, 'ESTIMATED');
  });

  it('the advertising allowance is off by default', () => {
    // Assuming one would silently reduce every reported margin.
    assert.equal(DEFAULT_DROPSHIP_COST_CONFIG.includeAdvertisingAllowance, false);
  });

  it('an enabled advertising allowance is a percentage of revenue and ESTIMATED', () => {
    const economics = complete({
      config: config({ includeAdvertisingAllowance: true, advertisingAllowancePercentage: 15 }),
    });
    assert.equal(economics.advertisingAllowance.amount, 224.85);
    assert.equal(economics.advertisingAllowance.confidence, 'ESTIMATED');
    assert.match(economics.advertisingAllowance.source, /not measured ad spend/);
  });
});

describe('contribution and margin', () => {
  it('matches the brief worked example', () => {
    // Customer 1499, product 520, shipping 110, payment fees 55, ads 200
    // -> commercial 885, contribution 614, margin ~41%.
    const economics = computeOrderEconomics({
      currencyCode: 'INR',
      customerRevenue: 1499,
      lines: [{ quantity: 1, unitCost: 520, unitShippingCost: 110 }],
      config: config({
        includePaymentFees: true,
        // Rates chosen to land on the brief's figures.
        paymentFeePercentage: 3.669,
        includeAdvertisingAllowance: true,
        advertisingAllowancePercentage: 13.342,
      }),
    });

    assert.equal(economics.landedCost.amount, 630);
    assert.equal(economics.paymentFees.amount, 55);
    assert.equal(economics.advertisingAllowance.amount, 200);
    assert.equal(economics.commercialCost.amount, 885);
    assert.equal(economics.estimatedProfit.amount, 614);
    assert.equal(Math.round(economics.estimatedMargin.value ?? 0), 41);
  });

  it('margin is on revenue, not on cost', () => {
    // 1000 revenue, 600 cost -> 40% of revenue, NOT 66.7% of cost.
    const economics = complete({
      customerRevenue: 1000,
      lines: [{ quantity: 1, unitCost: 600, unitShippingCost: 0 }],
    });
    assert.equal(economics.estimatedMargin.value, 40);
  });

  it('reports a loss as a negative contribution and warns', () => {
    const economics = complete({
      customerRevenue: 100,
      lines: [{ quantity: 1, unitCost: 250, unitShippingCost: 50 }],
    });
    assert.equal(economics.estimatedProfit.amount, -200);
    assert.equal(economics.estimatedMargin.value, -200);
    assert.ok(
      economics.warnings.some((w) => /loses money/.test(w)),
      economics.warnings.join(' | '),
    );
  });

  it('does not divide by zero on a free order', () => {
    const economics = complete({
      customerRevenue: 0,
      lines: [{ quantity: 1, unitCost: 10, unitShippingCost: 0 }],
    });
    assert.equal(economics.estimatedMargin.value, null);
  });
});

describe('fulfillment surcharge', () => {
  it('is a known zero when no line records one', () => {
    // Nothing recorded anywhere means this supplier has no surcharge - a fact, not
    // a gap - so it must not block the landed cost.
    const economics = complete();
    assert.equal(economics.supplierFulfillmentCost.amount, 0);
    assert.equal(economics.supplierFulfillmentCost.confidence, 'KNOWN');
    assert.equal(economics.landedCost.confidence, 'KNOWN');
  });

  it('is included when recorded', () => {
    const economics = complete({
      lines: [{ quantity: 2, unitCost: 100, unitShippingCost: 10, unitFulfillmentCost: 5 }],
    });
    assert.equal(economics.supplierFulfillmentCost.amount, 10);
    assert.equal(economics.landedCost.amount, 230);
  });
});

describe('worstConfidence', () => {
  it('degrades to the weakest input', () => {
    assert.equal(worstConfidence('KNOWN', 'KNOWN'), 'KNOWN');
    assert.equal(worstConfidence('KNOWN', 'ESTIMATED'), 'ESTIMATED');
    assert.equal(worstConfidence('ESTIMATED', 'UNKNOWN'), 'UNKNOWN');
    assert.equal(worstConfidence('KNOWN', 'UNKNOWN', 'ESTIMATED'), 'UNKNOWN');
  });

  it('is KNOWN for no inputs', () => {
    assert.equal(worstConfidence(), 'KNOWN');
  });
});

describe('every figure explains itself', () => {
  it('populates a source on all figures, known or not', () => {
    for (const economics of [
      complete(),
      complete({ customerRevenue: null }),
      complete({ lines: [{ quantity: 1, unitCost: null, unitShippingCost: null }] }),
    ]) {
      const figures = [
        economics.customerRevenue,
        economics.supplierProductCost,
        economics.supplierShippingCost,
        economics.supplierFulfillmentCost,
        economics.paymentFees,
        economics.shopifyFees,
        economics.advertisingAllowance,
        economics.otherCommercialCosts,
        economics.landedCost,
        economics.commercialCost,
        economics.estimatedProfit,
      ];
      for (const figure of figures) {
        assert.ok(figure.source.length > 0, 'a figure has no source');
        // The invariant: amount is null if and only if confidence is UNKNOWN.
        assert.equal(
          figure.amount === null,
          figure.confidence === 'UNKNOWN',
          `amount/confidence disagree: ${JSON.stringify(figure)}`,
        );
      }
    }
  });
});
