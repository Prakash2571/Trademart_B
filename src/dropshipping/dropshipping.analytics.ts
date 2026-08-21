/**
 * Dashboard aggregates, supplier capital exposure, and Needs Attention.
 *
 * THE AGGREGATION RULE IS DELIBERATELY DIFFERENT FROM THE PER-ORDER RULE
 * ---------------------------------------------------------------------
 * dropshipping.cost.ts refuses to produce a partial total for ONE order: if the
 * supplier cost is unknown, that order's cost is UNKNOWN rather than the sum of the
 * parts we happen to have. Presenting a partial figure as "the cost of this order"
 * would be a false statement about that order.
 *
 * Across MANY orders the useful answer is different. One unpriced order out of five
 * hundred must not blank the entire dashboard, and silently summing 499 as if it
 * were 500 would be the same dishonesty at a larger scale. So every total here:
 *
 *   * INCLUDES the orders whose figure is known or estimated
 *   * EXCLUDES the orders whose figure is unknown, and COUNTS them
 *   * reports both counts, so the UI can say "from 490 of 500 orders"
 *
 * That is the only presentation that is both usable and true. A total with an
 * `ordersExcluded` above zero is a lower bound, not a measurement, and it says so.
 *
 * MIXED CURRENCIES ARE NOT SUMMED
 * -------------------------------
 * Adding 500 INR to 40 GBP produces a number that is not money in any currency.
 * Orders outside the primary currency are excluded and counted, with a warning -
 * never converted, because no exchange rate is available here.
 *
 * Pure: input is DropshipOrder[] plus a clock. No Shopify, no database, no config.
 */

import { roundMoney, sumMoney } from '../common/money';
import {
  type DataConfidence,
  type DropshipCostConfig,
  type DropshipFulfillmentState,
  type Figure,
} from './dropshipping.types';
import type { DropshipOrder } from './dropshipping.view';

const DAY_MS = 86_400_000;

/* --------------------------------------------------------------- shapes ---- */

/**
 * A total across several orders, honest about coverage.
 *
 * `amount` is never null: with nothing to include it is a genuine zero across zero
 * orders, which `ordersIncluded: 0` makes unambiguous. That differs from a per-order
 * Figure, where null means "this order's value is unknown".
 */
export interface Aggregate {
  amount: number;
  currencyCode: string | null;
  confidence: DataConfidence;
  /** Orders whose figure was known or estimated, and so counted. */
  ordersIncluded: number;
  /**
   * Orders left out because their figure was unknown or in another currency. Their
   * value is NOT zero - the total is a lower bound while this is above zero.
   */
  ordersExcluded: number;
  source: string;
}

export interface StateCounts {
  /** ORDER_RECEIVED + AWAITING_SUPPLIER: nothing has been dispatched. */
  awaitingFulfillment: number;
  processing: number;
  /** Fulfilled / label created / picked up: dispatched, no transit scan yet. */
  shipped: number;
  inTransit: number;
  outForDelivery: number;
  delivered: number;
  deliveryFailed: number;
  cancelled: number;
  unknown: number;
  /**
   * Counted from the `delayed` flag, NOT from a progress state - an order can be in
   * transit and late at once, so this deliberately overlaps the buckets above.
   */
  delayed: number;
}

export interface AttentionBucket {
  code: string;
  label: string;
  /** What to do about it. Never performed automatically. */
  action: string;
  severity: 'critical' | 'warning' | 'info';
  count: number;
  /** Up to a handful of examples, so the UI can link straight to them. */
  examples: { shopifyOrderId: string; orderName: string }[];
}

/**
 * Answers "how much cash do I need available to keep these orders moving?" (C12).
 *
 * Built from LANDED cost, never commercial cost: the supplier is owed for goods and
 * shipping, not for payment fees or an advertising allowance. Using commercial cost
 * here would overstate the cash requirement by money nobody is going to invoice.
 */
export interface CapitalExposure {
  /** Revenue already collected from customers on paid orders. */
  paidCustomerOrders: Aggregate;
  /** Landed cost of every paid, non-cancelled order - the total supplier bill. */
  supplierCommitments: Aggregate;
  /** Landed cost of the part already dispatched. */
  alreadyFulfilled: Aggregate;
  /**
   * Committed but not yet dispatched: the cash still required.
   * supplierCommitments - alreadyFulfilled.
   */
  outstanding: Aggregate;
  /**
   * Paid orders whose landed cost is unknown, so they are in NONE of the totals
   * above. Prominent because it is the size of the blind spot.
   */
  ordersWithUnknownCost: number;
  warnings: string[];
}

export interface DropshipDashboard {
  currencyCode: string | null;
  generatedAt: string;
  ordersConsidered: number;
  ordersToday: number;
  ordersThisWeek: number;
  counts: StateCounts;
  revenue: Aggregate;
  /** Landed cost: what suppliers are owed. */
  supplierCost: Aggregate;
  /** Commercial cost: landed + fees + allowances. */
  commercialCost: Aggregate;
  estimatedProfit: Aggregate;
  /** Percentage of included revenue. Null when no revenue was included. */
  estimatedMarginPercentage: number | null;
  exposure: CapitalExposure;
  attention: AttentionBucket[];
  /** Coverage caveats that apply to the whole dashboard. */
  warnings: string[];
}

/* -------------------------------------------------------------- helpers ---- */

const PAID_STATUSES = new Set(['PAID', 'PARTIALLY_PAID', 'PARTIALLY_REFUNDED']);

/** True when the merchant is holding the customer's money. */
function isPaid(order: DropshipOrder): boolean {
  return order.paymentStatus !== null && PAID_STATUSES.has(order.paymentStatus);
}

function isCancelled(order: DropshipOrder): boolean {
  return order.shipment.normalizedStatus === 'CANCELLED';
}

/** Progress states at or beyond dispatch. */
const DISPATCHED: ReadonlySet<DropshipFulfillmentState> = new Set([
  'FULFILLED',
  'LABEL_CREATED',
  'CARRIER_PICKED_UP',
  'IN_TRANSIT',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
]);

function worst(a: DataConfidence, b: DataConfidence): DataConfidence {
  const rank: Record<DataConfidence, number> = { KNOWN: 0, ESTIMATED: 1, UNKNOWN: 2 };
  return rank[b] > rank[a] ? b : a;
}

/**
 * Totals one figure across orders, excluding and counting what it cannot include.
 *
 * An order is excluded when its figure is UNKNOWN, or when it is denominated in a
 * currency other than the primary one. Both are reported, so a total is never
 * mistaken for full coverage.
 */
function aggregate(
  orders: readonly DropshipOrder[],
  pick: (order: DropshipOrder) => Figure,
  primaryCurrency: string | null,
  describe: string,
): Aggregate {
  const amounts: number[] = [];
  let excluded = 0;
  let confidence: DataConfidence = 'KNOWN';

  for (const order of orders) {
    const figure = pick(order);
    if (figure.amount === null || figure.confidence === 'UNKNOWN') {
      excluded += 1;
      continue;
    }
    // Never convert. No exchange rate is available, and a converted figure would be
    // an invention presented as a measurement.
    if (
      primaryCurrency !== null &&
      figure.currencyCode !== null &&
      figure.currencyCode !== primaryCurrency
    ) {
      excluded += 1;
      continue;
    }
    amounts.push(figure.amount);
    confidence = worst(confidence, figure.confidence);
  }

  // Any exclusion makes the total a lower bound rather than a measurement, and the
  // confidence must say so even if every INCLUDED figure was known.
  if (excluded > 0) confidence = worst(confidence, 'ESTIMATED');

  return {
    amount: sumMoney(...amounts),
    currencyCode: primaryCurrency,
    confidence,
    ordersIncluded: amounts.length,
    ordersExcluded: excluded,
    source:
      excluded === 0
        ? `${describe} across all ${amounts.length} order(s).`
        : `${describe} across ${amounts.length} order(s). ${excluded} excluded (unknown value or a different currency), so this is a LOWER BOUND.`,
  };
}

/** The currency to report in: the one most orders use. */
function primaryCurrencyOf(orders: readonly DropshipOrder[]): string | null {
  const tally = new Map<string, number>();
  for (const order of orders) {
    const currency = order.economics.currencyCode;
    if (currency === null) continue;
    tally.set(currency, (tally.get(currency) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [currency, count] of tally) {
    if (count > bestCount) {
      best = currency;
      bestCount = count;
    }
  }
  return best;
}

function startOfUtcDay(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/** Most recent Monday 00:00 UTC. */
function startOfUtcWeek(date: Date): number {
  const day = date.getUTCDay(); // 0 = Sunday
  const daysSinceMonday = (day + 6) % 7;
  return startOfUtcDay(date) - daysSinceMonday * DAY_MS;
}

/* -------------------------------------------------------------- attention -- */

function buildAttention(
  orders: readonly DropshipOrder[],
  config: DropshipCostConfig,
): AttentionBucket[] {
  const definitions: {
    code: string;
    label: string;
    action: string;
    severity: AttentionBucket['severity'];
    match: (order: DropshipOrder) => boolean;
  }[] = [
    {
      code: 'FAILED_FULFILLMENT',
      label: 'Delivery failed',
      action: 'Contact the carrier or the customer and arrange redelivery or a refund.',
      severity: 'critical',
      match: (order) => order.shipment.normalizedStatus === 'DELIVERY_FAILED',
    },
    {
      code: 'NEGATIVE_MARGIN',
      label: 'Losing money',
      action: 'Check the supplier cost and the selling price before fulfilling more of these.',
      severity: 'critical',
      // Only when the margin is actually KNOWN. An unknown margin is a different
      // problem with a different fix, and counting it here would cry wolf.
      match: (order) =>
        order.economics.estimatedMargin.value !== null &&
        order.economics.estimatedMargin.value < 0,
    },
    {
      code: 'NO_TRACKING',
      label: 'Dispatched with no tracking',
      action:
        'Ask the supplier for a tracking number. Until one exists the customer can see nothing at all.',
      severity: 'warning',
      match: (order) =>
        DISPATCHED.has(order.shipment.normalizedStatus) && !order.shipment.hasTracking,
    },
    {
      code: 'DELAYED',
      label: 'Delayed',
      action: 'Consider contacting the customer before they contact you.',
      severity: 'warning',
      match: (order) => order.shipment.delayed,
    },
    {
      code: 'LOW_MARGIN',
      label: `Below the ${config.minimumMarginPercentage}% margin floor`,
      action: 'Reprice, or stop promoting the product.',
      severity: 'warning',
      match: (order) => {
        const margin = order.economics.estimatedMargin.value;
        const profit = order.economics.estimatedProfit.amount;
        if (margin === null) return false;
        // Not also negative - that is reported as the more severe bucket above, and
        // an order should appear once with its worst problem.
        if (margin < 0) return false;
        if (margin < config.minimumMarginPercentage) return true;
        return (
          config.minimumProfitAmount > 0 &&
          profit !== null &&
          profit < config.minimumProfitAmount
        );
      },
    },
    {
      code: 'UNKNOWN_SUPPLIER_COST',
      label: 'No supplier cost recorded',
      action:
        'Set "Cost per item" in Shopify or record a manual cost. Profit for these orders cannot be calculated.',
      severity: 'warning',
      match: (order) => order.economics.missingInputs.includes('supplierProductCost'),
    },
    {
      code: 'UNKNOWN_SUPPLIER_SHIPPING',
      label: 'No supplier shipping cost recorded',
      action: 'Record the supplier shipping cost. It is unknown, not free.',
      severity: 'info',
      match: (order) => order.economics.missingInputs.includes('supplierShippingCost'),
    },
    {
      code: 'UNKNOWN_SUPPLIER',
      label: 'Supplier could not be identified',
      action:
        'Check the product vendor, tags or fulfillment service so the order can be attributed.',
      severity: 'info',
      match: (order) => order.supplier === 'UNKNOWN',
    },
    {
      code: 'UNKNOWN_FULFILLMENT_STATE',
      label: 'Fulfillment state unknown',
      action: 'Open the order in Shopify - Trademart could not interpret its status.',
      severity: 'info',
      // Never silently treated as "processing".
      match: (order) => order.shipment.normalizedStatus === 'UNKNOWN',
    },
  ];

  return definitions
    .map((definition) => {
      const matched = orders.filter(definition.match);
      return {
        code: definition.code,
        label: definition.label,
        action: definition.action,
        severity: definition.severity,
        count: matched.length,
        examples: matched.slice(0, 5).map((order) => ({
          shopifyOrderId: order.shopifyOrderId,
          orderName: order.orderName,
        })),
      };
    })
    .filter((bucket) => bucket.count > 0);
}

/* --------------------------------------------------------------- exposure -- */

/**
 * Supplier capital exposure (C12).
 *
 * Cancelled orders are excluded entirely: nothing is owed on an order that will not
 * be fulfilled. Unpaid orders are excluded too - the merchant has not taken the
 * money, so there is no committed cash to reserve yet.
 */
export function computeExposure(
  orders: readonly DropshipOrder[],
  primaryCurrency: string | null,
): CapitalExposure {
  const paid = orders.filter((order) => isPaid(order) && !isCancelled(order));
  const dispatched = paid.filter((order) => DISPATCHED.has(order.shipment.normalizedStatus));

  const paidCustomerOrders = aggregate(
    paid,
    (order) => order.economics.customerRevenue,
    primaryCurrency,
    'Revenue collected on paid orders',
  );
  const supplierCommitments = aggregate(
    paid,
    (order) => order.economics.landedCost,
    primaryCurrency,
    'Landed cost owed to suppliers on paid orders',
  );
  const alreadyFulfilled = aggregate(
    dispatched,
    (order) => order.economics.landedCost,
    primaryCurrency,
    'Landed cost of orders already dispatched',
  );

  // Outstanding is computed from the SAME excluded set as its inputs, so it cannot
  // drift from them. Floored at zero: a negative outstanding would mean more was
  // dispatched than committed, which is a data problem, not a refund owed.
  const outstandingAmount = Math.max(
    0,
    roundMoney(supplierCommitments.amount - alreadyFulfilled.amount),
  );
  const ordersWithUnknownCost = paid.filter(
    (order) => order.economics.landedCost.amount === null,
  ).length;

  const warnings: string[] = [];
  if (ordersWithUnknownCost > 0) {
    warnings.push(
      `${ordersWithUnknownCost} paid order(s) have no known landed cost, so they are excluded from every figure here. The real outstanding exposure is HIGHER than shown.`,
    );
  }
  if (supplierCommitments.ordersExcluded > supplierCommitments.ordersIncluded) {
    warnings.push(
      'More paid orders were excluded than included, so these figures cover a minority of the order book and should not be used for cash planning yet.',
    );
  }

  return {
    paidCustomerOrders,
    supplierCommitments,
    alreadyFulfilled,
    outstanding: {
      amount: outstandingAmount,
      currencyCode: primaryCurrency,
      confidence: worst(supplierCommitments.confidence, alreadyFulfilled.confidence),
      ordersIncluded: supplierCommitments.ordersIncluded - alreadyFulfilled.ordersIncluded,
      ordersExcluded: supplierCommitments.ordersExcluded,
      source:
        'Landed cost committed on paid orders, minus the part already dispatched. This is the cash still needed to keep these orders moving.',
    },
    ordersWithUnknownCost,
    warnings,
  };
}

/* -------------------------------------------------------------- dashboard -- */

/** Counts orders into the dashboard's buckets. */
export function countStates(orders: readonly DropshipOrder[]): StateCounts {
  const counts: StateCounts = {
    awaitingFulfillment: 0,
    processing: 0,
    shipped: 0,
    inTransit: 0,
    outForDelivery: 0,
    delivered: 0,
    deliveryFailed: 0,
    cancelled: 0,
    unknown: 0,
    delayed: 0,
  };

  for (const order of orders) {
    // Progress comes from normalizedStatus, not displayState: an order that is both
    // in transit and late belongs in inTransit AND in delayed, and reading the
    // collapsed value would move it out of its progress bucket.
    switch (order.shipment.normalizedStatus) {
      case 'ORDER_RECEIVED':
      case 'AWAITING_SUPPLIER':
        counts.awaitingFulfillment += 1;
        break;
      case 'SUPPLIER_PROCESSING':
        counts.processing += 1;
        break;
      case 'FULFILLED':
      case 'LABEL_CREATED':
      case 'CARRIER_PICKED_UP':
        counts.shipped += 1;
        break;
      case 'IN_TRANSIT':
        counts.inTransit += 1;
        break;
      case 'OUT_FOR_DELIVERY':
        counts.outForDelivery += 1;
        break;
      case 'DELIVERED':
        counts.delivered += 1;
        break;
      case 'DELIVERY_FAILED':
        counts.deliveryFailed += 1;
        break;
      case 'CANCELLED':
        counts.cancelled += 1;
        break;
      default:
        counts.unknown += 1;
    }
    if (order.shipment.delayed) counts.delayed += 1;
  }

  return counts;
}

export function buildDashboard(
  orders: readonly DropshipOrder[],
  config: DropshipCostConfig,
  now: Date = new Date(),
): DropshipDashboard {
  const currency = primaryCurrencyOf(orders);
  const dayStart = startOfUtcDay(now);
  const weekStart = startOfUtcWeek(now);

  let ordersToday = 0;
  let ordersThisWeek = 0;
  for (const order of orders) {
    const created = new Date(order.createdAt).getTime();
    if (!Number.isFinite(created)) continue;
    if (created >= dayStart) ordersToday += 1;
    if (created >= weekStart) ordersThisWeek += 1;
  }

  const revenue = aggregate(
    orders,
    (order) => order.economics.customerRevenue,
    currency,
    'Customer revenue',
  );
  const supplierCost = aggregate(
    orders,
    (order) => order.economics.landedCost,
    currency,
    'Landed cost owed to suppliers',
  );
  const commercialCost = aggregate(
    orders,
    (order) => order.economics.commercialCost,
    currency,
    'Commercial cost',
  );
  const estimatedProfit = aggregate(
    orders,
    (order) => order.economics.estimatedProfit,
    currency,
    'Estimated contribution',
  );

  // Margin is derived from the PROFIT aggregate's own revenue coverage, not from the
  // dashboard revenue total: those cover different order sets when some orders have
  // unknown costs, and dividing one by the other would produce a ratio of two
  // different populations.
  const profitOrders = orders.filter(
    (order) =>
      order.economics.estimatedProfit.amount !== null &&
      order.economics.customerRevenue.amount !== null,
  );
  const revenueForMargin = sumMoney(
    ...profitOrders.map((order) => order.economics.customerRevenue.amount),
  );
  const estimatedMarginPercentage =
    revenueForMargin > 0
      ? roundMoney((estimatedProfit.amount / revenueForMargin) * 100, 'margin')
      : null;

  const warnings: string[] = [];
  const currencies = new Set(
    orders.map((order) => order.economics.currencyCode).filter((value) => value !== null),
  );
  if (currencies.size > 1) {
    warnings.push(
      `Orders span ${currencies.size} currencies (${[...currencies].join(', ')}). Totals cover ${currency} only - amounts are never converted, because no exchange rate is available.`,
    );
  }
  if (revenue.ordersExcluded > 0 || supplierCost.ordersExcluded > 0) {
    warnings.push(
      'Some orders are missing data and are excluded from the totals, so the money figures are lower bounds. See Needs Attention for which.',
    );
  }

  return {
    currencyCode: currency,
    generatedAt: now.toISOString(),
    ordersConsidered: orders.length,
    ordersToday,
    ordersThisWeek,
    counts: countStates(orders),
    revenue,
    supplierCost,
    commercialCost,
    estimatedProfit,
    estimatedMarginPercentage,
    exposure: computeExposure(orders, currency),
    attention: buildAttention(orders, config),
    warnings,
  };
}
