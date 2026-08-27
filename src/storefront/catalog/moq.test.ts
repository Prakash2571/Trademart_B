/**
 * Wholesale minimum order quantity.
 *
 * Two properties matter more than the parsing itself:
 *
 *   1. A MALFORMED TAG YIELDS NO MINIMUM. `moq:ten`, `moq:0`, `moq:-5` must not become a
 *      minimum of any value. Guessing would either block a legitimate order or advertise a
 *      quantity rule the merchant never set.
 *   2. AN ABSENT TAG IS NOT "1". Null means no minimum, and the storefront shows nothing.
 *      Defaulting to 1 would put an "MOQ 1" badge on every product in a catalog that mostly
 *      has no minimum, and make a deliberate MOQ 1 indistinguishable from an untagged one.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MAX_MINIMUM_ORDER_QUANTITY,
  meetsMinimumOrderQuantity,
  minimumOrderValuePaise,
  parseMinimumOrderQuantity,
} from './moq';

describe('parseMinimumOrderQuantity', () => {
  it('reads the documented tag form', () => {
    assert.equal(parseMinimumOrderQuantity(['moq:12']), 12);
  });

  it('tolerates the ways a merchant actually types it', () => {
    // These are all one person meaning the same thing in the Shopify admin.
    for (const tag of ['MOQ:12', 'Moq: 12', 'moq : 12', 'moq=12', 'moq-12', '  moq:12  ']) {
      assert.equal(parseMinimumOrderQuantity([tag]), 12, tag);
    }
  });

  it('ignores every other tag', () => {
    assert.equal(
      parseMinimumOrderQuantity(['wholesale', 'bulk', 'electronics', 'new-arrival']),
      null,
    );
  });

  it('is null when there are no tags at all', () => {
    assert.equal(parseMinimumOrderQuantity([]), null);
    assert.equal(parseMinimumOrderQuantity(null), null);
    assert.equal(parseMinimumOrderQuantity(undefined), null);
  });

  it('refuses a malformed value rather than guessing', () => {
    for (const tag of ['moq:ten', 'moq:', 'moq:1.5', 'moq:1e3', 'moq:12x', 'moq', 'moq::12']) {
      assert.equal(parseMinimumOrderQuantity([tag]), null, tag);
    }
  });

  it('refuses zero and negatives, which cannot be a minimum', () => {
    assert.equal(parseMinimumOrderQuantity(['moq:0']), null);
    assert.equal(parseMinimumOrderQuantity(['moq:-5']), null);
  });

  it('refuses a minimum the checkout could never satisfy', () => {
    // Above the per-line quantity cap the storefront would advertise a minimum that
    // checkout is guaranteed to reject, which is worse than showing none.
    assert.equal(parseMinimumOrderQuantity([`moq:${MAX_MINIMUM_ORDER_QUANTITY}`]), MAX_MINIMUM_ORDER_QUANTITY);
    assert.equal(parseMinimumOrderQuantity([`moq:${MAX_MINIMUM_ORDER_QUANTITY + 1}`]), null);
  });

  it('takes the LARGEST when a product carries contradictory tags', () => {
    // Two MOQ tags is a merchant mistake. Honouring the smaller one would let an order
    // through that one of the two rules forbids, so the conservative value wins.
    assert.equal(parseMinimumOrderQuantity(['moq:6', 'moq:24', 'moq:12']), 24);
  });

  it('survives a non-string in the tag array', () => {
    // Tags come from an external API; a null in the array must not throw during a catalog
    // projection that is serving a page.
    assert.equal(
      parseMinimumOrderQuantity([null as unknown as string, 'moq:8', 42 as unknown as string]),
      8,
    );
  });
});

describe('meetsMinimumOrderQuantity', () => {
  it('allows anything when no minimum is set', () => {
    assert.equal(meetsMinimumOrderQuantity(1, null), true);
  });

  it('allows the minimum exactly, and more', () => {
    assert.equal(meetsMinimumOrderQuantity(12, 12), true);
    assert.equal(meetsMinimumOrderQuantity(13, 12), true);
  });

  it('refuses one below the minimum', () => {
    assert.equal(meetsMinimumOrderQuantity(11, 12), false);
  });

  it('refuses a non-integer quantity', () => {
    // The checkout validator already rejects these, but this predicate is also the one the
    // storefront uses, and it must not answer "fine" to 11.5.
    assert.equal(meetsMinimumOrderQuantity(12.5, 12), false);
    assert.equal(meetsMinimumOrderQuantity(Number.NaN, 12), false);
  });
});

describe('minimumOrderValuePaise', () => {
  it('multiplies unit price by the minimum', () => {
    // ₹349 x 10 = ₹3,490. Exposed so the storefront shows the same figure the backend
    // computes instead of multiplying a formatted price string in the browser.
    assert.equal(minimumOrderValuePaise(34_900, 10), 349_000);
  });

  it('is null when either half is unknown', () => {
    assert.equal(minimumOrderValuePaise(null, 10), null);
    assert.equal(minimumOrderValuePaise(34_900, null), null);
  });

  it('refuses to produce an unsafe integer', () => {
    assert.equal(minimumOrderValuePaise(Number.MAX_SAFE_INTEGER, 10), null);
  });

  it('rejects a negative unit price', () => {
    assert.equal(minimumOrderValuePaise(-100, 10), null);
  });
});
