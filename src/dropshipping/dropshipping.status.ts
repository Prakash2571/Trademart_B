/**
 * Normalises Shopify's several overlapping fulfillment signals into one answer to
 * "where is this order?".
 *
 * WHY NORMALISATION IS NEEDED AT ALL
 * ----------------------------------
 * Shopify reports fulfillment three different ways and none is sufficient alone:
 *
 *   order.displayFulfillmentStatus   UNFULFILLED / IN_PROGRESS / FULFILLED ...
 *                                    Order-level. Says nothing about the parcel.
 *   fulfillment.status               OPEN / SUCCESS / CANCELLED / ERROR.
 *                                    Whether the fulfillment RECORD is healthy.
 *   fulfillment.displayStatus        IN_TRANSIT / OUT_FOR_DELIVERY / DELIVERED ...
 *                                    Where the parcel is. Often null.
 *
 * An operator asking "has it shipped?" needs all three collapsed, with the raw
 * values kept so a surprising answer can be explained rather than argued with.
 *
 * PURE, AND THE CLOCK IS INJECTED
 * -------------------------------
 * No Shopify calls, no config singleton, no `Date.now()` inside. `now` is a
 * parameter, because a delay calculation that reads the clock internally can only
 * be tested by waiting.
 */

import {
  DEFAULT_SHIPPING_SLA,
  STATE_RANK,
  type DropshipFulfillmentState,
  type DropshipShipment,
  type ShipmentTracking,
  type ShippingSla,
} from './dropshipping.types';
import type {
  FulfillmentDisplayStatus,
  FulfillmentDto,
  OrderFinancialStatus,
  OrderFulfillmentStatus,
} from '../shopify/shopify.types';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * Shopify's per-parcel display status to our progress state.
 *
 * The non-obvious ones:
 *
 *   SUBMITTED / CONFIRMED   the supplier has the job but nothing is packed yet.
 *                           SUPPLIER_PROCESSING, not FULFILLED - a confirmation is
 *                           not a shipment.
 *   LABEL_PRINTED /
 *   LABEL_PURCHASED         a label exists; nothing has physically moved. Treating
 *                           this as "shipped" is the single most common way a
 *                           dropshipping dashboard lies to a customer.
 *   READY_FOR_PICKUP        local collection: the parcel has reached its final
 *                           point and awaits the customer, which is the same
 *                           position in the journey as OUT_FOR_DELIVERY.
 *   ATTEMPTED_DELIVERY /
 *   NOT_DELIVERED /
 *   FAILURE                 DELIVERY_FAILED. Someone has to act.
 *   LABEL_VOIDED            the label was cancelled, so this parcel is not coming.
 */
const DISPLAY_STATUS_MAP: Readonly<Record<string, DropshipFulfillmentState>> = Object.freeze({
  SUBMITTED: 'SUPPLIER_PROCESSING',
  CONFIRMED: 'SUPPLIER_PROCESSING',
  FULFILLED: 'FULFILLED',
  MARKED_AS_FULFILLED: 'FULFILLED',
  LABEL_PRINTED: 'LABEL_CREATED',
  LABEL_PURCHASED: 'LABEL_CREATED',
  PICKED_UP: 'CARRIER_PICKED_UP',
  IN_TRANSIT: 'IN_TRANSIT',
  OUT_FOR_DELIVERY: 'OUT_FOR_DELIVERY',
  READY_FOR_PICKUP: 'OUT_FOR_DELIVERY',
  DELIVERED: 'DELIVERED',
  ATTEMPTED_DELIVERY: 'DELIVERY_FAILED',
  NOT_DELIVERED: 'DELIVERY_FAILED',
  FAILURE: 'DELIVERY_FAILED',
  CANCELED: 'CANCELLED',
  LABEL_VOIDED: 'CANCELLED',
});

/**
 * Order-level fulfillment status, used only when there are no fulfillments to read.
 *
 * `paid` matters here and nowhere else: an unpaid order asks nothing of the
 * supplier yet (ORDER_RECEIVED), whereas a PAID order with no supplier movement is
 * the state where the merchant's money is committed and nothing is happening -
 * AWAITING_SUPPLIER, which is what the dashboard needs to surface.
 */
function fromOrderStatus(
  status: OrderFulfillmentStatus | null,
  paid: boolean,
): { state: DropshipFulfillmentState; note: string | null } {
  switch (status) {
    case 'FULFILLED':
      // Fulfilled with no fulfillment record attached: unusual, but the order-level
      // field is still evidence, so report progress rather than UNKNOWN.
      return { state: 'FULFILLED', note: null };
    case 'IN_PROGRESS':
    case 'PARTIALLY_FULFILLED':
      return { state: 'SUPPLIER_PROCESSING', note: null };
    case 'PENDING_FULFILLMENT':
    case 'SCHEDULED':
      return { state: 'AWAITING_SUPPLIER', note: null };
    case 'ON_HOLD':
      return {
        state: 'AWAITING_SUPPLIER',
        note: 'Shopify reports this order ON_HOLD, so it will not progress until the hold is released.',
      };
    case 'REQUEST_DECLINED':
      // The fulfillment service REFUSED the job. Not DELIVERY_FAILED - nothing was
      // ever dispatched, so claiming a failed delivery would be wrong. It is
      // reported as awaiting the supplier, with a note, because the honest answer to
      // "where is it" is "nowhere, and someone must intervene".
      return {
        state: 'AWAITING_SUPPLIER',
        note: 'The fulfillment service DECLINED this request. It will not ship without operator action.',
      };
    case 'RESTOCKED':
      return {
        state: 'CANCELLED',
        note: 'Items were restocked, which means the order was cancelled or refunded.',
      };
    case 'OPEN':
    case 'UNFULFILLED':
      return paid
        ? { state: 'AWAITING_SUPPLIER', note: null }
        : { state: 'ORDER_RECEIVED', note: null };
    default:
      // Includes null and any status Shopify adds later. UNKNOWN is the honest
      // answer; guessing "processing" would invent progress that may not exist.
      return { state: 'UNKNOWN', note: null };
  }
}

/** Maps one fulfillment to a progress state, falling back through its fields. */
function fromFulfillment(fulfillment: FulfillmentDto): DropshipFulfillmentState {
  const display = fulfillment.displayStatus;
  if (display !== null && display !== undefined) {
    const mapped = DISPLAY_STATUS_MAP[display];
    if (mapped !== undefined) return mapped;
  }

  // Observed timestamps outrank the coarse `status` field: they are facts about the
  // parcel, whereas `status` describes the record.
  if (fulfillment.deliveredAt !== null) return 'DELIVERED';
  if (fulfillment.inTransitAt !== null) return 'IN_TRANSIT';

  switch (fulfillment.status) {
    case 'CANCELLED':
      return 'CANCELLED';
    case 'ERROR':
    case 'FAILURE':
      return 'DELIVERY_FAILED';
    case 'SUCCESS':
      // A successful fulfillment RECORD with no display status and no movement
      // timestamps. It is fulfilled; whether the carrier has it is unknown, so
      // FULFILLED (not IN_TRANSIT) is the furthest defensible claim.
      return 'FULFILLED';
    case 'OPEN':
    case 'PENDING':
      return 'SUPPLIER_PROCESSING';
    default:
      return 'UNKNOWN';
  }
}

function rankOf(state: DropshipFulfillmentState): number {
  if (state === 'DELAYED') return -1; // Never a progress state; see the type.
  return STATE_RANK[state];
}

function isTerminal(state: DropshipFulfillmentState): boolean {
  return state === 'DELIVERED' || state === 'CANCELLED' || state === 'DELIVERY_FAILED';
}

export interface ResolveShipmentInput {
  orderFulfillmentStatus: OrderFulfillmentStatus | null;
  financialStatus: OrderFinancialStatus | null;
  fulfillments: readonly FulfillmentDto[];
  /** Order creation time, for the processing-SLA clock. */
  createdAt: string;
  cancelledAt?: string | null;
  now: Date;
  sla?: ShippingSla;
}

/** True for the financial statuses that mean the merchant is holding the money. */
function isPaid(status: OrderFinancialStatus | null): boolean {
  return status === 'PAID' || status === 'PARTIALLY_PAID' || status === 'PARTIALLY_REFUNDED';
}

function parseTime(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

/**
 * Collapses an order's fulfillment signals into one shipment view.
 *
 * The resulting `normalizedStatus` is the FURTHEST-progressed parcel, except that
 * a failed or cancelled parcel outranks in-flight ones - if part of an order went
 * wrong, that is what needs attention, not the part still moving.
 */
export function resolveShipment(input: ResolveShipmentInput): DropshipShipment {
  const sla = input.sla ?? DEFAULT_SHIPPING_SLA;
  const paid = isPaid(input.financialStatus);
  const notes: string[] = [];

  // A cancelled order is cancelled regardless of what any parcel says.
  const cancelled = parseTime(input.cancelledAt) !== null;

  let state: DropshipFulfillmentState;
  if (cancelled) {
    state = 'CANCELLED';
  } else if (input.fulfillments.length === 0) {
    const derived = fromOrderStatus(input.orderFulfillmentStatus, paid);
    state = derived.state;
    if (derived.note !== null) notes.push(derived.note);
  } else {
    state = 'UNKNOWN';
    for (const fulfillment of input.fulfillments) {
      const candidate = fromFulfillment(fulfillment);
      if (rankOf(candidate) > rankOf(state)) state = candidate;
    }
    // A partially-fulfilled order has parcels moving AND items not yet sent. The
    // parcel state alone would imply the whole order is on its way.
    if (
      input.orderFulfillmentStatus === 'PARTIALLY_FULFILLED' &&
      !isTerminal(state)
    ) {
      notes.push(
        'Only part of this order has been fulfilled; the remaining items are still with the supplier.',
      );
    }
  }

  // ---- tracking -----------------------------------------------------------
  const tracking: ShipmentTracking[] = input.fulfillments.flatMap(
    (fulfillment) => fulfillment.tracking,
  );
  const trackingNumbers = tracking
    .map((entry) => entry.number)
    .filter((value): value is string => value !== null);
  const trackingUrls = tracking
    .map((entry) => entry.url)
    .filter((value): value is string => value !== null);
  const carrier =
    tracking.find((entry) => entry.company !== null)?.company ?? null;

  // ---- observed timestamps ------------------------------------------------
  // Earliest ETA and earliest in-transit across parcels; latest delivery, because
  // an order is only fully delivered once its LAST parcel arrives.
  const etas = input.fulfillments
    .map((f) => parseTime(f.estimatedDeliveryAt))
    .filter((value): value is number => value !== null);
  const inTransits = input.fulfillments
    .map((f) => parseTime(f.inTransitAt))
    .filter((value): value is number => value !== null);
  const delivereds = input.fulfillments
    .map((f) => parseTime(f.deliveredAt))
    .filter((value): value is number => value !== null);

  const estimatedDeliveryAt = etas.length > 0 ? new Date(Math.min(...etas)).toISOString() : null;
  const inTransitAt =
    inTransits.length > 0 ? new Date(Math.min(...inTransits)).toISOString() : null;
  const allDelivered =
    input.fulfillments.length > 0 && delivereds.length === input.fulfillments.length;
  const deliveredAt =
    allDelivered && delivereds.length > 0
      ? new Date(Math.max(...delivereds)).toISOString()
      : null;

  // ---- delay (orthogonal to progress) -------------------------------------
  const delaySignals: string[] = [...notes];
  const nowMs = input.now.getTime();

  if (!isTerminal(state) && state !== 'ORDER_RECEIVED') {
    // Past the carrier's own promise.
    const graceMs = sla.deliveryDelayDays * DAY_MS;
    const etaMs = parseTime(estimatedDeliveryAt);
    if (etaMs !== null && nowMs > etaMs + graceMs) {
      const daysLate = Math.floor((nowMs - etaMs) / DAY_MS);
      delaySignals.push(
        daysLate >= 1
          ? `Past the carrier's estimated delivery date by ${daysLate} day(s).`
          : "Past the carrier's estimated delivery date.",
      );
    }

    // Paid, but the supplier has not started.
    const createdMs = parseTime(input.createdAt);
    if (
      createdMs !== null &&
      paid &&
      (state === 'AWAITING_SUPPLIER' || state === 'SUPPLIER_PROCESSING') &&
      nowMs - createdMs > sla.processingWarningHours * HOUR_MS
    ) {
      const hours = Math.floor((nowMs - createdMs) / HOUR_MS);
      delaySignals.push(
        `Paid ${hours}h ago and the supplier has not dispatched it (threshold ${sla.processingWarningHours}h).`,
      );
    }

    // Fulfilled, but nothing to track. A customer cannot see anything at all here,
    // which is the most common source of "where is my order?" contacts.
    const oldestFulfilment = input.fulfillments
      .map((f) => parseTime(f.createdAt))
      .filter((value): value is number => value !== null)
      .sort((a, b) => a - b)[0];
    if (
      trackingNumbers.length === 0 &&
      rankOf(state) >= STATE_RANK.FULFILLED &&
      oldestFulfilment !== undefined &&
      nowMs - oldestFulfilment > sla.trackingWarningHours * HOUR_MS
    ) {
      const hours = Math.floor((nowMs - oldestFulfilment) / HOUR_MS);
      delaySignals.push(
        `Marked fulfilled ${hours}h ago with no tracking number (threshold ${sla.trackingWarningHours}h).`,
      );
    }
  }

  return {
    normalizedStatus: state,
    rawShopifyStatus: {
      orderFulfillmentStatus: input.orderFulfillmentStatus,
      fulfillmentDisplayStatuses: input.fulfillments.map(
        (f) => (f.displayStatus ?? null) as FulfillmentDisplayStatus | null,
      ),
    },
    carrier,
    trackingNumbers,
    trackingUrls,
    tracking,
    estimatedDeliveryAt,
    inTransitAt,
    deliveredAt,
    events: input.fulfillments.flatMap((fulfillment) =>
      fulfillment.events.map((event) => ({
        status: event.status,
        happenedAt: event.happenedAt,
        message: event.message,
      })),
    ),
    delayed: delaySignals.length > 0,
    delaySignals,
    hasTracking: trackingNumbers.length > 0,
  };
}

/**
 * One value for a single-badge display.
 *
 * Returns DELAYED when the order is late, otherwise the progress state. Callers
 * that show both (the order detail timeline) should read `normalizedStatus` and
 * `delayed` separately - this helper exists so a compact list does not have to
 * re-implement the precedence and get it subtly different.
 */
export function effectiveStatus(shipment: DropshipShipment): DropshipFulfillmentState {
  return shipment.delayed ? 'DELAYED' : shipment.normalizedStatus;
}

/** Human-readable label for a state. Kept beside the states so it cannot drift. */
export function describeState(state: DropshipFulfillmentState): string {
  switch (state) {
    case 'ORDER_RECEIVED':
      return 'Order received';
    case 'AWAITING_SUPPLIER':
      return 'Awaiting supplier';
    case 'SUPPLIER_PROCESSING':
      return 'Supplier processing';
    case 'FULFILLED':
      return 'Fulfilled';
    case 'LABEL_CREATED':
      return 'Label created';
    case 'CARRIER_PICKED_UP':
      return 'Carrier picked up';
    case 'IN_TRANSIT':
      return 'In transit';
    case 'OUT_FOR_DELIVERY':
      return 'Out for delivery';
    case 'DELIVERED':
      return 'Delivered';
    case 'DELAYED':
      return 'Delayed';
    case 'DELIVERY_FAILED':
      return 'Delivery failed';
    case 'CANCELLED':
      return 'Cancelled';
    default:
      return 'Unknown';
  }
}
