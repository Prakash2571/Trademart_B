/**
 * Composition of the dropshipping order view.
 *
 * buildDropshipOrder is the pure half of the service (no Shopify, no database), so
 * it is tested directly. What matters here is that it COMPOSES the existing pieces
 * rather than re-deriving them:
 *
 *   - cost provenance comes from the existing cost hierarchy (resolveCostSource)
 *   - fulfillment state comes from resolveShipment
 *   - money comes from computeOrderEconomics
 *
 * A second opinion about cost in this file is how two screens end up disagreeing
 * about a margin, so the tests check the wiring, not the arithmetic.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// Imported from the PURE module, not the service: the service pulls in the config
// singleton, which calls process.exit(1) on an invalid environment and would kill
// the test process at import time.
import { buildDropshipOrder, type DropshipSettings } from './dropshipping.view';
import {
  DEFAULT_DROPSHIP_COST_CONFIG,
  DEFAULT_SHIPPING_SLA,
} from './dropshipping.types';
import type { ManualCost } from '../suppliers/cost';
import type { FulfillmentDto, OrderDto, OrderLineItemDto } from '../shopify/shopify.types';

const NOW = new Date('2026-03-10T12:00:00Z');
const VARIANT = 'gid://shopify/ProductVariant/200';

const money = (amount: number, currencyCode = 'INR') => ({
  amount,
  currencyCode,
  raw: amount.toFixed(2),
});

const settings: DropshipSettings = {
  cost: {
    ...DEFAULT_DROPSHIP_COST_CONFIG,
    // Fees off so the landed/commercial distinction is the thing under test.
    includePaymentFees: false,
    includeShopifyFees: false,
    includeAdvertisingAllowance: false,
  },
  sla: DEFAULT_SHIPPING_SLA,
};

function line(overrides: Partial<OrderLineItemDto> = {}): OrderLineItemDto {
  return {
    shopifyLineItemId: 'gid://shopify/LineItem/1',
    title: 'Portable Neck Fan',
    quantity: 1,
    sku: 'FAN-1',
    vendor: 'Tradelle',
    shopifyVariantId: VARIANT,
    shopifyProductId: 'gid://shopify/Product/100',
    unitPrice: money(1499),
    discountedTotal: money(1499),
    unitCost: money(520),
    fulfillmentService: 'tradelle-fulfillment',
    supplier: 'TRADELLE',
    supplierEvidence: ['fulfillmentService="tradelle-fulfillment"'],
    ...overrides,
  };
}

function order(overrides: Partial<OrderDto> = {}): OrderDto {
  return {
    shopifyOrderId: 'gid://shopify/Order/500',
    name: '#1001',
    createdAt: '2026-03-10T11:00:00Z',
    processedAt: null,
    financialStatus: 'PAID',
    fulfillmentStatus: 'UNFULFILLED',
    currencyCode: 'INR',
    customer: null,
    subtotal: money(1499),
    totalDiscounts: null,
    // What the CUSTOMER paid for shipping. Must never be read as supplier cost.
    totalShipping: money(99),
    totalTax: null,
    total: money(1499),
    shippingLine: null,
    lineItems: [line()],
    fulfillments: [],
    supplier: 'TRADELLE',
    cancelledAt: null,
    destination: {
      countryCode: 'IN',
      country: 'India',
      provinceCode: 'MH',
      province: 'Maharashtra',
      city: 'Pune',
    },
    ...overrides,
  };
}

function build(
  o: Partial<OrderDto> = {},
  costs: ReadonlyMap<string, ManualCost> = new Map(),
) {
  return buildDropshipOrder(order(o), costs, settings, NOW);
}

describe('cost provenance comes from the existing hierarchy', () => {
  it("uses Shopify's cost per item when there is no recorded supplier cost", () => {
    const view = build();
    assert.equal(view.items[0]?.unitCost, 520);
    // The hierarchy's own label, not a string invented here.
    assert.match(view.items[0]?.unitCostSource ?? '', /SHOPIFY_UNIT_COST|Shopify/i);
  });

  it('a recorded supplier shipping cost reaches the landed cost', () => {
    const costs = new Map<string, ManualCost>([
      [VARIANT, { amount: 520, currencyCode: 'INR', shippingCost: 110 }],
    ]);
    const view = build({}, costs);

    assert.equal(view.items[0]?.unitShippingCost, 110);
    assert.equal(view.economics.landedCost.amount, 630);
    assert.equal(view.economics.landedCost.confidence, 'KNOWN');
  });

  it('a manual override wins, as the hierarchy defines', () => {
    const costs = new Map<string, ManualCost>([
      [VARIANT, { amount: 600, currencyCode: 'INR', override: true }],
    ]);
    const view = build({}, costs);
    assert.equal(view.items[0]?.unitCost, 600);
  });

  it('customer-paid shipping is NEVER used as supplier shipping', () => {
    // The order carries totalShipping 99 (revenue). With no recorded supplier
    // shipping, supplier shipping must be UNKNOWN - not 99.
    const view = build();
    assert.equal(view.items[0]?.unitShippingCost, null);
    assert.equal(view.economics.supplierShippingCost.amount, null);
    assert.notEqual(view.economics.supplierShippingCost.amount, 99);
    assert.equal(view.economics.landedCost.amount, null);
  });
});

describe('supplier identification carries its evidence (C3)', () => {
  it('reports TRADELLE with the evidence that justified it', () => {
    const view = build();
    assert.equal(view.supplier, 'TRADELLE');
    assert.ok(view.supplierEvidence.some((e) => e.includes('fulfillmentService')));
  });

  it('an UNKNOWN supplier is flagged rather than assumed', () => {
    const view = build({
      supplier: 'UNKNOWN',
      lineItems: [line({ supplier: 'UNKNOWN', supplierEvidence: [], vendor: null })],
    });
    assert.equal(view.supplier, 'UNKNOWN');
    assert.deepEqual(view.supplierEvidence, []);
    assert.ok(
      view.warnings.some((w) => /UNKNOWN rather than assumed/.test(w)),
      view.warnings.join(' | '),
    );
  });

  it('deduplicates evidence repeated across lines', () => {
    const view = build({
      lineItems: [line({ shopifyLineItemId: 'l1' }), line({ shopifyLineItemId: 'l2' })],
    });
    assert.equal(view.supplierEvidence.length, 1);
  });
});

describe('shipment state is delegated, not re-derived', () => {
  it('a paid unfulfilled order is AWAITING_SUPPLIER', () => {
    assert.equal(build().shipment.normalizedStatus, 'AWAITING_SUPPLIER');
  });

  it('surfaces the delay signals as order warnings', () => {
    // Paid 3 days ago, still nothing from the supplier.
    const view = build({ createdAt: '2026-03-07T12:00:00Z' });
    assert.equal(view.shipment.delayed, true);
    assert.ok(view.warnings.some((w) => /has not dispatched/.test(w)));
    // And the compact single-value state reflects it.
    assert.equal(view.displayState, 'DELAYED');
  });

  it('a cancelled order is cancelled', () => {
    const view = build({ cancelledAt: '2026-03-09T00:00:00Z' });
    assert.equal(view.shipment.normalizedStatus, 'CANCELLED');
  });

  it('passes tracking through to the view', () => {
    const fulfillment: FulfillmentDto = {
      id: 'gid://shopify/Fulfillment/1',
      status: 'SUCCESS',
      displayStatus: 'IN_TRANSIT',
      createdAt: '2026-03-10T11:30:00Z',
      updatedAt: null,
      estimatedDeliveryAt: '2026-03-15T00:00:00Z',
      inTransitAt: '2026-03-10T11:45:00Z',
      deliveredAt: null,
      trackingCompany: 'YunExpress',
      trackingNumber: 'YT123',
      trackingUrl: 'https://track/YT123',
      tracking: [{ company: 'YunExpress', number: 'YT123', url: 'https://track/YT123' }],
      events: [],
    };
    const view = build({ fulfillments: [fulfillment], fulfillmentStatus: 'FULFILLED' });

    assert.equal(view.shipment.normalizedStatus, 'IN_TRANSIT');
    assert.equal(view.shipment.carrier, 'YunExpress');
    assert.deepEqual(view.shipment.trackingNumbers, ['YT123']);
    assert.equal(view.shipment.estimatedDeliveryAt, '2026-03-15T00:00:00.000Z');
  });
});

describe('the view keeps Shopify as the record', () => {
  it('retains Shopify status wording alongside the normalised one', () => {
    const view = build({ fulfillmentStatus: 'UNFULFILLED', financialStatus: 'PAID' });
    assert.equal(view.paymentStatus, 'PAID');
    assert.equal(view.fulfillmentStatus, 'UNFULFILLED');
    assert.equal(view.shipment.rawShopifyStatus.orderFulfillmentStatus, 'UNFULFILLED');
  });

  it('passes the destination through for regional analysis', () => {
    assert.equal(build().customerRegion?.provinceCode, 'MH');
  });

  it('a withheld destination is null, not an empty region', () => {
    // Null means protected customer data was not approved - NOT an order with no
    // destination, and callers must not report it as "unknown region".
    assert.equal(build({ destination: null }).customerRegion, null);
  });
});

describe('multi-line orders', () => {
  it('totals costs across lines', () => {
    const costs = new Map<string, ManualCost>([
      [VARIANT, { amount: 520, currencyCode: 'INR', shippingCost: 110 }],
    ]);
    const view = build(
      { lineItems: [line({ shopifyLineItemId: 'l1' }), line({ shopifyLineItemId: 'l2', quantity: 2 })] },
      costs,
    );
    // 3 units of 520 + 3 units of 110.
    assert.equal(view.economics.supplierProductCost.amount, 1560);
    assert.equal(view.economics.supplierShippingCost.amount, 330);
    assert.equal(view.items.length, 2);
  });

  it('one uncosted line makes the order total unknown', () => {
    const view = build({
      lineItems: [line({ shopifyLineItemId: 'l1' }), line({ shopifyLineItemId: 'l2', unitCost: null })],
    });
    assert.equal(view.economics.supplierProductCost.amount, null);
    assert.ok(view.warnings.some((w) => /No supplier cost recorded/.test(w)));
  });

  it('a line with no variant id cannot be matched to a recorded cost', () => {
    // Must not throw, and must not silently borrow another line's cost.
    const costs = new Map<string, ManualCost>([
      [VARIANT, { amount: 520, currencyCode: 'INR', shippingCost: 110 }],
    ]);
    const view = build({ lineItems: [line({ shopifyVariantId: null, unitCost: null })] }, costs);
    assert.equal(view.items[0]?.unitCost, null);
    assert.equal(view.economics.landedCost.amount, null);
  });
});
