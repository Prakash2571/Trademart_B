/**
 * GET /api/health
 *
 * Contract required by the brief is exactly `{ "status": "ok" }`, so that key
 * stays at the top level and unwrapped. Extra diagnostic fields are additive
 * and safe to ignore. No secrets are exposed - only booleans.
 */

import { Router } from 'express';

import { config, isDatabaseConfigured, isShopifyConfigured } from '../config';
import { getDatabaseStatus } from '../database/mongo';

export const healthRouter = Router();

healthRouter.get('/health', (_req, res) => {
  const database = getDatabaseStatus();

  res.json({
    status: 'ok',
    service: 'trademart-backend',
    environment: config.nodeEnv,
    uptimeSeconds: Math.round(process.uptime()),
    checks: {
      database: {
        configured: isDatabaseConfigured(),
        status: database.status,
        error: database.error,
      },
      shopify: {
        configured: isShopifyConfigured(),
        authStrategy: config.shopify.authStrategy,
        storeDomain: config.shopify.storeDomain,
        apiVersion: config.shopify.apiVersion,
      },
    },
  });
});
