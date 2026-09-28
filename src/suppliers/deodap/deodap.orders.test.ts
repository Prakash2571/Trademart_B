/**
 * DeoDap orders: which lines are DeoDap's, what DeoDap will charge, and what still
 * needs placing.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AppError } from '../../common/errors';
import type { OrderDto, OrderLineItemDto } from '../../shopify/shopify.types';
import type { ManualCost } from '../cost';
import {
  buildDeodapOrderView,
  extractDeodapLines,
  needsForwarding,
  stageTimestamps,
  validateForwardingUpdate,
  type ForwardingRecord,
} from './deodap.orders';

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
    createdAt: '2026-09-01T10:00:00.000Z',
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

const DEODAP_LINE = line({
  shopifyLineItemId: 'gid://shopify/LineItem/1',
  title: 'Mini Fan',
  quantity: 2,
  sku: 'DD-100',
  shopifyVariantId: 'gid://shopify/ProductVariant/11',
  shopifyProductId: 'gid://shopify/Product/1',
  supplier: 'DEODAP',
  supplierEvidence: ['vendor="DeoDap"'],
});

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

function forwarding(status: ForwardingRecord['status']): ForwardingRecord {
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
  };
}

describe('extractDeodapLines', () => {
  it('takes identified DeoDap lines and lines the import ledger knows, and counts the rest', () => {
    const result = extractDeodapLines(order([DEODAP_LINE, LEDGER_LINE, OTHER_LINE]), REFS);
    assert.deepEqual(
      result.lines.map((entry) => entry.sku),
      ['DD-100', 'DD-102'],
    );
    assert.equal(result.otherLineCount, 1);
    assert.equal(result.lines[1]?.supplierRef, 'DD-102');
    assert.ok(result.lines[1]?.evidence.includes('imported from DeoDap by Trademart'));
  });
});

describe('needsForwarding', () => {
  const paid = order([DEODAP_LINE]);

  it('is true for an open order not yet placed with DeoDap', () => {
    assert.equal(needsForwarding(paid, null), true);
    assert.equal(needsForwarding(paid, forwarding('NOT_PLACED')), true);
  });

  it('includes cash-on-delivery orders, whose payment is still pending', () => {
    assert.equal(needsForwarding(order([DEODAP_LINE], { financialStatus: 'PENDING' }), null), true);
  });

  it('is false once placed, when cancelled, or when already fulfilled', () => {
    assert.equal(needsForwarding(paid, forwarding('PLACED')), false);
    assert.equal(needsForwarding(order([DEODAP_LINE], { cancelledAt: '2026-09-02T00:00:00Z' }), null), false);
    assert.equal(needsForwarding(order([DEODAP_LINE], { fulfillmentStatus: 'FULFILLED' }), null), false);
  });

  it('is true for a recorded problem, whatever else is true', () => {
    assert.equal(needsForwarding(order([DEODAP_LINE], { fulfillmentStatus: 'FULFILLED' }), forwarding('PROBLEM')), true);
  });
});

describe('buildDeodapOrderView', () => {
  const costs = new Map<string, ManualCost>([
    ['gid://shopify/ProductVariant/11', { amount: 100, currencyCode: 'INR', shippingCost: 20 }],
    ['gid://shopify/ProductVariant/21', { amount: 40, currencyCode: 'INR', shippingCost: null }],
  ]);

  it('totals what DeoDap will charge, shipping included, per unit ordered', () => {
    const current = order([DEODAP_LINE, LEDGER_LINE]);
    const view = buildDeodapOrderView(current, extractDeodapLines(current, REFS), null, costs);
    // 2 x (100 + 20) + 1 x 40
    assert.deepEqual(view.supplierCost, { total: 280, currencyCode: 'INR', complete: true });
    assert.equal(view.needsAction, true);
  });

  it('marks the total incomplete when a line has no recorded cost', () => {
    const current = order([DEODAP_LINE, LEDGER_LINE]);
    const view = buildDeodapOrderView(
      current,
      extractDeodapLines(current, REFS),
      null,
      new Map([['gid://shopify/ProductVariant/11', { amount: 100, currencyCode: 'INR' }]]),
    );
    assert.equal(view.supplierCost.total, 200);
    assert.equal(view.supplierCost.complete, false);
  });

  it('refuses to add up costs in different currencies', () => {
    const current = order([DEODAP_LINE, LEDGER_LINE]);
    const view = buildDeodapOrderView(
      current,
      extractDeodapLines(current, REFS),
      null,
      new Map<string, ManualCost>([
        ['gid://shopify/ProductVariant/11', { amount: 100, currencyCode: 'INR' }],
        ['gid://shopify/ProductVariant/21', { amount: 1, currencyCode: 'USD' }],
      ]),
    );
    assert.equal(view.supplierCost.total, null);
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
