/**
 * CSRF protection, double-submit cookie pattern.
 *
 * The session cookie alone is not enough. A cookie is attached by the browser to
 * ANY request to this origin, including one triggered by a malicious page, so a
 * cookie-authenticated mutation endpoint is forgeable without a second factor
 * the attacker cannot read or set.
 *
 * How this works:
 *   1. The server sets a random token in a NON-HttpOnly cookie, so the frontend
 *      JavaScript can read it (that is the point - it must be able to echo it).
 *   2. Mutations must send the same value in the X-CSRF-Token header.
 *   3. The server requires the two to match.
 *
 * A cross-origin attacker can cause the cookie to be sent but cannot read it
 * (same-origin policy) and cannot set a custom header on a simple form post, so
 * they cannot produce a matching pair. SameSite=Lax on the session cookie is a
 * second, independent layer.
 *
 * This is only required for COOKIE-authenticated requests. A request
 * authenticated by an explicit Authorization header is not forgeable this way -
 * a browser will not attach that header automatically - so API-key clients are
 * exempt (see operator.middleware.ts).
 *
 * Pure apart from node:crypto.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';

const TOKEN_BYTES = 32;

/** Generates a fresh CSRF token. */
export function createCsrfToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/**
 * Constant-time comparison of the cookie value and the header value.
 *
 * Both must be present and identical. An empty value never matches, so a
 * missing cookie cannot be satisfied by sending an empty header.
 */
export function csrfTokensMatch(
  cookieToken: string | undefined,
  headerToken: string | undefined,
): boolean {
  if (
    cookieToken === undefined ||
    headerToken === undefined ||
    cookieToken.length === 0 ||
    headerToken.length === 0
  ) {
    return false;
  }

  const a = Buffer.from(cookieToken, 'utf8');
  const b = Buffer.from(headerToken, 'utf8');
  // Length inequality is itself a mismatch, and comparing different lengths
  // would make timingSafeEqual throw.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** HTTP methods that change state and therefore require a CSRF token. */
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** True when this method needs CSRF verification. */
export function methodRequiresCsrf(method: string): boolean {
  return MUTATING_METHODS.has(method.toUpperCase());
}
