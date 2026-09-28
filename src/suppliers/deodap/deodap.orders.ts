/**
 * DeoDap orders - pure.
 *
 * Dropshipping with DeoDap means that for every Shopify order containing DeoDap
 * products, someone has to place a matching order with DeoDap. There is no DeoDap
 * order API to call (deodap.api.ts), so today the operator places it on DeoDap and
 * records it here: the DeoDap order number, then tracking once DeoDap ships.
 *
 * This module decides which order lines are DeoDap's, what they cost, and whether an
 * order still needs placing. Nothing here stores customer data: the list shows the
 * destination region Shopify already gives the order view, and the operator reads the
 * full address in Shopify when placing the order.
 */

import { AppError } from '../../common/errors';
import { multiplyMoney, sumMoney } from '../../common/money';
import type { OrderDto } from '../../shopify/shopify.types';
import type { ManualCost } from '../cost';

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

export interface DeodapLineMatch {
  shopifyLineItemId: string;
  shopifyVariantId: string | null;
  shopifyProductId: string | null;
  title: string;
  sku: string | null;
  quantity: number;
  /** The DeoDap reference from the import ledger, when Trademart imported the product. */
  supplierRef: string | null;
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
  /** What DeoDap will charge for these lines, from the recorded costs. */
  supplierCost: {
    total: number | null;
    currencyCode: string | null;
    /** False when some line has no recorded cost, so the total is a minimum. */
    complete: boolean;
  };
  /** Tracking already on the order in Shopify. */
  shopifyTracking: { company: string | null; number: string | null; url: string | null }[];
  forwarding: ForwardingRecord | null;
  /** True when the order still has to be placed with DeoDap, or has a problem. */
  needsAction: boolean;
}

/**
 * The lines of an order that come from DeoDap.
 *
 * A line counts when its product is identified as DeoDap (vendor, tag, SKU prefix)
 * OR its variant is one Trademart imported from DeoDap. The second matters for a
 * store that changed the vendor to its own brand and removed the tag.
 */
export function extractDeodapLines(
  order: OrderDto,
  refsByVariant: ReadonlyMap<string, string>,
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
    const evidence = line.supplier === 'DEODAP' ? [...line.supplierEvidence] : [];
    if (ref !== undefined) evidence.push('imported from DeoDap by Trademart');
    lines.push({
      shopifyLineItemId: line.shopifyLineItemId,
      shopifyVariantId: line.shopifyVariantId,
      shopifyProductId: line.shopifyProductId,
      title: line.title,
      sku: line.sku,
      quantity: line.quantity,
      supplierRef: ref ?? null,
      evidence,
    });
  }
  return { lines, otherLineCount };
}

/** True when the order still has to be placed with DeoDap, or something went wrong. */
export function needsForwarding(order: OrderDto, forwarding: ForwardingRecord | null): boolean {
  if (forwarding?.status === 'PROBLEM') return true;
  if (order.cancelledAt !== null) return false;
  if (forwarding !== null && forwarding.status !== 'NOT_PLACED') return false;
  return order.fulfillmentStatus !== 'FULFILLED';
}

export function buildDeodapOrderView(
  order: OrderDto,
  match: { lines: DeodapLineMatch[]; otherLineCount: number },
  forwarding: ForwardingRecord | null,
  costs: ReadonlyMap<string, ManualCost>,
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
    supplierCost: {
      total,
      currencyCode,
      complete: total !== null && costed.length === lines.length,
    },
    shopifyTracking: order.fulfillments.flatMap((fulfillment) => fulfillment.tracking),
    forwarding,
    needsAction: needsForwarding(order, forwarding),
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
