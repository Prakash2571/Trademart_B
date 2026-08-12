/**
 * Client credentials grant provider.
 *
 * Exchanges the app's own client id + secret for an Admin API access token, with
 * no human interaction and nothing to paste into .env:
 *
 *   POST https://{shop}.myshopify.com/admin/oauth/access_token
 *   { client_id, client_secret, grant_type: "client_credentials" }
 *   -> { access_token, scope, expires_in }
 *
 * Requires the app to be installed on the store. Tokens are short-lived, so
 * they are cached and refreshed automatically shortly before expiry.
 *
 * https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/client-credentials-grant
 * https://shopify.dev/docs/apps/build/dev-dashboard/get-api-access-tokens
 */

import { AppError } from '../../common/errors';
import { logger } from '../../common/logger';
import { mapTokenFailure } from '../shopify.errors';
import {
  computeExpiresAt,
  isTokenUsable,
  parseScopes,
  secondsUntilExpiry,
  type CachedToken,
} from './token.cache';
import type {
  RawTokenResponse,
  ShopifyTokenProvider,
  TokenDiagnostics,
  TokenFetcher,
} from './token.types';

const TOKEN_REQUEST_TIMEOUT_MS = 15000;

/** Real transport. Kept separate so tests can substitute it. */
export const httpTokenFetcher: TokenFetcher = async ({
  shopDomain,
  clientId,
  clientSecret,
}) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TOKEN_REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`https://${shopDomain}/admin/oauth/access_token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'client_credentials',
      }),
      signal: controller.signal,
    });

    let body: RawTokenResponse = {};
    const text = await response.text();
    if (text.length > 0) {
      try {
        body = JSON.parse(text) as RawTokenResponse;
      } catch {
        body = { error: 'invalid_json' };
      }
    }
    return { status: response.status, body };
  } finally {
    clearTimeout(timeout);
  }
};

interface ProviderState {
  token: CachedToken | null;
  /** Shared promise so concurrent callers trigger only one token request. */
  inFlight: Promise<CachedToken> | null;
  fetchCount: number;
  lastFetchedAt: number | null;
  lastError: string | null;
}

export class ClientCredentialsTokenProvider implements ShopifyTokenProvider {
  readonly strategy = 'CLIENT_CREDENTIALS' as const;
  readonly canRefresh = true;

  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly fetcher: TokenFetcher;
  private readonly now: () => number;
  /** Keyed by shop domain so a per-merchant provider is a drop-in later. */
  private readonly states = new Map<string, ProviderState>();

  constructor(options: {
    clientId: string;
    clientSecret: string;
    fetcher?: TokenFetcher;
    now?: () => number;
  }) {
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.fetcher = options.fetcher ?? httpTokenFetcher;
    this.now = options.now ?? Date.now;
  }

  private stateFor(shopDomain: string): ProviderState {
    let state = this.states.get(shopDomain);
    if (state === undefined) {
      state = { token: null, inFlight: null, fetchCount: 0, lastFetchedAt: null, lastError: null };
      this.states.set(shopDomain, state);
    }
    return state;
  }

  async getAccessToken(shopDomain: string): Promise<CachedToken> {
    const state = this.stateFor(shopDomain);

    if (isTokenUsable(state.token, this.now())) {
      return state.token as CachedToken;
    }

    // Single-flight: a burst of parallel requests must not each ask Shopify for
    // a token (that would waste calls and risk rate limiting).
    if (state.inFlight !== null) {
      return state.inFlight;
    }

    const request = this.requestToken(shopDomain, state)
      .catch((error: unknown) => {
        state.lastError = error instanceof Error ? error.message : 'Token request failed.';
        throw error;
      })
      .finally(() => {
        state.inFlight = null;
      });

    state.inFlight = request;
    return request;
  }

  private async requestToken(
    shopDomain: string,
    state: ProviderState,
  ): Promise<CachedToken> {
    const isRefresh = state.token !== null;
    logger.info(
      isRefresh
        ? 'Refreshing Shopify access token (client credentials).'
        : 'Requesting Shopify access token (client credentials).',
      { shopDomain },
    );

    let result: { status: number; body: RawTokenResponse };
    try {
      result = await this.fetcher({
        shopDomain,
        clientId: this.clientId,
        clientSecret: this.clientSecret,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown';
      throw new AppError(
        'SHOPIFY_NETWORK_ERROR',
        `Could not reach Shopify to obtain an access token: ${reason}`,
        { retryable: true },
      );
    }

    const accessToken = result.body.access_token;
    if (result.status < 200 || result.status >= 300 || typeof accessToken !== 'string') {
      // mapTokenFailure turns Shopify's documented error bodies into an
      // actionable message (bad secret vs. app not installed).
      throw mapTokenFailure(result.status, result.body);
    }

    const issuedAt = this.now();
    const token: CachedToken = {
      accessToken,
      issuedAt,
      expiresAt: computeExpiresAt(result.body.expires_in, issuedAt),
      scopes: parseScopes(result.body.scope),
    };

    state.token = token;
    state.fetchCount += 1;
    state.lastFetchedAt = issuedAt;
    state.lastError = null;

    // Log the lifetime and scopes, never the token itself.
    logger.info('Shopify access token obtained.', {
      shopDomain,
      expiresInSeconds: secondsUntilExpiry(token, issuedAt),
      scopeCount: token.scopes.length,
    });

    return token;
  }

  invalidate(shopDomain: string): void {
    const state = this.states.get(shopDomain);
    if (state === undefined) return;
    state.token = null;
    logger.warn('Discarded cached Shopify access token; a new one will be requested.', {
      shopDomain,
    });
  }

  describe(shopDomain: string): TokenDiagnostics {
    const state = this.states.get(shopDomain);
    const now = this.now();
    const token = state?.token ?? null;
    return {
      strategy: this.strategy,
      cached: isTokenUsable(token, now),
      expiresAt: token?.expiresAt === null || token === null
        ? null
        : new Date(token.expiresAt).toISOString(),
      expiresInSeconds: secondsUntilExpiry(token, now),
      scopes: token?.scopes ?? [],
      fetchCount: state?.fetchCount ?? 0,
      lastFetchedAt:
        state?.lastFetchedAt === null || state?.lastFetchedAt === undefined
          ? null
          : new Date(state.lastFetchedAt).toISOString(),
      lastError: state?.lastError ?? null,
    };
  }
}
