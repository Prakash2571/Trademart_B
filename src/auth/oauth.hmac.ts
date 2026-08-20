/**
 * Shopify OAuth request HMAC verification.
 *
 * This is a DIFFERENT scheme from the webhook HMAC in webhooks/webhook.verify.ts
 * and the two must never be mixed up:
 *
 *                    | webhook delivery        | OAuth / install redirect
 *   -----------------+-------------------------+--------------------------------
 *   signed material  | raw request body bytes  | sorted query string
 *   digest encoding  | base64                  | hex
 *   header/param     | X-Shopify-Hmac-Sha256   | ?hmac= query parameter
 *   secret           | SHOPIFY_WEBHOOK_SECRET  | SHOPIFY_CLIENT_SECRET
 *
 * Algorithm: drop the `hmac` (and legacy `signature`) parameters, sort the rest
 * lexicographically by key, join as `key=value` with `&`, HMAC-SHA256 with the
 * app's client secret, and compare hex digests in constant time.
 * https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/authorization-code-grant
 *
 * Uses only node:crypto, so it is unit testable with no npm dependencies.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/** Parameters Shopify excludes from the signed material. */
const EXCLUDED_KEYS = new Set(['hmac', 'signature']);

export type OAuthHmacResult = { valid: true } | { valid: false; reason: string };

interface RawPair {
  key: string;
  /** Value exactly as it appeared on the wire, still percent-encoded. */
  rawValue: string;
}

/**
 * Splits a raw query string into pairs, preserving the original encoding.
 *
 * A leading '?' is tolerated so callers can pass either `req.originalUrl`'s tail
 * or `URL.search` without massaging it first.
 */
function parseRawPairs(rawQuery: string): RawPair[] {
  const trimmed = rawQuery.startsWith('?') ? rawQuery.slice(1) : rawQuery;
  if (trimmed.length === 0) return [];

  const pairs: RawPair[] = [];
  for (const segment of trimmed.split('&')) {
    if (segment.length === 0) continue;
    const separator = segment.indexOf('=');
    // A valueless parameter (`&foo&`) signs as an empty value, matching how
    // Shopify's own serialisation treats it.
    const key = separator === -1 ? segment : segment.slice(0, separator);
    const rawValue = separator === -1 ? '' : segment.slice(separator + 1);
    pairs.push({ key: decodeComponent(key), rawValue });
  }
  return pairs;
}

/** Percent-decodes, falling back to the raw text on malformed escapes. */
function decodeComponent(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    // decodeURIComponent throws on a stray '%'. A malformed escape cannot match
    // a legitimate signature anyway, so preserving the raw text is enough.
    return value;
  }
}

/**
 * Reads the `hmac` parameter out of a raw query string.
 * Returns null when absent, so the caller can distinguish "missing" from "wrong".
 */
export function extractHmacParam(rawQuery: string): string | null {
  for (const pair of parseRawPairs(rawQuery)) {
    if (pair.key === 'hmac') return decodeComponent(pair.rawValue);
  }
  return null;
}

/**
 * Builds the two signature bases we are willing to accept.
 *
 * Why two: Shopify sorts the parameters and joins them, but the exact encoding
 * of the values it signs has not been consistent across its own client
 * libraries, and the `host` parameter is base64 that can carry `=` padding -
 * precisely the character where an encoded and decoded form diverge. Verifying
 * against both candidates avoids rejecting genuine callbacks over an encoding
 * detail.
 *
 * This does not weaken the check: each candidate is still a full HMAC-SHA256
 * over a fixed, well-defined string keyed by the client secret. An attacker who
 * cannot forge one cannot forge the other.
 *
 * Exported for the tests, which assert the exact strings.
 */
export function buildSignatureBases(rawQuery: string): string[] {
  const pairs = parseRawPairs(rawQuery).filter((pair) => !EXCLUDED_KEYS.has(pair.key));

  // Sort by key. Shopify sorts lexicographically by code unit, which is what a
  // plain `<` comparison gives - NOT localeCompare, whose collation is locale
  // dependent and would reorder keys differently on some systems.
  const sorted = [...pairs].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const encoded = sorted.map((pair) => `${pair.key}=${pair.rawValue}`).join('&');
  const decoded = sorted
    .map((pair) => `${pair.key}=${decodeComponent(pair.rawValue)}`)
    .join('&');

  return encoded === decoded ? [encoded] : [encoded, decoded];
}

/** Hex HMAC-SHA256 of `message` under `secret`. */
export function computeOAuthHmac(message: string, secret: string): string {
  return createHmac('sha256', secret).update(message, 'utf8').digest('hex');
}

/** Constant-time hex digest comparison. */
function digestsMatch(expectedHex: string, providedHex: string): boolean {
  const expected = Buffer.from(expectedHex, 'hex');
  const provided = Buffer.from(providedHex.toLowerCase(), 'hex');
  // Bail before timingSafeEqual, which throws on a length mismatch.
  if (expected.length !== provided.length || expected.length === 0) return false;
  return timingSafeEqual(expected, provided);
}

/**
 * Verifies the `hmac` parameter of an OAuth callback or install request.
 *
 * `rawQuery` must be the query string AS RECEIVED. Re-serialising a parsed query
 * object can reorder or re-encode parameters and silently break verification.
 */
export function verifyOAuthHmac(
  rawQuery: string,
  clientSecret: string | null,
): OAuthHmacResult {
  if (clientSecret === null || clientSecret.length === 0) {
    return {
      valid: false,
      reason: 'SHOPIFY_CLIENT_SECRET is not configured on the server.',
    };
  }

  const provided = extractHmacParam(rawQuery);
  if (provided === null || provided.length === 0) {
    return { valid: false, reason: 'Missing hmac query parameter.' };
  }
  if (!/^[0-9a-fA-F]+$/.test(provided)) {
    return { valid: false, reason: 'hmac parameter is not a hex digest.' };
  }

  for (const base of buildSignatureBases(rawQuery)) {
    if (digestsMatch(computeOAuthHmac(base, clientSecret), provided)) {
      return { valid: true };
    }
  }

  return { valid: false, reason: 'hmac verification failed.' };
}
