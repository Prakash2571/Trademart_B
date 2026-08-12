/**
 * Access token cache arithmetic.
 *
 * Pure and import-free so the expiry/refresh policy is unit testable without a
 * network or a clock.
 *
 * Shopify's client credentials grant returns a SHORT-LIVED token: `expires_in`
 * is typically 86399 (~24h) but 3599 (~1h) also occurs, so the lifetime is
 * always taken from the response and never hardcoded.
 * https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/client-credentials-grant
 */

export interface CachedToken {
  accessToken: string;
  /** Epoch ms when Shopify says the token stops working. Null = no expiry. */
  expiresAt: number | null;
  /** Epoch ms when we obtained it. */
  issuedAt: number;
  /** Scopes Shopify actually granted, parsed from the `scope` field. */
  scopes: string[];
}

/**
 * How long before real expiry we treat a token as stale, so a request never
 * goes out with a token that expires mid-flight.
 */
export const DEFAULT_SAFETY_WINDOW_MS = 5 * 60 * 1000;

/**
 * The effective safety window.
 *
 * A fixed 5 minutes would be longer than the whole lifetime of a very
 * short-lived token, which would make every token look stale the moment it
 * arrived and cause an infinite refresh loop. So the window is capped at half
 * the token's actual lifetime.
 */
export function effectiveSafetyWindowMs(
  token: CachedToken,
  safetyWindowMs: number = DEFAULT_SAFETY_WINDOW_MS,
): number {
  if (token.expiresAt === null) return 0;
  const lifetime = token.expiresAt - token.issuedAt;
  if (lifetime <= 0) return 0;
  return Math.min(safetyWindowMs, Math.floor(lifetime / 2));
}

/** True when the token can still be used for a request right now. */
export function isTokenUsable(
  token: CachedToken | null,
  now: number,
  safetyWindowMs: number = DEFAULT_SAFETY_WINDOW_MS,
): boolean {
  if (token === null) return false;
  if (token.accessToken.length === 0) return false;
  // A token with no expiry (legacy static token) never goes stale.
  if (token.expiresAt === null) return true;
  return now < token.expiresAt - effectiveSafetyWindowMs(token, safetyWindowMs);
}

/**
 * Converts Shopify's `expires_in` (seconds) into an absolute epoch-ms deadline.
 * Returns null when absent or unusable, meaning "treat as non-expiring".
 */
export function computeExpiresAt(expiresIn: unknown, now: number): number | null {
  if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn)) return null;
  if (expiresIn <= 0) return null;
  return now + Math.floor(expiresIn * 1000);
}

/** Parses the space/comma separated `scope` string Shopify returns. */
export function parseScopes(scope: unknown): string[] {
  if (typeof scope !== 'string' || scope.trim().length === 0) return [];
  return scope
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** Seconds until expiry, for diagnostics. Null when non-expiring. */
export function secondsUntilExpiry(
  token: CachedToken | null,
  now: number,
): number | null {
  if (token === null || token.expiresAt === null) return null;
  return Math.max(0, Math.round((token.expiresAt - now) / 1000));
}
