/**
 * Shopify connection routes.
 *
 * GET /api/shopify/shop    - connection test + basic shop info
 * GET /api/shopify/status  - configuration/connectivity summary (never a token)
 */

import { Router } from 'express';

import { asyncHandler, sendSuccess } from '../common/http';
import { AppError } from '../common/errors';
import { config, isShopifyConfigured } from '../config';
import { getLastThrottleStatus } from './shopify.client';
import { getShop } from './shopify.service';

export const shopifyRouter = Router();

shopifyRouter.get(
  '/shop',
  asyncHandler(async (req, res) => {
    // ?fresh=1 bypasses the short-lived cache (used by the Settings page).
    const shop = await getShop({ useCache: req.query['fresh'] !== '1' });
    sendSuccess(res, shop, { throttle: getLastThrottleStatus() });
  }),
);

shopifyRouter.get(
  '/status',
  asyncHandler(async (_req, res) => {
    // Deliberately reports only booleans and non-secret identifiers.
    const base = {
      configured: isShopifyConfigured(),
      storeDomain: config.shopify.storeDomain,
      apiVersion: config.shopify.apiVersion,
      graphqlEndpoint: config.shopify.graphqlEndpoint,
      hasAccessToken: config.shopify.accessToken !== null,
      hasWebhookSecret: config.shopify.webhookSecret !== null,
      hasOauthCredentials:
        config.shopify.clientId !== null && config.shopify.clientSecret !== null,
    };

    if (!isShopifyConfigured()) {
      sendSuccess(res, {
        ...base,
        connected: false,
        shop: null,
        error: {
          code: 'SHOPIFY_NOT_CONFIGURED',
          message:
            'SHOPIFY_ACCESS_TOKEN is not set in the backend .env file. Supply it and restart the server.',
        },
      });
      return;
    }

    try {
      const shop = await getShop();
      sendSuccess(res, { ...base, connected: true, shop, error: null });
    } catch (error) {
      // Status must always answer 200 with a diagnosis - the dashboard relies
      // on it to render a connection banner rather than a crashed page.
      const appError =
        error instanceof AppError
          ? error
          : new AppError('INTERNAL_ERROR', 'Unexpected error contacting Shopify.');
      sendSuccess(res, {
        ...base,
        connected: false,
        shop: null,
        error: { code: appError.code, message: appError.message },
      });
    }
  }),
);
