import { createHash } from 'node:crypto';

import { StorefrontError } from '../checkout/storefront.error';

export interface SafeRazorpayWebhook {
  eventId: string;
  eventType: string;
  payment: {
    razorpayOrderId: string | null;
    razorpayPaymentId: string | null;
    amountPaise: number | null;
    currency: string | null;
    status: string | null;
    captured: boolean;
    failureCode: string | null;
  };
}

function rawObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Parse only the fields needed for reconciliation; discard contact/card/method data. */
export function parseSafeRazorpayWebhook(
  rawBody: Buffer,
  headerEventId: string | undefined,
): SafeRazorpayWebhook {
  let decoded: unknown;
  try {
    decoded = JSON.parse(rawBody.toString('utf8'));
  } catch {
    throw new StorefrontError('VALIDATION_ERROR', 'Webhook body was not valid JSON.', 400);
  }
  const root = rawObject(decoded);
  const eventType = typeof root?.['event'] === 'string' ? root['event'] : '';
  if (!/^[a-z.]{3,80}$/.test(eventType)) {
    throw new StorefrontError('VALIDATION_ERROR', 'Webhook event type was invalid.', 400);
  }
  const payload = rawObject(root?.['payload']);
  const paymentWrapper = rawObject(payload?.['payment']);
  const payment = rawObject(paymentWrapper?.['entity']);
  const bodyHash = createHash('sha256').update(rawBody).digest('hex');
  const eventId =
    headerEventId && /^[A-Za-z0-9_-]{8,128}$/.test(headerEventId)
      ? headerEventId
      : `body_${bodyHash}`;

  return {
    eventId,
    eventType,
    payment: {
      razorpayOrderId: typeof payment?.['order_id'] === 'string' ? payment['order_id'] : null,
      razorpayPaymentId: typeof payment?.['id'] === 'string' ? payment['id'] : null,
      amountPaise: Number.isSafeInteger(payment?.['amount']) ? (payment!['amount'] as number) : null,
      currency: typeof payment?.['currency'] === 'string' ? payment['currency'] : null,
      status: typeof payment?.['status'] === 'string' ? payment['status'] : null,
      captured: payment?.['captured'] === true,
      failureCode: typeof payment?.['error_code'] === 'string' ? payment['error_code'] : null,
    },
  };
}
