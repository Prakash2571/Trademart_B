import { logger } from '../../common/logger';
import { StorefrontError } from '../checkout/storefront.error';
import type { RazorpayConfig } from './razorpay.config';
import {
  MAX_READ_ATTEMPTS,
  parseRetryAfterSeconds,
  retryDelayMs,
  shouldRetryRead,
  type RazorpayAttemptOutcome,
} from './razorpay.retry';

/** Local sleep so this module does not depend on the Shopify throttle helpers. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface RazorpayOrder {
  id: string;
  amount: number;
  amountPaid: number;
  amountDue: number;
  currency: string;
  receipt: string | null;
  status: string;
}

export interface RazorpayPayment {
  id: string;
  orderId: string | null;
  amount: number;
  currency: string;
  status: string;
  captured: boolean;
  createdAt: Date;
  errorCode: string | null;
}

export interface RazorpayPort {
  createOrRecoverOrder(input: {
    amountPaise: number;
    currency: 'INR';
    receipt: string;
    checkoutPublicId: string;
  }): Promise<RazorpayOrder>;
  fetchPayment(paymentId: string): Promise<RazorpayPayment>;
}

interface RawOrder {
  id?: unknown;
  amount?: unknown;
  amount_paid?: unknown;
  amount_due?: unknown;
  currency?: unknown;
  receipt?: unknown;
  status?: unknown;
}

function mapOrder(raw: RawOrder): RazorpayOrder | null {
  if (
    typeof raw.id !== 'string' ||
    !Number.isSafeInteger(raw.amount) ||
    !Number.isSafeInteger(raw.amount_paid) ||
    !Number.isSafeInteger(raw.amount_due) ||
    typeof raw.currency !== 'string' ||
    typeof raw.status !== 'string'
  ) {
    return null;
  }
  return {
    id: raw.id,
    amount: raw.amount as number,
    amountPaid: raw.amount_paid as number,
    amountDue: raw.amount_due as number,
    currency: raw.currency,
    receipt: typeof raw.receipt === 'string' ? raw.receipt : null,
    status: raw.status,
  };
}

function validProviderId(value: string, prefix: 'pay_' | 'order_'): boolean {
  return value.startsWith(prefix) && /^[A-Za-z0-9_]{8,80}$/.test(value);
}

export class RazorpayHttpClient implements RazorpayPort {
  public constructor(
    private readonly config: RazorpayConfig,
    private readonly requestFetch: typeof fetch = fetch,
  ) {}

  /**
   * One attempt. Every call has an explicit 15s timeout: without the AbortController
   * a hung TCP connection would hold a checkout request open until the reverse proxy
   * gave up, with the customer watching a spinner.
   */
  private async attempt(
    path: string,
    init: RequestInit,
  ): Promise<{ ok: true; body: unknown } | { ok: false; outcome: RazorpayAttemptOutcome }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await this.requestFetch(`${this.config.apiBaseUrl}${path}`, {
        ...init,
        headers: {
          Accept: 'application/json',
          Authorization: `Basic ${Buffer.from(`${this.config.keyId}:${this.config.keySecret}`).toString('base64')}`,
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
          ...init.headers,
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        return {
          ok: false,
          outcome: {
            status: response.status,
            retryAfterSeconds: parseRetryAfterSeconds(response.headers.get('Retry-After')),
          },
        };
      }
      return { ok: true, body: await response.json() };
    } catch {
      // No response at all: a timeout, a reset, a DNS failure. Reported as
      // `status: null` so the retry classifier can tell it apart from a 4xx.
      return { ok: false, outcome: { status: null } };
    } finally {
      clearTimeout(timer);
    }
  }

  private failure(outcome: RazorpayAttemptOutcome): StorefrontError {
    const transient =
      outcome.status === null || outcome.status === 429 || outcome.status >= 500;
    return new StorefrontError(
      'PAYMENT_FAILED',
      transient
        ? 'Payment service is temporarily unavailable. Please try again.'
        : 'Payment could not be prepared. Please try again.',
      transient ? 503 : 502,
      outcome.status === null ? undefined : { providerStatus: outcome.status },
      transient,
    );
  }

  /**
   * A READ. Retried, because nothing changes upstream and the caller is deciding
   * whether a customer's money moved - see razorpay.retry.ts for why writes are not.
   */
  private async read(path: string): Promise<unknown> {
    let last: RazorpayAttemptOutcome = { status: null };
    for (let attempt = 1; attempt <= MAX_READ_ATTEMPTS; attempt += 1) {
      const result = await this.attempt(path, {});
      if (result.ok) return result.body;
      last = result.outcome;

      const verdict = shouldRetryRead(result.outcome);
      if (!verdict.retry || attempt === MAX_READ_ATTEMPTS) break;

      logger.warn('Retrying a Razorpay read.', {
        attempt,
        of: MAX_READ_ATTEMPTS,
        providerStatus: result.outcome.status,
        reason: verdict.reason,
      });
      await sleep(retryDelayMs(attempt, result.outcome));
    }
    throw this.failure(last);
  }

  /**
   * A WRITE. Exactly one attempt, on purpose: a blind retry of an order creation can
   * produce a second Razorpay order for one purchase. Recovery is by receipt lookup
   * in createOrRecoverOrder, which is idempotent by identity rather than by hope.
   */
  private async write(path: string, init: RequestInit): Promise<unknown> {
    const result = await this.attempt(path, init);
    if (result.ok) return result.body;
    throw this.failure(result.outcome);
  }

  private assertExpectedOrder(
    order: RazorpayOrder,
    expected: { amountPaise: number; currency: string; receipt: string },
  ): RazorpayOrder {
    if (
      order.amount !== expected.amountPaise ||
      order.currency !== expected.currency ||
      order.receipt !== expected.receipt
    ) {
      throw new StorefrontError(
        'PAYMENT_MISMATCH',
        'Payment order did not match the approved checkout total.',
        502,
      );
    }
    return order;
  }

  private async recoverByReceipt(input: {
    amountPaise: number;
    currency: 'INR';
    receipt: string;
  }): Promise<RazorpayOrder | null> {
    const body = (await this.read(
      `/orders?receipt=${encodeURIComponent(input.receipt)}&count=10`,
    )) as { items?: unknown };
    if (!Array.isArray(body.items)) return null;
    const matches = body.items
      .map((entry) => mapOrder(entry as RawOrder))
      .filter((entry): entry is RazorpayOrder => entry !== null && entry.receipt === input.receipt);
    if (matches.length !== 1) return null;
    return this.assertExpectedOrder(matches[0]!, input);
  }

  public async createOrRecoverOrder(input: {
    amountPaise: number;
    currency: 'INR';
    receipt: string;
    checkoutPublicId: string;
  }): Promise<RazorpayOrder> {
    if (!Number.isSafeInteger(input.amountPaise) || input.amountPaise < 10) {
      throw new StorefrontError('VALIDATION_ERROR', 'Payment amount is invalid.', 400);
    }
    try {
      const body = (await this.write('/orders', {
        method: 'POST',
        body: JSON.stringify({
          amount: input.amountPaise,
          currency: input.currency,
          receipt: input.receipt,
          notes: { checkout_id: input.checkoutPublicId },
        }),
      })) as RawOrder;
      const order = mapOrder(body);
      if (!order || !validProviderId(order.id, 'order_')) {
        throw new StorefrontError('PAYMENT_FAILED', 'Payment service returned an invalid order.', 502);
      }
      return this.assertExpectedOrder(order, input);
    } catch (createError) {
      // Receipt is Razorpay's idempotency key. If POST succeeded but its response was
      // lost, fetch the one order carrying that receipt instead of creating another.
      try {
        const recovered = await this.recoverByReceipt(input);
        if (recovered) return recovered;
      } catch {
        // Surface the original create failure; it best explains what the customer saw.
      }
      throw createError;
    }
  }

  public async fetchPayment(paymentId: string): Promise<RazorpayPayment> {
    if (!validProviderId(paymentId, 'pay_')) {
      throw new StorefrontError('VALIDATION_ERROR', 'Payment identifier is invalid.', 400);
    }
    const raw = (await this.read(`/payments/${encodeURIComponent(paymentId)}`)) as Record<
      string,
      unknown
    >;
    if (
      raw['id'] !== paymentId ||
      !Number.isSafeInteger(raw['amount']) ||
      typeof raw['currency'] !== 'string' ||
      typeof raw['status'] !== 'string'
    ) {
      throw new StorefrontError('PAYMENT_FAILED', 'Payment status could not be confirmed.', 502);
    }
    return {
      id: paymentId,
      orderId: typeof raw['order_id'] === 'string' ? raw['order_id'] : null,
      amount: raw['amount'] as number,
      currency: raw['currency'],
      status: raw['status'],
      captured: raw['captured'] === true,
      createdAt: new Date(
        typeof raw['created_at'] === 'number' ? raw['created_at'] * 1000 : Date.now(),
      ),
      errorCode: typeof raw['error_code'] === 'string' ? raw['error_code'] : null,
    };
  }
}
