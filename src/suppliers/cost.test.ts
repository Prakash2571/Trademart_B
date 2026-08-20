/**
 * Unit tests for the cost-source hierarchy and manual-cost validation.
 *
 * The property that matters most: a missing or non-positive cost is UNKNOWN at
 * every level, never fabricated as 0 - because an UNKNOWN cost stops the product
 * being repriced, and a 0 would price it as if it were free.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AppError } from '../common/errors';
import {
  COST_SOURCE_ORDER,
  UNKNOWN_COST_POLICY,
  hasUsableCost,
  resolveCostSource,
  type CostInputs,
} from './cost';
import { validateManualCostInput } from './manualCost.validate';
import {
  anySupplierCostApiAvailable,
  describeSupplierCostSupport,
} from './supplier.registry';
import { tradelleProvider } from './tradelle/tradelle.provider';

function money(amount: number, currencyCode = 'GBP') {
  return { amount, currencyCode, raw: amount.toFixed(2) };
}

describe('resolveCostSource - hierarchy', () => {
  it('prefers supplier API over everything', () => {
    const result = resolveCostSource({
      supplierApiCost: money(10),
      shopifyUnitCost: money(20),
      manualCost: { amount: 30, currencyCode: 'GBP' },
    });
    assert.equal(result.source, 'SUPPLIER_API');
    assert.equal(result.amount, 10);
  });

  it('falls back to Shopify cost per item when no supplier API value', () => {
    const result = resolveCostSource({
      shopifyUnitCost: money(20),
      manualCost: { amount: 30, currencyCode: 'GBP' },
    });
    assert.equal(result.source, 'SHOPIFY_UNIT_COST');
    assert.equal(result.amount, 20);
  });

  it('falls back to manual when no API and no Shopify cost', () => {
    const result = resolveCostSource({ manualCost: { amount: 30, currencyCode: 'GBP' } });
    assert.equal(result.source, 'MANUAL');
    assert.equal(result.amount, 30);
  });

  it('is UNKNOWN when nothing is available', () => {
    const result = resolveCostSource({});
    assert.equal(result.source, 'UNKNOWN');
    assert.equal(result.amount, null);
    assert.equal(result.currencyCode, null);
  });

  it('lets an explicit manual override beat Shopify cost per item', () => {
    // A merchant correcting a wrong Shopify cost must not be ignored.
    const result = resolveCostSource({
      shopifyUnitCost: money(20),
      manualCost: { amount: 30, currencyCode: 'GBP', override: true },
    });
    assert.equal(result.source, 'MANUAL');
    assert.equal(result.amount, 30);
  });

  it('does NOT let a manual override beat a supplier API value', () => {
    // The API is the most authoritative source; override only outranks Shopify.
    const result = resolveCostSource({
      supplierApiCost: money(10),
      manualCost: { amount: 30, currencyCode: 'GBP', override: true },
    });
    assert.equal(result.source, 'SUPPLIER_API');
  });
});

describe('resolveCostSource - never fabricates', () => {
  const zeroCases: CostInputs[] = [
    { shopifyUnitCost: money(0) },
    { shopifyUnitCost: money(-5) },
    { supplierApiCost: money(0) },
    { manualCost: { amount: 0, currencyCode: 'GBP' } },
    { manualCost: { amount: -1, currencyCode: 'GBP' } },
  ];

  for (const [index, input] of zeroCases.entries()) {
    it(`treats non-positive as UNKNOWN, not free (case ${index + 1})`, () => {
      assert.equal(resolveCostSource(input).source, 'UNKNOWN');
    });
  }

  it('skips a zero Shopify cost and uses a positive manual fallback', () => {
    const result = resolveCostSource({
      shopifyUnitCost: money(0),
      manualCost: { amount: 12, currencyCode: 'GBP' },
    });
    assert.equal(result.source, 'MANUAL');
    assert.equal(result.amount, 12);
  });

  it('rejects a manual cost with no currency', () => {
    const result = resolveCostSource({
      manualCost: { amount: 12, currencyCode: '' },
    });
    assert.equal(result.source, 'UNKNOWN');
  });

  it('carries the manual updatedAt through as fetchedAt', () => {
    const result = resolveCostSource({
      manualCost: { amount: 12, currencyCode: 'GBP', updatedAt: '2026-01-01T00:00:00Z' },
    });
    assert.equal(result.fetchedAt, '2026-01-01T00:00:00Z');
  });
});

describe('hasUsableCost', () => {
  it('is true for a positive resolved cost', () => {
    assert.equal(hasUsableCost(resolveCostSource({ shopifyUnitCost: money(5) })), true);
  });
  it('is false for UNKNOWN', () => {
    assert.equal(hasUsableCost(resolveCostSource({})), false);
  });
});

describe('validateManualCostInput', () => {
  const base = {
    shopifyProductId: '123',
    supplierProductCost: 10,
    currencyCode: 'gbp',
  };

  it('accepts a minimal valid payload and normalises', () => {
    const result = validateManualCostInput({ ...base });
    assert.equal(result.shopifyProductId, 'gid://shopify/Product/123');
    assert.equal(result.currencyCode, 'GBP');
    assert.equal(result.shopifyVariantId, null);
    assert.equal(result.provider, 'UNKNOWN');
    assert.equal(result.override, false);
  });

  it('normalises a variant numeric id to a GID', () => {
    const result = validateManualCostInput({ ...base, shopifyVariantId: '456' });
    assert.equal(result.shopifyVariantId, 'gid://shopify/ProductVariant/456');
  });

  it('rejects a zero cost - never stored as free', () => {
    assert.throws(
      () => validateManualCostInput({ ...base, supplierProductCost: 0 }),
      (e: unknown) => e instanceof AppError && e.code === 'VALIDATION_ERROR',
    );
  });

  it('rejects a negative cost', () => {
    assert.throws(() => validateManualCostInput({ ...base, supplierProductCost: -1 }));
  });

  it('rejects a missing product id', () => {
    assert.throws(() => validateManualCostInput({ supplierProductCost: 10, currencyCode: 'GBP' }));
  });

  it('rejects a bad currency code', () => {
    assert.throws(() => validateManualCostInput({ ...base, currencyCode: 'pounds' }));
  });

  it('accepts an optional positive shipping cost, rejects zero', () => {
    assert.equal(
      validateManualCostInput({ ...base, supplierShippingCost: 3 }).supplierShippingCost,
      3,
    );
    assert.throws(() => validateManualCostInput({ ...base, supplierShippingCost: 0 }));
  });

  it('carries an override flag', () => {
    assert.equal(validateManualCostInput({ ...base, override: true }).override, true);
  });

  it('validates the provider enum', () => {
    assert.equal(validateManualCostInput({ ...base, provider: 'tradelle' }).provider, 'TRADELLE');
    assert.throws(() => validateManualCostInput({ ...base, provider: 'aliexpress' }));
  });

  it('rejects an over-long note', () => {
    assert.throws(() => validateManualCostInput({ ...base, note: 'x'.repeat(501) }));
  });

  it('rejects an Order GID passed where a Product is expected', () => {
    assert.throws(() =>
      validateManualCostInput({ ...base, shopifyProductId: 'gid://shopify/Order/1' }),
    );
  });
});


import { decideVariantPrice } from '../automation/price.rules';
import { DEFAULT_AUTOMATION_RULES } from '../automation/rules.types';
import type { ProductVariantDto } from '../shopify/shopify.types';

function variant(unitCost: ReturnType<typeof money> | null): ProductVariantDto {
  return {
    shopifyVariantId: 'gid://shopify/ProductVariant/1',
    title: 'V',
    sku: null,
    barcode: null,
    // Current price differs from the 50%-margin target so a change is produced
    // (target from cost 10 is 20; a price of 12 makes the repricing visible).
    price: money(12),
    compareAtPrice: null,
    availableForSale: true,
    inventoryQuantity: 5,
    inventoryItemId: null,
    inventoryTracked: true,
    unitCost,
  };
}

const priceRules = {
  ...DEFAULT_AUTOMATION_RULES.price,
  enabled: true,
  paymentFeePercentage: 0,
  rounding: 'none' as const,
  targetMarginPercentage: 50,
  minMarginPercentage: 0,
  maxIncreasePercentage: 500,
};

describe('decideVariantPrice - cost source integration', () => {
  it('prices from a manual cost when Shopify has none', () => {
    const decision = decideVariantPrice(variant(null), priceRules, {
      amount: 10,
      currencyCode: 'GBP',
    });
    assert.equal(decision.kind, 'change');
    assert.equal(decision.costSource, 'MANUAL');
    assert.equal(decision.kind === 'change' ? decision.to : null, 20); // 10 / (1-0.5)
  });

  it('reports the cost source in the reasons', () => {
    const decision = decideVariantPrice(variant(money(10)), priceRules);
    assert.equal(decision.costSource, 'SHOPIFY_UNIT_COST');
    assert.match(decision.reasons.join(' '), /Shopify cost per item/);
  });

  it('still skips when no cost from any source', () => {
    const decision = decideVariantPrice(variant(null), priceRules, null);
    assert.equal(decision.kind, 'skip');
    assert.equal(decision.costSource, 'UNKNOWN');
  });

  it('a manual override beats the Shopify unit cost', () => {
    const decision = decideVariantPrice(variant(money(10)), priceRules, {
      amount: 40,
      currencyCode: 'GBP',
      override: true,
    });
    assert.equal(decision.costSource, 'MANUAL');
    // Target from override cost 40 at 50% margin is 80, but +500% of the current
    // price (12) caps a single run at 72 - the clamp guardrail still applies to
    // an override, which is correct.
    assert.equal(decision.kind === 'change' ? decision.to : null, 72);
  });
});


describe('COST_SOURCE_ORDER', () => {
  it('matches the documented hierarchy', () => {
    assert.deepEqual(
      [...COST_SOURCE_ORDER],
      ['SUPPLIER_API', 'SHOPIFY_UNIT_COST', 'MANUAL', 'UNKNOWN'],
    );
  });

  it('is the order resolveCostSource actually applies', () => {
    // Walks the hierarchy by removing the winning tier one at a time. This is
    // what stops /api/automation/status documenting an order the resolver does
    // not implement - the exact drift that made the old costSource field wrong.
    const all: CostInputs = {
      supplierApiCost: money(10),
      shopifyUnitCost: money(20),
      manualCost: { amount: 30, currencyCode: 'GBP' },
    };

    assert.equal(resolveCostSource(all).source, COST_SOURCE_ORDER[0]);

    const { supplierApiCost: _s, ...withoutSupplier } = all;
    assert.equal(resolveCostSource(withoutSupplier).source, COST_SOURCE_ORDER[1]);

    const { shopifyUnitCost: _u, ...withoutShopify } = withoutSupplier;
    assert.equal(resolveCostSource(withoutShopify).source, COST_SOURCE_ORDER[2]);

    assert.equal(resolveCostSource({}).source, COST_SOURCE_ORDER[3]);
  });

  it('lists UNKNOWN last, and it is a real outcome rather than an absence', () => {
    assert.equal(COST_SOURCE_ORDER[COST_SOURCE_ORDER.length - 1], 'UNKNOWN');

    const resolved = resolveCostSource({});
    assert.equal(resolved.source, 'UNKNOWN');
    // The guarantee UNKNOWN_COST_POLICY describes: null, never 0.
    assert.equal(resolved.amount, null);
    assert.equal(hasUsableCost(resolved), false);
  });

  it('states the unknown-cost policy as skipping automatic pricing', () => {
    assert.equal(UNKNOWN_COST_POLICY, 'SKIP_AUTOMATIC_PRICING');
  });
});

describe('describeSupplierCostSupport', () => {
  it('reports Tradelle as having no supplier cost API', () => {
    const support = describeSupplierCostSupport();
    const tradelle = support.find((entry) => entry.providerName === 'TRADELLE');

    if (tradelle === undefined) {
      throw new Error('TRADELLE must be registered');
    }
    // The honesty requirement: the method exists and returns null, so the
    // capability must NOT be advertised as available.
    assert.equal(tradelle.supplierCostApi, false);
    assert.equal(tradelle.shopifyIntegration, true);
    assert.ok(
      tradelle.limitation !== null && tradelle.limitation.length > 0,
      'a false capability must explain itself',
    );
  });

  it('does not infer capability from method existence', () => {
    // tradelleProvider.getSupplierCost IS a function, but returns null.
    assert.equal(typeof tradelleProvider.getSupplierCost, 'function');
    assert.equal(tradelleProvider.capabilities.getSupplierCost, false);
  });

  it('reports no supplier cost API available across the whole registry', () => {
    // Guards the `available: false` flag on the SUPPLIER_API tier in
    // /api/automation/status. Flips automatically when a real provider lands.
    assert.equal(anySupplierCostApiAvailable(), false);
  });

  it('returns null from the Tradelle cost lookup rather than inventing a number', async () => {
    assert.equal(await tradelleProvider.getSupplierCost?.('gid://shopify/Product/1'), null);
  });
});
