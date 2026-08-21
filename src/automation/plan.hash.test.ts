/**
 * hashPlan - the mechanism that makes the preview gate real.
 *
 * WHY THIS MATTERS MORE THAN IT LOOKS
 * ----------------------------------
 * An operator reviews a preview ("raise SKU-1 from 20.00 to 25.00") and then
 * clicks apply. Between those two moments Shopify or the cost data can move, so
 * the same rules now produce a DIFFERENT set of writes (18.00 -> 23.00). Comparing
 * this hash is what detects that and refuses the apply as PREVIEW_STALE.
 *
 * So a hash that is insensitive to a change it ought to notice does not fail
 * loudly - it silently applies a plan the operator never saw. Every "CHANGES
 * when..." case below is therefore a safety assertion, not a formatting one, and
 * the "INSENSITIVE to..." cases matter just as much: a hash that changes when
 * nothing meaningful did produces spurious PREVIEW_STALE errors and trains
 * operators to distrust the gate.
 *
 * hashPlan lives in automation.service.ts, which is the ONE place a plan is
 * hashed. Keeping it there rather than in a separate pure module is deliberate:
 * two implementations of a safety hash drifting apart would produce false
 * PREVIEW_STALE rejections that nobody could explain.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// Imported from ./plan, NOT from ./automation.service. The service pulls in the
// Shopify client and the Mongo models, which pull in the config singleton, and
// config/index.ts calls process.exit(1) on invalid env - so importing it here would
// kill the test process in any environment without a configured Shopify store
// rather than failing an assertion. Hashing a plan is pure logic; it is tested as
// such.
import { hashPlan } from './plan';
import type {
  AutomationAction,
  AutomationPlan,
  PriceAction,
  VisibilityAction,
} from './plan';

function priceAction(overrides: Partial<PriceAction> = {}): PriceAction {
  return {
    type: 'price',
    shopifyProductId: 'gid://shopify/Product/1',
    shopifyVariantId: 'gid://shopify/ProductVariant/11',
    title: 'Widget',
    variantTitle: 'Default',
    from: 20,
    to: 25,
    currencyCode: 'GBP',
    currentMarginPercentage: 10,
    projectedMarginPercentage: 30,
    costSource: 'SHOPIFY_UNIT_COST',
    clamped: false,
    reasons: ['below target margin'],
    ...overrides,
  };
}

function visibilityAction(overrides: Partial<VisibilityAction> = {}): VisibilityAction {
  return {
    type: 'visibility',
    shopifyProductId: 'gid://shopify/Product/2',
    title: 'Gadget',
    from: 'ACTIVE',
    to: 'DRAFT',
    reasons: ['out of stock'],
    ...overrides,
  };
}

function plan(actions: AutomationAction[]): AutomationPlan {
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

describe('hashPlan is stable', () => {
  it('is identical for the same plan hashed twice', () => {
    const a = plan([priceAction(), visibilityAction()]);
    const b = plan([priceAction(), visibilityAction()]);
    assert.equal(hashPlan(a), hashPlan(b));
  });

  it('ignores action ORDER', () => {
    // Shopify pagination order is not guaranteed, so re-preparing the same plan
    // can legitimately yield the actions in a different sequence. If ordering
    // affected the hash, every apply would risk a spurious PREVIEW_STALE.
    const forwards = plan([priceAction(), visibilityAction()]);
    const backwards = plan([visibilityAction(), priceAction()]);
    assert.equal(hashPlan(forwards), hashPlan(backwards));
  });

  it('distinguishes an empty plan from one with actions', () => {
    assert.notEqual(hashPlan(plan([])), hashPlan(plan([priceAction()])));
  });

  it('is stable for an empty plan', () => {
    assert.equal(hashPlan(plan([])), hashPlan(plan([])));
  });
});

describe('hashPlan CHANGES when the writes would change', () => {
  it('when the destination price changes', () => {
    assert.notEqual(
      hashPlan(plan([priceAction({ to: 25 })])),
      hashPlan(plan([priceAction({ to: 26 })])),
    );
  });

  it('when the STARTING price changes - the core staleness case', () => {
    // Someone edited the price in Shopify after the preview. The destination is
    // the same, but the operator approved a different change from a different
    // starting point, and the margin they were shown is now wrong.
    assert.notEqual(
      hashPlan(plan([priceAction({ from: 20 })])),
      hashPlan(plan([priceAction({ from: 18 })])),
    );
  });

  it('when the currency changes at the same numeric price', () => {
    assert.notEqual(
      hashPlan(plan([priceAction({ currencyCode: 'GBP' })])),
      hashPlan(plan([priceAction({ currencyCode: 'USD' })])),
    );
  });

  it('when an action is added', () => {
    assert.notEqual(
      hashPlan(plan([priceAction()])),
      hashPlan(plan([priceAction(), visibilityAction()])),
    );
  });

  it('when an action is removed', () => {
    assert.notEqual(
      hashPlan(plan([priceAction(), visibilityAction()])),
      hashPlan(plan([priceAction()])),
    );
  });

  it('when a visibility target flips', () => {
    assert.notEqual(
      hashPlan(plan([visibilityAction({ to: 'DRAFT' })])),
      hashPlan(plan([visibilityAction({ to: 'ACTIVE' })])),
    );
  });

  it('when the product being changed is different', () => {
    assert.notEqual(
      hashPlan(plan([priceAction({ shopifyProductId: 'gid://shopify/Product/1' })])),
      hashPlan(plan([priceAction({ shopifyProductId: 'gid://shopify/Product/9' })])),
    );
  });

  it('when the VARIANT being changed is different at the same product and price', () => {
    // Repricing the wrong variant of a multi-variant product is a silent,
    // customer-visible error, so the variant must be part of the identity.
    assert.notEqual(
      hashPlan(plan([priceAction({ shopifyVariantId: 'gid://shopify/ProductVariant/11' })])),
      hashPlan(plan([priceAction({ shopifyVariantId: 'gid://shopify/ProductVariant/12' })])),
    );
  });

  it('distinguishes a price action from a visibility action on the same product', () => {
    const asPrice = plan([priceAction({ shopifyProductId: 'gid://shopify/Product/5' })]);
    const asVisibility = plan([
      visibilityAction({ shopifyProductId: 'gid://shopify/Product/5' }),
    ]);
    assert.notEqual(hashPlan(asPrice), hashPlan(asVisibility));
  });
});

describe('hashPlan is INSENSITIVE to things that do not change the writes', () => {
  it('ignores float noise, because money is compared at 2dp', () => {
    // 25.00 and 25.000000000000004 produce the same Shopify write. Hashing the
    // raw float would make repeated arithmetic yield spurious PREVIEW_STALE.
    assert.equal(
      hashPlan(plan([priceAction({ to: 25 })])),
      hashPlan(plan([priceAction({ to: 25.000000000000004 })])),
    );
  });

  it('ignores presentational fields', () => {
    // Titles, margin percentages and reason strings are shown to the operator but
    // are not part of what gets written. A retitled product is not a stale plan.
    assert.equal(
      hashPlan(plan([priceAction()])),
      hashPlan(
        plan([
          priceAction({
            title: 'Widget (renamed)',
            variantTitle: 'Large',
            currentMarginPercentage: 99,
            projectedMarginPercentage: 1,
            reasons: ['completely different explanation'],
          }),
        ]),
      ),
    );
  });

  it('ignores `skipped` and `summary`, which describe the plan rather than its writes', () => {
    const base = plan([priceAction()]);
    const decorated: AutomationPlan = {
      ...base,
      skipped: [
        {
          shopifyProductId: 'gid://shopify/Product/77',
          shopifyVariantId: null,
          title: 'Skipped thing',
          reasons: ['exempt tag'],
        },
      ],
      summary: { ...base.summary, productsConsidered: 999, truncated: true },
    };
    assert.equal(hashPlan(base), hashPlan(decorated));
  });

  it('ignores costSource, because an identical price is an identical write', () => {
    // Documented rather than asserted as desirable: provenance changing at the
    // same resulting price means the STORE change is byte-identical, so refusing
    // the apply would be a false alarm. Provenance is still recorded on the run
    // and in the audit trail, where it belongs.
    assert.equal(
      hashPlan(plan([priceAction({ costSource: 'SHOPIFY_UNIT_COST' })])),
      hashPlan(plan([priceAction({ costSource: 'MANUAL' })])),
    );
  });
});

describe('the hash is a usable identifier', () => {
  it('is a 64-character hex sha256', () => {
    assert.match(hashPlan(plan([priceAction()])), /^[a-f0-9]{64}$/);
  });
});
