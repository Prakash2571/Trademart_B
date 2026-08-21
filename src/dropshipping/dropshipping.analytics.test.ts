/**
 * Dashboard aggregates, capital exposure and Needs Attention.
 *
 * The theme: an aggregate must be usable WITHOUT being dishonest. One unpriced order
 * out of five hundred must not blank the dashboard, and it must not be silently
 * counted as costing nothing either. Every total therefore declares its coverage,
 * and a total with exclusions is a LOWER BOUND that says so.
 *
 * Capital exposure gets particular attention because it answers a cash question -
 * "how much do I need available?" - and understating it is the expensive direction.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildDashboard, computeExposure, countStates } from './dropshipping.analytics';
import { DEFAULT_DROPSHIP_COST_CONFIG, type DropshipCostConfig } from './dropshipping.types';
import type { DropshipOrder } from './dropshipping.view';

const NOW = new Date('2026-03-11T12:00:00Z'); // A Wednesday.

const config: DropshipCostConfig = {
  ...DEFAULT_DROPSHIP_COST_CONFIG,
  minimumMarginPercentage: 15,
  minimumProfitAmount: 0,
};

/** Builds a DropshipOrder shaped enough for the analytics under test. */
function order(overrides: {
  id?: string;
  name?: string;
  createdAt?: string;
  paymentStatus?: string | null;
  state?: DropshipOrder['shipment']['normalizedStatus'];
  delayed?: boolean;
  hasTracking?: boolean;
  revenue?: number | null;
  landed?: number | null;
  commercial?: number | null;
  profit?: number | null;
  margin?: number | null;
  currency?: string;
  missingInputs?: string[];
  supplier?: DropshipOrder['supplier'];
} = {}): DropshipOrder {
  const currency = overrides.currency ?? 'INR';
  const figure = (amount: number | null | undefined, source: string) =>
    amount === null || amount === undefined
      ? { amount: null, currencyCode: null, confidence: 'UNKNOWN' as const, source }
      : { amount, currencyCode: currency, confidence: 'KNOWN' as const, source };

  return {
    shopifyOrderId: overrides.id ?? 'gid://shopify/Order/1',
    orderName: overrides.name ?? '#1001',
    createdAt: overrides.createdAt ?? '2026-03-11T10:00:00Z',
    paymentStatus: overrides.paymentStatus === undefined ? 'PAID' : overrides.paymentStatus,
    fulfillmentStatus: null,
    supplier: overrides.supplier ?? 'TRADELLE',
    supplierEvidence: [],
    items: [],
    customerRegion: null,
    economics: {
      currencyCode: currency,
      customerRevenue: figure(overrides.revenue === undefined ? 1499 : overrides.revenue, 'r'),
      supplierProductCost: figure(520, 'p'),
      supplierShippingCost: figure(110, 's'),
      supplierFulfillmentCost: figure(0, 'f'),
      paymentFees: figure(0, 'pf'),
      shopifyFees: figure(0, 'sf'),
      advertisingAllowance: figure(0, 'ad'),
      otherCommercialCosts: figure(0, 'o'),
      landedCost: figure(overrides.landed === undefined ? 630 : overrides.landed, 'l'),
      commercialCost: figure(overrides.commercial === undefined ? 630 : overrides.commercial, 'c'),
      estimatedProfit: figure(overrides.profit === undefined ? 869 : overrides.profit, 'pr'),
      estimatedMargin: {
        value: overrides.margin === undefined ? 58 : overrides.margin,
        confidence: 'KNOWN',
      },
      confidence: 'KNOWN',
      missingInputs: overrides.missingInputs ?? [],
      warnings: [],
    },
    shipment: {
      normalizedStatus: overrides.state ?? 'AWAITING_SUPPLIER',
      rawShopifyStatus: { orderFulfillmentStatus: null, fulfillmentDisplayStatuses: [] },
      carrier: null,
      trackingNumbers: overrides.hasTracking === true ? ['YT1'] : [],
      trackingUrls: [],
      tracking: [],
      estimatedDeliveryAt: null,
      inTransitAt: null,
      deliveredAt: null,
      events: [],
      delayed: overrides.delayed ?? false,
      delaySignals: overrides.delayed === true ? ['late'] : [],
      hasTracking: overrides.hasTracking ?? false,
    },
    displayState: overrides.state ?? 'AWAITING_SUPPLIER',
    warnings: [],
  };
}

describe('totals declare their coverage', () => {
  it('reports full coverage when nothing is missing', () => {
    const dashboard = buildDashboard([order(), order({ id: 'o2' })], config, NOW);
    assert.equal(dashboard.revenue.amount, 2998);
    assert.equal(dashboard.revenue.ordersIncluded, 2);
    assert.equal(dashboard.revenue.ordersExcluded, 0);
    assert.equal(dashboard.revenue.confidence, 'KNOWN');
  });

  it('EXCLUDES an unknown figure and counts it, rather than treating it as zero', () => {
    const dashboard = buildDashboard(
      [order({ landed: 630 }), order({ id: 'o2', landed: null })],
      config,
      NOW,
    );
    // Not 630 + 0.
    assert.equal(dashboard.supplierCost.amount, 630);
    assert.equal(dashboard.supplierCost.ordersIncluded, 1);
    assert.equal(dashboard.supplierCost.ordersExcluded, 1);
  });

  it('marks a total with exclusions as a LOWER BOUND, not a measurement', () => {
    const dashboard = buildDashboard(
      [order(), order({ id: 'o2', landed: null })],
      config,
      NOW,
    );
    assert.match(dashboard.supplierCost.source, /LOWER BOUND/);
    // Confidence degrades even though every INCLUDED figure was KNOWN.
    assert.equal(dashboard.supplierCost.confidence, 'ESTIMATED');
    assert.ok(dashboard.warnings.some((w) => /lower bounds/.test(w)));
  });

  it('one unpriced order does not blank the dashboard', () => {
    // The per-order rule refuses partial totals; the aggregate rule must not, or a
    // single gap would destroy the whole view.
    const orders = [
      ...Array.from({ length: 9 }, (_, i) => order({ id: `o${i}` })),
      order({ id: 'bad', landed: null }),
    ];
    const dashboard = buildDashboard(orders, config, NOW);
    assert.equal(dashboard.supplierCost.ordersIncluded, 9);
    assert.ok(dashboard.supplierCost.amount > 0);
  });

  it('an empty order list is a genuine zero across zero orders', () => {
    const dashboard = buildDashboard([], config, NOW);
    assert.equal(dashboard.revenue.amount, 0);
    assert.equal(dashboard.revenue.ordersIncluded, 0);
    assert.equal(dashboard.estimatedMarginPercentage, null);
  });
});

describe('mixed currencies are never summed', () => {
  it('totals the primary currency only, and says so', () => {
    const dashboard = buildDashboard(
      [
        order({ id: 'a', currency: 'INR', revenue: 1000 }),
        order({ id: 'b', currency: 'INR', revenue: 1000 }),
        order({ id: 'c', currency: 'GBP', revenue: 40 }),
      ],
      config,
      NOW,
    );
    assert.equal(dashboard.currencyCode, 'INR');
    // 40 GBP is NOT added to 2000 INR.
    assert.equal(dashboard.revenue.amount, 2000);
    assert.equal(dashboard.revenue.ordersExcluded, 1);
    assert.ok(dashboard.warnings.some((w) => /never converted/.test(w)));
  });
});

describe('state counts', () => {
  it('buckets progress states as the dashboard presents them', () => {
    const counts = countStates([
      order({ id: '1', state: 'AWAITING_SUPPLIER' }),
      order({ id: '2', state: 'ORDER_RECEIVED' }),
      order({ id: '3', state: 'SUPPLIER_PROCESSING' }),
      order({ id: '4', state: 'LABEL_CREATED' }),
      order({ id: '5', state: 'IN_TRANSIT' }),
      order({ id: '6', state: 'OUT_FOR_DELIVERY' }),
      order({ id: '7', state: 'DELIVERED' }),
      order({ id: '8', state: 'DELIVERY_FAILED' }),
      order({ id: '9', state: 'CANCELLED' }),
      order({ id: '10', state: 'UNKNOWN' }),
    ]);

    assert.equal(counts.awaitingFulfillment, 2);
    assert.equal(counts.processing, 1);
    assert.equal(counts.shipped, 1);
    assert.equal(counts.inTransit, 1);
    assert.equal(counts.outForDelivery, 1);
    assert.equal(counts.delivered, 1);
    assert.equal(counts.deliveryFailed, 1);
    assert.equal(counts.cancelled, 1);
    assert.equal(counts.unknown, 1);
  });

  it('counts delayed ALONGSIDE the progress bucket, not instead of it', () => {
    // The brief's dashboard lists "In transit" and "Delayed" separately, so an order
    // that is both must appear in both.
    const counts = countStates([order({ state: 'IN_TRANSIT', delayed: true })]);
    assert.equal(counts.inTransit, 1);
    assert.equal(counts.delayed, 1);
  });
});

describe('time windows', () => {
  it('counts today and this week from UTC boundaries', () => {
    // NOW is Wednesday 2026-03-11; the week starts Monday 2026-03-09.
    const dashboard = buildDashboard(
      [
        order({ id: 'today', createdAt: '2026-03-11T01:00:00Z' }),
        order({ id: 'monday', createdAt: '2026-03-09T09:00:00Z' }),
        order({ id: 'lastweek', createdAt: '2026-03-07T09:00:00Z' }),
      ],
      config,
      NOW,
    );
    assert.equal(dashboard.ordersToday, 1);
    assert.equal(dashboard.ordersThisWeek, 2);
    assert.equal(dashboard.ordersConsidered, 3);
  });
});

describe('supplier capital exposure (C12)', () => {
  it('computes outstanding as committed minus dispatched', () => {
    // Two paid orders at 630 landed each; one already in transit.
    const exposure = computeExposure(
      [
        order({ id: 'a', state: 'IN_TRANSIT', landed: 630 }),
        order({ id: 'b', state: 'AWAITING_SUPPLIER', landed: 630 }),
      ],
      'INR',
    );
    assert.equal(exposure.supplierCommitments.amount, 1260);
    assert.equal(exposure.alreadyFulfilled.amount, 630);
    assert.equal(exposure.outstanding.amount, 630);
  });

  it('is built from LANDED cost, never commercial cost', () => {
    // The supplier is owed for goods and shipping, not for payment fees or an
    // advertising allowance. Using commercial cost would overstate the cash needed.
    const exposure = computeExposure(
      [order({ state: 'AWAITING_SUPPLIER', landed: 630, commercial: 885 })],
      'INR',
    );
    assert.equal(exposure.supplierCommitments.amount, 630);
    assert.notEqual(exposure.supplierCommitments.amount, 885);
  });

  it('EXCLUDES unpaid orders - no money has been taken, so none is committed', () => {
    const exposure = computeExposure(
      [
        order({ id: 'paid', paymentStatus: 'PAID', landed: 630 }),
        order({ id: 'unpaid', paymentStatus: 'PENDING', landed: 630 }),
      ],
      'INR',
    );
    assert.equal(exposure.supplierCommitments.amount, 630);
    assert.equal(exposure.paidCustomerOrders.ordersIncluded, 1);
  });

  it('EXCLUDES cancelled orders - nothing is owed on an order that will not ship', () => {
    const exposure = computeExposure(
      [
        order({ id: 'live', landed: 630 }),
        order({ id: 'dead', state: 'CANCELLED', landed: 630 }),
      ],
      'INR',
    );
    assert.equal(exposure.supplierCommitments.amount, 630);
  });

  it('says the real exposure is HIGHER when a paid order has no known cost', () => {
    // Understating a cash requirement is the expensive direction, so this is loud.
    const exposure = computeExposure(
      [order({ id: 'a', landed: 630 }), order({ id: 'b', landed: null })],
      'INR',
    );
    assert.equal(exposure.ordersWithUnknownCost, 1);
    assert.ok(
      exposure.warnings.some((w) => /HIGHER than shown/.test(w)),
      exposure.warnings.join(' | '),
    );
  });

  it('warns when the figures cover a minority of the order book', () => {
    const exposure = computeExposure(
      [
        order({ id: 'a', landed: 630 }),
        order({ id: 'b', landed: null }),
        order({ id: 'c', landed: null }),
      ],
      'INR',
    );
    assert.ok(
      exposure.warnings.some((w) => /minority of the order book/.test(w)),
      exposure.warnings.join(' | '),
    );
  });

  it('never reports a negative outstanding', () => {
    // Dispatched-but-not-committed is a data problem, not a refund owed.
    const exposure = computeExposure(
      [order({ state: 'DELIVERED', landed: 630 })],
      'INR',
    );
    assert.equal(exposure.outstanding.amount, 0);
  });
});

describe('needs attention', () => {
  function codes(orders: DropshipOrder[]): string[] {
    return buildDashboard(orders, config, NOW).attention.map((bucket) => bucket.code);
  }

  it('is empty when nothing needs attention', () => {
    assert.deepEqual(codes([order({ hasTracking: true, state: 'IN_TRANSIT' })]), []);
  });

  it('flags a failed delivery as critical', () => {
    const dashboard = buildDashboard([order({ state: 'DELIVERY_FAILED' })], config, NOW);
    const bucket = dashboard.attention.find((b) => b.code === 'FAILED_FULFILLMENT');
    assert.equal(bucket?.severity, 'critical');
    assert.equal(bucket?.count, 1);
  });

  it('flags a dispatched order with no tracking', () => {
    assert.ok(codes([order({ state: 'IN_TRANSIT', hasTracking: false })]).includes('NO_TRACKING'));
  });

  it('does NOT flag missing tracking before dispatch', () => {
    // Nothing has shipped, so there is nothing to track yet.
    assert.ok(
      !codes([order({ state: 'AWAITING_SUPPLIER', hasTracking: false })]).includes('NO_TRACKING'),
    );
  });

  it('reports a losing order as negative, not merely low', () => {
    const result = codes([order({ margin: -12, profit: -100, hasTracking: true, state: 'IN_TRANSIT' })]);
    assert.ok(result.includes('NEGATIVE_MARGIN'));
    // An order appears once, under its worst problem.
    assert.ok(!result.includes('LOW_MARGIN'));
  });

  it('flags a thin margin against the configured floor', () => {
    assert.ok(
      codes([order({ margin: 5, hasTracking: true, state: 'IN_TRANSIT' })]).includes('LOW_MARGIN'),
    );
  });

  it('does NOT flag an unknown margin as low - that is a different problem', () => {
    // Counting unknowns as low-margin would cry wolf and hide the real fix.
    const result = codes([
      order({ margin: null, profit: null, hasTracking: true, state: 'IN_TRANSIT' }),
    ]);
    assert.ok(!result.includes('LOW_MARGIN'));
    assert.ok(!result.includes('NEGATIVE_MARGIN'));
  });

  it('flags an absolute contribution below the minimum', () => {
    const strict: DropshipCostConfig = { ...config, minimumProfitAmount: 300 };
    const dashboard = buildDashboard(
      [order({ margin: 40, profit: 100, hasTracking: true, state: 'IN_TRANSIT' })],
      strict,
      NOW,
    );
    // 40% margin clears the percentage floor but 100 does not clear 300.
    assert.ok(dashboard.attention.some((b) => b.code === 'LOW_MARGIN'));
  });

  it('flags unknown supplier cost and unknown shipping separately', () => {
    const result = codes([
      order({
        missingInputs: ['supplierProductCost', 'supplierShippingCost'],
        hasTracking: true,
        state: 'IN_TRANSIT',
      }),
    ]);
    assert.ok(result.includes('UNKNOWN_SUPPLIER_COST'));
    assert.ok(result.includes('UNKNOWN_SUPPLIER_SHIPPING'));
  });

  it('flags an unidentified supplier', () => {
    assert.ok(
      codes([order({ supplier: 'UNKNOWN', hasTracking: true, state: 'IN_TRANSIT' })]).includes(
        'UNKNOWN_SUPPLIER',
      ),
    );
  });

  it('flags an uninterpretable fulfillment state rather than assuming progress', () => {
    assert.ok(codes([order({ state: 'UNKNOWN' })]).includes('UNKNOWN_FULFILLMENT_STATE'));
  });

  it('carries examples so the UI can link to the orders', () => {
    const dashboard = buildDashboard(
      [order({ id: 'gid://shopify/Order/9', name: '#1009', state: 'DELIVERY_FAILED' })],
      config,
      NOW,
    );
    const bucket = dashboard.attention.find((b) => b.code === 'FAILED_FULFILLMENT');
    assert.equal(bucket?.examples[0]?.orderName, '#1009');
  });

  it('every bucket states an action for a human', () => {
    const dashboard = buildDashboard(
      [
        order({ id: 'a', state: 'DELIVERY_FAILED' }),
        order({ id: 'b', margin: -1, profit: -1 }),
        order({ id: 'c', state: 'IN_TRANSIT', delayed: true }),
        order({ id: 'd', supplier: 'UNKNOWN' }),
      ],
      config,
      NOW,
    );
    assert.ok(dashboard.attention.length >= 3);
    for (const bucket of dashboard.attention) {
      assert.ok(bucket.action.length > 0, `${bucket.code} has no action`);
      assert.ok(bucket.count > 0, `${bucket.code} is empty but present`);
    }
  });
});

describe('aggregate margin', () => {
  it('divides profit by the revenue of the SAME orders', () => {
    // Not by the dashboard revenue total: when some orders have unknown costs the two
    // cover different populations, and the ratio would be of two different things.
    const dashboard = buildDashboard(
      [
        order({ id: 'a', revenue: 1000, profit: 400 }),
        // Unknown profit: excluded from BOTH sides of the ratio.
        order({ id: 'b', revenue: 1000, profit: null }),
      ],
      config,
      NOW,
    );
    assert.equal(dashboard.estimatedProfit.amount, 400);
    // 400 / 1000, not 400 / 2000.
    assert.equal(dashboard.estimatedMarginPercentage, 40);
  });
});
