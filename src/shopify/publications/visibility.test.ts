/**
 * The "can customers see this product?" rule.
 *
 * Exhaustive on purpose. Every branch here corresponds to a real way this has
 * been got wrong: equating ACTIVE with on-sale, equating published with on-sale,
 * counting a non-web channel as visibility, and reporting a confident `false` when
 * the status was never returned.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { decideVisibility } from './publications.service';

const PRODUCT = 'gid://shopify/Product/1';

function channel(name: string, isPublished: boolean) {
  return {
    publicationId: `gid://shopify/Publication/${name}`,
    name,
    isPublished,
    publishDate: isPublished ? '2026-01-01T00:00:00Z' : null,
  };
}

function decide(status: string | null, publications: ReturnType<typeof channel>[]) {
  return decideVisibility({ shopifyProductId: PRODUCT, status, publications });
}

describe('visibility requires BOTH ACTIVE and Online Store publication', () => {
  it('ACTIVE + published to Online Store is visible', () => {
    const result = decide('ACTIVE', [channel('Online Store', true)]);
    assert.equal(result.visibleToCustomers, true);
    assert.match(result.reason, /ACTIVE and the product is published/);
  });

  it('ACTIVE but NOT published is not visible', () => {
    // The original bug: it looks live in the Shopify admin and no customer can
    // find it.
    const result = decide('ACTIVE', [channel('Online Store', false)]);
    assert.equal(result.visibleToCustomers, false);
    assert.match(result.reason, /looks live in the Shopify admin/);
  });

  it('DRAFT but published is not visible', () => {
    const result = decide('DRAFT', [channel('Online Store', true)]);
    assert.equal(result.visibleToCustomers, false);
    assert.match(result.reason, /status is DRAFT/);
    // The reason has to say the fix is one step away, or an operator will go
    // looking for a publication problem that does not exist.
    assert.match(result.reason, /Setting it ACTIVE/);
  });

  it('ARCHIVED and published is not visible', () => {
    const result = decide('ARCHIVED', [channel('Online Store', true)]);
    assert.equal(result.visibleToCustomers, false);
    assert.match(result.reason, /ARCHIVED/);
  });

  it('DRAFT and unpublished names both problems', () => {
    const result = decide('DRAFT', [channel('Online Store', false)]);
    assert.equal(result.visibleToCustomers, false);
    assert.match(result.reason, /DRAFT/);
    assert.match(result.reason, /not published/);
  });
});

describe('only the Online Store counts as customer visibility', () => {
  it('published to a non-web channel only is NOT visible', () => {
    // Real publication, but it does not put the product on the web storefront.
    const result = decide('ACTIVE', [
      channel('Point of Sale', true),
      channel('Online Store', false),
    ]);
    assert.equal(result.visibleToCustomers, false);
    // publishedAnywhere must still be true - it is a different question, and
    // conflating the two is the mistake this field exists to prevent.
    assert.equal(result.publishedAnywhere, true);
  });

  it('reports the Online Store entry it used', () => {
    const result = decide('ACTIVE', [
      channel('Point of Sale', true),
      channel('Online Store', true),
    ]);
    assert.equal(result.onlineStore?.name, 'Online Store');
    assert.equal(result.visibleToCustomers, true);
  });

  it('matches the Online Store channel case-insensitively', () => {
    const result = decide('ACTIVE', [channel('online store', true)]);
    assert.equal(result.visibleToCustomers, true);
  });

  it('when no Online Store channel is visible, says so instead of guessing', () => {
    // Usually a missing read_publications scope. Reporting a bare false would
    // send someone hunting for a publication problem rather than a scope one.
    const result = decide('ACTIVE', [channel('Point of Sale', true)]);
    assert.equal(result.visibleToCustomers, false);
    assert.equal(result.onlineStore, null);
    assert.match(result.reason, /read_publications/);
  });

  it('no channels at all is not visible', () => {
    const result = decide('ACTIVE', []);
    assert.equal(result.visibleToCustomers, false);
    assert.equal(result.publishedAnywhere, false);
    assert.match(result.reason, /read_publications/);
  });
});

describe('an unknown status is reported as unknown, not as hidden', () => {
  it('null status explains that visibility cannot be determined', () => {
    const result = decide(null, [channel('Online Store', true)]);
    assert.equal(result.visibleToCustomers, false);
    assert.match(result.reason, /cannot be determined/);
    assert.match(result.reason, /read_products/);
  });
});

describe('the payload always carries an explanation', () => {
  it('every combination produces a non-empty reason', () => {
    for (const status of ['ACTIVE', 'DRAFT', 'ARCHIVED', null]) {
      for (const publications of [
        [],
        [channel('Online Store', true)],
        [channel('Online Store', false)],
        [channel('Point of Sale', true)],
        [channel('Point of Sale', true), channel('Online Store', true)],
      ]) {
        const result = decide(status, publications);
        assert.ok(
          result.reason.length > 0,
          `no reason for status=${String(status)} publications=${publications.length}`,
        );
        assert.equal(result.shopifyProductId, PRODUCT);
      }
    }
  });
});
