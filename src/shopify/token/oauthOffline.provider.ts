/**
 * OAuth offline token provider.
 *
 * Resolves a per-merchant access token that the OAuth redirect flow captured and
 * stored (encrypted) on the Store document. This is the OAUTH_OFFLINE strategy
 * the token seam was designed for: nothing downstream changes, because the
 * Shopify client already asks for a token by shop domain.
 *
 * Offline tokens do not expire, so there is nothing to refresh on a timer. The
 * cache exists purely to avoid a Mongo read plus a decrypt on every Admin API
 * call; `invalidate()` drops it so a reinstall is picked up immediately.
 *
 * https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/authorization-code-grant
 */

import { AppError } from '../../common/errors';
import { decodeEncryptionKey, decryptSecret } from '../../common/crypto';
import { logger } from '../../common/logger';
import { config } from '../../config';
import { getDatabaseStatus } from '../../database/mongo';
import { StoreModel } from '../../database/models/Store';
import { isTokenUsable, type CachedToken } from './token.cache';
import type { ShopifyTokenProvider, TokenDiagnostics } from './token.types';

/** Loads the stored row for a shop. Injectable so the provider is testable. */
export type StoredTokenLoader = (shopDomain: string) => Promise<{
  accessTokenEncrypted: string | null;
  tokenScopes: string[];
  uninstalledAt: Date | null;
} | null>;

const mongoTokenLoader: StoredTokenLoader = async (shopDomain) => {
  const store = await StoreModel.findOne({ shopDomain })
    .select('accessTokenEncrypted tokenScopes uninstalledAt')
    .lean();
  if (store === null) return null;
  return {
    accessTokenEncrypted: store.accessTokenEncrypted ?? null,
    tokenScopes: store.tokenScopes ?? [],
    uninstalledAt: store.uninstalledAt ?? null,
  };
};

interface ProviderState {
  token: CachedToken | null;
  inFlight: Promise<CachedToken> | null;
  fetchCount: number;
  lastFetchedAt: number | null;
  lastError: string | null;
}

export class OAuthOfflineTokenProvider implements ShopifyTokenProvider {
  readonly strategy = 'OAUTH_OFFLINE' as const;
  /**
   * True: on a 401 the client calls invalidate() and asks again, which re-reads
   * the database. That is a real recovery path - a merchant who reinstalled has
   * a new token waiting there. The client only ever retries once, so a
   * still-invalid token cannot cause a loop.
   */
  readonly canRefresh = true;

  private readonly loader: StoredTokenLoader;
  private readonly now: () => number;
  private readonly states = new Map<string, ProviderState>();

  constructor(options: { loader?: StoredTokenLoader; now?: () => number } = {}) {
    this.loader = options.loader ?? mongoTokenLoader;
    this.now = options.now ?? Date.now;
  }

  private stateFor(shopDomain: string): ProviderState {
    let state = this.states.get(shopDomain);
    if (state === undefined) {
      state = {
        token: null,
        inFlight: null,
        fetchCount: 0,
        lastFetchedAt: null,
        lastError: null,
      };
      this.states.set(shopDomain, state);
    }
    return state;
  }

  async getAccessToken(shopDomain: string): Promise<CachedToken> {
    const state = this.stateFor(shopDomain);

    if (isTokenUsable(state.token, this.now())) {
      return state.token as CachedToken;
    }

    // Single-flight, matching the client credentials provider: a burst of
    // parallel dashboard requests must not each hit Mongo and decrypt.
    if (state.inFlight !== null) return state.inFlight;

    const request = this.loadToken(shopDomain, state)
      .catch((error: unknown) => {
        state.lastError = error instanceof Error ? error.message : 'Token load failed.';
        throw error;
      })
      .finally(() => {
        state.inFlight = null;
      });

    state.inFlight = request;
    return request;
  }

  private async loadToken(
    shopDomain: string,
    state: ProviderState,
  ): Promise<CachedToken> {
    if (config.tokenEncryptionKey === null) {
      throw new AppError(
        'ENCRYPTION_NOT_CONFIGURED',
        'TOKEN_ENCRYPTION_KEY is not set, so the stored offline token cannot be decrypted.',
      );
    }
    if (getDatabaseStatus().status !== 'connected') {
      // Distinct from "not installed": the operator needs to know it is the
      // database that is missing, not the install.
      throw new AppError(
        'DATABASE_UNAVAILABLE',
        'SHOPIFY_AUTH_MODE=oauth stores tokens in MongoDB, but no database connection is available.',
      );
    }

    const stored = await this.loader(shopDomain);

    if (stored === null || stored.accessTokenEncrypted === null) {
      const detail =
        stored?.uninstalledAt != null
          ? 'The app was uninstalled from this store.'
          : 'No installation has been completed for this store.';
      throw new AppError(
        'SHOPIFY_NOT_CONFIGURED',
        `${detail} Visit /api/auth/install?shop=${shopDomain} to install the Trademart app and store an offline access token.`,
      );
    }

    const key = decodeEncryptionKey(config.tokenEncryptionKey);
    const accessToken = decryptSecret(stored.accessTokenEncrypted, key);

    const issuedAt = this.now();
    const token: CachedToken = {
      accessToken,
      issuedAt,
      // Offline tokens do not expire; null means "never goes stale".
      expiresAt: null,
      scopes: stored.tokenScopes,
    };

    state.token = token;
    state.fetchCount += 1;
    state.lastFetchedAt = issuedAt;
    state.lastError = null;

    logger.info('Loaded stored offline token for shop.', {
      shopDomain,
      scopeCount: token.scopes.length,
    });

    return token;
  }

  invalidate(shopDomain: string): void {
    const state = this.states.get(shopDomain);
    if (state === undefined) return;
    state.token = null;
    logger.warn('Discarded cached offline token; it will be re-read from the database.', {
      shopDomain,
    });
  }

  describe(shopDomain: string): TokenDiagnostics {
    const state = this.states.get(shopDomain);
    const token = state?.token ?? null;
    return {
      strategy: this.strategy,
      cached: isTokenUsable(token, this.now()),
      // Offline tokens are non-expiring, so these are always null.
      expiresAt: null,
      expiresInSeconds: null,
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
