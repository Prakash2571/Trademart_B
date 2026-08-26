import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { computeSourceability, type SupplierInfo } from '../../intelligence/sourceability';
import type { PushedVariantMapping } from '../../intelligence/variant.mapping';
import {
  evaluateStorefrontSellability,
  inrAmountToPaise,
  normalizeInrAmount,
} from './sellability';

const NOW = new Date('2026-08-26T12:00:00.000Z');

function supplier(overrides: Partial<SupplierInfo> = {}): SupplierInfo {
  return {
    provider: 'TRADELLE',
    supplierProductId: 'internal-product',
    sourceUrl: null,
    availability: 'AVAILABLE',
    availabilitySource: 'MANUAL',
    checkedAt: NOW.toISOString(),
    observedAt: NOW.toISOString(),
    note: null,
    stockKnown: true,
    productAvailable: true,
    productCost: 500,
    productCurrency: 'INR',
    shippingCost: 100,
    shippingCurrency: 'INR',
    shippingDays: 5,
    variants: [
      {
        supplierVariantId: 'sv-1',
        sku: 'SKU-1',
        title: 'Black / M',
        optionValues: { Color: 'Black', Size: 'M' },
        availability: 'AVAILABLE',
        stockKnown: true,
        cost: 500,
        currencyCode: 'INR',
        checkedAt: NOW.toISOString(),
      },
    ],
    evidence: [],
    ...overrides,
  };
}

const mapping: PushedVariantMapping = {
  publicVariantId: 'kv_public',
  shopifyVariantId: 'gid://shopify/ProductVariant/1',
  supplierVariantId: 'sv-1',
  supplierSku: 'SKU-1',
  supplierTitle: 'Black / M',
  optionValues: { Color: 'Black', Size: 'M' },
  mappedAt: NOW.toISOString(),
};

function evaluate(overrides: Partial<Parameters<typeof evaluateStorefrontSellability>[0]> = {}) {
  return evaluateStorefrontSellability({
    productStatus: 'ACTIVE',
    channelPublication: 'PUBLISHED',
    sourceability: computeSourceability(supplier(), NOW),
    mapping,
    shopifyVariantAvailableForSale: true,
    priceAmount: '1499.00',
    priceCurrencyCode: 'INR',
    now: NOW,
    ...overrides,
  });
}

describe('fail-closed storefront sellability', () => {
  it('is SELLABLE only when every authority gate passes', () => {
    assert.deepEqual(evaluate(), {
      availability: 'SELLABLE',
      availableForSale: true,
      approvedPrice: '1499.00',
      blockReason: null,
    });
  });

  it('blocks an ACTIVE Shopify product when Trademart says supplier unavailable', () => {
    const sourceability = computeSourceability(
      supplier({ availability: 'UNAVAILABLE', productAvailable: false }),
      NOW,
    );
    const result = evaluate({ sourceability });
    assert.equal(result.availability, 'UNAVAILABLE');
    assert.equal(result.blockReason, 'SOURCEABILITY_BLOCKED');
  });

  it('blocks stale sourceability and a stale variant check', () => {
    const stale = '2026-08-10T12:00:00.000Z';
    const productStale = evaluate({
      sourceability: computeSourceability(supplier({ checkedAt: stale }), NOW),
    });
    assert.equal(productStale.availability, 'UNAVAILABLE');

    const variantStale = evaluate({
      sourceability: computeSourceability(
        supplier({ variants: [{ ...supplier().variants[0]!, checkedAt: stale }] }),
        NOW,
      ),
    });
    assert.equal(variantStale.blockReason, 'SUPPLIER_VARIANT_STALE');
  });

  it('requires an exact durable variant mapping', () => {
    assert.equal(evaluate({ mapping: null }).blockReason, 'VARIANT_MAPPING_MISSING');
    assert.equal(
      evaluate({ mapping: { ...mapping, supplierVariantId: 'different' } }).blockReason,
      'SUPPLIER_VARIANT_MISSING',
    );
  });

  it('never converts or accepts a non-INR price', () => {
    const result = evaluate({ priceAmount: '18.00', priceCurrencyCode: 'USD' });
    assert.equal(result.availability, 'UNAVAILABLE');
    assert.equal(result.blockReason, 'PRICE_NOT_INR');
  });

  it('distinguishes genuine Shopify out-of-stock from commercial unavailability', () => {
    const result = evaluate({ shopifyVariantAvailableForSale: false });
    assert.equal(result.availability, 'OUT_OF_STOCK');
    assert.equal(result.approvedPrice, '1499.00');
  });

  it('blocks when publication or Shopify availability is unknown', () => {
    assert.equal(evaluate({ channelPublication: 'UNPUBLISHED' }).availability, 'UNAVAILABLE');
    assert.equal(
      evaluate({ shopifyVariantAvailableForSale: null }).blockReason,
      'SHOPIFY_VARIANT_AVAILABILITY_UNKNOWN',
    );
  });
});

describe('INR decimal safety', () => {
  it('normalizes decimals and converts to paise without floating point', () => {
    assert.equal(normalizeInrAmount('1499'), '1499.00');
    assert.equal(normalizeInrAmount('1499.5'), '1499.50');
    assert.equal(inrAmountToPaise('1499.00'), 149900n);
  });

  it('refuses zero, negatives, malformed values, and extra precision', () => {
    assert.equal(normalizeInrAmount('0'), null);
    assert.equal(normalizeInrAmount('-1'), null);
    assert.equal(normalizeInrAmount('1.001'), null);
    assert.equal(normalizeInrAmount('₹1499'), null);
  });
});
