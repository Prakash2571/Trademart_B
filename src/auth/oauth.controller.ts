/**
 * OAuth redirect flow routes.
 *
 * GET /api/auth/install   - starts the handshake (redirects to Shopify)
 * GET /api/auth/callback  - the "Allowed redirection URL" Shopify calls back
 * GET /api/auth/status    - non-secret diagnostics for the Settings page
 *
 * These are only needed for the redirect-based install. A single-store
 * deployment using Shopify-managed installation plus the client credentials
 * grant does not need them at all - see docs/OAUTH_AND_WEBHOOKS.md.
 *
 * Security order of operations on the callback (never reordered):
 *   1. verify the HMAC over the raw query string
 *   2. verify the signed state and that it is bound to this shop
 *   3. validate the shop domain
 *   4. only then exchange the code and store anything
 */

import { Router } from 'express';

import { AppError } from '../common/errors';
import { asyncHandler, sendSuccess } from '../common/http';
import { logger } from '../common/logger';
import {
  config,
  isOAuthConfigured,
  isTokenEncryptionConfigured,
} from '../config';
import { OAUTH_CALLBACK_PATH } from '../config/env.validation';
import { getDatabaseStatus } from '../database/mongo';
import { buildAuthorizeUrl, normaliseShopDomain } from './oauth.authorize';
import { verifyOAuthHmac } from './oauth.hmac';
import { createOAuthState, verifyOAuthState } from './oauth.state';
import { exchangeCodeForToken, persistOfflineToken } from './oauth.service';

export const oauthRouter = Router();

/**
 * Express strips the query string from `req.url` differently depending on the
 * mount path, and `req.query` is a PARSED object that cannot be re-serialised
 * byte-for-byte. HMAC verification needs the original string, so it is taken
 * from `req.originalUrl`.
 */
function rawQueryOf(originalUrl: string): string {
  const index = originalUrl.indexOf('?');
  return index === -1 ? '' : originalUrl.slice(index + 1);
}

function requireOAuthConfigured(): void {
  if (isOAuthConfigured()) return;

  const missing: string[] = [];
  if (config.appUrl === null) missing.push('APP_URL');
  if (config.shopify.clientId === null) missing.push('SHOPIFY_CLIENT_ID');
  if (config.shopify.clientSecret === null) missing.push('SHOPIFY_CLIENT_SECRET');

  throw new AppError(
    'OAUTH_NOT_CONFIGURED',
    `The OAuth redirect flow is not configured. Missing: ${missing.join(', ')}.`,
  );
}

/**
 * Starts the install. Shopify also calls the app URL directly with `shop`,
 * `timestamp` and `hmac` when a merchant installs from the App Store, so an
 * `hmac` is verified when present but not demanded - a human pasting this URL to
 * begin an install has no way to produce one.
 */
oauthRouter.get(
  '/install',
  asyncHandler(async (req, res) => {
    requireOAuthConfigured();

    const rawQuery = rawQueryOf(req.originalUrl);
    if (rawQuery.includes('hmac=')) {
      const verification = verifyOAuthHmac(rawQuery, config.shopify.clientSecret);
      if (!verification.valid) {
        logger.warn('Rejected install request with an invalid HMAC.', {
          reason: verification.reason,
        });
        throw new AppError('OAUTH_INVALID_HMAC', verification.reason);
      }
    }

    const shopDomain = normaliseShopDomain(req.query['shop']);
    // Non-null: requireOAuthConfigured() proved all three are set.
    const clientId = config.shopify.clientId as string;
    const clientSecret = config.shopify.clientSecret as string;
    const redirectUri = config.shopify.oauthRedirectUri as string;

    const state = createOAuthState(shopDomain, clientSecret);
    const authorizeUrl = buildAuthorizeUrl({
      shopDomain,
      clientId,
      scopes: config.shopify.scopes,
      redirectUri,
      state,
    });

    logger.info('Starting Shopify OAuth handshake.', {
      shopDomain,
      scopeCount: config.shopify.scopes.length,
    });

    // 302 rather than 301: the handshake is not a permanent redirect and must
    // never be cached by the browser.
    res.redirect(302, authorizeUrl);
  }),
);

oauthRouter.get(
  '/callback',
  asyncHandler(async (req, res) => {
    requireOAuthConfigured();

    const rawQuery = rawQueryOf(req.originalUrl);
    const clientSecret = config.shopify.clientSecret as string;

    // 1. Prove the request came from Shopify before trusting ANY parameter.
    const hmacResult = verifyOAuthHmac(rawQuery, clientSecret);
    if (!hmacResult.valid) {
      logger.warn('Rejected OAuth callback: HMAC verification failed.', {
        reason: hmacResult.reason,
      });
      throw new AppError('OAUTH_INVALID_HMAC', hmacResult.reason);
    }

    // 2. Prove we started this handshake (CSRF).
    const stateParam = typeof req.query['state'] === 'string' ? req.query['state'] : undefined;
    const stateResult = verifyOAuthState(stateParam, clientSecret);
    if (!stateResult.valid) {
      logger.warn('Rejected OAuth callback: state verification failed.', {
        reason: stateResult.reason,
      });
      throw new AppError('OAUTH_STATE_INVALID', stateResult.reason);
    }

    // 3. The shop in the callback must be the shop the state was issued for.
    //    Without this the state proves only "we started some handshake", not
    //    "we started THIS handshake".
    const shopDomain = normaliseShopDomain(req.query['shop']);
    if (shopDomain !== stateResult.shopDomain) {
      logger.warn('Rejected OAuth callback: shop does not match the signed state.', {
        shopDomain,
      });
      throw new AppError(
        'OAUTH_STATE_INVALID',
        'The shop in the callback does not match the shop the handshake was started for.',
      );
    }

    const code = req.query['code'];
    if (typeof code !== 'string' || code.length === 0) {
      throw new AppError('OAUTH_INVALID_REQUEST', 'Missing authorization code.');
    }

    // 4. Verified - now exchange and store.
    const token = await exchangeCodeForToken(shopDomain, code);
    await persistOfflineToken(shopDomain, token);

    // Hand the merchant back to the dashboard. `shop` is included so the
    // frontend can show which store was connected; no token ever crosses this
    // boundary.
    const target = new URL(config.frontendUrl);
    target.pathname = '/dashboard';
    target.searchParams.set('installed', '1');
    target.searchParams.set('shop', shopDomain);
    res.redirect(302, target.toString());
  }),
);

oauthRouter.get(
  '/status',
  asyncHandler(async (_req, res) => {
    // Booleans and non-secret identifiers only.
    sendSuccess(res, {
      configured: isOAuthConfigured(),
      authMode: config.shopify.authMode,
      appUrl: config.appUrl,
      /**
       * The exact string to paste into "Allowed redirection URL(s)" in the
       * Shopify Dev Dashboard. Surfaced because Shopify compares it verbatim and
       * a hand-typed mismatch is the most common install failure.
       */
      redirectUri: config.shopify.oauthRedirectUri,
      callbackPath: OAUTH_CALLBACK_PATH,
      requestedScopes: config.shopify.scopes,
      installPath: '/api/auth/install',
      tokenEncryptionConfigured: isTokenEncryptionConfigured(),
      persistenceAvailable: getDatabaseStatus().status === 'connected',
      note:
        config.shopify.authMode === 'oauth'
          ? 'SHOPIFY_AUTH_MODE=oauth - stored per-merchant offline tokens are preferred over the client credentials grant.'
          : 'SHOPIFY_AUTH_MODE=auto - the client credentials grant is used for Admin API calls. Installing via OAuth stores a token but does not change how requests authenticate.',
    });
  }),
);
