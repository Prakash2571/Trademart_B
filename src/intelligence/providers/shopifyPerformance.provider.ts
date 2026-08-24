/**
 * The store's own trading history, from its own Shopify orders.
 *
 * The only provider in this module that supplies MEASURED data, and therefore the most
 * valuable one. Everything else in Research describes the world; this describes what
 * happened when this store sold something comparable - which is the difference between
 * "this product is popular" and "this product works here".
 *
 * It answers two questions:
 *
 *   StorePerformanceSignal     does the store already trade in this category, at what
 *                              price, and does that category come back as refunds?
 *   FulfillmentHistorySignal   when this store sold things like this, did they
 *                              actually arrive, on time, with tracking?
 *
 * The second closes the feedback loop the brief describes: research -> push -> sell ->
 * fulfil -> measure -> better research. It reuses resolveShipment(), so "late" means
 * exactly what it means on the dropshipping dashboard rather than being defined a
 * second time here.
 *
 * AGGREGATION DOCTRINE (inherited from dropshipping.analytics.ts)
 * -------------------------------------------------------------
 * Include what is known, EXCLUDE and COUNT what is not, and report both. A rate whose
 * denominator excluded orders is a rate over the orders we could read, not over the
 * store's whole history, and the caller is told so. Never sum or compare across
 * currencies. A truncated read produces a LOWER BOUND on the sample, never a
 * measurement presented as complete.
 *
 * Pure: OrderDto[] and ProductDto[] in, signals out, clock injected. No Shopify client,
 * no config, no database - the service fetches and hands the data over.
 */

import { resolveShipment } from '../../dropshipping/dropshipping.status';
import {
  DEFAULT_SHIPPING_SLA,
  STATE_RANK,
  type DropshipFulfillmentState,
  type ShippingSla,
} from '../../dropshipping/dropshipping.types';
import type { OrderDto, ProductDto } from '../../shopify/shopify.types';
import type { SignalGeography, TargetMarket } from '../candidate.types';
import type {
  FulfillmentHistorySignal,
  StorePerformanceSignal,
} from '../scoring/scoring.types';
import {
  NO_RESEARCH_CAPABILITIES,
  type ResearchProvider,
  type ResearchRequest,
} from './provider.types';

const SOURCE = 'This store\u2019s own Shopify orders';

/**
 * A parcel has left when it reaches FULFILLED or beyond.
 *
 * Used for the no-tracking rate: an order still awaiting the supplier has no tracking
 * number because nothing has shipped, which is not a tracking failure. Counting it as
 * one would make every busy day look like a tracking outage.
 */
const DISPATCHED_RANK = STATE_RANK.FULFILLED;

function isDispatched(state: DropshipFulfillmentState): boolean {
  if (state === 'DELAYED') return false;
  return STATE_RANK[state] >= DISPATCHED_RANK;
}

/* ===========================================================================
 * Input and output
 * ======================================================================== */

export interface StoreHistoryInput {
  /** Orders read from Shopify, newest-first or not - order does not matter. */
  orders: readonly OrderDto[];
  /**
   * Products read from Shopify, used to map a product id to its category.
   *
   * Needed because an order line item carries no productType, so the category of a
   * sale can only be established by looking the product up.
   */
  products: readonly ProductDto[];
  /** The category being researched. Null means no category comparison is possible. */
  category: string | null;
  market: TargetMarket;
  /** True when Shopify had more orders than were read. */
  truncated: boolean;
  sla?: ShippingSla;
  now: Date;
}

export interface StoreHistorySummary {
  storePerformance: StorePerformanceSignal | null;
  fulfillmentHistory: FulfillmentHistorySignal | null;
  /** Orders that contained at least one product in the category. */
  categoryOrderCount: number;
  /** Category products found in the catalogue. */
  categoryProductCount: number;
  /** Honest caveats about what these numbers do and do not cover. */
  notes: string[];
}

/* ===========================================================================
 * Category matching
 * ======================================================================== */

function normalise(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed === '' ? null : trimmed;
}

/**
 * Products whose category matches, by Shopify's productType.
 *
 * productType only - not tags, not vendor. Tags are a free-for-all in most stores and
 * matching on them would silently widen the comparison set until "this category" meant
 * "most of the catalogue", which would make store fit meaningless while still
 * reporting a confident number.
 */
function categoryProductsOf(
  products: readonly ProductDto[],
  category: string | null,
): ProductDto[] {
  const wanted = normalise(category);
  if (wanted === null) return [];
  return products.filter((product) => normalise(product.productType) === wanted);
}

/* ===========================================================================
 * Price band
 * ======================================================================== */

/**
 * The price band the store actually trades in, as the 25th-75th percentile of its
 * category variant prices.
 *
 * NOT the min and max. One clearance item at 2.00 and one premium bundle at 200.00
 * would produce a 2-200 band, inside which every conceivable price "fits" - a check
 * that always passes is worse than no check, because it looks like it verified
 * something. The interquartile range describes where the store's business actually is.
 */
function priceBandOf(products: readonly ProductDto[]): {
  min: number | null;
  max: number | null;
  currencyCode: string | null;
  note: string | null;
} {
  const prices: number[] = [];
  const currencies = new Set<string>();

  for (const product of products) {
    for (const variant of product.variants) {
      if (variant.price === null) continue;
      prices.push(variant.price.amount);
      currencies.add(variant.price.currencyCode.trim().toUpperCase());
    }
  }

  if (prices.length === 0) {
    return { min: null, max: null, currencyCode: null, note: null };
  }

  if (currencies.size > 1) {
    // A band spanning two currencies is not a band. Refused rather than converted,
    // because no exchange rate is configured and a wrong band would silently pass or
    // fail the price-fit check.
    return {
      min: null,
      max: null,
      currencyCode: null,
      note: `Price band not computed: this category is priced in ${[...currencies].sort().join(' and ')}, and no exchange rate is configured to combine them.`,
    };
  }

  const sorted = [...prices].sort((a, b) => a - b);
  return {
    min: percentile(sorted, 0.25),
    max: percentile(sorted, 0.75),
    currencyCode: [...currencies][0] ?? null,
    note: null,
  };
}

/** Nearest-rank percentile over an ascending array. */
function percentile(sorted: readonly number[], fraction: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.round(fraction * (sorted.length - 1))),
  );
  return sorted[index] ?? null;
}

/* ===========================================================================
 * Geography
 * ======================================================================== */

/**
 * Where these sales actually went.
 *
 * Derived from the orders' own destinations rather than assumed to be the target
 * market. Shopify withholds `destination` unless protected customer data access is
 * approved, and in that case the honest answer is null - meaning "we do not know where
 * these sales went" - rather than quietly claiming they match the market being
 * researched.
 */
function geographyOf(orders: readonly OrderDto[]): SignalGeography {
  const counts = new Map<string, number>();

  for (const order of orders) {
    const country = normalise(order.destination?.countryCode ?? null);
    if (country === null) continue;
    const key = country.toUpperCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  let dominant: string | null = null;
  let best = 0;
  for (const [country, count] of counts) {
    if (count > best) {
      dominant = country;
      best = count;
    }
  }

  // Region stays null: Trademart does not aggregate the store's own sales by province,
  // so claiming a region would be inventing precision.
  return { countryCode: dominant, region: null };
}

/* ===========================================================================
 * The computation
 * ======================================================================== */

/** True for the financial statuses that mean money was given back. */
function isRefunded(order: OrderDto): boolean {
  return order.financialStatus === 'REFUNDED' || order.financialStatus === 'PARTIALLY_REFUNDED';
}

/** True when the merchant is holding the customer's money. */
function isPaid(order: OrderDto): boolean {
  return (
    order.financialStatus === 'PAID' ||
    order.financialStatus === 'PARTIALLY_PAID' ||
    order.financialStatus === 'PARTIALLY_REFUNDED'
  );
}

function rate(numerator: number, denominator: number): number | null {
  // Null, not 0, when there is nothing to divide by. A rate over no orders is not
  // zero percent - it is unmeasured, and the scorers must exclude it rather than
  // reward the store for a delay rate it never earned.
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 1000) / 10;
}

export function summariseStoreHistory(input: StoreHistoryInput): StoreHistorySummary {
  const notes: string[] = [];
  const sla = input.sla ?? DEFAULT_SHIPPING_SLA;

  const categoryProducts = categoryProductsOf(input.products, input.category);
  const categoryProductIds = new Set(
    categoryProducts.map((product) => product.shopifyProductId),
  );

  if (normalise(input.category) === null) {
    notes.push(
      'No category is set on this candidate, so no comparison against the store\u2019s existing catalogue was possible. Set a category to get a store-fit score.',
    );
    return {
      storePerformance: null,
      fulfillmentHistory: null,
      categoryOrderCount: 0,
      categoryProductCount: 0,
      notes,
    };
  }

  if (input.truncated) {
    notes.push(
      'Shopify had more orders than were read in one page, so the sample below is a LOWER BOUND on the store\u2019s history rather than a complete measurement.',
    );
  }

  // ---- category orders ----------------------------------------------------
  const categoryOrders = input.orders.filter((order) =>
    order.lineItems.some(
      (line) => line.shopifyProductId !== null && categoryProductIds.has(line.shopifyProductId),
    ),
  );

  let unitsSold = 0;
  for (const order of categoryOrders) {
    for (const line of order.lineItems) {
      if (line.shopifyProductId === null) continue;
      if (!categoryProductIds.has(line.shopifyProductId)) continue;
      unitsSold += line.quantity;
    }
  }

  const band = priceBandOf(categoryProducts);
  if (band.note !== null) notes.push(band.note);

  const geography = geographyOf(categoryOrders);
  if (geography.countryCode === null && categoryOrders.length > 0) {
    notes.push(
      'Shopify did not report a destination for these orders, so where the store\u2019s existing sales went is unknown. That lowers confidence rather than being assumed to match the target market.',
    );
  }

  // observedAt is the NEWEST order in the sample: that is when the most recent fact
  // behind these figures was true. Using `now` would make a six-month-old history
  // look current.
  const newestOrderAt = categoryOrders.reduce<string | null>((newest, order) => {
    if (newest === null) return order.createdAt;
    return order.createdAt > newest ? order.createdAt : newest;
  }, null);

  const refundedCount = categoryOrders.filter(isRefunded).length;

  const storePerformance: StorePerformanceSignal = {
    source: SOURCE,
    geography,
    observedAt: newestOrderAt,
    fetchedAt: input.now.toISOString(),
    // A real zero: the catalogue was read and contains nothing in this category. That
    // is a fact about the store, not a gap in the data, and scoreStoreFit treats it as
    // "this would open a new line" rather than as a defect.
    categoryProductCount: categoryProducts.length,
    categoryUnitsSold: categoryOrders.length === 0 ? null : unitsSold,
    typicalSellingPriceMin: band.min,
    typicalSellingPriceMax: band.max,
    priceCurrency: band.currencyCode,
    categoryRefundRatePercentage: rate(refundedCount, categoryOrders.length),
  };

  // ---- fulfillment outcomes ----------------------------------------------
  //
  // Only orders where fulfillment was actually EXPECTED: paid, and not cancelled. An
  // unpaid order the supplier was never asked to ship is not a late delivery, and a
  // cancelled one is not a failed one.
  const fulfillable = categoryOrders.filter(
    (order) => isPaid(order) && order.cancelledAt === null,
  );

  let delayed = 0;
  let dispatched = 0;
  let withoutTracking = 0;
  const deliveryDays: number[] = [];

  for (const order of fulfillable) {
    const shipment = resolveShipment({
      orderFulfillmentStatus: order.fulfillmentStatus,
      financialStatus: order.financialStatus,
      fulfillments: order.fulfillments,
      createdAt: order.createdAt,
      cancelledAt: order.cancelledAt,
      now: input.now,
      sla,
    });

    if (shipment.delayed) delayed += 1;

    if (isDispatched(shipment.normalizedStatus)) {
      dispatched += 1;
      if (!shipment.hasTracking) withoutTracking += 1;
    }

    if (shipment.deliveredAt !== null) {
      const days = daysBetween(order.createdAt, shipment.deliveredAt);
      if (days !== null) deliveryDays.push(days);
    }
  }

  const fulfillmentHistory: FulfillmentHistorySignal | null =
    fulfillable.length === 0
      ? null
      : {
          source: SOURCE,
          geography,
          observedAt: newestOrderAt,
          fetchedAt: input.now.toISOString(),
          sampleSize: fulfillable.length,
          delayRatePercentage: rate(delayed, fulfillable.length),
          // Refunds are measured over the orders where fulfillment was expected, so
          // the figure lines up with the delay rate's denominator.
          refundRatePercentage: rate(fulfillable.filter(isRefunded).length, fulfillable.length),
          // Over DISPATCHED orders only, and null when nothing has shipped yet.
          noTrackingRatePercentage: rate(withoutTracking, dispatched),
          averageDeliveryDays:
            deliveryDays.length === 0
              ? null
              : Math.round(
                  (deliveryDays.reduce((sum, days) => sum + days, 0) / deliveryDays.length) * 10,
                ) / 10,
        };

  if (fulfillable.length === 0 && categoryOrders.length > 0) {
    notes.push(
      'None of the orders in this category were both paid and uncancelled, so there is no delivery performance to measure yet.',
    );
  }

  return {
    storePerformance,
    fulfillmentHistory,
    categoryOrderCount: categoryOrders.length,
    categoryProductCount: categoryProducts.length,
    notes,
  };
}

/** Whole days between two ISO timestamps, or null when either is unusable. */
function daysBetween(from: string, to: string): number | null {
  const start = new Date(from).getTime();
  const end = new Date(to).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const days = (end - start) / (1000 * 60 * 60 * 24);
  // A negative duration means the timestamps disagree - a delivery before the order.
  // Discarded rather than clamped to 0, which would drag the average down with a fact
  // that cannot be true.
  return days < 0 ? null : Math.round(days * 10) / 10;
}

/* ===========================================================================
 * The provider
 * ======================================================================== */

/**
 * Wraps an already-computed summary as a provider.
 *
 * A factory rather than a module-level object because this provider needs Shopify data,
 * and fetching it inside a synchronous fetchX() is impossible. The service fetches,
 * calls summariseStoreHistory, and hands the result here - which also keeps every
 * provider's interface synchronous and this module free of the config singleton.
 */
export function createShopifyPerformanceProvider(
  summary: StoreHistorySummary,
): ResearchProvider {
  return {
    providerName: 'Shopify order history',
    source: 'SHOPIFY_PERFORMANCE',

    capabilities: {
      ...NO_RESEARCH_CAPABILITIES,
      storePerformance: true,
      fulfillmentHistory: true,
    },

    limitations: {
      demand:
        'The store\u2019s own orders show what it already sells, not what people are searching for. A product the store has never listed has no sales history to read.',
      trend:
        'A store\u2019s own sales trend reflects its own marketing as much as the market. It is not a substitute for market momentum.',
      competition: 'Shopify knows nothing about competitors.',
      seasonality:
        'A meaningful seasonal pattern needs several years of the store\u2019s own history in the same category, which most stores do not have.',
      supplierCommercials:
        'Shopify holds a "cost per item" per variant, which Trademart already reads for existing products - but a research candidate is not in the catalogue yet, so there is nothing to read.',
    },

    fetchStorePerformance(_request: ResearchRequest): StorePerformanceSignal | null {
      return summary.storePerformance;
    },

    fetchFulfillmentHistory(_request: ResearchRequest): FulfillmentHistorySignal | null {
      return summary.fulfillmentHistory;
    },
  };
}
