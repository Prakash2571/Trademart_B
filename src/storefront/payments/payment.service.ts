import { incrementCounter } from '../../common/metrics';
import type { CheckoutSessionRecord, CheckoutSessionRepository } from '../checkout/checkout.types';
import { StorefrontError } from '../checkout/storefront.error';
import type { PaidOrderOrchestrator } from '../orders/order.orchestrator';
import { deriveTrackingToken, hashTrackingToken } from '../orders/tracking-token';
import type { PaymentAttemptRepository, PaymentAttemptStatus } from './payment.repository';
import type { RazorpayPort, RazorpayPayment } from './razorpay.client';
import type { RazorpayConfig } from './razorpay.config';
import { verifyRazorpayPaymentSignature } from './razorpay.signature';
import type { SafeRazorpayWebhook } from './razorpay.webhook';

export interface VerifyPaymentInput {
  checkoutSessionId: string;
  razorpayOrderId: string;
  razorpayPaymentId: string;
  razorpaySignature: string;
}

export interface PaymentStatusResponse {
  checkoutSessionId: string;
  status: 'PAYMENT_PENDING' | 'PAID' | 'ORDER_PENDING' | 'COMPLETE' | 'REFUNDED';
  amountPaidPaise: number;
  orderNumber?: string;
  trackingToken?: string;
}

function paymentStatus(payment: RazorpayPayment): PaymentAttemptStatus {
  if (payment.status === 'captured' && payment.captured) return 'CAPTURED';
  if (payment.status === 'authorized') return 'AUTHORIZED';
  if (payment.status === 'refunded') return 'REFUNDED';
  return 'FAILED';
}

function matchesSnapshot(session: CheckoutSessionRecord, payment: {
  orderId: string | null;
  amount: number;
  currency: string;
}): boolean {
  return (
    payment.orderId === session.razorpayOrderId &&
    payment.amount === session.snapshot.totalPaise &&
    payment.currency === 'INR'
  );
}

export class StorefrontPaymentService {
  public constructor(
    private readonly sessions: CheckoutSessionRepository,
    private readonly attempts: PaymentAttemptRepository,
    private readonly razorpay: RazorpayPort,
    private readonly razorpayConfig: RazorpayConfig,
    private readonly orders: PaidOrderOrchestrator,
    private readonly trackingTokenSecret: string,
  ) {}

  private publicStatus(session: CheckoutSessionRecord): PaymentStatusResponse {
    let status: PaymentStatusResponse['status'] = 'PAYMENT_PENDING';
    if (session.status === 'REFUNDED') status = 'REFUNDED';
    else if (session.status === 'ORDER_CREATED') status = 'COMPLETE';
    else if (session.paidAt) status = 'ORDER_PENDING';

    const response: PaymentStatusResponse = {
      checkoutSessionId: session.publicId,
      status,
      amountPaidPaise: session.paidAt ? session.snapshot.totalPaise : 0,
    };
    if (session.shopifyOrderName) response.orderNumber = session.shopifyOrderName;
    if (session.paidAt) {
      response.trackingToken = deriveTrackingToken(session.publicId, this.trackingTokenSecret);
    }
    return response;
  }

  public async status(checkoutId: string, statusToken: string): Promise<PaymentStatusResponse> {
    if (!/^[0-9a-f-]{36}$/i.test(checkoutId)) {
      throw new StorefrontError('TRACKING_NOT_FOUND', 'Checkout status link is invalid.', 404);
    }
    const session = await this.sessions.findByStatusTokenHash(
      checkoutId,
      hashTrackingToken(statusToken),
    );
    if (!session) {
      throw new StorefrontError('TRACKING_NOT_FOUND', 'Checkout status link is invalid.', 404);
    }
    return this.publicStatus(session);
  }

  private async observe(
    session: CheckoutSessionRecord,
    payment: RazorpayPayment,
    source: 'BROWSER_VERIFY' | 'WEBHOOK',
  ): Promise<void> {
    await this.attempts.observe({
      checkoutPublicId: session.publicId,
      razorpayOrderId: session.razorpayOrderId!,
      razorpayPaymentId: payment.id,
      status: paymentStatus(payment),
      amountPaise: payment.amount,
      currency: 'INR',
      captured: payment.captured,
      source,
      providerObservedAt: payment.createdAt,
      failureCode: payment.errorCode,
      failureMessage: payment.status === 'failed' ? 'Payment was not completed.' : null,
    });
  }

  private async markCaptured(
    session: CheckoutSessionRecord,
    payment: RazorpayPayment,
    source: 'BROWSER_VERIFY' | 'WEBHOOK',
  ): Promise<CheckoutSessionRecord> {
    if (!matchesSnapshot(session, payment)) {
      throw new StorefrontError(
        'PAYMENT_MISMATCH',
        'Payment amount or order did not match the approved checkout.',
        409,
      );
    }
    await this.observe(session, payment, source);
    const paid = await this.sessions.markPaid({
      publicId: session.publicId,
      razorpayOrderId: session.razorpayOrderId!,
      razorpayPaymentId: payment.id,
      paidAt: payment.createdAt,
    });
    // A Shopify failure is not a payment failure. The orchestrator records
    // ORDER_PENDING and a retry time, and the customer must never pay again.
    await this.orders.processOne(session.publicId);
    return (await this.sessions.findByPublicId(paid.publicId)) ?? paid;
  }

  public async verify(input: VerifyPaymentInput): Promise<PaymentStatusResponse> {
    if (
      !/^[0-9a-f-]{36}$/i.test(input.checkoutSessionId) ||
      !/^order_[A-Za-z0-9_]{3,70}$/.test(input.razorpayOrderId) ||
      !/^pay_[A-Za-z0-9_]{3,70}$/.test(input.razorpayPaymentId)
    ) {
      throw new StorefrontError('VALIDATION_ERROR', 'Payment details are invalid.', 400);
    }
    const session = await this.sessions.findByPublicId(input.checkoutSessionId);
    if (!session || !session.razorpayOrderId || session.razorpayOrderId !== input.razorpayOrderId) {
      throw new StorefrontError('PAYMENT_MISMATCH', 'Payment does not match this checkout.', 409);
    }
    if (
      !verifyRazorpayPaymentSignature({
        serverRazorpayOrderId: session.razorpayOrderId,
        razorpayPaymentId: input.razorpayPaymentId,
        providedSignature: input.razorpaySignature,
        keySecret: this.razorpayConfig.keySecret,
      })
    ) {
      // Counted, not just thrown: a signature that does not verify is either an
      // attempt to forge a payment or a key-rotation mistake, and both need to be
      // visible somewhere an operator looks. See common/metrics.ts.
      incrementCounter('storefront.payment.signature_invalid');
      throw new StorefrontError(
        'PAYMENT_INVALID_SIGNATURE',
        'Payment confirmation could not be verified.',
        401,
      );
    }

    // HMAC proves the callback came from Razorpay. The server-side fetch proves
    // it belongs to this order, is the frozen amount/currency, and was captured.
    const payment = await this.razorpay.fetchPayment(input.razorpayPaymentId);
    if (!matchesSnapshot(session, payment)) {
      throw new StorefrontError('PAYMENT_MISMATCH', 'Payment amount did not match checkout.', 409);
    }
    if (payment.status === 'authorized' && !payment.captured) {
      await this.observe(session, payment, 'BROWSER_VERIFY');
      throw new StorefrontError(
        'PAYMENT_PENDING',
        "We're confirming your payment. Do not pay again.",
        202,
        undefined,
        true,
      );
    }
    if (payment.status !== 'captured' || !payment.captured) {
      await this.observe(session, payment, 'BROWSER_VERIFY');
      incrementCounter('storefront.payment.verify_failed');
      throw new StorefrontError(
        'PAYMENT_FAILED',
        "Payment wasn't completed. You were not charged if Razorpay shows it as failed.",
        402,
      );
    }
    return this.publicStatus(await this.markCaptured(session, payment, 'BROWSER_VERIFY'));
  }

  public async processWebhook(event: SafeRazorpayWebhook): Promise<'PROCESSED' | 'IGNORED'> {
    const supported = [
      'payment.authorized',
      'payment.captured',
      'payment.failed',
      'payment.refunded',
      'order.paid',
    ];
    if (!supported.includes(event.eventType)) return 'IGNORED';
    const p = event.payment;
    if (!p.razorpayOrderId || !p.razorpayPaymentId || p.amountPaise === null || !p.currency) {
      return 'IGNORED';
    }
    const session = await this.sessions.findByRazorpayOrderId(p.razorpayOrderId);
    if (!session) return 'IGNORED';
    const payment: RazorpayPayment = {
      id: p.razorpayPaymentId,
      orderId: p.razorpayOrderId,
      amount: p.amountPaise,
      currency: p.currency,
      status: p.status ?? (event.eventType === 'order.paid' ? 'captured' : 'unknown'),
      captured: p.captured || event.eventType === 'order.paid',
      createdAt: new Date(),
      errorCode: p.failureCode,
    };
    if (!matchesSnapshot(session, payment)) return 'IGNORED';

    if (event.eventType === 'payment.failed') {
      await this.observe(session, payment, 'WEBHOOK');
      return 'PROCESSED';
    }
    if (event.eventType === 'payment.refunded' || payment.status === 'refunded') {
      await this.attempts.observe({
        checkoutPublicId: session.publicId,
        razorpayOrderId: p.razorpayOrderId,
        razorpayPaymentId: p.razorpayPaymentId,
        status: 'REFUNDED',
        amountPaise: p.amountPaise,
        currency: 'INR',
        captured: true,
        source: 'WEBHOOK',
        providerObservedAt: new Date(),
      });
      if (session.razorpayPaymentId === p.razorpayPaymentId) {
        await this.sessions.markRefunded({
          publicId: session.publicId,
          razorpayPaymentId: p.razorpayPaymentId,
          refundedAt: new Date(),
        });
      }
      return 'PROCESSED';
    }
    if (payment.status === 'captured' && payment.captured) {
      await this.markCaptured(session, payment, 'WEBHOOK');
      return 'PROCESSED';
    }
    await this.observe(session, payment, 'WEBHOOK');
    return 'PROCESSED';
  }
}
