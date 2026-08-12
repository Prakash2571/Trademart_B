/**
 * GET /api/analytics/overview   - aggregates over real Shopify orders
 * GET /api/analytics/traffic    - honest "unavailable" response
 * GET /api/dashboard/summary    - single call powering the dashboard
 */

import { Router } from 'express';

import { AppError } from '../common/errors';
import { asyncHandler, sendSuccess } from '../common/http';
import { parseIntParam } from '../common/validate';
import { config, isShopifyConfigured } from '../config';
import { getDatabaseStatus } from '../database/mongo';
import { getCounts, getShop, listOrders } from '../shopify/shopify.service';
import { buildOverview, getTrafficAvailability } from './analytics.service';

export const analyticsRouter = Router();

analyticsRouter.get(
  '/analytics/overview',
  asyncHandler(async (req, res) => {
    const limit = parseIntParam(req.query['limit'], 'limit', {
      min: 1,
      max: 250,
      fallback: 100,
    });

    // Shopify caps a single page at 250; request in one page for the MVP.
    const first = Math.min(limit, 250);
    const result = await listOrders({ first });
    const overview = buildOverview(result.items, {
      truncated: result.meta.hasNextPage,
    });

    // An empty store yields no currency from orders; use the shop's own so
    // zero totals are still labelled. getShop() is cached, so this is cheap.
    if (overview.currencyCode === null) {
      try {
        overview.currencyCode = (await getShop()).currencyCode;
      } catch {
        // Leave it null rather than guessing - the UI renders a bare number.
      }
    }

    sendSuccess(res, overview, result.meta.degraded ? { degraded: result.meta.degraded } : undefined);
  }),
);

analyticsRouter.get(
  '/analytics/traffic',
  asyncHandler(async (_req, res) => {
    // Returned as data (not an error) so the UI can render an explanatory card.
    sendSuccess(res, getTrafficAvailability());
  }),
);

analyticsRouter.get(
  '/dashboard/summary',
  asyncHandler(async (_req, res) => {
    const database = getDatabaseStatus();
    const errors: { source: string; code: string; message: string }[] = [];

    const summary: Record<string, unknown> = {
      shopify: {
        configured: isShopifyConfigured(),
        storeDomain: config.shopify.storeDomain,
        apiVersion: config.shopify.apiVersion,
        connected: false,
        shop: null as unknown,
      },
      database: { configured: config.mongoUri !== null, status: database.status },
      counts: { products: null, orders: null, customers: null },
      revenue: null as unknown,
      pendingFulfillmentCount: null as number | null,
      errors,
    };

    if (!isShopifyConfigured()) {
      errors.push({
        source: 'shopify',
        code: 'SHOPIFY_NOT_CONFIGURED',
        message:
          'No Shopify credentials are configured. Set SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET in the backend .env file and restart.',
      });
      sendSuccess(res, summary);
      return;
    }

    // Each block degrades independently so one missing scope cannot blank the
    // entire dashboard.
    let shopCurrencyCode: string | null = null;
    try {
      const shop = await getShop();
      shopCurrencyCode = shop.currencyCode;
      summary['shopify'] = {
        configured: true,
        storeDomain: config.shopify.storeDomain,
        apiVersion: config.shopify.apiVersion,
        connected: true,
        shop,
      };
    } catch (error) {
      const appError = error instanceof AppError ? error : null;
      errors.push({
        source: 'shopify.shop',
        code: appError?.code ?? 'INTERNAL_ERROR',
        message: appError?.message ?? 'Could not load shop information.',
      });
    }

    // Each count issue reports its own code - an auth failure must not be
    // presented as a missing scope.
    const { counts, issues } = await getCounts();
    summary['counts'] = counts;
    for (const issue of issues) {
      errors.push({ source: issue.source, code: issue.code, message: issue.message });
    }

    try {
      const orders = await listOrders({ first: 100 });
      const overview = buildOverview(orders.items, { truncated: orders.meta.hasNextPage });
      summary['revenue'] = {
        // With no orders there is nothing to infer a currency from, so fall
        // back to the shop's own currency - otherwise a zero total renders as a
        // bare "0.00" with no indication of what it is denominated in.
        currencyCode: overview.currencyCode ?? shopCurrencyCode,
        total: overview.totalRevenue,
        averageOrderValue: overview.averageOrderValue,
        window: overview.window,
      };
      summary['pendingFulfillmentCount'] = overview.pendingFulfillmentCount;
    } catch (error) {
      const appError = error instanceof AppError ? error : null;
      errors.push({
        source: 'shopify.orders',
        code: appError?.code ?? 'INTERNAL_ERROR',
        message: appError?.message ?? 'Could not load orders.',
      });
    }

    sendSuccess(res, summary);
  }),
);
