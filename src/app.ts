/**
 * Express application assembly.
 *
 * Middleware order matters here:
 *  1. security headers
 *  2. CORS restricted to the configured frontend origin
 *  3. webhook RECEIVER first, because HMAC verification needs the raw body and a
 *     global JSON parser would consume it
 *  4. JSON parser + rate limiting for the normal API surface
 *  5. 404 handler, then the terminal error handler
 *
 * The webhook receiver and the webhook admin routes are deliberately two
 * different routers: only the receiver needs the raw body, and mounting the
 * admin routes before the JSON parser would leave them unable to read a body.
 */

import cors from 'cors';
import express, { type Express } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';

import { errorHandler, notFoundHandler } from './common/errorHandler';
import { analyticsRouter } from './analytics/analytics.controller';
import { oauthRouter } from './auth/oauth.controller';
import { config } from './config';
import { customersRouter } from './customers/customers.controller';
import { healthRouter } from './health/health.controller';
import { inventoryRouter } from './inventory/inventory.controller';
import { ordersRouter } from './orders/orders.controller';
import { pricingRouter } from './pricing/pricing.controller';
import { productsRouter } from './products/products.controller';
import { shopifyRouter } from './shopify/shopify.controller';
import { suppliersRouter } from './suppliers/suppliers.controller';
import {
  webhookAdminRouter,
  webhooksRouter,
} from './webhooks/webhooks.controller';

export function createApp(): Express {
  const app = express();

  // Trust the first proxy hop so rate limiting sees real client IPs when
  // running behind a tunnel (e.g. Shopify CLI) or a reverse proxy.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(helmet());

  // Only the configured frontend origin may call this API from a browser.
  app.use(
    cors({
      origin: [config.frontendUrl],
      methods: ['GET', 'POST', 'OPTIONS'],
      allowedHeaders: ['Content-Type'],
      credentials: false,
      maxAge: 86400,
    }),
  );

  // Webhooks before the JSON parser (raw body required for HMAC).
  app.use('/api', webhooksRouter);

  app.use(express.json({ limit: '1mb' }));

  app.use(
    '/api',
    rateLimit({
      windowMs: 60_000,
      limit: 300,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: {
        success: false,
        code: 'RATE_LIMITED',
        message: 'Too many requests. Please slow down.',
      },
    }),
  );

  app.use('/api', healthRouter);
  // OAuth redirect flow. Mounted after the JSON parser (these are ordinary GET
  // redirects, not raw-body routes) and inside the rate limiter.
  app.use('/api/auth', oauthRouter);
  // Webhook registration/admin routes. Separate from webhooksRouter because
  // those must stay ahead of express.json() for raw-body HMAC verification.
  app.use('/api', webhookAdminRouter);
  app.use('/api/shopify', shopifyRouter);
  app.use('/api/shopify', productsRouter);
  app.use('/api/shopify', ordersRouter);
  app.use('/api/shopify', customersRouter);
  app.use('/api/shopify', inventoryRouter);
  app.use('/api', pricingRouter);
  app.use('/api', analyticsRouter);
  app.use('/api', suppliersRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
