/**
 * OAuth `state` nonce: creation and verification.
 *
 * `state` defends against CSRF on the callback - without it, an attacker can
 * feed our callback an authorization code obtained for a shop of their choosing
 * and get the backend to install/store a token it never asked for.
 *
 * The state is SIGNED AND SELF-CONTAINED rather than stored server-side:
 *
 *   base64url(`<shopDomain>:<issuedAtMs>:<nonce>`) + '.' + hex HMAC of that
 *
 * Rationale: Mongo is optional in this codebase (see database/mongo.ts, which
 * degrades to "no persistence" rather than failing), so a state table would make
 * OAuth silently unavailable exactly when persistence is down. A signed state
 * needs no storage, and binding the shop domain into the signed payload is what
 * actually blocks the substitution attack - the callback compares the shop it
 * was called with against the shop inside the state.
 *
 * The trade-off is that a signed state cannot be single-use without storage, so
 * replay is bounded by a short TTL instead. That is the same trade-off Shopify's
 * own cookie-based state makes.
 *
 * Uses only node:crypto, so it is unit testable with no npm dependencies.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * How long an install handshake may take. Long enough for a merchant to read
 * and accept the permission screen, short enough to bound replay.
 */
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

const NONCE_BYTES = 16;

export type OAuthStateResult =
  | { valid: true; shopDomain: string; issuedAt: number }
  | { valid: false; reason: string };

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function base64UrlDecode(value: string): string {
  return Buffer.from(value, 'base64url').toString('utf8');
}

/**
 * Creates a signed state bound to `shopDomain`.
 *
 * `nonce` and `now` are injectable so tests are deterministic; production always
 * uses crypto-random bytes and the real clock.
 */
export function createOAuthState(
  shopDomain: string,
  secret: string,
  options: { now?: number; nonce?: string } = {},
): string {
  const now = options.now ?? Date.now();
  const nonce = options.nonce ?? randomBytes(NONCE_BYTES).toString('hex');
  // ':' is safe as a separator because a myshopify domain cannot contain one and
  // the nonce is hex.
  const payload = base64UrlEncode(`${shopDomain}:${now}:${nonce}`);
  return `${payload}.${sign(payload, secret)}`;
}

/**
 * Verifies a state returned by Shopify.
 *
 * Order of checks is deliberate: the signature is verified BEFORE the payload is
 * parsed or trusted, so an unsigned payload never influences control flow.
 */
export function verifyOAuthState(
  state: string | undefined,
  secret: string | null,
  options: { now?: number; ttlMs?: number } = {},
): OAuthStateResult {
  if (secret === null || secret.length === 0) {
    return {
      valid: false,
      reason: 'SHOPIFY_CLIENT_SECRET is not configured on the server.',
    };
  }
  if (state === undefined || state.length === 0) {
    return { valid: false, reason: 'Missing state parameter.' };
  }

  const separator = state.lastIndexOf('.');
  if (separator <= 0 || separator === state.length - 1) {
    return { valid: false, reason: 'state parameter is malformed.' };
  }

  const payload = state.slice(0, separator);
  const providedSignature = state.slice(separator + 1);

  const expected = Buffer.from(sign(payload, secret), 'hex');
  const provided = Buffer.from(providedSignature.toLowerCase(), 'hex');
  if (expected.length !== provided.length || expected.length === 0) {
    return { valid: false, reason: 'state signature is invalid.' };
  }
  if (!timingSafeEqual(expected, provided)) {
    return { valid: false, reason: 'state signature is invalid.' };
  }

  // Signature verified - only now is the payload safe to read.
  let decoded: string;
  try {
    decoded = base64UrlDecode(payload);
  } catch {
    return { valid: false, reason: 'state payload is not valid base64url.' };
  }

  const parts = decoded.split(':');
  if (parts.length !== 3) {
    return { valid: false, reason: 'state payload is malformed.' };
  }

  const [shopDomain, issuedAtRaw] = parts as [string, string, string];
  if (shopDomain.length === 0) {
    return { valid: false, reason: 'state payload has no shop domain.' };
  }
  if (!/^\d+$/.test(issuedAtRaw)) {
    return { valid: false, reason: 'state payload has an invalid timestamp.' };
  }

  const issuedAt = Number(issuedAtRaw);
  const now = options.now ?? Date.now();
  const ttlMs = options.ttlMs ?? OAUTH_STATE_TTL_MS;

  if (now - issuedAt > ttlMs) {
    return { valid: false, reason: 'state has expired; restart the installation.' };
  }
  // A state from the future means a forged or badly skewed timestamp. Allowing a
  // small negative skew avoids spurious failures between hosts.
  if (issuedAt - now > 60_000) {
    return { valid: false, reason: 'state timestamp is in the future.' };
  }

  return { valid: true, shopDomain, issuedAt };
}
