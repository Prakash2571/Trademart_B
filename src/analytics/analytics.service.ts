/**
 * Analytics derived strictly from data Shopify actually returns.
 *
 * What this module will NOT do:
 *  - invent sessions, visitors or conversion rates
 *  - infer traffic from order counts
 *  - claim exact margins when supplier costs are unknown
 *
 * Revenue/AOV are computed by summing real Shopify order money fields over an
 * explicit window, and the window is reported alongside the numbers so the
 * figures can never be mistaken for all-time store totals.
 */

import type { OrderDto } from '../shopify/shopify.types';
import { round2 } from '../pricing/pricing.service';

export interface AnalyticsWindow {
  orderCount: number;
  from: string | null;
  to: string | null;
  /** Explains exactly what the numbers are based on. */
  basedOn: string;
  /** True when more orders exist beyond the sampled window. */
  truncated: boolean;
}

export interface TopProductEntry {
  shopifyProductId: string | null;
  title: string;
  unitsSold: number;
  revenue: number;
}

export interface UnavailableMetric {
  available: false;
  reason: string;
}

export interface AnalyticsOverview {
  window: AnalyticsWindow;
  currencyCode: string | null;
  totalRevenue: number;
  orderCount: number;
  averageOrderValue: number | null;
  totalDiscounts: number;
  totalShipping: number;
  totalTax: number;
  pendingFulfillmentCount: number;
  financialStatusBreakdown: Record<string, number>;
  fulfillmentStatusBreakdown: Record<string, number>;
  ordersByDay: { date: string; orders: number; revenue: number }[];
  topProducts: TopProductEntry[];
  estimatedMargin: UnavailableMetric;
  notes: string[];
}

const UNFULFILLED_STATUSES = new Set(['UNFULFILLED', 'PARTIALLY_FULFILLED', 'IN_PROGRESS', 'SCHEDULED', 'ON_HOLD']);

function bump(record: Record<string, number>, key: string | null): void {
  const safeKey = key ?? 'UNKNOWN';
  record[safeKey] = (record[safeKey] ?? 0) + 1;
}

/**
 * Pure: turns a page of real orders into aggregate figures.
 * Exported separately from the controller so it is unit testable.
 */
export function buildOverview(
  orders: OrderDto[],
  options: { truncated: boolean },
): AnalyticsOverview {
  const financialStatusBreakdown: Record<string, number> = {};
  const fulfillmentStatusBreakdown: Record<string, number> = {};
  const byDay = new Map<string, { orders: number; revenue: number }>();
  const productTotals = new Map<string, TopProductEntry>();

  let totalRevenue = 0;
  let totalDiscounts = 0;
  let totalShipping = 0;
  let totalTax = 0;
  let pendingFulfillmentCount = 0;
  let currencyCode: string | null = null;
  let earliest: string | null = null;
  let latest: string | null = null;

  for (const order of orders) {
    currencyCode ??= order.total?.currencyCode ?? order.currencyCode ?? null;

    totalRevenue += order.total?.amount ?? 0;
    totalDiscounts += order.totalDiscounts?.amount ?? 0;
    totalShipping += order.totalShipping?.amount ?? 0;
    totalTax += order.totalTax?.amount ?? 0;

    bump(financialStatusBreakdown, order.financialStatus);
    bump(fulfillmentStatusBreakdown, order.fulfillmentStatus);

    if (order.fulfillmentStatus && UNFULFILLED_STATUSES.has(order.fulfillmentStatus)) {
      pendingFulfillmentCount += 1;
    }

    if (earliest === null || order.createdAt < earliest) earliest = order.createdAt;
    if (latest === null || order.createdAt > latest) latest = order.createdAt;

    const day = order.createdAt.slice(0, 10);
    const dayEntry = byDay.get(day) ?? { orders: 0, revenue: 0 };
    dayEntry.orders += 1;
    dayEntry.revenue += order.total?.amount ?? 0;
    byDay.set(day, dayEntry);

    for (const item of order.lineItems) {
      const key = item.shopifyProductId ?? `title:${item.title}`;
      const entry =
        productTotals.get(key) ??
        ({
          shopifyProductId: item.shopifyProductId,
          title: item.title,
          unitsSold: 0,
          revenue: 0,
        } satisfies TopProductEntry);
      entry.unitsSold += item.quantity;
      entry.revenue += item.discountedTotal?.amount ?? 0;
      productTotals.set(key, entry);
    }
  }

  const orderCount = orders.length;
  const ordersByDay = [...byDay.entries()]
    .map(([date, value]) => ({
      date,
      orders: value.orders,
      revenue: round2(value.revenue),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const topProducts = [...productTotals.values()]
    .map((entry) => ({ ...entry, revenue: round2(entry.revenue) }))
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 10);

  const notes: string[] = [
    'Figures are computed from the Shopify orders in the sampled window only - they are not all-time store totals.',
  ];
  if (options.truncated) {
    notes.push(
      'More orders exist than were sampled. Increase the limit or use webhook-backed persistence for complete totals.',
    );
  }

  return {
    window: {
      orderCount,
      from: earliest,
      to: latest,
      basedOn: `most recent ${orderCount} order(s) returned by the Shopify Admin API`,
      truncated: options.truncated,
    },
    currencyCode,
    totalRevenue: round2(totalRevenue),
    orderCount,
    averageOrderValue: orderCount > 0 ? round2(totalRevenue / orderCount) : null,
    totalDiscounts: round2(totalDiscounts),
    totalShipping: round2(totalShipping),
    totalTax: round2(totalTax),
    pendingFulfillmentCount,
    financialStatusBreakdown,
    fulfillmentStatusBreakdown,
    ordersByDay,
    topProducts,
    estimatedMargin: {
      available: false,
      reason:
        'Supplier product and shipping costs are not available from Shopify for these products, so margin cannot be calculated. Enter costs in the Pricing module for an estimate.',
    },
    notes,
  };
}

/**
 * Traffic / store reach.
 *
 * The Admin GraphQL API does not expose sessions, visitors, conversion rate or
 * cart/checkout funnel data to apps by default. Shopify's documented route for
 * store analytics inside an app is ShopifyQL via the `shopifyqlQuery` field,
 * which requires the read_reports access scope (and is not available on every
 * plan). Until that is granted and verified, this reports unavailable rather
 * than guessing.
 */
export function getTrafficAvailability(): UnavailableMetric & {
  documentation: string;
  requiredScope: string;
} {
  return {
    available: false,
    reason:
      'Sessions, visitors, conversion rate and checkout funnel metrics are not available through the granted Shopify permissions. Shopify exposes store analytics to apps via ShopifyQL (shopifyqlQuery), which requires the read_reports scope and is plan-dependent.',
    requiredScope: 'read_reports',
    documentation: 'https://shopify.dev/docs/apps/build/shopifyql/graphql-admin-api',
  };
}
