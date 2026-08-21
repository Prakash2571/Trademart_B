/**
 * The store's own trading history.
 *
 * The only MEASURED input the research module has, so the tests concentrate on the
 * places a measurement could quietly become a fabrication: a rate over no orders, a
 * price band wide enough that every price fits, a no-tracking rate that counts orders
 * which have not shipped, and a truncated read presented as complete.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type {
  Money,
  OrderDto,
  OrderFinancialStatus,
  OrderFulfillmentStatus,
  ProductDto,
} from '../../shopify/shopify.types';
import type { TargetMarket } from '../candidate.types';
import { summariseStoreHistory, type StoreHistoryInput } from './shopifyPerformance.provider';

const NOW = new Date('2026-06-15T12:00:00.000Z');
const MARKET: TargetMarket = { countryCode: 'GB', region: null, horizonDays: 30 };

function money(amount: number, currencyCode = 'GBP'): Money {
  return { amount, currencyCode, raw: amount.toFixed(2) };
}

function product(
  id: string,
  productType: string | null,
  prices: number[],
  currencyCode = 'GBP',
): ProductDto {
  return {
    shopifyProductId: id,
    title: `Product ${id}`,
    handle: `product-${id}`,
    description: null,
    status: 'ACTIVE',
    vendor: null,
    productType,
    tags: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    featuredImageUrl: null,
    minPrice: null,
    maxPrice: null,
    totalInventory: null,
    variants: prices.map((price, index) => ({
      shopifyVariantId: `${id}-v${index}`,
      title: 'Default',
      sku: null,
      barcode: null,
      price: money(price, currencyCode),
      compareAtPrice: null,
      availableForSale: true,
      inventoryQuantity: null,
      inventoryItemId: null,
      inventoryTracked: null,
      unitCost: null,
    })),
    supplier: 'UNKNOWN',
    supplierEvidence: [],
  };
}

interface OrderOptions {
  productId: string;
  quantity?: number;
  financialStatus?: OrderFinancialStatus | null;
  fulfillmentStatus?: OrderFulfillmentStatus | null;
  createdAt?: string;
  cancelledAt?: string | null;
  countryCode?: string | null;
  deliveredAt?: string | null;
  trackingNumber?: string | null;
}

function order(id: string, options: OrderOptions): OrderDto {
  const hasFulfillment =
    options.deliveredAt !== undefined && options.deliveredAt !== null
      ? true
      : options.fulfillmentStatus === 'FULFILLED';

  return {
    shopifyOrderId: id,
    name: `#${id}`,
    createdAt: options.createdAt ?? '2026-06-01T00:00:00.000Z',
    processedAt: null,
    financialStatus: options.financialStatus ?? 'PAID',
    fulfillmentStatus: options.fulfillmentStatus ?? 'UNFULFILLED',
    currencyCode: 'GBP',
    customer: null,
    subtotal: null,
    totalDiscounts: null,
    totalShipping: null,
    totalTax: null,
    total: money(50),
    shippingLine: null,
    lineItems: [
      {
        shopifyLineItemId: `${id}-l1`,
        title: 'Line',
        quantity: options.quantity ?? 1,
        sku: null,
        vendor: null,
        shopifyVariantId: `${options.productId}-v0`,
        shopifyProductId: options.productId,
        unitPrice: money(50),
        discountedTotal: money(50),
        unitCost: null,
        fulfillmentService: null,
        supplier: 'UNKNOWN',
        supplierEvidence: [],
      },
    ],
    fulfillments: hasFulfillment
      ? [
          {
            id: `${id}-f1`,
            status: 'SUCCESS',
            displayStatus: options.deliveredAt == null ? 'IN_TRANSIT' : 'DELIVERED',
            createdAt: options.createdAt ?? '2026-06-01T00:00:00.000Z',
            updatedAt: options.deliveredAt ?? '2026-06-02T00:00:00.000Z',
            deliveredAt: options.deliveredAt ?? null,
            inTransitAt: '2026-06-02T00:00:00.000Z',
            estimatedDeliveryAt: null,
            trackingCompany: options.trackingNumber == null ? null : 'Royal Mail',
            trackingNumber: options.trackingNumber ?? null,
            trackingUrl: null,
            tracking:
              options.trackingNumber == null
                ? []
                : [{ company: 'Royal Mail', number: options.trackingNumber, url: null }],
            events: [],
          },
        ]
      : [],
    supplier: 'UNKNOWN',
    cancelledAt: options.cancelledAt ?? null,
    destination:
      options.countryCode === null
        ? null
        : {
            countryCode: options.countryCode ?? 'GB',
            country: 'United Kingdom',
            provinceCode: null,
            province: null,
            city: null,
          },
  } as OrderDto;
}

function summarise(overrides: Partial<StoreHistoryInput> = {}) {
  return summariseStoreHistory({
    orders: [],
    products: [],
    category: 'Home',
    market: MARKET,
    truncated: false,
    now: NOW,
    ...overrides,
  });
}

/* ===========================================================================
 * Category matching
 * ======================================================================== */

describe('category matching', () => {
  it('does not compute anything without a category', () => {
    const result = summarise({ category: null, products: [product('p1', 'Home', [20])] });
    assert.equal(result.storePerformance, null);
    assert.equal(result.fulfillmentHistory, null);
    assert.ok(result.notes.some((note) => note.includes('No category is set')));
  });

  it('matches on productType only, case and whitespace insensitively', () => {
    const result = summarise({
      products: [product('p1', ' home ', [20]), product('p2', 'Garden', [20])],
    });
    assert.equal(result.categoryProductCount, 1);
  });

  it('does not match on tags, which would widen the category until it meant nothing', () => {
    const tagged = product('p2', 'Garden', [20]);
    const result = summarise({ products: [{ ...tagged, tags: ['Home'] }] });
    assert.equal(result.categoryProductCount, 0);
  });

  it('reports an empty category as a real zero, not as missing data', () => {
    const result = summarise({ products: [product('p1', 'Garden', [20])] });
    // The catalogue WAS read and contains nothing here. scoreStoreFit treats that as
    // "this would open a new line", which is a strategy choice rather than a defect.
    assert.equal(result.storePerformance?.categoryProductCount, 0);
  });
});

/* ===========================================================================
 * Price band
 * ======================================================================== */

describe('price band', () => {
  it('uses the interquartile range, not the full min-max', () => {
    // One clearance item and one premium bundle must not produce a 2-200 band inside
    // which every conceivable price "fits".
    const result = summarise({
      products: [product('p1', 'Home', [2, 18, 20, 22, 200])],
    });
    const signal = result.storePerformance;
    assert.ok((signal?.typicalSellingPriceMin as number) > 2);
    assert.ok((signal?.typicalSellingPriceMax as number) < 200);
    assert.equal(signal?.typicalSellingPriceMin, 18);
    assert.equal(signal?.typicalSellingPriceMax, 22);
  });

  it('refuses a band spanning two currencies rather than converting', () => {
    const result = summarise({
      products: [product('p1', 'Home', [20], 'GBP'), product('p2', 'Home', [2000], 'INR')],
    });
    assert.equal(result.storePerformance?.typicalSellingPriceMin, null);
    assert.equal(result.storePerformance?.priceCurrency, null);
    assert.ok(result.notes.some((note) => note.includes('no exchange rate')));
  });

  it('reports no band when nothing is priced', () => {
    const unpriced = product('p1', 'Home', []);
    const result = summarise({ products: [unpriced] });
    assert.equal(result.storePerformance?.typicalSellingPriceMin, null);
  });
});

/* ===========================================================================
 * Rates
 * ======================================================================== */

describe('rates', () => {
  it('returns null rather than 0 when there is nothing to divide by', () => {
    const result = summarise({ products: [product('p1', 'Home', [20])], orders: [] });
    // A refund rate over no orders is unmeasured, not zero percent. A 0 would reward
    // the store for a record it never earned.
    assert.equal(result.storePerformance?.categoryRefundRatePercentage, null);
    assert.equal(result.storePerformance?.categoryUnitsSold, null);
    assert.equal(result.fulfillmentHistory, null);
  });

  it('counts units sold only for products in the category', () => {
    const result = summarise({
      products: [product('p1', 'Home', [20]), product('p2', 'Garden', [20])],
      orders: [
        order('o1', { productId: 'p1', quantity: 3 }),
        order('o2', { productId: 'p2', quantity: 9 }),
      ],
    });
    assert.equal(result.storePerformance?.categoryUnitsSold, 3);
    assert.equal(result.categoryOrderCount, 1);
  });

  it('computes a refund rate from the orders that contained the category', () => {
    const result = summarise({
      products: [product('p1', 'Home', [20])],
      orders: [
        order('o1', { productId: 'p1', financialStatus: 'REFUNDED' }),
        order('o2', { productId: 'p1', financialStatus: 'PAID' }),
        order('o3', { productId: 'p1', financialStatus: 'PARTIALLY_REFUNDED' }),
        order('o4', { productId: 'p1', financialStatus: 'PAID' }),
      ],
    });
    // 2 of 4, and a partial refund counts - money did go back.
    assert.equal(result.storePerformance?.categoryRefundRatePercentage, 50);
  });

  it('measures delivery only on orders where fulfillment was expected', () => {
    const result = summarise({
      products: [product('p1', 'Home', [20])],
      orders: [
        order('o1', { productId: 'p1', financialStatus: 'PAID' }),
        // Never paid: the supplier was never asked to ship it.
        order('o2', { productId: 'p1', financialStatus: 'PENDING' }),
        // Cancelled: not a failed delivery.
        order('o3', { productId: 'p1', cancelledAt: '2026-06-02T00:00:00.000Z' }),
      ],
    });
    assert.equal(result.fulfillmentHistory?.sampleSize, 1);
  });

  it('measures the no-tracking rate over DISPATCHED orders only', () => {
    const result = summarise({
      products: [product('p1', 'Home', [20])],
      orders: [
        // Dispatched with tracking.
        order('o1', { productId: 'p1', fulfillmentStatus: 'FULFILLED', trackingNumber: 'TN1' }),
        // Dispatched without tracking - the real failure.
        order('o2', { productId: 'p1', fulfillmentStatus: 'FULFILLED', trackingNumber: null }),
        // Not dispatched: no tracking because nothing has shipped, which is not a
        // tracking failure. Counting it would make every busy day look like an outage.
        order('o3', { productId: 'p1', fulfillmentStatus: 'UNFULFILLED' }),
      ],
    });
    assert.equal(result.fulfillmentHistory?.sampleSize, 3);
    assert.equal(result.fulfillmentHistory?.noTrackingRatePercentage, 50);
  });

  it('reports no tracking rate at all when nothing has shipped', () => {
    const result = summarise({
      products: [product('p1', 'Home', [20])],
      orders: [order('o1', { productId: 'p1', fulfillmentStatus: 'UNFULFILLED' })],
    });
    assert.equal(result.fulfillmentHistory?.noTrackingRatePercentage, null);
  });

  it('averages delivery days from order creation to delivery', () => {
    const result = summarise({
      products: [product('p1', 'Home', [20])],
      orders: [
        order('o1', {
          productId: 'p1',
          fulfillmentStatus: 'FULFILLED',
          createdAt: '2026-06-01T00:00:00.000Z',
          deliveredAt: '2026-06-08T00:00:00.000Z',
          trackingNumber: 'TN1',
        }),
        order('o2', {
          productId: 'p1',
          fulfillmentStatus: 'FULFILLED',
          createdAt: '2026-06-01T00:00:00.000Z',
          deliveredAt: '2026-06-04T00:00:00.000Z',
          trackingNumber: 'TN2',
        }),
      ],
    });
    // 7 days and 3 days.
    assert.equal(result.fulfillmentHistory?.averageDeliveryDays, 5);
  });

  it('discards a delivery dated before its order rather than clamping it to zero', () => {
    const result = summarise({
      products: [product('p1', 'Home', [20])],
      orders: [
        order('o1', {
          productId: 'p1',
          fulfillmentStatus: 'FULFILLED',
          createdAt: '2026-06-10T00:00:00.000Z',
          deliveredAt: '2026-06-01T00:00:00.000Z',
          trackingNumber: 'TN1',
        }),
      ],
    });
    // Clamping to 0 would drag the average down with a fact that cannot be true.
    assert.equal(result.fulfillmentHistory?.averageDeliveryDays, null);
  });
});

/* ===========================================================================
 * Provenance and honesty
 * ======================================================================== */

describe('provenance', () => {
  it('ages from the newest order, not from now', () => {
    const result = summarise({
      products: [product('p1', 'Home', [20])],
      orders: [
        order('o1', { productId: 'p1', createdAt: '2026-01-05T00:00:00.000Z' }),
        order('o2', { productId: 'p1', createdAt: '2026-05-20T00:00:00.000Z' }),
      ],
    });
    // Using `now` would make a six-month-old history look current.
    assert.equal(result.storePerformance?.observedAt, '2026-05-20T00:00:00.000Z');
    assert.equal(result.storePerformance?.fetchedAt, NOW.toISOString());
  });

  it('derives geography from where the sales actually went', () => {
    const result = summarise({
      products: [product('p1', 'Home', [20])],
      orders: [
        order('o1', { productId: 'p1', countryCode: 'GB' }),
        order('o2', { productId: 'p1', countryCode: 'GB' }),
        order('o3', { productId: 'p1', countryCode: 'IE' }),
      ],
    });
    assert.deepEqual(result.storePerformance?.geography, { countryCode: 'GB', region: null });
  });

  it('reports unknown geography when Shopify withholds destinations', () => {
    const result = summarise({
      products: [product('p1', 'Home', [20])],
      orders: [order('o1', { productId: 'p1', countryCode: null })],
    });
    // Null means "we do not know where these went", not "they match the target market".
    assert.equal(result.storePerformance?.geography.countryCode, null);
    assert.ok(result.notes.some((note) => note.includes('did not report a destination')));
  });

  it('never claims a region, because sales are not aggregated by province', () => {
    const result = summarise({
      products: [product('p1', 'Home', [20])],
      orders: [order('o1', { productId: 'p1' })],
      market: { countryCode: 'GB', region: 'Scotland', horizonDays: 30 },
    });
    assert.equal(result.storePerformance?.geography.region, null);
  });

  it('says a truncated read is a lower bound rather than a measurement', () => {
    const result = summarise({
      products: [product('p1', 'Home', [20])],
      orders: [order('o1', { productId: 'p1' })],
      truncated: true,
    });
    assert.ok(result.notes.some((note) => note.includes('LOWER BOUND')));
  });

  it('names the store\u2019s own orders as the source', () => {
    const result = summarise({ products: [product('p1', 'Home', [20])] });
    assert.ok(result.storePerformance?.source.includes('own Shopify orders'));
  });
});
