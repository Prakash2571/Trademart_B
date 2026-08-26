/**
 * Headless sales-channel visibility.
 *
 * A custom storefront is its OWN Shopify publication. The two failure modes this
 * pins down are the ones that put a product in front of a customer who cannot buy
 * it, or hide one who could:
 *
 *   ACTIVE but not published to the headless channel  -> not sellable there,
 *       even when it is perfectly visible on the themed Online Store.
 *   Published to the headless channel but DRAFT       -> not sellable either.
 *
 * And the third, quieter one: publication the app could not CONFIRM is UNKNOWN, and
 * UNKNOWN is never sellable. A missing read_publications scope must not be able to
 * look like a merchant's deliberate decision, in either direction.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveChannelPublication, resolveHeadlessVisibility } from './visibility';
import type { ProductPublicationState } from './publications.types';

const PRODUCT = 'gid://shopify/Product/1';
const HEADLESS_ID = 'gid://shopify/Publication/777';
const ONLINE_STORE_ID = 'gid://shopify/Publication/111';

function channel(
  id: string,
  name: string,
  isPublished: boolean,
): ProductPublicationState {
  return {
    publicationId: id,
    name,
    isPublished,
    publishDate: isPublished ? '2026-01-01T00:00:00Z' : null,
  };
}

const onlineStorePublished = channel(ONLINE_STORE_ID, 'Online Store', true);
const onlineStoreUnpublished = channel(ONLINE_STORE_ID, 'Online Store', false);
const headlessPublished = channel(HEADLESS_ID, 'Kanay Headless', true);
const headlessUnpublished = channel(HEADLESS_ID, 'Kanay Headless', false);

function decide(status: string | null, publications: ProductPublicationState[]) {
  return resolveHeadlessVisibility({
    shopifyProductId: PRODUCT,
    status,
    publications,
    headlessChannel: { publicationId: HEADLESS_ID },
  });
}

describe('7. ACTIVE but not published to the headless channel is NOT headless-visible', () => {
  it('refuses when the headless channel reports unpublished', () => {
    const result = decide('ACTIVE', [onlineStorePublished, headlessUnpublished]);
    assert.equal(result.sellableOnHeadlessStorefront, false);
    assert.equal(result.headless, 'UNPUBLISHED');
    assert.equal(result.isActive, true);
  });

  it('Online Store publication does NOT stand in for headless publication', () => {
    // The whole bug class: the product looks live in the Shopify admin and is
    // genuinely on sale on the themed store, and is still absent from the custom one.
    const result = decide('ACTIVE', [onlineStorePublished, headlessUnpublished]);
    assert.equal(result.onlineStore, 'PUBLISHED');
    assert.equal(result.sellableOnHeadlessStorefront, false);
    assert.match(result.reason, /ACTIVE but/i);
  });

  it('refuses when the headless channel is not visible to the app at all', () => {
    const result = decide('ACTIVE', [onlineStorePublished]);
    assert.equal(result.headless, 'UNKNOWN');
    assert.equal(result.sellableOnHeadlessStorefront, false);
  });

  it('refuses when Shopify returned no publications at all', () => {
    const result = decide('ACTIVE', []);
    assert.equal(result.headless, 'UNKNOWN');
    assert.equal(result.sellableOnHeadlessStorefront, false);
    assert.match(result.reason, /read_publications/);
  });
});

describe('8. published to the headless channel but DRAFT is NOT sellable', () => {
  it('refuses a DRAFT product that is published to the headless channel', () => {
    const result = decide('DRAFT', [headlessPublished]);
    assert.equal(result.headless, 'PUBLISHED');
    assert.equal(result.isActive, false);
    assert.equal(result.sellableOnHeadlessStorefront, false);
  });

  it('says which half is missing, so the fix is obvious', () => {
    const result = decide('DRAFT', [headlessPublished]);
    assert.match(result.reason, /status is DRAFT/i);
    assert.match(result.reason, /ACTIVE/);
  });

  it('refuses an ARCHIVED product that is published to the headless channel', () => {
    assert.equal(decide('ARCHIVED', [headlessPublished]).sellableOnHeadlessStorefront, false);
  });

  it('reports UNKNOWN rather than a confident false when status was withheld', () => {
    const result = decide(null, [headlessPublished]);
    assert.equal(result.sellableOnHeadlessStorefront, false);
    assert.match(result.reason, /read_products/);
  });
});

describe('headless visibility is the conjunction, and only the conjunction', () => {
  it('ACTIVE + headless published is sellable', () => {
    const result = decide('ACTIVE', [onlineStoreUnpublished, headlessPublished]);
    assert.equal(result.sellableOnHeadlessStorefront, true);
    assert.equal(result.headless, 'PUBLISHED');
  });

  it('does not require Online Store publication - a headless-only product sells', () => {
    // A headless store is allowed to be the ONLY storefront. Requiring the themed
    // channel too would hide products the merchant deliberately sells only here.
    const result = decide('ACTIVE', [onlineStoreUnpublished, headlessPublished]);
    assert.equal(result.onlineStore, 'UNPUBLISHED');
    assert.equal(result.sellableOnHeadlessStorefront, true);
  });

  it('never reports ACTIVE alone as sellable', () => {
    for (const publications of [[], [onlineStorePublished], [headlessUnpublished]]) {
      assert.equal(decide('ACTIVE', publications).sellableOnHeadlessStorefront, false);
    }
  });
});

describe('channel resolution matches by GID first, then by name', () => {
  it('matches by publication GID', () => {
    const result = resolveChannelPublication([headlessPublished], {
      publicationId: HEADLESS_ID,
    });
    assert.equal(result.status, 'PUBLISHED');
    assert.equal(result.entry?.publicationId, HEADLESS_ID);
  });

  it('prefers the GID over the name when both are supplied', () => {
    // A renamed channel must still resolve, and a name collision must not win.
    const decoy = channel('gid://shopify/Publication/999', 'Kanay Headless', false);
    const result = resolveChannelPublication([decoy, headlessPublished], {
      publicationId: HEADLESS_ID,
      name: 'Kanay Headless',
    });
    assert.equal(result.status, 'PUBLISHED');
    assert.equal(result.entry?.publicationId, HEADLESS_ID);
  });

  it('falls back to an exact then substring name match', () => {
    assert.equal(
      resolveChannelPublication([headlessPublished], { name: 'kanay headless' }).status,
      'PUBLISHED',
    );
    assert.equal(
      resolveChannelPublication([headlessPublished], { name: 'headless' }).status,
      'PUBLISHED',
    );
  });

  it('a GID that matches nothing is UNKNOWN, not UNPUBLISHED', () => {
    const result = resolveChannelPublication([onlineStorePublished], {
      publicationId: HEADLESS_ID,
    });
    assert.equal(result.status, 'UNKNOWN');
    assert.equal(result.entry, null);
  });

  it('an empty selector is UNKNOWN and says so', () => {
    const result = resolveChannelPublication([headlessPublished], {});
    assert.equal(result.status, 'UNKNOWN');
    assert.match(result.reason, /No sales channel was configured/i);
  });

  it('distinguishes UNPUBLISHED from UNKNOWN', () => {
    // Both block a sale; they are separated so an operator is told which problem
    // they actually have rather than being sent hunting.
    assert.equal(
      resolveChannelPublication([headlessUnpublished], { publicationId: HEADLESS_ID }).status,
      'UNPUBLISHED',
    );
    assert.equal(
      resolveChannelPublication([], { publicationId: HEADLESS_ID }).status,
      'UNKNOWN',
    );
  });
});
