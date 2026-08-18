/**
 * Chooses the token provider from configuration.
 *
 * Precedence:
 *   1. SHOPIFY_ACCESS_TOKEN set  -> STATIC_TOKEN (explicit override wins)
 *   2. client id + secret set    -> CLIENT_CREDENTIALS (the normal path)
 *   3. neither                   -> null, and Shopify routes report
 *                                   SHOPIFY_NOT_CONFIGURED
 *
 * Multi-merchant OAuth slots in here and nowhere else: OAUTH_OFFLINE resolves
 * tokens per shop from the database. Nothing downstream changes, because
 * everything already asks for a token by shop domain.
 *
 * OAuth is opt-in via SHOPIFY_AUTH_MODE=oauth rather than being picked
 * automatically. Adding a redirect flow must not silently change how an
 * already-working single-store deployment authenticates, and both paths use the
 * same client id/secret - so presence of credentials cannot disambiguate them.
 */

import { config } from '../../config';
import { logger } from '../../common/logger';
import { ClientCredentialsTokenProvider } from './clientCredentials.provider';
import { OAuthOfflineTokenProvider } from './oauthOffline.provider';
import { StaticTokenProvider } from './static.provider';
import type { ShopifyTokenProvider } from './token.types';

let provider: ShopifyTokenProvider | null | undefined;

function build(): ShopifyTokenProvider | null {
  if (config.shopify.accessToken !== null) {
    logger.warn(
      'Using SHOPIFY_ACCESS_TOKEN override. Unset it to use the client credentials grant, which refreshes automatically.',
    );
    return new StaticTokenProvider(config.shopify.accessToken);
  }

  // Checked before client credentials: in oauth mode the stored per-merchant
  // token is the authority, even though the same client id/secret are also set
  // (they are needed to perform the handshake itself).
  if (config.shopify.authMode === 'oauth') {
    logger.info(
      'SHOPIFY_AUTH_MODE=oauth - Admin API calls will use the stored per-merchant offline token.',
    );
    return new OAuthOfflineTokenProvider();
  }

  if (config.shopify.clientId !== null && config.shopify.clientSecret !== null) {
    return new ClientCredentialsTokenProvider({
      clientId: config.shopify.clientId,
      clientSecret: config.shopify.clientSecret,
    });
  }

  return null;
}

/** Lazily built so config validation runs first. */
export function getTokenProvider(): ShopifyTokenProvider | null {
  if (provider === undefined) provider = build();
  return provider;
}

/** Test/diagnostic helper - forces the provider to be rebuilt. */
export function resetTokenProvider(): void {
  provider = undefined;
}

export type { ShopifyTokenProvider, TokenDiagnostics, AuthStrategy } from './token.types';
export type { CachedToken } from './token.cache';
export { ClientCredentialsTokenProvider } from './clientCredentials.provider';
export { OAuthOfflineTokenProvider } from './oauthOffline.provider';
export { StaticTokenProvider } from './static.provider';
