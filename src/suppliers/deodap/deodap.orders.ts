/**
 * DeoDap orders - pure.
 *
 * TWO WAYS AN ORDER REACHES DEODAP
 * --------------------------------
 *   DEODAP_APP  The Tradelle model. DeoDap's own Shopify app imported the product, and
 *               it picks the Shopify order up by itself. Trademart cannot see inside
 *               the app, so it watches the one thing it can: the Shopify order. When
 *               the app accepts, fulfils and adds tracking, Shopify says so, and that
 *               is what this page shows. An order that does not move within the
 *               dropshipping processing SLA is flagged, because that is exactly what an
 *               order the app never received looks like from here.
 *   MANUAL      The operator places the order with DeoDap and records it here: the
 *               DeoDap order number, then tracking once DeoDap ships.
 *
 * The route is decided PER LINE. With the app in use, a product that Trademart's own
 * CSV import created (it is in the import ledger) is still MANUAL: DeoDap's app did not
 * import it, so it has no reason to know the product exists.
 *
 * There is no DeoDap order API to call (deodap.api.ts). Nothing here stores customer
 * data: the list shows the destination region Shopify already gives the order view,
 * and the operator reads the full address in Shopify when placing an order.
 */

import { AppError } from '../../common/errors';
import { multiplyMoney, sumMoney } from '../../common/money';
import { resolveShipment } from '../../dropshipping/dropshipping.status';
import type {
  DropshipFulfillmentState,
  DropshipShipment,
  ShippingSla,
} from '../../dropshipping/dropshipping.types';
import type { OrderDto } from '../../shopify/shopify.types';
import type { ManualCost } from '../cost';
import type { DeodapOrderFlow } from './deodap.settings';

export type DeodapOrderStatus =
  /** Not yet placed with DeoDap. */
  | 'NOT_PLACED'
  /** Placed with DeoDap; waiting for dispatch. */
  | 'PLACED'
  /** DeoDap has dispatched it. */
  | 'SHIPPED'
  | 'DELIVERED'
  | 'CANCELLED'
  /** Something needs a person: out of stock at DeoDap, returned, wrong item. */
  | 'PROBLEM';

export const DEODAP_ORDER_STATUSES: readonly DeodapOrderStatus[] = Object.freeze([
  'NOT_PLACED',
  'PLACED',
  'SHIPPED',
  'DELIVERED',
  'CANCELLED',
  'PROBLEM',
]);

/** Who sends a line to DeoDap. */
export type DeodapLineRoute =
  /** DeoDap's Shopify app picks the order up from Shopify. */
  | 'DEODAP_APP'
  /** The operator places it with DeoDap and records it here. */
  | 'MANUAL';

/** An order's route: MIXED when some lines go each way. */
export type DeodapOrderRoute = DeodapLineRoute | 'MIXED';

export interface DeodapLineMatch {
  shopifyLineItemId: string;
  shopifyVariantId: string | null;
  shopifyProductId: string | null;
  title: string;
  sku: string | null;
  quantity: number;
  /** The DeoDap reference from the import ledger, when Trademart imported the product. */
  supplierRef: string | null;
  /** True when Trademart's CSV import created the product. */
  importedByTrademart: boolean;
  route: DeodapLineRoute;
  /** Why this line counts as a DeoDap line. */
  evidence: string[];
}

export interface DeodapOrderLine extends DeodapLineMatch {
  /** Recorded DeoDap cost for one unit. Null when none is recorded - never 0. */
  unitCost: number | null;
  unitShippingCost: number | null;
  currencyCode: string | null;
}

/** What has been recorded about placing the order with DeoDap. */
export interface ForwardingRecord {
  status: DeodapOrderStatus;
  supplierOrderId: string | null;
  trackingCompany: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  note: string | null;
  placedVia: 'MANUAL' | 'API';
  placedAt: string | null;
  shippedAt: string | null;
  deliveredAt: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

/** What an order view is judged against. Injected, so the rules are testable. */
export interface DeodapOrderContext {
  flow: DeodapOrderFlow;
  /** The dropshipping SLA, so this page and the dropshipping dashboard agree on "late". */
  sla: ShippingSla;
  now: Date;
}

export interface DeodapOrderView {
  shopifyOrderId: string;
  name: string;
  createdAt: string;
  financialStatus: string | null;
  fulfillmentStatus: string | null;
  cancelledAt: string | null;
  destination: OrderDto['destination'];
  lines: DeodapOrderLine[];
  /** Lines from other suppliers in the same order. */
  otherLineCount: number;
  /** Who sends this order to DeoDap. */
  route: DeodapOrderRoute;
  /** What DeoDap will charge for these lines, from the recorded costs. */
  supplierCost: {
    total: number | null;
    currencyCode: string | null;
    /** False when some line has no recorded cost, so the total is a minimum. */
    complete: boolean;
  };
  /**
   * Where the order is, as Shopify reports it. The same normalisation the dropshipping
   * pages use, so the two can never disagree about an order.
   */
  shipment: DropshipShipment;
  forwarding: ForwardingRecord | null;
  /** What needs a person, in words. Empty when nothing does. */
  attention: string[];
  needsAction: boolean;
}

/**
 * The lines of an order that come from DeoDap, and who sends each one.
 *
 * A line counts when its product is identified as DeoDap (vendor, tag, fulfillment
 * service, SKU prefix) OR its variant is one Trademart imported from DeoDap. The second
 * matters for a store that changed the vendor to its own brand and removed the tag.
 */
export function extractDeodapLines(
  order: OrderDto,
  refsByVariant: ReadonlyMap<string, string>,
  flow: DeodapOrderFlow,
): { lines: DeodapLineMatch[]; otherLineCount: number } {
  const lines: DeodapLineMatch[] = [];
  let otherLineCount = 0;
  for (const line of order.lineItems) {
    const ref =
      line.shopifyVariantId === null ? undefined : refsByVariant.get(line.shopifyVariantId);
    if (line.supplier !== 'DEODAP' && ref === undefined) {
      otherLineCount += 1;
      continue;
    }
    const importedByTrademart = ref !== undefined;
    const evidence = line.supplier === 'DEODAP' ? [...line.supplierEvidence] : [];
    if (importedByTrademart) evidence.push('imported from DeoDap by Trademart');
    lines.push({
      shopifyLineItemId: line.shopifyLineItemId,
      shopifyVariantId: line.shopifyVariantId,
      shopifyProductId: line.shopifyProductId,
      title: line.title,
      sku: line.sku,
      quantity: line.quantity,
      supplierRef: ref ?? null,
      importedByTrademart,
      route: flow === 'SHOPIFY_APP' && !importedByTrademart ? 'DEODAP_APP' : 'MANUAL',
      evidence,
    });
  }
  return { lines, otherLineCount };
}

export function orderRoute(lines: readonly DeodapLineMatch[]): DeodapOrderRoute {
  const routes = new Set(lines.map((line) => line.route));
  if (routes.size > 1) return 'MIXED';
  return routes.has('DEODAP_APP') ? 'DEODAP_APP' : 'MANUAL';
}

const PAID: readonly string[] = ['PAID', 'PARTIALLY_PAID', 'PARTIALLY_REFUNDED'];
/** Nothing is owed to the customer any more, so nothing should ship. */
const PAYMENT_CLOSED: readonly string[] = ['REFUNDED', 'VOIDED', 'EXPIRED'];
const NOT_DISPATCHED: readonly DropshipFulfillmentState[] = [
  'ORDER_RECEIVED',
  'AWAITING_SUPPLIER',
  'SUPPLIER_PROCESSING',
];

function hoursSince(iso: string, now: Date): number | null {
  const time = new Date(iso).getTime();
  if (!Number.isFinite(time)) return null;
  return Math.floor((now.getTime() - time) / 3_600_000);
}

function items(count: number): string {
  return count === 1 ? '1 item' : `${count} items`;
}

function sameTracking(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * What about an order needs a person, as sentences an operator can act on.
 *
 * Deliberately a list of reasons rather than a flag: "place it yourself", "the app has
 * not dispatched it" and "fulfil it in Shopify" are three different jobs.
 */
export function assessDeodapOrder(
  order: OrderDto,
  lines: readonly DeodapLineMatch[],
  forwarding: ForwardingRecord | null,
  shipment: DropshipShipment,
  context: DeodapOrderContext,
): string[] {
  const attention: string[] = [];
  const recorded = forwarding?.status ?? null;

  if (recorded === 'PROBLEM') {
    attention.push(
      forwarding?.note == null
        ? 'You recorded a problem with DeoDap for this order.'
        : `You recorded a problem with DeoDap: ${forwarding.note}`,
    );
  }

  // Cancelled or refunded in Shopify: nothing should ship, so nothing else applies.
  if (order.cancelledAt !== null || PAYMENT_CLOSED.includes(order.financialStatus ?? '')) {
    return attention;
  }

  if (recorded === 'CANCELLED') {
    attention.push(
      'Recorded as cancelled with DeoDap, but the Shopify order is still open. Cancel or refund it in Shopify so the customer is not left waiting.',
    );
    return attention;
  }

  const fulfilled = order.fulfillmentStatus === 'FULFILLED';
  const recordedPlaced = recorded === 'PLACED' || recorded === 'SHIPPED' || recorded === 'DELIVERED';
  const recordedShipped = recorded === 'SHIPPED' || recorded === 'DELIVERED';
  const manualLines = lines.filter((line) => line.route === 'MANUAL');

  let notPlaced = false;
  if (manualLines.length > 0 && !recordedPlaced && !fulfilled) {
    notPlaced = true;
    attention.push(
      context.flow === 'SHOPIFY_APP'
        ? `${items(manualLines.length)} came from Trademart's CSV import, which DeoDap's Shopify app does not know about. Place ${manualLines.length === 1 ? 'it' : 'them'} with DeoDap yourself, then record the DeoDap order number.`
        : 'Not placed with DeoDap yet. Place it with DeoDap, then record the DeoDap order number.',
    );
  }

  // Tracking the operator recorded that Shopify does not have: the customer cannot see
  // it. Shopify's own view is stale by the operator's record here, so its delay signals
  // ("the supplier has not dispatched it") would mislead and are left out.
  const recordedTracking = forwarding?.trackingNumber ?? null;
  const trackingMissingFromShopify =
    recordedShipped &&
    recordedTracking !== null &&
    !shipment.trackingNumbers.some((number) => sameTracking(number, recordedTracking));
  if (trackingMissingFromShopify) {
    attention.push(
      'Tracking is recorded here but not on the Shopify order, so the customer has not been told. Fulfil the order in Shopify with this tracking number.',
    );
    return attention;
  }

  // Shopify's view of progress, with the same delay rules as the dropshipping dashboard.
  attention.push(...shipment.delaySignals);

  // The dashboard's processing SLA only applies to paid orders. A pending payment is
  // usually cash on delivery here, and DeoDap ships those too - so an unpaid order
  // that has not moved is checked as well.
  const hours = hoursSince(order.createdAt, context.now);
  if (
    !notPlaced &&
    !PAID.includes(order.financialStatus ?? '') &&
    NOT_DISPATCHED.includes(shipment.normalizedStatus) &&
    hours !== null &&
    hours > context.sla.processingWarningHours
  ) {
    const check =
      orderRoute(lines) === 'MANUAL'
        ? 'Check with DeoDap.'
        : "If DeoDap should ship it, check that DeoDap's app received it.";
    attention.push(
      `Payment is pending (for example cash on delivery) and nothing has been dispatched ${hours}h after the order was placed (threshold ${context.sla.processingWarningHours}h). ${check}`,
    );
  }

  return attention;
}

export function buildDeodapOrderView(
  order: OrderDto,
  match: { lines: DeodapLineMatch[]; otherLineCount: number },
  forwarding: ForwardingRecord | null,
  costs: ReadonlyMap<string, ManualCost>,
  context: DeodapOrderContext,
): DeodapOrderView {
  const lines: DeodapOrderLine[] = match.lines.map((line) => {
    const cost = line.shopifyVariantId === null ? undefined : costs.get(line.shopifyVariantId);
    return {
      ...line,
      unitCost: cost?.amount ?? null,
      unitShippingCost: cost?.shippingCost ?? null,
      currencyCode: cost?.currencyCode ?? null,
    };
  });

  // One total only when every costed line is in the same currency. Adding INR to GBP
  // produces a number that is not an amount in any currency.
  const currencies = new Set(
    lines.filter((line) => line.unitCost !== null).map((line) => line.currencyCode),
  );
  const costed = lines.filter((line) => line.unitCost !== null);
  let total: number | null = null;
  let currencyCode: string | null = null;
  if (costed.length > 0 && currencies.size === 1) {
    currencyCode = [...currencies][0] ?? null;
    total = sumMoney(
      ...costed.map((line) =>
        sumMoney(
          multiplyMoney(line.unitCost ?? 0, line.quantity),
          line.unitShippingCost === null ? null : multiplyMoney(line.unitShippingCost, line.quantity),
        ),
      ),
    );
  }

  const shipment = resolveShipment({
    orderFulfillmentStatus: order.fulfillmentStatus,
    financialStatus: order.financialStatus,
    fulfillments: order.fulfillments,
    createdAt: order.createdAt,
    cancelledAt: order.cancelledAt,
    now: context.now,
    sla: context.sla,
  });
  const attention = assessDeodapOrder(order, match.lines, forwarding, shipment, context);

  return {
    shopifyOrderId: order.shopifyOrderId,
    name: order.name,
    createdAt: order.createdAt,
    financialStatus: order.financialStatus,
    fulfillmentStatus: order.fulfillmentStatus,
    cancelledAt: order.cancelledAt,
    destination: order.destination,
    lines,
    otherLineCount: match.otherLineCount,
    route: orderRoute(match.lines),
    supplierCost: {
      total,
      currencyCode,
      complete: total !== null && costed.length === lines.length,
    },
    shipment,
    forwarding,
    attention,
    needsAction: attention.length > 0,
  };
}

/* ===========================================================================
 * Recording what happened with DeoDap
 * ======================================================================== */

export interface ForwardingUpdate {
  status: DeodapOrderStatus;
  supplierOrderId: string | null;
  trackingCompany: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  note: string | null;
}

function fail(message: string): never {
  throw new AppError('VALIDATION_ERROR', message);
}

function optionalText(raw: unknown, field: string, max: number): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') fail(`${field} must be text.`);
  const value = raw.trim();
  if (value.length > max) fail(`${field} must be at most ${max} characters.`);
  return value.length > 0 ? value : null;
}

export function validateForwardingUpdate(body: Record<string, unknown>): ForwardingUpdate {
  const rawStatus = body['status'];
  const status = typeof rawStatus === 'string' ? rawStatus.trim().toUpperCase() : '';
  if (!(DEODAP_ORDER_STATUSES as readonly string[]).includes(status)) {
    fail(`status must be one of ${DEODAP_ORDER_STATUSES.join(', ')}.`);
  }

  const trackingUrl = optionalText(body['trackingUrl'], 'trackingUrl', 500);
  if (trackingUrl !== null) {
    let parsed: URL;
    try {
      parsed = new URL(trackingUrl);
    } catch {
      return fail('trackingUrl must be a full https:// address.');
    }
    if (parsed.protocol !== 'https:' || parsed.hostname.length === 0) {
      fail('trackingUrl must be a full https:// address.');
    }
  }

  return {
    status: status as DeodapOrderStatus,
    supplierOrderId: optionalText(body['supplierOrderId'], 'supplierOrderId', 100),
    trackingCompany: optionalText(body['trackingCompany'], 'trackingCompany', 100),
    trackingNumber: optionalText(body['trackingNumber'], 'trackingNumber', 100),
    trackingUrl,
    note: optionalText(body['note'], 'note', 500),
  };
}

const PLACED_OR_LATER: readonly DeodapOrderStatus[] = ['PLACED', 'SHIPPED', 'DELIVERED'];
const SHIPPED_OR_LATER: readonly DeodapOrderStatus[] = ['SHIPPED', 'DELIVERED'];

/**
 * When the order reached each stage. A stage keeps the time it was FIRST reached, so
 * correcting a typo in the tracking number does not move "shipped" to today.
 */
export function stageTimestamps(
  previous: { placedAt: Date | null; shippedAt: Date | null; deliveredAt: Date | null } | null,
  status: DeodapOrderStatus,
  now: Date,
): { placedAt: Date | null; shippedAt: Date | null; deliveredAt: Date | null } {
  return {
    placedAt: previous?.placedAt ?? (PLACED_OR_LATER.includes(status) ? now : null),
    shippedAt: previous?.shippedAt ?? (SHIPPED_OR_LATER.includes(status) ? now : null),
    deliveredAt: previous?.deliveredAt ?? (status === 'DELIVERED' ? now : null),
  };
}
