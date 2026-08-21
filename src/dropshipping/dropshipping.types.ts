/**
 * Dropshipping view types.
 *
 * A NORMALISED VIEW OVER SHOPIFY, NOT A SECOND COPY OF IT
 * -------------------------------------------------------
 * Shopify is the system of record for orders, payments and fulfillment. Nothing
 * here duplicates an order; these shapes are what Trademart DERIVES from one, so
 * the operator can answer questions Shopify's admin does not: what did this cost
 * me, what will I make, is it late, and how much supplier cash am I committed to.
 *
 * Deliberately dependency-free (type-only imports) so the decision logic built on
 * it stays unit-testable without a configured Shopify store or a database.
 */

import type {
  FulfillmentDisplayStatus,
  Money,
  OrderFinancialStatus,
  OrderFulfillmentStatus,
  SupplierClassification,
} from '../shopify/shopify.types';

/* ===========================================================================
 * Data confidence
 * ======================================================================== */

/**
 * How much a number can be trusted. Applied per figure, not per order.
 *
 *   KNOWN      observed. Shopify told us, or an operator recorded it.
 *   ESTIMATED  derived from a rule or a configured percentage, not observed.
 *   UNKNOWN    genuinely absent. NEVER rendered as 0, and never silently
 *              excluded from a total without saying so.
 *
 * The distinction exists because "supplier cost: 0" and "supplier cost: unknown"
 * lead to opposite decisions, and a dashboard that cannot tell them apart will
 * confidently report a profit on an order whose cost nobody has entered.
 */
export type DataConfidence = 'KNOWN' | 'ESTIMATED' | 'UNKNOWN';

/** A monetary figure that always states how much it can be trusted. */
export interface Figure {
  /** Null if and only if confidence is UNKNOWN. */
  amount: number | null;
  currencyCode: string | null;
  confidence: DataConfidence;
  /** Where the number came from, in plain language. Always populated. */
  source: string;
}

/* ===========================================================================
 * Fulfillment progress
 * ======================================================================== */

/**
 * Where an order is, normalised across Shopify's several overlapping status
 * fields.
 *
 * ORDERED BY PROGRESS. The numeric rank in STATE_RANK below is what lets an order
 * with several fulfillments report the FURTHEST one, which is what an operator
 * means by "where is this order".
 *
 * A note on DELAYED, which the product brief lists alongside these:
 * lateness is ORTHOGONAL to progress. An order can be in transit AND late, and
 * the dashboard counts "In transit" and "Delayed" separately - so collapsing them
 * into one field would either double-count or throw away the parcel's actual
 * position. `normalizedStatus` therefore reports PROGRESS and never returns
 * DELAYED; `delayed` + `delaySignals` report lateness. DELAYED remains part of
 * this union so `effectiveStatus()` can return it for a single-badge display.
 */
export type DropshipFulfillmentState =
  /** Order exists; payment not yet captured, nothing expected of the supplier. */
  | 'ORDER_RECEIVED'
  /** Paid, but the supplier has not started. This is where money is at risk. */
  | 'AWAITING_SUPPLIER'
  /** The supplier accepted the job and is working on it. */
  | 'SUPPLIER_PROCESSING'
  /** Marked fulfilled, but no carrier movement observed yet. */
  | 'FULFILLED'
  /** A shipping label exists. Nothing has physically moved. */
  | 'LABEL_CREATED'
  /** The carrier has the parcel. */
  | 'CARRIER_PICKED_UP'
  | 'IN_TRANSIT'
  | 'OUT_FOR_DELIVERY'
  | 'DELIVERED'
  /** Lateness, not progress. Only ever returned by effectiveStatus(). */
  | 'DELAYED'
  /** A delivery was attempted and did not succeed. */
  | 'DELIVERY_FAILED'
  | 'CANCELLED'
  /** Shopify gave us nothing usable. NEVER assume this means "processing". */
  | 'UNKNOWN';

/**
 * Progress ordering. Higher wins when an order has several fulfillments.
 *
 * DELIVERY_FAILED and CANCELLED sit ABOVE the in-flight states deliberately: if
 * any parcel of an order failed or was cancelled, that is the thing the operator
 * needs to see, not the fact that another parcel is still moving.
 *
 * DELAYED is absent because it is not a progress state (see the type above).
 */
export const STATE_RANK: Readonly<Record<Exclude<DropshipFulfillmentState, 'DELAYED'>, number>> =
  Object.freeze({
    UNKNOWN: 0,
    ORDER_RECEIVED: 1,
    AWAITING_SUPPLIER: 2,
    SUPPLIER_PROCESSING: 3,
    FULFILLED: 4,
    LABEL_CREATED: 5,
    CARRIER_PICKED_UP: 6,
    IN_TRANSIT: 7,
    OUT_FOR_DELIVERY: 8,
    DELIVERED: 9,
    DELIVERY_FAILED: 10,
    CANCELLED: 11,
  });

export interface ShipmentTracking {
  company: string | null;
  number: string | null;
  url: string | null;
}

export interface ShipmentEvent {
  status: string | null;
  happenedAt: string | null;
  message: string | null;
}

export interface DropshipShipment {
  /** Progress. Never DELAYED - see DropshipFulfillmentState. */
  normalizedStatus: DropshipFulfillmentState;
  /**
   * Shopify's own words, ALWAYS retained. When a normalisation looks wrong, this
   * is what makes it debuggable instead of a mystery.
   */
  rawShopifyStatus: {
    orderFulfillmentStatus: OrderFulfillmentStatus | null;
    fulfillmentDisplayStatuses: (FulfillmentDisplayStatus | null)[];
  };
  carrier: string | null;
  trackingNumbers: string[];
  trackingUrls: string[];
  tracking: ShipmentTracking[];
  estimatedDeliveryAt: string | null;
  inTransitAt: string | null;
  deliveredAt: string | null;
  events: ShipmentEvent[];
  /** True when the order is late. Orthogonal to normalizedStatus. */
  delayed: boolean;
  /** Why it is considered late. Empty when not delayed. */
  delaySignals: string[];
  /** True when nothing is trackable yet. Not the same as "not shipped". */
  hasTracking: boolean;
}

/* ===========================================================================
 * Shipping SLA (C13)
 * ======================================================================== */

/**
 * Thresholds that turn elapsed time into a delay.
 *
 * Configurable because they are commercial judgements, not facts: a store selling
 * from a domestic warehouse and one shipping from overseas have very different
 * ideas of "late", and a threshold that cries wolf gets ignored.
 */
export interface ShippingSla {
  /** Paid but not yet accepted by the supplier for longer than this. */
  processingWarningHours: number;
  /** Fulfilled but still no tracking number after this long. */
  trackingWarningHours: number;
  /** Grace period past Shopify's own ETA before calling it late. */
  deliveryDelayDays: number;
}

export const DEFAULT_SHIPPING_SLA: Readonly<ShippingSla> = Object.freeze({
  processingWarningHours: 24,
  trackingWarningHours: 48,
  // Zero: past the carrier's OWN estimate already is late. A grace period here
  // would be Trademart overriding the carrier's promise to the customer.
  deliveryDelayDays: 0,
});
