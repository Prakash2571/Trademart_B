import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import { StorefrontError } from '../checkout/storefront.error';

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export function assertTrackingSecret(secret: string | null | undefined): string {
  if (!secret || Buffer.byteLength(secret, 'utf8') < 32) {
    throw new StorefrontError(
      'INTERNAL_ERROR',
      'Secure order tracking is not configured.',
      503,
    );
  }
  return secret;
}

/** Re-derivable across idempotent retries; the public token remains 256-bit and unguessable. */
export function deriveTrackingToken(publicId: string, secret: string): string {
  return createHmac('sha256', assertTrackingSecret(secret))
    .update(`kanay-store:tracking:v1:${publicId}`, 'utf8')
    .digest('base64url');
}

export function deriveCheckoutStatusToken(publicId: string, secret: string): string {
  return createHmac('sha256', assertTrackingSecret(secret))
    .update(`kanay-store:checkout-status:v1:${publicId}`, 'utf8')
    .digest('base64url');
}

export function hashTrackingToken(token: string): string {
  if (!TOKEN.test(token)) {
    throw new StorefrontError('TRACKING_NOT_FOUND', 'Order tracking link is invalid.', 404);
  }
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function trackingTokenMatches(token: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashTrackingToken(token), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
