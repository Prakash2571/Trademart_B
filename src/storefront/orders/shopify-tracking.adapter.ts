/**
 * The Shopify-backed implementation of OrderTrackingPort.
 *
 * WHY THIS IS NOT IN tracking.service.ts
 * -------------------------------------
 * `getOrder` comes from shopify.service, which imports the Shopify client, which
 * imports the config singleton - and config/index.ts calls process.exit(1) on
 * invalid env. Any test that imported tracking.service.ts to exercise the pure
 * StorefrontTrackingService was therefore killed at import time in CI, where no
 * SHOPIFY_STORE_DOMAIN is set. The service is pure and port-driven; only this
 * adapter needs Shopify, so only this file pays for it.
 *
 * Same reasoning as shopify/publications/visibility.ts, which documents the rule:
 * keep the decision logic in a dependency-free module and push the I/O to an edge.
 */

import { getOrder } from '../../shopify/shopify.service';
import type { OrderDto } from '../../shopify/shopify.types';
import type { OrderTrackingPort, PublicFulfillment } from './tracking.service';

/** Refuses anything that is not http(s) so a hostile tracking URL cannot become a link. */
function safeUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Collapses several fulfillments into the single status worth showing a customer,
 * most-progressed first. Returns null rather than guessing when Shopify said nothing.
 */
function shipmentStatus(order: OrderDto): string | null {
  const statuses = order.fulfillments.map((item) => item.displayStatus).filter(Boolean) as string[];
  const priority = [
    'DELIVERED',
    'OUT_FOR_DELIVERY',
    'IN_TRANSIT',
    'PICKED_UP',
    'READY_FOR_PICKUP',
    'FULFILLED',
    'CONFIRMED',
    'SUBMITTED',
    'FAILURE',
    'NOT_DELIVERED',
    'ATTEMPTED_DELIVERY',
  ];
  return priority.find((status) => statuses.includes(status)) ?? statuses[0] ?? null;
}

export class ShopifyOrderTrackingAdapter implements OrderTrackingPort {
  public async get(shopifyOrderId: string): Promise<PublicFulfillment> {
    const order = await getOrder(shopifyOrderId);
    return {
      fulfillmentStatus: order.fulfillmentStatus,
      shipmentStatus: shipmentStatus(order),
      estimatedDeliveryAt:
        order.fulfillments.map((item) => item.estimatedDeliveryAt).find(Boolean) ?? null,
      tracking: order.fulfillments.flatMap((fulfillment) =>
        fulfillment.tracking.map((entry) => ({
          carrier: entry.company,
          number: entry.number,
          url: safeUrl(entry.url),
        }))),
      events: order.fulfillments
        .flatMap((fulfillment) => fulfillment.events)
        .filter((event): event is { id: string; status: string; happenedAt: string; message: string | null } =>
          Boolean(event.status && event.happenedAt),
        )
        .map((event) => ({ status: event.status, occurredAt: event.happenedAt })),
    };
  }
}
