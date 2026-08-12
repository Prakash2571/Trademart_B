/**
 * Static token provider - optional escape hatch.
 *
 * Used only when SHOPIFY_ACCESS_TOKEN is set explicitly. Client credentials is
 * the primary path; this exists because admin-created custom apps still issue
 * long-lived tokens, and because it is useful for debugging against a known
 * token.
 *
 * `canRefresh` is false: if Shopify rejects a hardcoded token there is nothing
 * the process can do about it, so the client must surface the error instead of
 * retrying.
 */

import type { ShopifyTokenProvider, TokenDiagnostics } from './token.types';
import type { CachedToken } from './token.cache';

export class StaticTokenProvider implements ShopifyTokenProvider {
  readonly strategy = 'STATIC_TOKEN' as const;
  readonly canRefresh = false;

  private readonly token: CachedToken;

  constructor(accessToken: string, now: () => number = Date.now) {
    this.token = {
      accessToken,
      issuedAt: now(),
      // A supplied token has no discoverable expiry; treat as non-expiring and
      // let Shopify be the authority if it has in fact expired.
      expiresAt: null,
      scopes: [],
    };
  }

  async getAccessToken(): Promise<CachedToken> {
    return this.token;
  }

  invalidate(): void {
    // Nothing to invalidate - the value came from the environment.
  }

  describe(): TokenDiagnostics {
    return {
      strategy: this.strategy,
      cached: true,
      expiresAt: null,
      expiresInSeconds: null,
      scopes: [],
      fetchCount: 0,
      lastFetchedAt: null,
      lastError: null,
    };
  }
}
