/**
 * OAuth authorization code grant: code exchange and offline-token persistence.
 *
 * The pure parts of the flow live next door and are unit tested independently:
 *   oauth.hmac.ts      - proving a request came from Shopify
 *   oauth.state.ts     - CSRF nonce creation/verification
 *   oauth.authorize.ts - shop validation + authorize URL
 *
 * This module owns only the side effects: one HTTPS POST and one Mongo write.
 *
 * https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/authorization-code-grant
 */

import { AppError } from '../common/errors';
import { decodeEncryptionKey, encryptSecret } from '../common/crypto';
import { logger } from '../common/logger';
import { config } from '../config';
import { getDatabaseStatus } from '../database/mongo';
import { StoreModel } from '../database/models/Store';
import { mapTokenFailure } from '../shopify/shopify.errors';
import { parseScopes } from '../shopify/token/token.cache';
import type { RawTokenResponse } from '../shopify/token/token.types';

const TOKEN_REQUEST_TIMEOUT_MS = 15000;

/**
 * Injectable transport, mirroring TokenFetcher in shopify/token/token.types.ts.
 * A separate type because the code grant sends `code` instead of a grant_type.
 */
export type CodeExchangeFetcher = (input: {
  shopDomain: string;
  clientId: string;
  clientSecret: string;
  code: string;
}) => Promise<{ status: number; body: RawTokenResponse }>;

export const httpCodeExchangeFetcher: CodeExchangeFetcher = async ({
  shopDomain,
  clientId,
  clientSecret,
  code,
}) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TOKEN_REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`https://${shopDomain}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
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

export interface ExchangedToken {
  accessToken: string;
  scopes: string[];
}

/**
 * Exchanges a one-time authorization code for an access token.
 *
 * The code is single-use and short-lived, so this is never retried: a second
 * attempt with the same code always fails, and retrying would just turn one
 * clear error into two.
 */
export async function exchangeCodeForToken(
  shopDomain: string,
  code: string,
  fetcher: CodeExchangeFetcher = httpCodeExchangeFetcher,
): Promise<ExchangedToken> {
  const { clientId, clientSecret } = config.shopify;
  if (clientId === null || clientSecret === null) {
    throw new AppError(
      'OAUTH_NOT_CONFIGURED',
      'SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET are required to complete the OAuth handshake.',
    );
  }

  let result: { status: number; body: RawTokenResponse };
  try {
    result = await fetcher({ shopDomain, clientId, clientSecret, code });
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown';
    throw new AppError(
      'SHOPIFY_NETWORK_ERROR',
      `Could not reach Shopify to exchange the authorization code: ${reason}`,
      { retryable: true },
    );
  }

  const accessToken = result.body.access_token;
  if (result.status < 200 || result.status >= 300 || typeof accessToken !== 'string') {
    // Reuses the same mapper as the client credentials grant, so "app not
    // installed" and "bad client secret" stay distinguishable here too.
    throw mapTokenFailure(result.status, result.body);
  }

  const scopes = parseScopes(result.body.scope);
  // Lifetime and scope count only - never the token.
  logger.info('Exchanged Shopify authorization code for an offline token.', {
    shopDomain,
    scopeCount: scopes.length,
  });

  return { accessToken, scopes };
}

/**
 * Encrypts and stores the offline token for a shop.
 *
 * Refuses to write anything when the key is missing: persisting a readable token
 * would be worse than failing the install, and the operator gets a clear reason.
 */
export async function persistOfflineToken(
  shopDomain: string,
  token: ExchangedToken,
): Promise<void> {
  if (config.tokenEncryptionKey === null) {
    throw new AppError(
      'ENCRYPTION_NOT_CONFIGURED',
      'TOKEN_ENCRYPTION_KEY is not set, so the offline access token cannot be stored safely. Set it and reinstall the app.',
    );
  }
  if (getDatabaseStatus().status !== 'connected') {
    throw new AppError(
      'DATABASE_UNAVAILABLE',
      'No database connection, so the offline access token cannot be stored. Set MONGODB_URI and retry the installation.',
    );
  }

  const key = decodeEncryptionKey(config.tokenEncryptionKey);
  const accessTokenEncrypted = encryptSecret(token.accessToken, key);

  await StoreModel.updateOne(
    { shopDomain },
    {
      $set: {
        shopDomain,
        apiVersion: config.shopify.apiVersion,
        accessTokenEncrypted,
        tokenScopes: token.scopes,
        installedAt: new Date(),
        // A fresh install clears any previous uninstall marker.
        uninstalledAt: null,
        lastConnectionError: null,
      },
    },
    { upsert: true },
  );

  logger.info('Stored encrypted offline token for shop.', {
    shopDomain,
    scopeCount: token.scopes.length,
  });
}

/**
 * Clears a stored token on uninstall, keeping the row for install history.
 *
 * Deliberately tolerant: an uninstall webhook for an unknown shop is not an
 * error worth failing the delivery over.
 */
export async function clearOfflineToken(shopDomain: string): Promise<void> {
  if (getDatabaseStatus().status !== 'connected') return;

  await StoreModel.updateOne(
    { shopDomain },
    {
      $set: {
        accessTokenEncrypted: null,
        tokenScopes: [],
        uninstalledAt: new Date(),
      },
    },
  );

  logger.info('Cleared stored offline token after uninstall.', { shopDomain });
}
