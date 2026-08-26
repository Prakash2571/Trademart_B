/**
 * Channel-aware sellability, and the tri-state that makes it honest.
 *
 * The gate used to take `publishedToOnlineStore: boolean`. Two bugs lived in that
 * signature: it hardcoded the themed Online Store as the selling channel, so a
 * headless storefront could not be gated correctly at all; and a boolean cannot
 * distinguish "Shopify says unpublished" from "this app could not see the channel".
 *
 * UNKNOWN blocks the sale exactly as UNPUBLISHED does. It is a separate value only
 * so the operator learns which problem they have.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveChannelPublicationStatus, ONLINE_STORE_SELECTOR } from './publication';
import { evaluateStorefrontSellability } from './sellability';
import type { ChannelPublicationStatus } from '../../shopify/publications/publications.types';
import type { PushedVariantMapping } from '../../intelligence/variant.mapping';
import type { SourceabilityResult } from '../../intelligence/sourceability';

const NOW = new Date('2026-08-26T12:00:00.000Z');
const FRESH = new Date('2026-08-26T10:00:00.000Z').toISOString();
const HEADLESS_ID = 'gid://shopify/Publication/777';

const mapping: PushedVariantMapping = {
  publicVariantId: 'v_1',
  shopifyVariantId: 'gid://shopify/ProductVariant/1',
  supplierVariantId: 'sv-1',
  supplierSku: 'SKU-1',
  supplierTitle: 'Black / M',
  optionValues: { Colour: 'Black', Size: 'M' },
  mappedAt: FRESH,
};

const sourceability = {
  current: 'SOURCEABLE',
  checkedAt: FRESH,
  variants: [
    {
      supplierVariantId: 'sv-1',
      sku: 'SKU-1',
      title: 'Black / M',
      optionValues: { Colour: 'Black', Size: 'M' },
      availability: 'AVAILABLE',
      checkedAt: FRESH,
    },
  ],
} as unknown as SourceabilityResult;

function evaluate(channelPublication: ChannelPublicationStatus, productStatus = 'ACTIVE') {
  return evaluateStorefrontSellability({
    productStatus,
    channelPublication,
    sourceability,
    mapping,
    shopifyVariantAvailableForSale: true,
    priceAmount: '1499.00',
    priceCurrencyCode: 'INR',
    now: NOW,
  });
}

describe('sellability is gated on the channel this storefront sells through', () => {
  it('sells when the channel confirms publication and the product is ACTIVE', () => {
    const result = evaluate('PUBLISHED');
    assert.equal(result.availableForSale, true);
    assert.equal(result.availability, 'SELLABLE');
    assert.equal(result.blockReason, null);
  });

  it('refuses when the channel reports the product unpublished', () => {
    const result = evaluate('UNPUBLISHED');
    assert.equal(result.availableForSale, false);
    assert.equal(result.blockReason, 'SHOPIFY_NOT_PUBLISHED');
  });

  it('refuses when channel publication is UNKNOWN, and says so distinctly', () => {
    const result = evaluate('UNKNOWN');
    assert.equal(result.availableForSale, false);
    assert.equal(result.availability, 'UNAVAILABLE');
    // Distinct from SHOPIFY_NOT_PUBLISHED so the operator is not sent looking for a
    // merchant decision that was never made.
    assert.equal(result.blockReason, 'SHOPIFY_PUBLICATION_UNKNOWN');
  });

  it('never sells a DRAFT product even when the channel confirms publication', () => {
    const result = evaluate('PUBLISHED', 'DRAFT');
    assert.equal(result.availableForSale, false);
    assert.equal(result.blockReason, 'SHOPIFY_NOT_ACTIVE');
  });

  it('never sells an ARCHIVED product on a published channel', () => {
    assert.equal(evaluate('PUBLISHED', 'ARCHIVED').availableForSale, false);
  });

  it('refuses when Shopify withheld the product status', () => {
    const result = evaluateStorefrontSellability({
      productStatus: null,
      channelPublication: 'PUBLISHED',
      sourceability,
      mapping,
      shopifyVariantAvailableForSale: true,
      priceAmount: '1499.00',
      priceCurrencyCode: 'INR',
      now: NOW,
    });
    assert.equal(result.availableForSale, false);
    assert.equal(result.blockReason, 'SHOPIFY_NOT_ACTIVE');
  });

  it('no publication status is ever sellable except PUBLISHED', () => {
    for (const status of ['UNPUBLISHED', 'UNKNOWN'] as ChannelPublicationStatus[]) {
      assert.equal(evaluate(status).availableForSale, false);
    }
  });
});

describe('resolveChannelPublicationStatus reads the raw payload the catalog already holds', () => {
  const published = (id: string, name: string, isPublished: boolean) => ({
    resourcePublicationsV2: {
      nodes: [{ isPublished, publication: { id, name } }],
    },
  });

  it('resolves a headless channel by GID', () => {
    assert.equal(
      resolveChannelPublicationStatus(published(HEADLESS_ID, 'Kanay Headless', true), {
        publicationId: HEADLESS_ID,
      }),
      'PUBLISHED',
    );
  });

  it('reports UNPUBLISHED only when Shopify explicitly said so', () => {
    assert.equal(
      resolveChannelPublicationStatus(published(HEADLESS_ID, 'Kanay Headless', false), {
        publicationId: HEADLESS_ID,
      }),
      'UNPUBLISHED',
    );
  });

  it('a channel missing from the payload is UNKNOWN, not UNPUBLISHED', () => {
    assert.equal(
      resolveChannelPublicationStatus(published('gid://shopify/Publication/111', 'Online Store', true), {
        publicationId: HEADLESS_ID,
      }),
      'UNKNOWN',
    );
  });

  it('an absent resourcePublicationsV2 is UNKNOWN', () => {
    assert.equal(resolveChannelPublicationStatus({}, { publicationId: HEADLESS_ID }), 'UNKNOWN');
    assert.equal(
      resolveChannelPublicationStatus({ resourcePublicationsV2: { nodes: [] } }, ONLINE_STORE_SELECTOR),
      'UNKNOWN',
    );
  });

  it('an empty selector is UNKNOWN rather than matching anything', () => {
    assert.equal(resolveChannelPublicationStatus(published(HEADLESS_ID, 'X', true), {}), 'UNKNOWN');
  });

  it('the Online Store selector still resolves the themed channel', () => {
    assert.equal(
      resolveChannelPublicationStatus(
        published('gid://shopify/Publication/111', 'Online Store', true),
        ONLINE_STORE_SELECTOR,
      ),
      'PUBLISHED',
    );
  });
});
