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
 * Re-exported from common/dataQuality, which is now the single definition.
 *
 * They moved there because product research needs exactly the same vocabulary: a
 * hand-typed supplier cost is no more observed in Research than in the order view.
 * Two definitions of "estimated" would drift, and a system that disagrees with
 * itself about whether a number is trustworthy is worse than one that never tracked
 * trust at all.
 *
 * Re-exported rather than replaced so no existing importer of these names changes.
 */
export type { DataConfidence, Figure } from '../common/dataQuality';

// Imported as well as re-exported: `export ... from` does not bring the names into
// this module's own scope, and OrderEconomics below is built out of them.
import type { DataConfidence, Figure } from '../common/dataQuality';

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
 * Order economics
 * ======================================================================== */

/**
 * What to fold into the commercial cost, and at what rate.
 *
 * Every inclusion is a switch because these are commercial modelling choices, not
 * facts. A store that funds ads from a separate budget should not have an
 * advertising allowance deducted from per-order contribution, and a store on a
 * flat-fee gateway should not have a percentage payment fee assumed.
 *
 * Excluding a component is NOT the same as it being unknown: an excluded component
 * contributes a KNOWN zero by policy, whereas an unknown one makes the total
 * unknown. Conflating those is how a dashboard reports profit on an order whose
 * supplier cost nobody entered.
 */
export interface DropshipCostConfig {
  includeSupplierShipping: boolean;
  includePaymentFees: boolean;
  includeShopifyFees: boolean;
  includeAdvertisingAllowance: boolean;
  /** Percentage of customer revenue. */
  paymentFeePercentage: number;
  shopifyFeePercentage: number;
  /**
   * Percentage of revenue set aside for acquisition. An ALLOWANCE, not a measured
   * spend - so any figure derived from it is ESTIMATED, never KNOWN.
   */
  advertisingAllowancePercentage: number;
  /** Flat per-order commercial cost (packaging, support, subscriptions). */
  otherCommercialCostPerOrder: number;

  /**
   * Alerting floors. An order below either is surfaced under Needs Attention.
   *
   * Both are needed because they catch different problems: a percentage floor misses
   * a thin absolute contribution on a cheap item, and an absolute floor misses a
   * poor percentage on an expensive one.
   *
   * These are ALERTING thresholds only - nothing here changes a price. The
   * target-margin and markup pricing rules are a separate, later concern.
   */
  minimumMarginPercentage: number;
  minimumProfitAmount: number;
}

export const DEFAULT_DROPSHIP_COST_CONFIG: Readonly<DropshipCostConfig> = Object.freeze({
  includeSupplierShipping: true,
  includePaymentFees: true,
  includeShopifyFees: true,
  // Off by default: an advertising allowance is a real cost for most dropshipping
  // stores, but assuming one silently reduces every reported margin. The operator
  // opts in once they know their number.
  includeAdvertisingAllowance: false,
  // A common card-processing rate. Deliberately not presented as measured.
  paymentFeePercentage: 2.9,
  shopifyFeePercentage: 0,
  advertisingAllowancePercentage: 15,
  otherCommercialCostPerOrder: 0,
  // A commonly-cited dropshipping floor. Deliberately not zero: an order at 2%
  // contribution is technically profitable and commercially not worth fulfilling.
  minimumMarginPercentage: 15,
  // 0 disables the absolute floor, because any default would be wrong for some
  // store's currency and price points.
  minimumProfitAmount: 0,
});

/**
 * One order's money, with every figure carrying its own confidence.
 *
 * THE TWO COST TOTALS ARE DELIBERATELY SEPARATE (C6):
 *
 *   landedCost      what it costs to get the goods to the customer -
 *                   supplier product + supplier shipping + fulfillment surcharge.
 *                   This is the money OWED TO THE SUPPLIER, and therefore the
 *                   basis of capital exposure.
 *   commercialCost  landed cost + payment fees + platform fees + advertising
 *                   allowance + other configured costs. The basis of CONTRIBUTION.
 *
 * Calling both "supplier cost" is how a margin ends up looking healthy while the
 * order loses money, and how supplier exposure ends up overstated by fees the
 * supplier never charges.
 */
export interface OrderEconomics {
  currencyCode: string | null;
  /** What the customer actually paid, per Shopify. */
  customerRevenue: Figure;
  supplierProductCost: Figure;
  supplierShippingCost: Figure;
  supplierFulfillmentCost: Figure;
  paymentFees: Figure;
  shopifyFees: Figure;
  advertisingAllowance: Figure;
  otherCommercialCosts: Figure;
  landedCost: Figure;
  commercialCost: Figure;
  estimatedProfit: Figure;
  /** Percentage of revenue. Null when it cannot be computed. */
  estimatedMargin: { value: number | null; confidence: DataConfidence };
  /** Worst confidence among the figures a decision would rest on. */
  confidence: DataConfidence;
  /** Which inputs are missing, so "unknown" is explainable rather than bare. */
  missingInputs: string[];
  warnings: string[];
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
