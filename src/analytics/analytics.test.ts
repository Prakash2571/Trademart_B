/**
 * Analytics tests.
 *
 * The guarantee under test: aggregates come from real order values only, the
 * sampling window is always disclosed, and traffic metrics report unavailable
 * rather than being inferred from order counts.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { OrderDto } from '../shopify/shopify.types';
import { buildOverview, getTrafficAvailability } from './analytics.service';

function money(amount: number) {
  return { amount, currencyCode: 'GBP', raw: amount.toFixed(2) };
}

function order(overrides: Partial<OrderDto> = {}): OrderDto {
  return {
    shopifyOrderId: 'gid://shopify/Order/1',
    name: '#1001',
    createdAt: '2026-02-01T10:00:00Z',
    processedAt: null,
    financialStatus: 'PAID',
    fulfillmentStatus: 'FULFILLED',
    currencyCode: 'GBP',
    customer: null,
    subtotal: money(40),
    totalDiscounts: money(0),
    totalShipping: money(5),
    totalTax: money(3),
    total: money(48),
    shippingLine: null,
    lineItems: [],
    fulfillments: [],
    supplier: 'UNKNOWN',
    ...overrides,
  };
}

describe('buildOverview', () => {
  it('sums real order values and computes AOV', () => {
    const overview = buildOverview(
      [order(), order({ shopifyOrderId: 'gid://shopify/Order/2', total: money(52) })],
      { truncated: false },
    );

    assert.equal(overview.orderCount, 2);
    assert.equal(overview.totalRevenue, 100);
    assert.equal(overview.averageOrderValue, 50);
    assert.equal(overview.currencyCode, 'GBP');
  });

  it('returns null AOV for an empty store rather than 0', () => {
    const overview = buildOverview([], { truncated: false });

    assert.equal(overview.orderCount, 0);
    assert.equal(overview.averageOrderValue, null);
    assert.equal(overview.totalRevenue, 0);
  });

  it('always discloses the sampling window', () => {
    const overview = buildOverview([order()], { truncated: false });

    assert.equal(overview.window.orderCount, 1);
    assert.equal(overview.window.from, '2026-02-01T10:00:00Z');
    assert.match(overview.window.basedOn, /most recent/);
    assert.ok(overview.notes.some((note) => note.includes('not all-time store totals')));
  });

  it('warns when the sample was truncated', () => {
    const overview = buildOverview([order()], { truncated: true });

    assert.equal(overview.window.truncated, true);
    assert.ok(overview.notes.some((note) => note.includes('More orders exist')));
  });

  it('counts pending fulfillments from real statuses', () => {
    const overview = buildOverview(
      [
        order({ fulfillmentStatus: 'UNFULFILLED' }),
        order({ shopifyOrderId: 'gid://shopify/Order/2', fulfillmentStatus: 'PARTIALLY_FULFILLED' }),
        order({ shopifyOrderId: 'gid://shopify/Order/3', fulfillmentStatus: 'FULFILLED' }),
      ],
      { truncated: false },
    );

    assert.equal(overview.pendingFulfillmentCount, 2);
    assert.equal(overview.fulfillmentStatusBreakdown['FULFILLED'], 1);
  });

  it('groups orders by day and ranks top products', () => {
    const overview = buildOverview(
      [
        order({
          createdAt: '2026-02-01T10:00:00Z',
          lineItems: [
            {
              shopifyLineItemId: 'l1',
              title: 'Widget',
              quantity: 2,
              sku: 'W-1',
              vendor: null,
              shopifyVariantId: null,
              shopifyProductId: 'gid://shopify/Product/100',
              unitPrice: money(20),
              discountedTotal: money(40),
              unitCost: null,
              fulfillmentService: null,
              supplierEvidence: [],
              supplier: 'UNKNOWN',
            },
          ],
        }),
        order({
          shopifyOrderId: 'gid://shopify/Order/2',
          createdAt: '2026-02-02T10:00:00Z',
          lineItems: [
            {
              shopifyLineItemId: 'l2',
              title: 'Gizmo',
              quantity: 1,
              sku: 'G-1',
              vendor: null,
              shopifyVariantId: null,
              shopifyProductId: 'gid://shopify/Product/101',
              unitPrice: money(80),
              discountedTotal: money(80),
              unitCost: null,
              fulfillmentService: null,
              supplierEvidence: [],
              supplier: 'UNKNOWN',
            },
          ],
        }),
      ],
      { truncated: false },
    );

    assert.equal(overview.ordersByDay.length, 2);
    assert.equal(overview.ordersByDay[0]?.date, '2026-02-01');
    assert.equal(overview.topProducts[0]?.title, 'Gizmo');
    assert.equal(overview.topProducts[1]?.unitsSold, 2);
  });

  it('never claims a margin it cannot compute', () => {
    const overview = buildOverview([order()], { truncated: false });

    assert.equal(overview.estimatedMargin.available, false);
    assert.match(overview.estimatedMargin.reason, /not available from Shopify/);
  });

  it('treats missing money fields as 0 contribution without inventing values', () => {
    const overview = buildOverview([order({ total: null, totalTax: null })], {
      truncated: false,
    });

    assert.equal(overview.totalRevenue, 0);
    assert.equal(overview.totalTax, 0);
  });
});

describe('getTrafficAvailability', () => {
  it('reports unavailable instead of inferring traffic from orders', () => {
    const traffic = getTrafficAvailability();

    assert.equal(traffic.available, false);
    assert.equal(traffic.requiredScope, 'read_reports');
    assert.match(traffic.reason, /Sessions/);
    assert.match(traffic.documentation, /shopify\.dev/);
  });
});
