/**
 * Shipping-aware cost resolution, and the two pricing floors.
 *
 * The bug being pinned here was silent and expensive: loadManualCostMap dropped
 * supplierShippingCost, so an operator could record 100 of shipping against a
 * variant and automation would price the product as though shipping were free. Every
 * margin was overstated - INCLUDING the minMarginPercentage floor that exists
 * specifically to stop a loss-making price.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_AUTOMATION_RULES,
  validateAutomationRules,
  type PriceRules,
} from '../automation/rules.types';
import {
  decideVariantPrice,
  marginAtPrice,
  profitAtPrice,
} from '../automation/price.rules';
import type { ProductVariantDto } from '../shopify/shopify.types';
import { resolveCostSource, type ManualCost } from './cost';

// `raw` is the original Shopify string, preserved on Money to avoid rounding
// surprises; mirrored here so these fixtures are the real shape.
const money = (amount: number, currencyCode = 'GBP') => ({
  amount,
  currencyCode,
  raw: amount.toFixed(2),
});

function priceRules(overrides: Partial<PriceRules> = {}): PriceRules {
  return {
    ...DEFAULT_AUTOMATION_RULES.price,
    enabled: true,
    // Neutralised so the arithmetic under test is visible rather than buried under
    // fees; individual tests re-enable what they care about.
    paymentFeePercentage: 0,
    shopifyFeePercentage: 0,
    advertisingCost: 0,
    otherCosts: 0,
    rounding: 'none',
    minMarginPercentage: 0,
    maxIncreasePercentage: 1000,
    maxDecreasePercentage: 90,
    ...overrides,
  };
}

function variant(overrides: Partial<ProductVariantDto> = {}): ProductVariantDto {
  return {
    shopifyVariantId: 'gid://shopify/ProductVariant/1',
    title: 'Default',
    sku: 'SKU-1',
    price: money(100),
    compareAtPrice: null,
    unitCost: money(40),
    inventoryQuantity: 10,
    inventoryItemId: 'gid://shopify/InventoryItem/1',
    availableForSale: true,
    ...overrides,
  } as ProductVariantDto;
}

describe('shipping is resolved separately and honestly', () => {
  it('is UNKNOWN, not zero, when nothing supplies it', () => {
    const resolved = resolveCostSource({ shopifyUnitCost: money(40) });

    // Shopify's "Cost per item" is a PRODUCT cost with no shipping component, so
    // there is genuinely nothing to read. Reporting 0 would assert free shipping.
    assert.equal(resolved.shippingCost, null);
    assert.equal(resolved.shippingSource, 'UNKNOWN');
    assert.equal(resolved.shippingKnown, false);
    // landedCost falls back to the product cost so pricing still works...
    assert.equal(resolved.landedCost, 40);
    // ...but the caller can tell that it is incomplete.
  });

  it('is included in landedCost when a manual shipping cost exists', () => {
    const manualCost: ManualCost = {
      amount: 40,
      currencyCode: 'GBP',
      shippingCost: 7.5,
    };
    const resolved = resolveCostSource({ shopifyUnitCost: money(40), manualCost });

    assert.equal(resolved.source, 'SHOPIFY_UNIT_COST');
    assert.equal(resolved.shippingCost, 7.5);
    assert.equal(resolved.shippingSource, 'MANUAL');
    assert.equal(resolved.shippingKnown, true);
    assert.equal(resolved.landedCost, 47.5);
    // `amount` still means PRODUCT cost, so nothing that reads it changes meaning.
    assert.equal(resolved.amount, 40);
  });

  it('treats a recorded shipping cost of 0 as KNOWN free shipping', () => {
    // Unlike a product cost, 0 is a legitimate shipping value - free shipping is a
    // real arrangement. Only absence means unknown.
    const resolved = resolveCostSource({
      shopifyUnitCost: money(40),
      manualCost: { amount: 40, currencyCode: 'GBP', shippingCost: 0 },
    });

    assert.equal(resolved.shippingKnown, true);
    assert.equal(resolved.shippingCost, 0);
    assert.equal(resolved.landedCost, 40);
  });

  it('ignores shipping denominated in a different currency', () => {
    // 100 INR of shipping added to 40 GBP of product cost is not a price in any
    // currency, and no exchange rate is available.
    const resolved = resolveCostSource({
      shopifyUnitCost: money(40, 'GBP'),
      manualCost: { amount: 40, currencyCode: 'INR', shippingCost: 100 },
    });

    assert.equal(resolved.shippingKnown, false);
    assert.equal(resolved.shippingCost, null);
    assert.equal(resolved.landedCost, 40);
  });

  it('prefers supplier-quoted shipping over a hand-typed figure', () => {
    const resolved = resolveCostSource({
      supplierApiCost: money(40),
      supplierApiShippingCost: money(5),
      manualCost: { amount: 40, currencyCode: 'GBP', shippingCost: 9 },
    });

    assert.equal(resolved.shippingCost, 5);
    assert.equal(resolved.shippingSource, 'SUPPLIER_API');
  });

  it('leaves everything null when the product cost is unknown', () => {
    const resolved = resolveCostSource({});
    assert.equal(resolved.landedCost, null);
    assert.equal(resolved.shippingKnown, false);
  });

  it('sums landedCost exactly, without float drift', () => {
    const resolved = resolveCostSource({
      shopifyUnitCost: money(0.1),
      manualCost: { amount: 0.1, currencyCode: 'GBP', shippingCost: 0.2 },
    });
    // 0.1 + 0.2 === 0.30000000000000004 in plain doubles.
    assert.equal(resolved.landedCost, 0.3);
  });
});

describe('pricing uses the landed cost, not the product cost alone', () => {
  it('a known shipping cost raises the target price', () => {
    const rules = priceRules({ pricingMode: 'multiplier', multiplier: 2 });

    // Current price 60 deliberately: with a price of 100 the shipping-inclusive
    // target (40 + 10) x 2 = 100 would equal it and correctly come back as a noop,
    // which would tell us nothing about the arithmetic.
    const base = variant({ price: money(60) });

    const withoutShipping = decideVariantPrice(base, rules);
    const withShipping = decideVariantPrice(base, rules, {
      amount: 40,
      currencyCode: 'GBP',
      shippingCost: 10,
    });

    assert.equal(withoutShipping.kind, 'change');
    assert.equal(withShipping.kind, 'change');
    if (withoutShipping.kind !== 'change' || withShipping.kind !== 'change') return;

    // 40 x 2 = 80 versus (40 + 10) x 2 = 100. Pricing on the product cost alone
    // undercharged by 20 on every unit.
    assert.equal(withoutShipping.to, 80);
    assert.equal(withShipping.to, 100);
  });

  it('says explicitly when shipping was NOT included', () => {
    const decision = decideVariantPrice(
      variant(),
      priceRules({ pricingMode: 'multiplier', multiplier: 2 }),
    );
    assert.equal(decision.kind, 'change');
    if (decision.kind !== 'change') return;

    // The operator must be able to see that the margin is an upper bound. A silent
    // omission is exactly what made this a bug rather than a limitation.
    assert.ok(
      decision.reasons.some((reason) => /shipping is UNKNOWN/i.test(reason)),
      `expected an unknown-shipping reason, got: ${decision.reasons.join(' | ')}`,
    );
    assert.ok(decision.reasons.some((reason) => /upper bound/i.test(reason)));
  });

  it('shows the landed-cost breakdown when shipping IS included', () => {
    const decision = decideVariantPrice(
      variant({ price: money(60) }),
      priceRules({ pricingMode: 'multiplier', multiplier: 2 }),
      { amount: 40, currencyCode: 'GBP', shippingCost: 10 },
    );
    assert.equal(decision.kind, 'change');
    if (decision.kind !== 'change') return;

    assert.ok(
      decision.reasons.some((reason) => /Landed cost 50\.00 GBP/.test(reason)),
      `expected a landed-cost reason, got: ${decision.reasons.join(' | ')}`,
    );
  });

  it('refuses to price at all when requireKnownShippingCost is on', () => {
    const decision = decideVariantPrice(
      variant(),
      priceRules({
        pricingMode: 'multiplier',
        multiplier: 2,
        requireKnownShippingCost: true,
      }),
    );

    assert.equal(decision.kind, 'skip');
    assert.ok(
      decision.reasons.some((reason) => /requireKnownShippingCost/.test(reason)),
      decision.reasons.join(' | '),
    );
  });

  it('requireKnownShippingCost still prices when shipping IS known', () => {
    const decision = decideVariantPrice(
      variant({ price: money(60) }),
      priceRules({
        pricingMode: 'multiplier',
        multiplier: 2,
        requireKnownShippingCost: true,
      }),
      { amount: 40, currencyCode: 'GBP', shippingCost: 10 },
    );
    assert.equal(decision.kind, 'change');
  });

  it('is off by default, so existing stores keep pricing', () => {
    assert.equal(DEFAULT_AUTOMATION_RULES.price.requireKnownShippingCost, false);
  });
});

describe('minimumProfitAmount is an absolute floor, not a percentage', () => {
  it('is disabled by default', () => {
    assert.equal(DEFAULT_AUTOMATION_RULES.price.minimumProfitAmount, 0);
  });

  it('computes contribution per unit', () => {
    assert.equal(profitAtPrice(100, 40, priceRules()), 60);
    // Sanity: the percentage view of the same numbers.
    assert.equal(marginAtPrice(100, 40, priceRules()), 60);
  });

  it('raises a price that clears the margin floor but not the cash floor', () => {
    // 15% of a 3.00 item is 45p, which does not cover one support email. This is
    // exactly the gap a percentage-only floor leaves open.
    const rules = priceRules({
      pricingMode: 'multiplier',
      multiplier: 1.2,
      minMarginPercentage: 10,
      minimumProfitAmount: 5,
    });
    const cheap = variant({ unitCost: money(3), price: money(3.2) });

    const decision = decideVariantPrice(cheap, rules);
    assert.equal(decision.kind, 'change');
    if (decision.kind !== 'change') return;

    // 3 x 1.2 = 3.60 gives only 0.60 contribution. It must be stepped up until the
    // contribution reaches 5.00, i.e. a price of at least 8.00.
    const profit = profitAtPrice(decision.to, 3, rules);
    assert.ok(
      profit !== null && profit >= 5,
      `expected contribution >= 5, got ${String(profit)} at price ${decision.to}`,
    );
    assert.ok(
      decision.reasons.some((reason) => /contribution per unit/.test(reason)),
      decision.reasons.join(' | '),
    );
  });

  it('does not interfere when the price already clears it', () => {
    const rules = priceRules({
      pricingMode: 'multiplier',
      multiplier: 2,
      minimumProfitAmount: 5,
    });
    const decision = decideVariantPrice(variant(), rules);
    assert.equal(decision.kind, 'change');
    if (decision.kind !== 'change') return;
    // 40 x 2 = 80 leaves 40 of contribution, far above the 5 floor.
    assert.equal(decision.to, 80);
  });

  it('skips rather than sells too cheaply when a clamp blocks the cash floor', () => {
    // The clamp caps the increase, so the price cannot reach the contribution floor.
    // Skipping is correct: applying the clamped price would knowingly sell below the
    // operator's stated minimum.
    const rules = priceRules({
      pricingMode: 'multiplier',
      multiplier: 5,
      minimumProfitAmount: 50,
      maxIncreasePercentage: 5,
    });
    const decision = decideVariantPrice(variant({ unitCost: money(40), price: money(41) }), rules);

    assert.equal(decision.kind, 'skip');
    assert.ok(
      decision.reasons.some((reason) => /contribution per unit/.test(reason)),
      decision.reasons.join(' | '),
    );
  });

  it('is rejected at validation time when negative', () => {
    const problems = validateAutomationRules({
      ...DEFAULT_AUTOMATION_RULES,
      price: { ...DEFAULT_AUTOMATION_RULES.price, minimumProfitAmount: -1 },
    });
    assert.ok(
      problems.some((problem) => problem.includes('minimumProfitAmount')),
      problems.join(' | '),
    );
  });
});
