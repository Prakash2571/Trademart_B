/**
 * Shopify webhook HMAC verification.
 *
 * Shopify signs each delivery with HMAC-SHA256 over the RAW request body using
 * the app's webhook signing secret, base64-encoded in X-Shopify-Hmac-Sha256.
 * The signature MUST be verified before the payload is trusted or parsed.
 * https://shopify.dev/docs/apps/build/webhooks/subscribe/https
 *
 * Uses only node:crypto, so it is unit testable with no npm dependencies.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export type WebhookVerificationResult =
  | { valid: true }
  | { valid: false; reason: string };

export function computeWebhookHmac(rawBody: Buffer | string, secret: string): string {
  return createHmac('sha256', secret)
    .update(Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, 'utf8'))
    .digest('base64');
}

/**
 * Constant-time comparison of the provided and expected signatures.
 */
export function verifyWebhookSignature(
  rawBody: Buffer | string | undefined,
  headerSignature: string | undefined,
  secret: string | null,
): WebhookVerificationResult {
  if (secret === null || secret.length === 0) {
    return {
      valid: false,
      reason: 'SHOPIFY_WEBHOOK_SECRET is not configured on the server.',
    };
  }
  if (rawBody === undefined) {
    return { valid: false, reason: 'Raw request body was not captured.' };
  }
  if (headerSignature === undefined || headerSignature.length === 0) {
    return { valid: false, reason: 'Missing X-Shopify-Hmac-Sha256 header.' };
  }

  const expected = computeWebhookHmac(rawBody, secret);
  const expectedBuffer = Buffer.from(expected, 'base64');
  const providedBuffer = Buffer.from(headerSignature, 'base64');

  // Length mismatch means it cannot match; bail before timingSafeEqual throws.
  if (expectedBuffer.length !== providedBuffer.length || expectedBuffer.length === 0) {
    return { valid: false, reason: 'Signature mismatch.' };
  }

  return timingSafeEqual(expectedBuffer, providedBuffer)
    ? { valid: true }
    : { valid: false, reason: 'Signature mismatch.' };
}

/**
 * Shop domain validation - a delivery claiming to be from another shop must
 * never be processed.
 */
export function isExpectedShopDomain(
  headerDomain: string | undefined,
  expectedDomain: string,
): boolean {
  if (headerDomain === undefined) return false;
  return headerDomain.trim().toLowerCase() === expectedDomain.trim().toLowerCase();
}

/**
 * Topics Trademart registers, in Shopify's GraphQL enum form.
 *
 * `webhooks.service.ts` reconciles Shopify's registered subscriptions against
 * this list, so adding a topic here is all that is needed to start receiving it.
 *
 * APP_UNINSTALLED is not a data topic but it is the only one with a real handler
 * today: it clears the stored offline access token, which would otherwise sit in
 * the database after the merchant removed the app.
 */
export const PLANNED_WEBHOOK_TOPICS = [
  'APP_UNINSTALLED',
  // Drives automation: a stock change can hide or restore a product, and a
  // product change can move its cost per item.
  'INVENTORY_LEVELS_UPDATE',
  'ORDERS_CREATE',
  'ORDERS_UPDATED',
  'ORDERS_CANCELLED',
  'FULFILLMENTS_CREATE',
  'FULFILLMENTS_UPDATE',
  'PRODUCTS_CREATE',
  'PRODUCTS_UPDATE',
  'PRODUCTS_DELETE',
  'CUSTOMERS_CREATE',
  'CUSTOMERS_UPDATE',
] as const;
