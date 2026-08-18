/**
 * Unit tests for the automation decision engines.
 *
 * These guard the rules that protect a real storefront: never price from a
 * guessed cost, never breach the margin floor, never move a price further than
 * one run is allowed to, and never un-hide something a human hid.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ProductDto, ProductVariantDto } from '../shopify/shopify.types';
import { buildAutomationPlan } from './plan';
import {
  applyRounding,
  decideVariantPrice,
  lowestCurrentMargin,
  marginAtPrice,
  resolveCost,
} from './price.rules';
import {
  DEFAULT_AUTOMATION_RULES,
  validateAutomationRules,
  type AutomationRules,
} from './rules.types';
import { decideVisibility, resolveStock } from './visibility.rules';

function money(amount: number, currencyCode = 'GBP') {
  return { amount, currencyCode, raw: amount.toFixed(2) };
}

function variant(overrides: Partial<ProductVariantDto> = {}): ProductVariantDto {
  return {
    shopifyVariantId: 'gid://shopify/ProductVariant/1',
    title: 'Default',
    sku: 'SKU-1',
    barcode: null,
    price: money(20),
    compareAtPrice: null,
    availableForSale: true,
    inventoryQuantity: 10,
    inventoryItemId: 'gid://shopify/InventoryItem/1',
    inventoryTracked: true,
    unitCost: money(10),
    ...overrides,
  };
}

function product(overrides: Partial<ProductDto> = {}): ProductDto {
  return {
    shopifyProductId: 'gid://shopify/Product/1',
    title: 'Test Product',
    handle: 'test-product',
    description: null,
    status: 'ACTIVE',
    vendor: 'Tradelle',
    productType: null,
    tags: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    featuredImageUrl: null,
    minPrice: money(20),
    maxPrice: money(20),
    totalInventory: 10,
    variants: [variant()],
    supplier: 'TRADELLE',
    supplierEvidence: [],
    ...overrides,
  };
}

/** Rules with price automation switched on (the default has it off). */
function rulesWithPricing(overrides: Partial<AutomationRules['price']> = {}): AutomationRules {
  return {
    ...DEFAULT_AUTOMATION_RULES,
    price: {
      ...DEFAULT_AUTOMATION_RULES.price,
      enabled: true,
      paymentFeePercentage: 0,
      rounding: 'none',
      ...overrides,
    },
  };
}

describe('DEFAULT_AUTOMATION_RULES', () => {
  it('ships with price writing DISABLED', () => {
    // Installing automation must not be able to change a price until opted in.
    assert.equal(DEFAULT_AUTOMATION_RULES.price.enabled, false);
  });

  it('ships with hideUnknownCost disabled', () => {
    // Otherwise the first run on a store with no cost data hides everything.
    assert.equal(DEFAULT_AUTOMATION_RULES.visibility.hideUnknownCost, false);
  });

  it('validates cleanly', () => {
    assert.deepEqual(validateAutomationRules(DEFAULT_AUTOMATION_RULES), []);
  });
});

describe('validateAutomationRules', () => {
  it('rejects a floor above the target', () => {
    const rules = rulesWithPricing({ targetMarginPercentage: 10, minMarginPercentage: 40 });
    assert.ok(validateAutomationRules(rules).some((p) => p.includes('minMarginPercentage')));
  });

  it('rejects margin plus fees reaching 100%', () => {
    const rules = rulesWithPricing({
      targetMarginPercentage: 95,
      paymentFeePercentage: 10,
    });
    assert.ok(validateAutomationRules(rules).some((p) => p.includes('below 100')));
  });

  it('rejects a non-positive maxItemsPerRun', () => {
    const rules = { ...DEFAULT_AUTOMATION_RULES, maxItemsPerRun: 0 };
    assert.ok(validateAutomationRules(rules).some((p) => p.includes('maxItemsPerRun')));
  });
});

describe('resolveCost', () => {
  it('reads Shopify cost per item', () => {
    assert.equal(resolveCost(variant({ unitCost: money(7.5) })), 7.5);
  });

  it('treats a missing cost as unknown', () => {
    assert.equal(resolveCost(variant({ unitCost: null })), null);
  });

  it('treats a zero cost as UNKNOWN, not as free', () => {
    // Shopify returns 0 for "never filled in" as well as genuinely free, and
    // pricing from 0 would be inventing data.
    assert.equal(resolveCost(variant({ unitCost: money(0) })), null);
  });
});

describe('applyRounding', () => {
  it('rounds down to the nearest .99 for charm pricing', () => {
    assert.equal(applyRounding(12.4, 'charm99'), 11.99);
    assert.equal(applyRounding(13.0, 'charm99'), 12.99);
  });

  it('keeps a value already at .99', () => {
    assert.equal(applyRounding(12.99, 'charm99'), 12.99);
  });

  it('never returns a non-positive charm price', () => {
    assert.equal(applyRounding(0.2, 'charm99'), 0.99);
  });

  it('rounds to whole units for integer mode', () => {
    assert.equal(applyRounding(12.4, 'integer'), 12);
    assert.equal(applyRounding(12.6, 'integer'), 13);
  });

  it('leaves the value alone for none', () => {
    assert.equal(applyRounding(12.345, 'none'), 12.35);
  });
});

describe('decideVariantPrice', () => {
  it('skips when price automation is disabled', () => {
    const decision = decideVariantPrice(variant(), DEFAULT_AUTOMATION_RULES.price);
    assert.equal(decision.kind, 'skip');
  });

  it('NEVER prices a variant with no known cost', () => {
    const decision = decideVariantPrice(
      variant({ unitCost: null }),
      rulesWithPricing().price,
    );
    assert.equal(decision.kind, 'skip');
    assert.match(decision.reasons.join(' '), /Cost per item/i);
  });

  it('prices to the target margin', () => {
    // cost 10, target 50% -> 10 / (1 - 0.5) = 20
    const decision = decideVariantPrice(
      variant({ unitCost: money(10), price: money(12) }),
      rulesWithPricing({ targetMarginPercentage: 50, maxIncreasePercentage: 200 }).price,
    );
    assert.equal(decision.kind, 'change');
    assert.equal(decision.kind === 'change' ? decision.to : null, 20);
  });

  it('reports the margin achieved at the new price', () => {
    const decision = decideVariantPrice(
      variant({ unitCost: money(10), price: money(12) }),
      rulesWithPricing({ targetMarginPercentage: 50, maxIncreasePercentage: 200 }).price,
    );
    assert.equal(decision.kind, 'change');
    const projected = decision.kind === 'change' ? decision.projectedMarginPercentage : null;
    assert.ok(projected !== null && Math.abs(projected - 50) < 0.01);
  });

  it('clamps an increase to maxIncreasePercentage', () => {
    // Target would be 20 but only +20% of 12 (= 14.40) is allowed in one run.
    const decision = decideVariantPrice(
      variant({ unitCost: money(10), price: money(12) }),
      rulesWithPricing({
        targetMarginPercentage: 50,
        maxIncreasePercentage: 20,
        minMarginPercentage: 0,
      }).price,
    );
    assert.equal(decision.kind, 'change');
    assert.equal(decision.kind === 'change' ? decision.to : null, 14.4);
    assert.equal(decision.kind === 'change' ? decision.clamped : null, true);
  });

  it('clamps a decrease to maxDecreasePercentage', () => {
    const decision = decideVariantPrice(
      variant({ unitCost: money(1), price: money(100) }),
      rulesWithPricing({
        targetMarginPercentage: 30,
        maxDecreasePercentage: 10,
        minMarginPercentage: 0,
      }).price,
    );
    assert.equal(decision.kind, 'change');
    assert.equal(decision.kind === 'change' ? decision.to : null, 90);
  });

  it('refuses a clamped price that would breach the margin floor', () => {
    // Cost 10 with a 40% floor needs >= ~16.67, but +5% of 12 is only 12.60.
    // Selling at a loss is never an acceptable compromise.
    const decision = decideVariantPrice(
      variant({ unitCost: money(10), price: money(12) }),
      rulesWithPricing({
        targetMarginPercentage: 50,
        minMarginPercentage: 40,
        maxIncreasePercentage: 5,
      }).price,
    );
    assert.equal(decision.kind, 'skip');
    assert.match(decision.reasons.join(' '), /below the 40% floor/);
  });

  it('respects the margin floor after charm rounding', () => {
    const decision = decideVariantPrice(
      variant({ unitCost: money(10), price: money(15) }),
      rulesWithPricing({
        targetMarginPercentage: 50,
        minMarginPercentage: 50,
        rounding: 'charm99',
        maxIncreasePercentage: 200,
      }).price,
    );
    if (decision.kind === 'change') {
      const margin = marginAtPrice(decision.to, 10, rulesWithPricing().price);
      assert.ok(margin !== null && margin >= 50 - 0.01, `margin was ${margin}`);
    }
  });

  it('does nothing when the price is already within minChangeAmount', () => {
    const decision = decideVariantPrice(
      variant({ unitCost: money(10), price: money(20) }),
      rulesWithPricing({ targetMarginPercentage: 50, minChangeAmount: 0.05 }).price,
    );
    assert.equal(decision.kind, 'noop');
  });

  it('skips when cost and price are in different currencies', () => {
    const decision = decideVariantPrice(
      variant({ unitCost: money(10, 'USD'), price: money(20, 'GBP') }),
      rulesWithPricing().price,
    );
    assert.equal(decision.kind, 'skip');
    assert.match(decision.reasons.join(' '), /exchange rate/);
  });

  it('skips a variant with no current price', () => {
    const decision = decideVariantPrice(
      variant({ price: null }),
      rulesWithPricing().price,
    );
    assert.equal(decision.kind, 'skip');
  });

  it('always explains itself', () => {
    const decision = decideVariantPrice(variant(), rulesWithPricing().price);
    assert.ok(decision.reasons.length > 0);
  });
});

describe('resolveStock', () => {
  it('sums tracked variant quantities', () => {
    const p = product({
      variants: [
        variant({ inventoryQuantity: 3 }),
        variant({ shopifyVariantId: 'v2', inventoryQuantity: 4 }),
      ],
    });
    assert.equal(resolveStock(p).quantity, 7);
  });

  it('returns null - never 0 - when quantities are unknown', () => {
    // read_inventory not granted. Unknown must not read as out of stock.
    const p = product({
      totalInventory: null,
      variants: [variant({ inventoryQuantity: null, inventoryTracked: null })],
    });
    assert.equal(resolveStock(p).quantity, null);
  });

  it('flags untracked variants as always available', () => {
    const p = product({ variants: [variant({ inventoryTracked: false })] });
    assert.equal(resolveStock(p).hasUntrackedVariant, true);
  });
});

describe('decideVisibility', () => {
  it('hides an out-of-stock product', () => {
    const p = product({ totalInventory: 0, variants: [variant({ inventoryQuantity: 0 })] });
    const decision = decideVisibility(p, DEFAULT_AUTOMATION_RULES);
    assert.equal(decision.kind, 'change');
    assert.equal(decision.kind === 'change' ? decision.to : null, 'DRAFT');
  });

  it('does not hide an out-of-stock product that has an untracked variant', () => {
    const p = product({
      totalInventory: 0,
      variants: [variant({ inventoryQuantity: 0 }), variant({ shopifyVariantId: 'v2', inventoryTracked: false })],
    });
    assert.equal(decideVisibility(p, DEFAULT_AUTOMATION_RULES).kind, 'noop');
  });

  it('leaves a product alone when stock is unknown', () => {
    const p = product({
      totalInventory: null,
      variants: [variant({ inventoryQuantity: null, inventoryTracked: null })],
    });
    assert.equal(decideVisibility(p, DEFAULT_AUTOMATION_RULES).kind, 'noop');
  });

  it('restores a product automation hid once it is back in stock', () => {
    const p = product({ status: 'DRAFT', tags: ['trademart:auto-hidden'] });
    const decision = decideVisibility(p, DEFAULT_AUTOMATION_RULES);
    assert.equal(decision.kind, 'change');
    assert.equal(decision.kind === 'change' ? decision.to : null, 'ACTIVE');
  });

  it('NEVER un-hides a product a human drafted', () => {
    // No auto-hidden tag => a merchant drafted it deliberately.
    const p = product({ status: 'DRAFT', tags: [] });
    const decision = decideVisibility(p, DEFAULT_AUTOMATION_RULES);
    assert.equal(decision.kind, 'skip');
    assert.match(decision.reasons.join(' '), /hidden manually/);
  });

  it('never touches an ARCHIVED product', () => {
    const p = product({ status: 'ARCHIVED' });
    const decision = decideVisibility(p, DEFAULT_AUTOMATION_RULES);
    assert.equal(decision.kind, 'skip');
    assert.match(decision.reasons.join(' '), /ARCHIVED/);
  });

  it('honours an exempt tag', () => {
    const p = product({
      tags: ['trademart:manual'],
      totalInventory: 0,
      variants: [variant({ inventoryQuantity: 0 })],
    });
    assert.equal(decideVisibility(p, DEFAULT_AUTOMATION_RULES).kind, 'skip');
  });

  it('matches exempt tags case-insensitively', () => {
    const p = product({
      tags: ['Trademart:Manual'],
      totalInventory: 0,
      variants: [variant({ inventoryQuantity: 0 })],
    });
    assert.equal(decideVisibility(p, DEFAULT_AUTOMATION_RULES).kind, 'skip');
  });

  it('hides a product below the margin floor when that rule is on', () => {
    const rules: AutomationRules = {
      ...rulesWithPricing({ minMarginPercentage: 40 }),
      visibility: { ...DEFAULT_AUTOMATION_RULES.visibility, hideBelowMinMargin: true },
    };
    // cost 10, price 11 -> ~9% margin, well under the 40% floor.
    const p = product({ variants: [variant({ unitCost: money(10), price: money(11) })] });
    const margin = lowestCurrentMargin(p.variants, rules.price);
    const decision = decideVisibility(p, rules, margin);
    assert.equal(decision.kind, 'change');
    assert.equal(decision.kind === 'change' ? decision.to : null, 'DRAFT');
  });
});

describe('buildAutomationPlan', () => {
  it('produces no actions for a healthy catalogue under default rules', () => {
    const plan = buildAutomationPlan([product()], DEFAULT_AUTOMATION_RULES);
    assert.equal(plan.actions.length, 0);
  });

  it('records reasons for everything it skips', () => {
    const plan = buildAutomationPlan([product()], DEFAULT_AUTOMATION_RULES);
    assert.ok(plan.skipped.every((entry) => entry.reasons.length > 0));
  });

  it('does not reprice a product it is hiding in the same run', () => {
    const rules: AutomationRules = rulesWithPricing({ targetMarginPercentage: 50 });
    const p = product({
      totalInventory: 0,
      variants: [variant({ inventoryQuantity: 0, unitCost: money(10), price: money(12) })],
    });
    const plan = buildAutomationPlan([p], rules);
    assert.equal(plan.summary.visibilityChanges, 1);
    assert.equal(plan.summary.priceChanges, 0);
  });

  it('counts increases and decreases separately', () => {
    const rules = rulesWithPricing({
      targetMarginPercentage: 50,
      maxIncreasePercentage: 500,
      maxDecreasePercentage: 90,
      minMarginPercentage: 0,
    });
    const cheap = product({
      shopifyProductId: 'gid://shopify/Product/cheap',
      variants: [variant({ unitCost: money(10), price: money(12) })],
    });
    const dear = product({
      shopifyProductId: 'gid://shopify/Product/dear',
      variants: [variant({ shopifyVariantId: 'v9', unitCost: money(1), price: money(80) })],
    });
    const plan = buildAutomationPlan([cheap, dear], rules);
    assert.equal(plan.summary.priceIncreases, 1);
    assert.equal(plan.summary.priceDecreases, 1);
  });

  it('stops at maxItemsPerRun and flags the plan as truncated', () => {
    const rules: AutomationRules = {
      ...rulesWithPricing({ targetMarginPercentage: 50, maxIncreasePercentage: 500 }),
      maxItemsPerRun: 2,
    };
    const products = Array.from({ length: 10 }, (_, index) =>
      product({
        shopifyProductId: `gid://shopify/Product/${index}`,
        variants: [variant({ shopifyVariantId: `v${index}`, unitCost: money(10), price: money(12) })],
      }),
    );
    const plan = buildAutomationPlan(products, rules);
    assert.equal(plan.actions.length, 2);
    assert.equal(plan.summary.truncated, true);
  });

  it('skips an exempt product exactly once, not per variant', () => {
    const p = product({
      tags: ['trademart:manual'],
      variants: [variant(), variant({ shopifyVariantId: 'v2' })],
    });
    const plan = buildAutomationPlan([p], rulesWithPricing());
    assert.equal(plan.skipped.length, 1);
    assert.equal(plan.actions.length, 0);
  });

  it('reports how many actions were clamped', () => {
    const rules = rulesWithPricing({
      targetMarginPercentage: 50,
      maxIncreasePercentage: 10,
      minMarginPercentage: 0,
    });
    const p = product({ variants: [variant({ unitCost: money(10), price: money(12) })] });
    assert.equal(buildAutomationPlan([p], rules).summary.clamped, 1);
  });
});
