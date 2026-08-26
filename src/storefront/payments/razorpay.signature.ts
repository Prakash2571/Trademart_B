import { createHmac, timingSafeEqual } from 'node:crypto';

function secureHexEqual(expected: string, provided: string | undefined): boolean {
  if (!provided || !/^[0-9a-fA-F]+$/.test(provided)) return false;
  const expectedBytes = Buffer.from(expected, 'hex');
  const providedBytes = Buffer.from(provided, 'hex');
  return (
    expectedBytes.length > 0 &&
    expectedBytes.length === providedBytes.length &&
    timingSafeEqual(expectedBytes, providedBytes)
  );
}

export function computeRazorpayPaymentSignature(
  serverRazorpayOrderId: string,
  razorpayPaymentId: string,
  keySecret: string,
): string {
  return createHmac('sha256', keySecret)
    .update(`${serverRazorpayOrderId}|${razorpayPaymentId}`, 'utf8')
    .digest('hex');
}

/** The order id argument must come from the persisted checkout, never the browser. */
export function verifyRazorpayPaymentSignature(input: {
  serverRazorpayOrderId: string;
  razorpayPaymentId: string;
  providedSignature: string | undefined;
  keySecret: string;
}): boolean {
  return secureHexEqual(
    computeRazorpayPaymentSignature(
      input.serverRazorpayOrderId,
      input.razorpayPaymentId,
      input.keySecret,
    ),
    input.providedSignature,
  );
}

export function computeRazorpayWebhookSignature(
  rawBody: Buffer | string,
  webhookSecret: string,
): string {
  return createHmac('sha256', webhookSecret)
    .update(Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, 'utf8'))
    .digest('hex');
}

export function verifyRazorpayWebhookSignature(input: {
  rawBody: Buffer | undefined;
  providedSignature: string | undefined;
  webhookSecret: string;
}): boolean {
  if (!input.rawBody) return false;
  return secureHexEqual(
    computeRazorpayWebhookSignature(input.rawBody, input.webhookSecret),
    input.providedSignature,
  );
}
