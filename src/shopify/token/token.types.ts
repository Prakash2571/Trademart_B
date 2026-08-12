/**
 * Token provider abstraction.
 *
 * This is the seam that keeps multi-merchant OAuth addable later without
 * touching the Shopify client or any controller. Everything that needs a token
 * asks a provider for one *by shop domain*, so a per-store implementation drops
 * straight in.
 *
 *   now      : CLIENT_CREDENTIALS - app's own client id/secret, single store
 *   optional : STATIC_TOKEN       - a pre-issued token supplied via env
 *   later    : OAUTH_OFFLINE      - per-merchant tokens from the database
 *
 * Every method is keyed by `shopDomain` even though only one store is supported
 * today; that is deliberate, so the signatures do not have to change.
 */

import type { CachedToken } from './token.cache';

export type AuthStrategy = 'CLIENT_CREDENTIALS' | 'STATIC_TOKEN' | 'OAUTH_OFFLINE';

export interface TokenDiagnostics {
  strategy: AuthStrategy;
  /** True when a usable token is currently held in memory. */
  cached: boolean;
  /** ISO timestamp of expiry, or null for non-expiring tokens. */
  expiresAt: string | null;
  expiresInSeconds: number | null;
  /** Scopes Shopify granted. Empty when unknown (static tokens don't report them). */
  scopes: string[];
  /** Number of times a token has been fetched since boot. */
  fetchCount: number;
  lastFetchedAt: string | null;
  lastError: string | null;
}

export interface ShopifyTokenProvider {
  readonly strategy: AuthStrategy;

  /**
   * True when the provider can obtain a fresh token unaided. False for
   * STATIC_TOKEN, where a rejected token needs human intervention - so the
   * client must not loop trying to "refresh" it.
   */
  readonly canRefresh: boolean;

  /** Returns a usable token, fetching or refreshing as required. */
  getAccessToken(shopDomain: string): Promise<CachedToken>;

  /**
   * Drops the cached token. Called when Shopify rejects it with 401 so the next
   * request transparently obtains a new one.
   */
  invalidate(shopDomain: string): void;

  /** Non-secret status for the diagnostics endpoints. Never returns the token. */
  describe(shopDomain: string): TokenDiagnostics;
}

/** Raw JSON body returned by POST /admin/oauth/access_token. */
export interface RawTokenResponse {
  access_token?: unknown;
  scope?: unknown;
  expires_in?: unknown;
  error?: unknown;
  error_description?: unknown;
}

/**
 * Injectable transport, so the provider's caching/refresh behaviour can be unit
 * tested without any network access.
 */
export type TokenFetcher = (input: {
  shopDomain: string;
  clientId: string;
  clientSecret: string;
}) => Promise<{ status: number; body: RawTokenResponse }>;
