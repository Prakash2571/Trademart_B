/**
 * Fetches the dropshipping view of Shopify orders.
 *
 * A VIEW, NOT A COPY (C2)
 * -----------------------
 * Shopify remains the system of record for orders, payments and fulfillment.
 * Nothing here writes an order to Mongo. Every read goes to Shopify and is
 * normalised on the way through, which means:
 *
 *   * there is no sync to fall behind, and nothing to reconcile
 *   * a refund, cancellation or address correction made in Shopify shows up
 *     immediately rather than whenever a job next ran
 *   * there is no second version of an order to disagree with the first
 *
 * The only Trademart-owned data mixed in is the SUPPLIER cost Shopify does not hold,
 * and that is read through the existing cost hierarchy rather than re-implemented.
 *
 * This module is the IMPURE half: config, database and Shopify. The composition
 * itself is in dropshipping.view.ts, which is pure and separately tested.
 */

import { logger } from '../common/logger';
import { config } from '../config';
import { getOrder, listOrders, type Paginated } from '../shopify/shopify.service';
import type { OrderDto } from '../shopify/shopify.types';
import type { ManualCost } from '../suppliers/cost';
import { loadManualCostMap } from '../suppliers/manualCost.service';
import {
  DEFAULT_DROPSHIP_COST_CONFIG,
  DEFAULT_SHIPPING_SLA,
} from './dropshipping.types';
import { buildDropshipOrder, type DropshipOrder, type DropshipSettings } from './dropshipping.view';

// Re-exported so callers have one import for the dropshipping surface, while the
// pure logic stays in a module that does not drag in the config singleton.
export { buildDropshipOrder } from './dropshipping.view';
export type {
  DropshipOrder,
  DropshipOrderItem,
  DropshipSettings,
} from './dropshipping.view';

/**
 * Effective settings.
 *
 * One function so the service, the analytics and the controller cannot disagree
 * about what the thresholds are. Falls back to the documented defaults, so an
 * unconfigured deployment behaves predictably rather than with zeroes.
 */
export function resolveSettings(): DropshipSettings {
  const overrides = (config as { dropshipping?: Partial<DropshipSettings> }).dropshipping;
  return {
    cost: { ...DEFAULT_DROPSHIP_COST_CONFIG, ...(overrides?.cost ?? {}) },
    sla: { ...DEFAULT_SHIPPING_SLA, ...(overrides?.sla ?? {}) },
  };
}

/**
 * Loads recorded supplier costs for every variant across a batch of orders.
 *
 * ONE query for the whole page. Returns an empty map when there is no database, so
 * the view degrades to Shopify's cost per item rather than failing - the same
 * degradation the automation engine already relies on.
 */
async function loadCostsFor(
  orders: readonly OrderDto[],
): Promise<ReadonlyMap<string, ManualCost>> {
  const byProduct = new Map<string, Set<string>>();
  for (const order of orders) {
    for (const line of order.lineItems) {
      if (line.shopifyProductId === null || line.shopifyVariantId === null) continue;
      const variants = byProduct.get(line.shopifyProductId) ?? new Set<string>();
      variants.add(line.shopifyVariantId);
      byProduct.set(line.shopifyProductId, variants);
    }
  }
  if (byProduct.size === 0) return new Map();

  try {
    return await loadManualCostMap(
      [...byProduct].map(([shopifyProductId, variantIds]) => ({
        shopifyProductId,
        variantIds: [...variantIds],
      })),
    );
  } catch (error) {
    // A cost lookup failure must not blank the order list: the orders are still worth
    // showing, and the economics will honestly report UNKNOWN rather than guessing.
    logger.warn('Could not load supplier costs for the dropshipping view.', {
      reason: error instanceof Error ? error.message : 'unknown',
    });
    return new Map();
  }
}

export interface ListDropshipParams {
  first?: number;
  after?: string;
  /** Shopify order search syntax, passed through unchanged. */
  query?: string;
}

/** A page of dropshipping orders, newest first. */
export async function listDropshipOrders(
  params: ListDropshipParams = {},
  now: Date = new Date(),
): Promise<Paginated<DropshipOrder>> {
  const settings = resolveSettings();
  const page = await listOrders({
    first: params.first ?? 25,
    ...(params.after === undefined ? {} : { after: params.after }),
    ...(params.query === undefined ? {} : { query: params.query }),
  });

  const costs = await loadCostsFor(page.items);
  return {
    items: page.items.map((order) => buildDropshipOrder(order, costs, settings, now)),
    meta: page.meta,
  };
}

/** One order, in full. */
export async function getDropshipOrder(
  gid: string,
  now: Date = new Date(),
): Promise<DropshipOrder> {
  const settings = resolveSettings();
  const order = await getOrder(gid);
  const costs = await loadCostsFor([order]);
  return buildDropshipOrder(order, costs, settings, now);
}
