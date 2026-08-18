/**
 * Authorize-URL construction and shop-domain validation.
 *
 * Pure (node builtins + the error model only) so the security-critical parts -
 * rejecting a hostile `shop` parameter and producing an exactly-correct
 * redirect_uri - are unit testable with no network.
 *
 * https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/authorization-code-grant
 */

import { AppError } from '../common/errors';
import { MYSHOPIFY_DOMAIN } from '../config/env.validation';

/**
 * Normalises and validates a merchant-supplied `shop` parameter.
 *
 * This is the single most security-sensitive input in the whole flow. The
 * authorize URL is built by interpolating it into a hostname, so an unvalidated
 * value is an open redirect (and an SSRF sink on the token exchange). Anything
 * that is not exactly `<store>.myshopify.com` is rejected - a hostname is never
 * "repaired" beyond stripping a scheme, a path and a trailing dot.
 *
 * The regex is imported from config/env.validation rather than redefined, so the
 * rule cannot drift between boot validation and request validation.
 */
export function normaliseShopDomain(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new AppError(
      'OAUTH_INVALID_REQUEST',
      'A shop query parameter is required, e.g. ?shop=your-store.myshopify.com.',
    );
  }

  const candidate = raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    // Drop anything from the first path separator, query or fragment onwards.
    .replace(/[/?#].*$/, '')
    // A trailing dot is a legal but equivalent FQDN form; Shopify rejects it.
    .replace(/\.$/, '');

  // Credentials or an explicit port in the authority are always an attack shape
  // here (e.g. "demo.myshopify.com@evil.test"), never a real store.
  if (candidate.includes('@') || candidate.includes(':')) {
    throw new AppError(
      'OAUTH_INVALID_REQUEST',
      'shop must be a plain myshopify.com hostname with no credentials or port.',
    );
  }

  if (candidate.startsWith('admin.shopify.com')) {
    throw new AppError(
      'OAUTH_INVALID_REQUEST',
      'shop must be the .myshopify.com domain, not the admin.shopify.com URL.',
    );
  }

  if (!MYSHOPIFY_DOMAIN.test(candidate)) {
    throw new AppError(
      'OAUTH_INVALID_REQUEST',
      `shop must look like your-store.myshopify.com (received "${raw}").`,
    );
  }

  return candidate;
}

export interface AuthorizeUrlInput {
  shopDomain: string;
  clientId: string;
  scopes: readonly string[];
  redirectUri: string;
  state: string;
  /**
   * Offline (default) yields a long-lived token tied to the shop, which is what
   * a background dashboard needs. Online yields a short-lived per-user token.
   */
  accessMode?: 'offline' | 'online';
}

/**
 * Builds the URL the merchant's browser is redirected to.
 *
 * `shopDomain` is expected to have been through `normaliseShopDomain` already;
 * it is re-checked here so this function is never the weak link if a future
 * caller forgets.
 */
export function buildAuthorizeUrl(input: AuthorizeUrlInput): string {
  const shopDomain = normaliseShopDomain(input.shopDomain);

  if (input.clientId.length === 0) {
    throw new AppError('OAUTH_NOT_CONFIGURED', 'SHOPIFY_CLIENT_ID is not configured.');
  }
  if (input.scopes.length === 0) {
    throw new AppError('OAUTH_NOT_CONFIGURED', 'No Shopify scopes are configured.');
  }
  if (!/^https?:\/\//.test(input.redirectUri)) {
    throw new AppError(
      'OAUTH_NOT_CONFIGURED',
      'APP_URL is not configured, so no redirect_uri can be built.',
    );
  }

  const url = new URL(`https://${shopDomain}/admin/oauth/authorize`);
  url.searchParams.set('client_id', input.clientId);
  // Shopify expects a comma-separated scope list.
  url.searchParams.set('scope', input.scopes.join(','));
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('state', input.state);

  // Offline is Shopify's default and is requested by OMITTING grant_options[].
  // Sending an empty grant_options[] is also valid but noisier; only the online
  // mode needs an explicit value.
  if (input.accessMode === 'online') {
    url.searchParams.set('grant_options[]', 'per-user');
  }

  return url.toString();
}
