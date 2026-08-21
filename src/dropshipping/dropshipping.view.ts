/**
 * The dropshipping order VIEW, as a pure function.
 *
 * Split from dropshipping.service.ts on purpose. The service imports the config
 * singleton (for settings), the database (for recorded supplier costs) and the
 * Shopify client - and config/index.ts calls process.exit(1) on an invalid
 * environment. Composing an order view is pure logic, so it lives here where it can
 * be unit tested without a configured store, a database, or the process being
 * killed at import time.
 *
 * WHAT THIS COMPOSES, AND WHY IT DOES NOT RE-DERIVE ANY OF IT
 * ----------------------------------------------------------
 *   cost provenance   suppliers/cost.ts resolveCostSource - the existing hierarchy
 *   fulfillment state dropshipping.status.ts resolveShipment
 *   money             dropshipping.cost.ts computeOrderEconomics
 *
 * A second opinion about cost or state in this file is exactly how two screens end
 * up disagreeing about a margin, so this module only arranges - it decides nothing.
 */

import { computeOrderEconomics, type CostLineInput } from './dropshipping.cost';
import { effectiveStatus, resolveShipment } from './dropshipping.status';
import type {
  DropshipCostConfig,
  DropshipFulfillmentState,
  DropshipShipment,
  OrderEconomics,
  ShippingSla,
} from './dropshipping.types';
import { resolveCostSource, type ManualCost } from '../suppliers/cost';
import type { OrderDto, SupplierClassification } from '../shopify/shopify.types';

export interface DropshipOrderItem {
  shopifyLineItemId: string;
  title: string;
  quantity: number;
  sku: string | null;
  shopifyProductId: string | null;
  shopifyVariantId: string | null;
  /** What the customer paid for this line. */
  lineRevenue: number | null;
  /** Per-unit supplier product cost, and where it came from. */
  unitCost: number | null;
  unitCostSource: string;
  /** Per-unit supplier shipping. Null means UNKNOWN, never free. */
  unitShippingCost: number | null;
  supplier: SupplierClassification;
  supplierEvidence: string[];
  fulfillmentService: string | null;
}

export interface DropshipOrder {
  shopifyOrderId: string;
  orderName: string;
  createdAt: string;
  /** Shopify's own words, retained. */
  paymentStatus: string | null;
  fulfillmentStatus: string | null;
  /** TRADELLE only when there is evidence for it (C3). */
  supplier: SupplierClassification;
  supplierEvidence: string[];
  items: DropshipOrderItem[];
  /**
   * Destination. Null when protected customer data access is not approved, which is
   * a WITHHELD field rather than an order with no destination.
   */
  customerRegion: OrderDto['destination'];
  economics: OrderEconomics;
  shipment: DropshipShipment;
  /** Single value for a compact list: DELAYED when late, else progress. */
  displayState: DropshipFulfillmentState;
  warnings: string[];
}

export interface DropshipSettings {
  cost: DropshipCostConfig;
  sla: ShippingSla;
}

/**
 * Aggregates per-line supplier evidence to an order-level list.
 *
 * Deduplicated: the same marker usually matches on every line, and repeating it
 * once per item makes a two-line order look like stronger evidence than it is.
 */
function collectEvidence(order: OrderDto): string[] {
  const evidence = new Set<string>();
  for (const line of order.lineItems) {
    for (const entry of line.supplierEvidence) evidence.add(entry);
  }
  return [...evidence];
}

/**
 * Turns one Shopify order into the dropshipping view.
 *
 * `manualCosts` is passed in rather than fetched so a page of 50 orders makes ONE
 * database round trip instead of 50, and `now` is injected so delay calculations
 * are testable without waiting.
 */
export function buildDropshipOrder(
  order: OrderDto,
  manualCosts: ReadonlyMap<string, ManualCost>,
  settings: DropshipSettings,
  now: Date,
): DropshipOrder {
  const items: DropshipOrderItem[] = [];
  const costLines: CostLineInput[] = [];

  for (const line of order.lineItems) {
    // The EXISTING cost hierarchy decides which cost wins (supplier API > manual
    // override > Shopify cost per item > manual) and reports shipping separately.
    const manual =
      line.shopifyVariantId === null ? null : manualCosts.get(line.shopifyVariantId) ?? null;
    const resolved = resolveCostSource({
      shopifyUnitCost: line.unitCost,
      manualCost: manual,
    });

    items.push({
      shopifyLineItemId: line.shopifyLineItemId,
      title: line.title,
      quantity: line.quantity,
      sku: line.sku,
      shopifyProductId: line.shopifyProductId,
      shopifyVariantId: line.shopifyVariantId,
      lineRevenue: line.discountedTotal?.amount ?? null,
      unitCost: resolved.amount,
      unitCostSource: resolved.source,
      unitShippingCost: resolved.shippingCost,
      supplier: line.supplier,
      supplierEvidence: line.supplierEvidence,
      fulfillmentService: line.fulfillmentService,
    });

    costLines.push({
      quantity: line.quantity,
      unitCost: resolved.amount,
      unitShippingCost: resolved.shippingCost,
      title: line.title,
    });
  }

  const shipment = resolveShipment({
    orderFulfillmentStatus: order.fulfillmentStatus,
    financialStatus: order.financialStatus,
    fulfillments: order.fulfillments,
    createdAt: order.createdAt,
    cancelledAt: order.cancelledAt,
    now,
    sla: settings.sla,
  });

  const economics = computeOrderEconomics({
    currencyCode: order.currencyCode,
    // The order TOTAL is revenue. Note that Shopify's totalShipping is part of this
    // - it is what the customer PAID for shipping, and is never a supplier cost.
    customerRevenue: order.total?.amount ?? null,
    lines: costLines,
    config: settings.cost,
  });

  // Order-level warnings gather everything needing a human, from both the money and
  // the shipment, so a list view can show one count per order.
  const warnings = [...economics.warnings, ...shipment.delaySignals];
  if (order.supplier === 'UNKNOWN') {
    warnings.push(
      'The supplier for this order could not be identified from Shopify data, so it is UNKNOWN rather than assumed.',
    );
  }

  return {
    shopifyOrderId: order.shopifyOrderId,
    orderName: order.name,
    createdAt: order.createdAt,
    paymentStatus: order.financialStatus,
    fulfillmentStatus: order.fulfillmentStatus,
    supplier: order.supplier,
    supplierEvidence: collectEvidence(order),
    items,
    customerRegion: order.destination,
    economics,
    shipment,
    displayState: effectiveStatus(shipment),
    warnings,
  };
}
