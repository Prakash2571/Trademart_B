import { randomUUID } from 'node:crypto';

import type { RazorpayPort } from '../payments/razorpay.client';
import {
  deriveCheckoutStatusToken,
  deriveTrackingToken,
  hashTrackingToken,
} from '../orders/tracking-token';
import { buildCheckoutSnapshot, checkoutRequestHash } from './checkout.snapshot';
import { StorefrontError } from './storefront.error';
import type {
  CheckoutCatalogPort,
  CheckoutSessionRecord,
  CheckoutSessionRepository,
  CreateCheckoutRequest,
  CreateCheckoutResponse,
  CustomerShippingPolicyPort,
} from './checkout.types';

export interface CheckoutServiceDependencies {
  catalog: CheckoutCatalogPort;
  shippingPolicy: CustomerShippingPolicyPort;
  sessions: CheckoutSessionRepository;
  razorpay: RazorpayPort;
  razorpayKeyId: string;
  trackingTokenSecret: string;
}

export class CheckoutService {
  public constructor(private readonly deps: CheckoutServiceDependencies) {}

  private response(session: CheckoutSessionRecord): CreateCheckoutResponse {
    if (!session.razorpayOrderId) {
      throw new StorefrontError(
        'PAYMENT_PENDING',
        'Payment is still being prepared. Please retry with the same idempotency key.',
        409,
        undefined,
        true,
      );
    }
    const statusToken = deriveCheckoutStatusToken(
      session.publicId,
      this.deps.trackingTokenSecret,
    );
    return {
      checkoutSessionId: session.publicId,
      statusToken,
      razorpayOrderId: session.razorpayOrderId,
      amountPaise: session.snapshot.totalPaise,
      currency: 'INR',
      keyId: this.deps.razorpayKeyId,
      summary: {
        items: session.snapshot.lines.map((line) => {
          const item: CreateCheckoutResponse['summary']['items'][number] = {
            title: line.title,
            variantTitle: line.variantTitle,
            quantity: line.quantity,
            unitPricePaise: line.unitPricePaise,
            lineTotalPaise: line.lineTotalPaise,
          };
          if (line.image) item.image = line.image;
          return item;
        }),
        subtotalPaise: session.snapshot.subtotalPaise,
        shippingPaise: session.snapshot.shippingPaise,
        discountPaise: session.snapshot.discountPaise,
        taxPaise: session.snapshot.taxPaise,
        totalPaise: session.snapshot.totalPaise,
      },
    };
  }

  public async create(
    request: CreateCheckoutRequest,
    idempotencyKey: string,
  ): Promise<CreateCheckoutResponse> {
    const requestHash = checkoutRequestHash(request);
    let session = await this.deps.sessions.findByIdempotencyKey(idempotencyKey);
    if (session && session.requestHash !== requestHash) {
      throw new StorefrontError(
        'IDEMPOTENCY_CONFLICT',
        'This checkout key was already used for different cart or customer details.',
        409,
      );
    }
    if (session?.razorpayOrderId) return this.response(session);

    if (!session) {
      const approved = await this.deps.catalog.revalidateLines(request.lines);
      const preliminarySubtotal = approved.reduce((sum, line) => {
        const amount = line.unitPricePaise * line.quantity;
        if (!Number.isSafeInteger(amount) || !Number.isSafeInteger(sum + amount)) {
          throw new StorefrontError('INTERNAL_ERROR', 'Cart total exceeded the safe payment range.', 500);
        }
        return sum + amount;
      }, 0);
      const quote = await this.deps.shippingPolicy.quote({
        lines: approved,
        subtotalPaise: preliminarySubtotal,
        shippingAddress: request.shippingAddress,
      });
      const snapshot = buildCheckoutSnapshot(request, approved, quote);
      const publicId = randomUUID();
      const trackingToken = deriveTrackingToken(publicId, this.deps.trackingTokenSecret);
      const statusToken = deriveCheckoutStatusToken(publicId, this.deps.trackingTokenSecret);
      session = await this.deps.sessions.create({
        publicId,
        idempotencyKey,
        requestHash,
        snapshot,
        statusTokenHash: hashTrackingToken(statusToken),
        trackingTokenHash: hashTrackingToken(trackingToken),
        shopifySourceIdentifier: `kanay-${publicId}`,
      });
      // A simultaneous retry can win the unique key. It is safe only if it carries
      // the same fingerprint; never attach our newly-generated provider order to it.
      if (session.requestHash !== requestHash) {
        throw new StorefrontError(
          'IDEMPOTENCY_CONFLICT',
          'This checkout key was already used for different details.',
          409,
        );
      }
      if (session.razorpayOrderId) return this.response(session);
    }

    const razorpayOrder = await this.deps.razorpay.createOrRecoverOrder({
      amountPaise: session.snapshot.totalPaise,
      currency: 'INR',
      receipt: `ks_${session.publicId.replace(/-/g, '')}`,
      checkoutPublicId: session.publicId,
    });
    session = await this.deps.sessions.attachRazorpayOrder({
      publicId: session.publicId,
      razorpayOrderId: razorpayOrder.id,
      razorpayOrderStatus: razorpayOrder.status,
    });
    return this.response(session);
  }
}
