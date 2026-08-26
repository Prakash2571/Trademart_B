import { getOrder } from '../../shopify/shopify.service';
import type { OrderDto } from '../../shopify/shopify.types';
import type { CheckoutSessionRecord, CheckoutSessionRepository } from '../checkout/checkout.types';
import { mapToPublicCheckoutStatus } from '../checkout/checkout.types';
import { StorefrontError } from '../checkout/storefront.error';
import { hashTrackingToken, trackingTokenMatches } from './tracking-token';

export interface PublicFulfillment {
  fulfillmentStatus: string | null;
  shipmentStatus: string | null;
  estimatedDeliveryAt: string | null;
  tracking: { carrier: string | null; number: string | null; url: string | null }[];
  events: { status: string; occurredAt: string }[];
}

export interface OrderTrackingPort {
  get(shopifyOrderId: string): Promise<PublicFulfillment>;
}

function safeUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

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

export interface PublicTrackingDto {
  orderNumber: string | null;
  orderStatus: 'PAYMENT_PENDING' | 'PAID' | 'ORDER_PENDING' | 'COMPLETE';
  createdAt: string;
  amountPaidPaise: number;
  currency: 'INR';
  paymentStatus: 'PENDING' | 'PAID' | 'REFUNDED';
  fulfillmentStatus: string | null;
  shipmentStatus: string | null;
  estimatedDeliveryAt: string | null;
  trackingAvailable: boolean;
  tracking: { carrier: string | null; number: string | null; url: string | null }[];
  items: {
    title: string;
    variantTitle: string | null;
    selectedOptions: { name: string; value: string }[];
    quantity: number;
    image: { url: string; alt: string | null } | null;
  }[];
  timeline: { code: string; label: string; occurredAt: string }[];
  addressSummary: { city: string; state: string; pinCode: string; countryCode: 'IN' };
  emailMasked: string;
}

function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  const shown = local.slice(0, Math.min(2, local.length));
  return `${shown}${'*'.repeat(Math.max(3, local.length - shown.length))}@${domain}`;
}

function baseTimeline(session: CheckoutSessionRecord): PublicTrackingDto['timeline'] {
  const timeline: PublicTrackingDto['timeline'] = [];
  if (session.paidAt) {
    timeline.push({ code: 'PAYMENT_RECEIVED', label: 'Payment received', occurredAt: session.paidAt.toISOString() });
  }
  if (session.shopifyOrderCreatedAt) {
    timeline.push({
      code: 'ORDER_CONFIRMED',
      label: 'Order confirmed',
      occurredAt: session.shopifyOrderCreatedAt.toISOString(),
    });
  }
  return timeline;
}

function carrierTimeline(
  fulfillment: PublicFulfillment,
): PublicTrackingDto['timeline'] {
  const recognised: Record<string, { code: string; label: string }> = {
    IN_TRANSIT: { code: 'SHIPPED', label: 'Shipped' },
    OUT_FOR_DELIVERY: { code: 'OUT_FOR_DELIVERY', label: 'Out for delivery' },
    DELIVERED: { code: 'DELIVERED', label: 'Delivered' },
  };
  const seen = new Set<string>();
  return [...fulfillment.events]
    .sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt))
    .flatMap((event) => {
      const status = recognised[event.status.toUpperCase()];
      if (!status || seen.has(status.code)) return [];
      seen.add(status.code);
      return [{ ...status, occurredAt: event.occurredAt }];
    });
}

export class StorefrontTrackingService {
  public constructor(
    private readonly sessions: CheckoutSessionRepository,
    private readonly orders: OrderTrackingPort,
  ) {}

  public async get(token: string): Promise<PublicTrackingDto> {
    const hash = hashTrackingToken(token);
    const session = await this.sessions.findByTrackingTokenHash(hash);
    if (!session || !trackingTokenMatches(token, session.trackingTokenHash)) {
      // Same response for malformed, missing and mismatched tokens: no enumeration oracle.
      throw new StorefrontError('TRACKING_NOT_FOUND', 'Order tracking link is invalid.', 404);
    }

    let fulfillment: PublicFulfillment = {
      fulfillmentStatus: null,
      shipmentStatus: null,
      estimatedDeliveryAt: null,
      tracking: [],
      events: [],
    };
    if (session.shopifyOrderId) {
      try {
        fulfillment = await this.orders.get(session.shopifyOrderId);
      } catch {
        // Payment/order state remains useful. Unknown tracking must stay unknown,
        // never be translated to "Processing" when Shopify is unavailable.
      }
    }

    return {
      orderNumber: session.shopifyOrderName,
      orderStatus: mapToPublicCheckoutStatus(session.status),
      createdAt: session.createdAt.toISOString(),
      amountPaidPaise: session.paidAt ? session.snapshot.totalPaise : 0,
      currency: 'INR',
      paymentStatus: session.status === 'REFUNDED' ? 'REFUNDED' : session.paidAt ? 'PAID' : 'PENDING',
      fulfillmentStatus: fulfillment.fulfillmentStatus,
      shipmentStatus: fulfillment.shipmentStatus,
      estimatedDeliveryAt: fulfillment.estimatedDeliveryAt,
      trackingAvailable: fulfillment.tracking.length > 0,
      tracking: fulfillment.tracking,
      items: session.snapshot.lines.map((line) => ({
        title: line.title,
        variantTitle: line.variantTitle,
        selectedOptions: line.selectedOptions,
        quantity: line.quantity,
        image: line.image,
      })),
      timeline: [...baseTimeline(session), ...carrierTimeline(fulfillment)],
      addressSummary: {
        city: session.snapshot.shippingAddress.city,
        state: session.snapshot.shippingAddress.state,
        pinCode: session.snapshot.shippingAddress.pinCode,
        countryCode: 'IN',
      },
      emailMasked: maskEmail(session.snapshot.customer.email),
    };
  }
}
