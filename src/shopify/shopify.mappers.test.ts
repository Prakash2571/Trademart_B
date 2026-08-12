/**
 * Mapper tests with mocked Shopify payloads.
 *
 * The guarantee under test: absent data becomes null, never 0, and money keeps
 * its original precision.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { mapCustomer, mapInventoryItem, mapOrder, mapProduct, mapShop } from './shopify.mappers';
import type { RawCustomer, RawInventoryItem, RawOrder, RawProduct, RawShop } from './shopify.types';

describe('mapShop', () => {
  it('maps shop fields and detects a development store', () => {
    const raw: RawShop = {
      id: 'gid://shopify/Shop/1',
      name: 'Test Store Mart',
      myshopifyDomain: 'teststoremart-uk8mmby.myshopify.com',
      email: 'owner@example.com',
      currencyCode: 'GBP',
      ianaTimezone: 'Europe/London',
      primaryDomain: { host: 'example.com', url: 'https://example.com' },
      plan: { displayName: 'Developer Preview', partnerDevelopment: true, shopifyPlus: false },
      billingAddress: { country: 'United Kingdom', countryCodeV2: 'GB' },
    };

    const shop = mapShop(raw, '2026-07');

    assert.equal(shop.shopifyShopId, 'gid://shopify/Shop/1');
    assert.equal(shop.isDevelopmentStore, true);
    assert.equal(shop.apiVersion, '2026-07');
    assert.equal(shop.country, 'United Kingdom');
  });

  it('falls back to contactEmail and tolerates withheld fields', () => {
    const shop = mapShop(
      {
        id: 'gid://shopify/Shop/1',
        name: 'S',
        myshopifyDomain: 'x.myshopify.com',
        contactEmail: 'contact@example.com',
        currencyCode: 'USD',
      },
      '2026-07',
    );

    assert.equal(shop.email, 'contact@example.com');
    assert.equal(shop.planDisplayName, null);
    assert.equal(shop.isDevelopmentStore, null);
  });
});

describe('mapProduct', () => {
  const raw: RawProduct = {
    id: 'gid://shopify/Product/100',
    title: 'Widget',
    handle: 'widget',
    description: 'A widget',
    status: 'ACTIVE',
    vendor: 'Tradelle',
    productType: 'Gadget',
    tags: ['new'],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
    totalInventory: 12,
    priceRangeV2: {
      minVariantPrice: { amount: '19.99', currencyCode: 'GBP' },
      maxVariantPrice: { amount: '29.99', currencyCode: 'GBP' },
    },
    variants: {
      edges: [
        {
          node: {
            id: 'gid://shopify/ProductVariant/200',
            title: 'Default',
            sku: 'W-1',
            price: '19.99',
            compareAtPrice: '24.99',
            availableForSale: true,
            inventoryQuantity: 12,
            inventoryItem: {
              id: 'gid://shopify/InventoryItem/300',
              tracked: true,
              unitCost: { amount: '8.50', currencyCode: 'GBP' },
            },
          },
        },
      ],
    },
  };

  it('maps a product and classifies its supplier', () => {
    const product = mapProduct(raw, 'GBP');

    assert.equal(product.shopifyProductId, 'gid://shopify/Product/100');
    assert.equal(product.supplier, 'TRADELLE');
    assert.ok(product.supplierEvidence.length > 0);
    assert.equal(product.variants[0]?.unitCost?.amount, 8.5);
    assert.equal(product.variants[0]?.price?.raw, '19.99');
  });

  it('returns null (not 0) for inventory fields withheld by scope', () => {
    const degraded: RawProduct = {
      ...raw,
      totalInventory: undefined,
      variants: {
        edges: [
          {
            node: {
              id: 'gid://shopify/ProductVariant/200',
              title: 'Default',
              sku: 'W-1',
              price: '19.99',
            },
          },
        ],
      },
    };

    const product = mapProduct(degraded, 'GBP');

    assert.equal(product.totalInventory, null);
    assert.equal(product.variants[0]?.inventoryQuantity, null);
    assert.equal(product.variants[0]?.unitCost, null);
    assert.equal(product.variants[0]?.compareAtPrice, null);
  });

  it('tolerates a missing variants connection', () => {
    const product = mapProduct({ ...raw, variants: null }, 'GBP');
    assert.deepEqual(product.variants, []);
  });
});

describe('mapOrder', () => {
  const raw: RawOrder = {
    id: 'gid://shopify/Order/500',
    name: '#1001',
    createdAt: '2026-02-01T10:00:00Z',
    displayFinancialStatus: 'PAID',
    displayFulfillmentStatus: 'UNFULFILLED',
    currencyCode: 'GBP',
    email: 'buyer@example.com',
    customer: { id: 'gid://shopify/Customer/900', displayName: 'A Buyer' },
    currentSubtotalPriceSet: { shopMoney: { amount: '40.00', currencyCode: 'GBP' } },
    currentTotalPriceSet: { shopMoney: { amount: '48.00', currencyCode: 'GBP' } },
    currentTotalTaxSet: { shopMoney: { amount: '3.00', currencyCode: 'GBP' } },
    totalShippingPriceSet: { shopMoney: { amount: '5.00', currencyCode: 'GBP' } },
    shippingLine: {
      title: 'Standard',
      carrierIdentifier: 'royal-mail',
      originalPriceSet: { shopMoney: { amount: '5.00', currencyCode: 'GBP' } },
    },
    fulfillments: [
      {
        id: 'gid://shopify/Fulfillment/1',
        status: 'SUCCESS',
        trackingInfo: [{ company: 'Royal Mail', number: 'AB123', url: 'https://track' }],
      },
    ],
    lineItems: {
      edges: [
        {
          node: {
            id: 'gid://shopify/LineItem/1',
            title: 'Widget',
            quantity: 2,
            sku: 'W-1',
            vendor: 'Tradelle',
            variant: { id: 'gid://shopify/ProductVariant/200' },
            product: { id: 'gid://shopify/Product/100', vendor: 'Tradelle' },
            originalUnitPriceSet: { shopMoney: { amount: '20.00', currencyCode: 'GBP' } },
            discountedTotalSet: { shopMoney: { amount: '40.00', currencyCode: 'GBP' } },
          },
        },
      ],
    },
  };

  it('maps financial values verbatim from Shopify', () => {
    const order = mapOrder(raw);

    assert.equal(order.total?.amount, 48);
    assert.equal(order.subtotal?.amount, 40);
    assert.equal(order.totalTax?.amount, 3);
    assert.equal(order.totalShipping?.amount, 5);
    // Not supplied by Shopify in this payload - must stay null, not 0.
    assert.equal(order.totalDiscounts, null);
  });

  it('maps tracking and shipping details', () => {
    const order = mapOrder(raw);

    assert.equal(order.fulfillments[0]?.trackingCompany, 'Royal Mail');
    assert.equal(order.fulfillments[0]?.trackingNumber, 'AB123');
    assert.equal(order.shippingLine?.carrier, 'royal-mail');
  });

  it('classifies a single-supplier order', () => {
    assert.equal(mapOrder(raw).supplier, 'TRADELLE');
  });

  it('marks mixed-supplier orders as OTHER rather than overstating', () => {
    const mixed: RawOrder = {
      ...raw,
      lineItems: {
        edges: [
          ...(raw.lineItems?.edges ?? []),
          {
            node: {
              id: 'gid://shopify/LineItem/2',
              title: 'Other thing',
              quantity: 1,
              vendor: 'Acme',
              product: { id: 'gid://shopify/Product/101', vendor: 'Acme' },
            },
          },
        ],
      },
    };

    assert.equal(mapOrder(mixed).supplier, 'OTHER');
  });

  it('returns a null customer when protected data was withheld', () => {
    const withheld: RawOrder = { ...raw, email: null, customer: null };

    assert.equal(mapOrder(withheld).customer, null);
  });
});

describe('mapCustomer', () => {
  it('maps aggregates and parses the string order count', () => {
    const raw: RawCustomer = {
      id: 'gid://shopify/Customer/900',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-05T00:00:00Z',
      state: 'ENABLED',
      numberOfOrders: '7',
      amountSpent: { amount: '250.00', currencyCode: 'GBP' },
      displayName: 'A Buyer',
      email: 'buyer@example.com',
      defaultAddress: { city: 'London', country: 'United Kingdom' },
    };

    const customer = mapCustomer(raw);

    assert.equal(customer.ordersCount, 7);
    assert.equal(customer.amountSpent?.amount, 250);
    assert.equal(customer.location, 'London, United Kingdom');
  });

  it('nulls PII that Shopify withheld', () => {
    const customer = mapCustomer({
      id: 'gid://shopify/Customer/901',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      numberOfOrders: '0',
    });

    assert.equal(customer.email, null);
    assert.equal(customer.displayName, null);
    assert.equal(customer.location, null);
    assert.equal(customer.ordersCount, 0);
  });
});

describe('mapInventoryItem', () => {
  it('sums available quantities across locations', () => {
    const raw: RawInventoryItem = {
      id: 'gid://shopify/InventoryItem/300',
      sku: 'W-1',
      tracked: true,
      unitCost: { amount: '8.50', currencyCode: 'GBP' },
      variant: {
        id: 'gid://shopify/ProductVariant/200',
        title: 'Default',
        product: { id: 'gid://shopify/Product/100', title: 'Widget' },
      },
      inventoryLevels: {
        edges: [
          {
            node: {
              id: 'gid://shopify/InventoryLevel/1',
              location: { id: 'gid://shopify/Location/1', name: 'Main' },
              quantities: [
                { name: 'available', quantity: 5 },
                { name: 'on_hand', quantity: 6 },
              ],
            },
          },
          {
            node: {
              id: 'gid://shopify/InventoryLevel/2',
              location: { id: 'gid://shopify/Location/2', name: 'Backup' },
              quantities: [{ name: 'available', quantity: 3 }],
            },
          },
        ],
      },
    };

    const item = mapInventoryItem(raw);

    assert.equal(item.available, 8);
    assert.equal(item.unitCost?.amount, 8.5);
    assert.equal(item.productTitle, 'Widget');
    assert.equal(item.levels.length, 2);
    assert.equal(item.levels[0]?.quantities['on_hand'], 6);
  });

  it('leaves available as null when no quantities were returned', () => {
    const item = mapInventoryItem({ id: 'gid://shopify/InventoryItem/301' });

    assert.equal(item.available, null);
    assert.equal(item.unitCost, null);
  });
});
