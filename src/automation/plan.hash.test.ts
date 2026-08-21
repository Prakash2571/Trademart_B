/**
 * Tests for plan fingerprinting.
 *
 * These cover the property the whole preview -> apply gate rests on: a plan whose
 * WRITES are identical hashes the same, and a plan whose writes or starting
 * values differ hashes differently. If this module is wrong, an operator can
 * approve one set of price changes and have another set applied.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { AutomationPlan, PriceAction, VisibilityAction } from './plan';
import {
  hashPlan,
  hashRules,
  normaliseScope,
  stableStringify,
} from './plan.hash';
import { DEFAULT_AUTOMATION_RULES } from './rules.types';

function priceAction(overrides: Partial<PriceAction> = {}): PriceAction {
  return {
    type: 'price',
    shopifyProductId: 'gid://shopify/Product/1',
    shopifyVariantId: 'gid://shopify/ProductVariant/11',
    title: 'Wireless Headphones',
    variantTitle: 'Default',
    from: 20,
    to: 25,
    currencyCode: 'GBP',
    currentMarginPercentage: 10,
    projectedMarginPercentage: 40,
    costSource: 'SHOPIFY_UNIT_COST',
    clamped: false,
    reasons: ['target margin 40%'],
    ...overrides,
  };
}

function visibilityAction(overrides: Partial<VisibilityAction> = {}): VisibilityAction {
  return {
    type: 'visibility',
    shopifyProductId: 'gid://shopify/Product/2',
    title: 'Out of stock thing',
    from: 'ACTIVE',
    to: 'DRAFT',
    reasons: ['no stock'],
    ...overrides,
  };
}

function plan(actions: AutomationPlan['actions']): AutomationPlan {
  return {
    actions,
    skipped: [],
    summary: {
      productsConsidered: actions.length,
      visibilityChanges: actions.filter((a) => a.type === 'visibility').length,
      priceChanges: actions.filter((a) => a.type === 'price').length,
      priceIncreases: 0,
      priceDecreases: 0,
      clamped: 0,
      skipped: 0,
      truncated: false,
    },
  };
}

describe('stableStringify', () => {
  it('is insensitive to key order', () => {
    // Rules are assembled by different paths (defaults+overrides vs
    // stored+overrides); insertion order must not change the fingerprint.
    assert.equal(stableStringify({ a: 1, b: 2 }), stableStringify({ b: 2, a: 1 }));
  });

  it('preserves array order, which IS significant', () => {
    assert.notEqual(stableStringify([1, 2]), stableStringify([2, 1]));
  });

  it('ignores undefined members', () => {
    assert.equal(stableStringify({ a: 1 }), stableStringify({ a: 1, b: undefined }));
  });
});

describe('hashPlan', () => {
  it('is stable for the same plan', () => {
    assert.equal(hashPlan(plan([priceAction()])), hashPlan(plan([priceAction()])));
  });

  it('ignores action ORDER - Shopify pagination order is not guaranteed', () => {
    const a = priceAction({ shopifyVariantId: 'gid://shopify/ProductVariant/11' });
    const b = priceAction({ shopifyVariantId: 'gid://shopify/ProductVariant/22' });
    assert.equal(hashPlan(plan([a, b])), hashPlan(plan([b, a])));
  });

  it('CHANGES when the destination price changes', () => {
    assert.notEqual(
      hashPlan(plan([priceAction({ to: 25 })])),
      hashPlan(plan([priceAction({ to: 26 })])),
    );
  });

  it('CHANGES when the starting price changes - the core staleness case', () => {
    // The scenario from the brief: preview computed 20 -> 25, but by apply time
    // the cost moved and the plan is now 18 -> 23. Even if only `from` differed,
    // the operator did not review this plan.
    assert.notEqual(
      hashPlan(plan([priceAction({ from: 20 })])),
      hashPlan(plan([priceAction({ from: 18 })])),
    );
  });

  it('CHANGES when an action is added', () => {
    assert.notEqual(
      hashPlan(plan([priceAction()])),
      hashPlan(plan([priceAction(), visibilityAction()])),
    );
  });

  it('CHANGES when an action is removed', () => {
    assert.notEqual(
      hashPlan(plan([priceAction(), visibilityAction()])),
      hashPlan(plan([priceAction()])),
    );
  });

  it('CHANGES when the cost provenance changes at an identical price', () => {
    // Same amount, different basis. The operator reviewed where the number came
    // from, so this counts as a different decision.
    assert.notEqual(
      hashPlan(plan([priceAction({ costSource: 'SHOPIFY_UNIT_COST' })])),
      hashPlan(plan([priceAction({ costSource: 'MANUAL' })])),
    );
  });

  it('CHANGES when a price becomes clamped', () => {
    assert.notEqual(
      hashPlan(plan([priceAction({ clamped: false })])),
      hashPlan(plan([priceAction({ clamped: true })])),
    );
  });

  it('CHANGES when a visibility target flips', () => {
    assert.notEqual(
      hashPlan(plan([visibilityAction({ to: 'DRAFT' })])),
      hashPlan(plan([visibilityAction({ to: 'ACTIVE' })])),
    );
  });

  it('is INSENSITIVE to presentational fields', () => {
    // A product rename must not invalidate a pricing decision, and neither
    // should a reworded reason or a recomputed margin.
    assert.equal(
      hashPlan(plan([priceAction({ title: 'Old name', reasons: ['a'] })])),
      hashPlan(
        plan([
          priceAction({
            title: 'Brand new name',
            variantTitle: 'Also different',
            reasons: ['completely different wording'],
            currentMarginPercentage: 99,
            projectedMarginPercentage: 1,
          }),
        ]),
      ),
    );
  });

  it('is insensitive to float noise in money, which is formatted to 2dp', () => {
    assert.equal(
      hashPlan(plan([priceAction({ to: 25 })])),
      hashPlan(plan([priceAction({ to: 25.000000001 })])),
    );
  });

  it('distinguishes an empty plan from a plan with actions', () => {
    assert.notEqual(hashPlan(plan([])), hashPlan(plan([priceAction()])));
  });
});

describe('hashRules', () => {
  it('is stable for the same rules', () => {
    assert.equal(hashRules(DEFAULT_AUTOMATION_RULES), hashRules(DEFAULT_AUTOMATION_RULES));
  });

  it('changes when a rule changes', () => {
    // Built by hand rather than via the service, so this test stays pure and does
    // not need a database or config to run.
    const changed = {
      ...DEFAULT_AUTOMATION_RULES,
      price: { ...DEFAULT_AUTOMATION_RULES.price, targetMarginPercentage: 55 },
    };
    assert.notEqual(hashRules(DEFAULT_AUTOMATION_RULES), hashRules(changed));
  });
});

describe('normaliseScope', () => {
  it('treats an absent and an empty product list identically', () => {
    assert.deepEqual(
      normaliseScope({ maxProducts: 50 }),
      normaliseScope({ maxProducts: 50, productIds: [] }),
    );
  });

  it('sorts product ids so caller ordering does not matter', () => {
    assert.deepEqual(
      normaliseScope({ maxProducts: 50, productIds: ['b', 'a'] }).productIds,
      ['a', 'b'],
    );
  });

  it('keeps query and maxProducts distinct', () => {
    const scope = normaliseScope({ query: 'tag:x', maxProducts: 10 });
    assert.equal(scope.query, 'tag:x');
    assert.equal(scope.maxProducts, 10);
  });
});
