/**
 * Unit tests for webhook trigger mapping, cooldown, and loop safety.
 *
 * The most important test in this file is the fixed-point one: it proves that
 * feeding automation's own output back in produces NO further change, which is
 * what stops a write -> webhook -> write feedback loop against a live store.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ProductDto, ProductVariantDto } from '../shopify/shopify.types';
import { buildAutomationPlan } from './plan';
import { decideVariantPrice } from './price.rules';
import {
  AUTOMATION_TRIGGER_TOPICS,
  TriggerCooldown,
  decideTrigger,
  toProductGid,
} from './automation.triggers';
import { DEFAULT_AUTOMATION_RULES, type AutomationRules } from './rules.types';

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

function rules(overrides: Partial<AutomationRules['price']> = {}): AutomationRules {
  return {
    ...DEFAULT_AUTOMATION_RULES,
    price: {
      ...DEFAULT_AUTOMATION_RULES.price,
      enabled: true,
      paymentFeePercentage: 0,
      rounding: 'none',
      maxIncreasePercentage: 500,
      maxDecreasePercentage: 90,
      minMarginPercentage: 0,
      ...overrides,
    },
  };
}

describe('toProductGid', () => {
  it('passes a GID through', () => {
    assert.equal(
      toProductGid('gid://shopify/Product/123'),
      'gid://shopify/Product/123',
    );
  });

  it('promotes a numeric string id', () => {
    assert.equal(toProductGid('123'), 'gid://shopify/Product/123');
  });

  it('promotes a JSON number id, as webhooks deliver them', () => {
    assert.equal(toProductGid(123), 'gid://shopify/Product/123');
  });

  it('rejects nonsense', () => {
    assert.equal(toProductGid('not-an-id'), null);
    assert.equal(toProductGid(null), null);
    assert.equal(toProductGid(-5), null);
  });
});

describe('decideTrigger', () => {
  it('triggers on products/update', () => {
    const decision = decideTrigger('products/update', { id: 555 });
    assert.equal(decision.run, true);
    assert.equal(
      decision.run === true ? decision.shopifyProductId : null,
      'gid://shopify/Product/555',
    );
  });

  it('triggers on products/create with a new-import reason', () => {
    const decision = decideTrigger('products/create', { id: 1 });
    assert.equal(decision.run, true);
    assert.match(decision.run === true ? decision.reason : '', /New product/i);
  });

  it('triggers on inventory_levels/update and passes the inventory item id', () => {
    // This payload has no product id at all, which the caller must resolve.
    const decision = decideTrigger('inventory_levels/update', {
      inventory_item_id: 99,
      available: 0,
    });
    assert.equal(decision.run, true);
    assert.equal(decision.run === true ? decision.shopifyProductId : 'x', null);
    assert.equal(
      decision.run === true ? decision.inventoryItemId : null,
      'gid://shopify/InventoryItem/99',
    );
  });

  it('ignores topics that cannot affect price or stock', () => {
    assert.equal(decideTrigger('orders/create', { id: 1 }).run, false);
    assert.equal(decideTrigger('app/uninstalled', {}).run, false);
  });

  it('is case-insensitive about the topic', () => {
    assert.equal(decideTrigger('PRODUCTS/UPDATE', { id: 1 }).run, true);
  });

  it('refuses a payload that is not an object', () => {
    assert.equal(decideTrigger('products/update', 'nope').run, false);
    assert.equal(decideTrigger('products/update', null).run, false);
  });

  it('refuses a product payload with no usable id', () => {
    const decision = decideTrigger('products/update', { title: 'no id here' });
    assert.equal(decision.run, false);
  });

  it('accepts admin_graphql_api_id as the id source', () => {
    const decision = decideTrigger('products/update', {
      admin_graphql_api_id: 'gid://shopify/Product/777',
    });
    assert.equal(decision.run, true);
  });

  it('lists exactly the topics it handles', () => {
    for (const topic of AUTOMATION_TRIGGER_TOPICS) {
      const payload =
        topic === 'inventory_levels/update' ? { inventory_item_id: 1 } : { id: 1 };
      assert.equal(decideTrigger(topic, payload).run, true, topic);
    }
  });
});

describe('TriggerCooldown', () => {
  it('allows the first attempt and blocks an immediate repeat', () => {
    let now = 1000;
    const cd = new TriggerCooldown({ windowMs: 60_000, now: () => now });
    assert.equal(cd.tryAcquire('p1'), true);
    assert.equal(cd.tryAcquire('p1'), false);
  });

  it('allows again once the window has passed', () => {
    let now = 1000;
    const cd = new TriggerCooldown({ windowMs: 60_000, now: () => now });
    assert.equal(cd.tryAcquire('p1'), true);
    now += 60_001;
    assert.equal(cd.tryAcquire('p1'), true);
  });

  it('tracks products independently', () => {
    let now = 1000;
    const cd = new TriggerCooldown({ windowMs: 60_000, now: () => now });
    assert.equal(cd.tryAcquire('p1'), true);
    assert.equal(cd.tryAcquire('p2'), true);
  });
});

describe('loop safety: automation output is a fixed point', () => {
  it('produces NO further change when fed its own result back', () => {
    // This is the property that terminates the write -> webhook -> write loop.
    const config = rules({ targetMarginPercentage: 50 });
    const before = product({
      variants: [variant({ unitCost: money(10), price: money(12) })],
    });

    const first = buildAutomationPlan([before], config);
    assert.equal(first.summary.priceChanges, 1, 'expected a first-pass change');

    const newPrice = (first.actions[0] as { to: number }).to;

    // Simulate Shopify after our write, then the products/update echo.
    const after = product({
      variants: [variant({ unitCost: money(10), price: money(newPrice) })],
    });
    const second = buildAutomationPlan([after], config);

    assert.equal(second.summary.priceChanges, 0, 'second pass must be a no-op');
  });

  it('is a fixed point in multiplier mode too', () => {
    const config = rules({ pricingMode: 'multiplier', multiplier: 2.5 });
    const before = product({
      variants: [variant({ unitCost: money(10), price: money(12) })],
    });
    const first = buildAutomationPlan([before], config);
    assert.equal(first.summary.priceChanges, 1);

    const newPrice = (first.actions[0] as { to: number }).to;
    const after = product({
      variants: [variant({ unitCost: money(10), price: money(newPrice) })],
    });
    assert.equal(buildAutomationPlan([after], config).summary.priceChanges, 0);
  });

  it('is a fixed point with charm rounding, which is where oscillation would show', () => {
    // Rounding down then re-evaluating is the classic oscillation trap.
    const config = rules({
      pricingMode: 'multiplier',
      multiplier: 2.5,
      rounding: 'charm99',
    });
    let current = 12;
    for (let pass = 0; pass < 5; pass += 1) {
      const decision = decideVariantPrice(
        variant({ unitCost: money(10), price: money(current) }),
        config.price,
      );
      if (decision.kind !== 'change') break;
      current = decision.to;
    }
    // After settling, another pass must not move it.
    const settled = decideVariantPrice(
      variant({ unitCost: money(10), price: money(current) }),
      config.price,
    );
    assert.notEqual(settled.kind, 'change', `oscillating at ${current}`);
  });
});
