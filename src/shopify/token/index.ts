/**
 * Chooses the token provider from configuration.
 *
 * Precedence:
 *   1. SHOPIFY_ACCESS_TOKEN set  -> STATIC_TOKEN (explicit override wins)
 *   2. client id + secret set    -> CLIENT_CREDENTIALS (the normal path)
 *   3. neither                   -> null, and Shopify routes report
 *                                   SHOPIFY_NOT_CONFIGURED
 *
 * When multi-merchant OAuth is added, this is the only place that needs to
 * learn about it: return an OAuth-offline provider that resolves tokens per
 * shop from the database. Nothing downstream changes, because everything
 * already asks for a token by shop domain.
 */

import { config } from '../../config';
import { logger } from '../../common/logger';
import { ClientCredentialsTokenProvider } from './clientCredentials.provider';
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
export { StaticTokenProvider } from './static.provider';
