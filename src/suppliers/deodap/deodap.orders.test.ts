/**
 * DeoDap orders: which lines are DeoDap's, who sends each one to DeoDap, what DeoDap
 * will charge, and what needs a person.
 *
 * The rule under test above all others: with DeoDap's Shopify app doing the ordering
 * (the Tradelle model), an order the app never picked up must still surface - and a
 * product Trademart imported itself is never assumed to be the app's.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AppError } from '../../common/errors';
import { DEFAULT_SHIPPING_SLA } from '../../dropshipping/dropshipping.types';
import type { FulfillmentDto, OrderDto, OrderLineItemDto } from '../../shopify/shopify.types';
import type { ManualCost } from '../cost';
import {
  buildDeodapOrderView,
  extractDeodapLines,
  orderRoute,
  stageTimestamps,
  validateForwardingUpdate,
  type DeodapOrderContext,
  type ForwardingRecord,
} from './deodap.orders';
import type { DeodapOrderFlow } from './deodap.settings';

const PLACED_AT = '2026-09-01T10:00:00.000Z';
/** Two hours after the order: inside the default 24h processing SLA. */
const SOON = new Date('2026-09-01T12:00:00.000Z');
/** Thirty hours after the order: past it. */
const LATE = new Date('2026-09-02T16:00:00.000Z');

function line(overrides: Partial<OrderLineItemDto>): OrderLineItemDto {
  return {
    shopifyLineItemId: 'gid://shopify/LineItem/1',
    title: 'Item',
    quantity: 1,
    sku: null,
    vendor: null,
    shopifyVariantId: null,
    shopifyProductId: null,
    unitPrice: null,
    discountedTotal: null,
    unitCost: null,
    fulfillmentService: null,
    supplier: 'UNKNOWN',
    supplierEvidence: [],
    ...overrides,
  };
}

function order(lines: OrderLineItemDto[], overrides: Partial<OrderDto> = {}): OrderDto {
  return {
    shopifyOrderId: 'gid://shopify/Order/1',
    name: '#1001',
    createdAt: PLACED_AT,
    processedAt: null,
    financialStatus: 'PAID',
    fulfillmentStatus: 'UNFULFILLED',
    currencyCode: 'INR',
    customer: null,
    subtotal: null,
    totalDiscounts: null,
    totalShipping: null,
    totalTax: null,
    total: null,
    shippingLine: null,
    lineItems: lines,
    fulfillments: [],
    supplier: 'UNKNOWN',
    cancelledAt: null,
    destination: null,
    ...overrides,
  };
}

function fulfillment(overrides: Partial<FulfillmentDto> = {}): FulfillmentDto {
  return {
    id: 'gid://shopify/Fulfillment/1',
    status: 'SUCCESS',
    displayStatus: 'IN_TRANSIT',
    createdAt: '2026-09-02T09:00:00.000Z',
    updatedAt: null,
    estimatedDeliveryAt: null,
    inTransitAt: '2026-09-02T10:00:00.000Z',
    deliveredAt: null,
    trackingCompany: 'Delhivery',
    trackingNumber: 'DL123',
    trackingUrl: null,
    tracking: [{ company: 'Delhivery', number: 'DL123', url: null }],
    events: [],
    ...overrides,
  };
}

/** Identified as DeoDap in Shopify, NOT created by Trademart: the app's product. */
const APP_LINE = line({
  shopifyLineItemId: 'gid://shopify/LineItem/1',
  title: 'Mini Fan',
  quantity: 2,
  sku: 'DD-100',
  shopifyVariantId: 'gid://shopify/ProductVariant/11',
  shopifyProductId: 'gid://shopify/Product/1',
  supplier: 'DEODAP',
  supplierEvidence: ['vendor="DeoDap"'],
});

/** Created by Trademart's CSV import (in the ledger), vendor changed to the store brand. */
const LEDGER_LINE = line({
  shopifyLineItemId: 'gid://shopify/LineItem/2',
  title: 'Jar',
  quantity: 1,
  sku: 'DD-102',
  shopifyVariantId: 'gid://shopify/ProductVariant/21',
  shopifyProductId: 'gid://shopify/Product/2',
  vendor: 'My Brand',
  supplier: 'OTHER',
});

const OTHER_LINE = line({ shopifyLineItemId: 'gid://shopify/LineItem/3', vendor: 'Acme', supplier: 'OTHER' });

const REFS = new Map([['gid://shopify/ProductVariant/21', 'DD-102']]);

function context(flow: DeodapOrderFlow, now: Date = SOON): DeodapOrderContext {
  return { flow, sla: DEFAULT_SHIPPING_SLA, now };
}

function forwarding(
  status: ForwardingRecord['status'],
  overrides: Partial<ForwardingRecord> = {},
): ForwardingRecord {
  return {
    status,
    supplierOrderId: null,
    trackingCompany: null,
    trackingNumber: null,
    trackingUrl: null,
    note: null,
    placedVia: 'MANUAL',
    placedAt: null,
    shippedAt: null,
    deliveredAt: null,
    updatedAt: null,
    updatedBy: null,
    ...overrides,
  };
}

function view(
  current: OrderDto,
  flow: DeodapOrderFlow,
  options: { now?: Date; record?: ForwardingRecord | null; costs?: Map<string, ManualCost> } = {},
) {
  return buildDeodapOrderView(
    current,
    extractDeodapLines(current, REFS, flow),
    options.record ?? null,
    options.costs ?? new Map(),
    context(flow, options.now ?? SOON),
  );
}

describe('extractDeodapLines', () => {
  it('takes identified DeoDap lines and lines the import ledger knows, and counts the rest', () => {
    const result = extractDeodapLines(order([APP_LINE, LEDGER_LINE, OTHER_LINE]), REFS, 'MANUAL');
    assert.deepEqual(
      result.lines.map((entry) => entry.sku),
      ['DD-100', 'DD-102'],
    );
    assert.equal(result.otherLineCount, 1);
    assert.equal(result.lines[1]?.supplierRef, 'DD-102');
    assert.ok(result.lines[1]?.evidence.includes('imported from DeoDap by Trademart'));
  });

  it('routes app products to DeoDap\u2019s app, and Trademart\u2019s own imports to the operator', () => {
    const result = extractDeodapLines(order([APP_LINE, LEDGER_LINE]), REFS, 'SHOPIFY_APP');
    assert.deepEqual(
      result.lines.map((entry) => [entry.sku, entry.route, entry.importedByTrademart]),
      [
        ['DD-100', 'DEODAP_APP', false],
        ['DD-102', 'MANUAL', true],
      ],
    );
    assert.equal(orderRoute(result.lines), 'MIXED');
  });

  it('routes everything to the operator in the manual flow', () => {
    const result = extractDeodapLines(order([APP_LINE, LEDGER_LINE]), REFS, 'MANUAL');
    assert.equal(orderRoute(result.lines), 'MANUAL');
  });
});

describe('orders sent by DeoDap\u2019s Shopify app', () => {
  it('asks nothing of the operator while the app still has time', () => {
    const result = view(order([APP_LINE]), 'SHOPIFY_APP');
    assert.equal(result.route, 'DEODAP_APP');
    assert.equal(result.shipment.normalizedStatus, 'AWAITING_SUPPLIER');
    assert.deepEqual(result.attention, []);
    assert.equal(result.needsAction, false);
  });

  it('flags a paid order the app has not dispatched within the SLA', () => {
    const result = view(order([APP_LINE]), 'SHOPIFY_APP', { now: LATE });
    assert.equal(result.needsAction, true);
    assert.ok(result.attention.some((reason) => reason.includes('has not dispatched it')));
  });

  it('flags a cash-on-delivery order the app has not dispatched, which the paid-only SLA would miss', () => {
    const result = view(order([APP_LINE], { financialStatus: 'PENDING' }), 'SHOPIFY_APP', { now: LATE });
    assert.equal(result.shipment.delayed, false, 'the dashboard SLA only watches paid orders');
    assert.ok(result.attention.some((reason) => reason.includes('cash on delivery')));
    assert.ok(result.attention.some((reason) => reason.includes("DeoDap's app")));
  });

  it('reports progress and tracking the app wrote into Shopify', () => {
    const result = view(
      order([APP_LINE], { fulfillmentStatus: 'FULFILLED', fulfillments: [fulfillment()] }),
      'SHOPIFY_APP',
      { now: LATE },
    );
    assert.equal(result.shipment.normalizedStatus, 'IN_TRANSIT');
    assert.deepEqual(result.shipment.trackingNumbers, ['DL123']);
    assert.equal(result.needsAction, false);
  });

  it('still asks the operator to place items Trademart imported itself', () => {
    const result = view(order([APP_LINE, LEDGER_LINE]), 'SHOPIFY_APP');
    assert.equal(result.route, 'MIXED');
    assert.ok(result.attention.some((reason) => reason.includes("Trademart's CSV import")));
  });
});

describe('orders placed by hand', () => {
  it('flags an order not yet placed with DeoDap', () => {
    const result = view(order([APP_LINE]), 'MANUAL');
    assert.equal(result.route, 'MANUAL');
    assert.ok(result.attention.some((reason) => reason.startsWith('Not placed with DeoDap')));
  });

  it('includes cash-on-delivery orders, whose payment is still pending', () => {
    assert.equal(view(order([APP_LINE], { financialStatus: 'PENDING' }), 'MANUAL').needsAction, true);
  });

  it('asks nothing once placed, while there is still time', () => {
    assert.equal(view(order([APP_LINE]), 'MANUAL', { record: forwarding('PLACED') }).needsAction, false);
  });

  it('flags tracking recorded here that the Shopify order does not have', () => {
    const result = view(order([APP_LINE]), 'MANUAL', {
      now: LATE,
      record: forwarding('SHIPPED', { trackingNumber: 'DL999' }),
    });
    assert.equal(result.attention.length, 1, 'the stale "not dispatched" signal is left out');
    assert.match(result.attention[0] ?? '', /Fulfil the order in Shopify/);
  });

  it('is satisfied once the same tracking is on the Shopify order', () => {
    const result = view(
      order([APP_LINE], { fulfillmentStatus: 'FULFILLED', fulfillments: [fulfillment()] }),
      'MANUAL',
      { now: LATE, record: forwarding('SHIPPED', { trackingNumber: ' dl123 ' }) },
    );
    assert.equal(result.needsAction, false);
  });
});

describe('what always applies', () => {
  it('flags a recorded problem, even on a cancelled order', () => {
    const result = view(order([APP_LINE], { cancelledAt: '2026-09-02T00:00:00Z' }), 'SHOPIFY_APP', {
      record: forwarding('PROBLEM', { note: 'Out of stock at DeoDap' }),
    });
    assert.deepEqual(result.attention, ['You recorded a problem with DeoDap: Out of stock at DeoDap']);
  });

  it('asks nothing of a cancelled or refunded order', () => {
    assert.equal(
      view(order([APP_LINE], { cancelledAt: '2026-09-02T00:00:00Z' }), 'MANUAL', { now: LATE }).needsAction,
      false,
    );
    assert.equal(
      view(order([APP_LINE], { financialStatus: 'REFUNDED' }), 'SHOPIFY_APP', { now: LATE }).needsAction,
      false,
    );
  });

  it('flags a DeoDap cancellation the Shopify order does not reflect', () => {
    const result = view(order([APP_LINE]), 'SHOPIFY_APP', { now: LATE, record: forwarding('CANCELLED') });
    assert.equal(result.attention.length, 1);
    assert.match(result.attention[0] ?? '', /Cancel or refund it in Shopify/);
  });

  it('asks nothing of an order already fulfilled in Shopify', () => {
    const result = view(
      order([APP_LINE], { fulfillmentStatus: 'FULFILLED', fulfillments: [fulfillment()] }),
      'MANUAL',
    );
    assert.equal(result.needsAction, false);
  });
});

describe('supplier cost', () => {
  const costs = new Map<string, ManualCost>([
    ['gid://shopify/ProductVariant/11', { amount: 100, currencyCode: 'INR', shippingCost: 20 }],
    ['gid://shopify/ProductVariant/21', { amount: 40, currencyCode: 'INR', shippingCost: null }],
  ]);

  it('totals what DeoDap will charge, shipping included, per unit ordered', () => {
    const result = view(order([APP_LINE, LEDGER_LINE]), 'MANUAL', { costs });
    // 2 x (100 + 20) + 1 x 40
    assert.deepEqual(result.supplierCost, { total: 280, currencyCode: 'INR', complete: true });
  });

  it('marks the total incomplete when a line has no recorded cost', () => {
    const result = view(order([APP_LINE, LEDGER_LINE]), 'MANUAL', {
      costs: new Map([['gid://shopify/ProductVariant/11', { amount: 100, currencyCode: 'INR' }]]),
    });
    assert.equal(result.supplierCost.total, 200);
    assert.equal(result.supplierCost.complete, false);
  });

  it('refuses to add up costs in different currencies', () => {
    const result = view(order([APP_LINE, LEDGER_LINE]), 'MANUAL', {
      costs: new Map<string, ManualCost>([
        ['gid://shopify/ProductVariant/11', { amount: 100, currencyCode: 'INR' }],
        ['gid://shopify/ProductVariant/21', { amount: 1, currencyCode: 'USD' }],
      ]),
    });
    assert.equal(result.supplierCost.total, null);
  });
});

describe('validateForwardingUpdate', () => {
  function isValidationError(error: unknown): boolean {
    return error instanceof AppError && error.code === 'VALIDATION_ERROR';
  }

  it('accepts a status in any case and blanks empty text', () => {
    assert.deepEqual(
      validateForwardingUpdate({ status: 'shipped', supplierOrderId: ' DD-778 ', trackingNumber: '', note: null }),
      {
        status: 'SHIPPED',
        supplierOrderId: 'DD-778',
        trackingCompany: null,
        trackingNumber: null,
        trackingUrl: null,
        note: null,
      },
    );
  });

  it('refuses an unknown status', () => {
    assert.throws(() => validateForwardingUpdate({ status: 'LOST' }), isValidationError);
    assert.throws(() => validateForwardingUpdate({}), isValidationError);
  });

  it('accepts only https tracking links', () => {
    assert.equal(
      validateForwardingUpdate({ status: 'SHIPPED', trackingUrl: 'https://track.example.com/123' }).trackingUrl,
      'https://track.example.com/123',
    );
    for (const url of ['http://track.example.com/1', 'javascript:alert(1)', 'not a url']) {
      assert.throws(() => validateForwardingUpdate({ status: 'SHIPPED', trackingUrl: url }), isValidationError);
    }
  });

  it('caps free text', () => {
    assert.throws(() => validateForwardingUpdate({ status: 'PLACED', note: 'x'.repeat(501) }), isValidationError);
  });
});

describe('stageTimestamps', () => {
  const earlier = new Date('2026-09-01T00:00:00Z');
  const now = new Date('2026-09-05T00:00:00Z');

  it('stamps each stage the first time it is reached', () => {
    assert.deepEqual(stageTimestamps(null, 'SHIPPED', now), { placedAt: now, shippedAt: now, deliveredAt: null });
    assert.deepEqual(stageTimestamps(null, 'NOT_PLACED', now), { placedAt: null, shippedAt: null, deliveredAt: null });
  });

  it('keeps the original time when an order is updated again', () => {
    const result = stageTimestamps({ placedAt: earlier, shippedAt: null, deliveredAt: null }, 'DELIVERED', now);
    assert.deepEqual(result, { placedAt: earlier, shippedAt: now, deliveredAt: now });
  });
});
