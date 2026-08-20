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
 *
 * AUTHENTICATION BOUNDARY
 * -----------------------
 * Public by design, each for a specific reason:
 *   /api/health              uptime probes must not need a credential
 *   /api/operator/*          you cannot sign in if signing in needs a sign-in
 *   /api/auth/*              Shopify calls the OAuth callback; secured by HMAC
 *   /api/webhooks/shopify    Shopify cannot sign in; secured by HMAC
 *
 * Everything else requires an operator for state-changing methods, and for
 * reads too when OPERATOR_PROTECT_READS=true.
 */

import cors from 'cors';
import express, { type Express } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';

import { errorHandler, notFoundHandler } from './common/errorHandler';
import { analyticsRouter } from './analytics/analytics.controller';
import { automationRouter } from './automation/automation.controller';
import { oauthRouter } from './auth/oauth.controller';
import { operatorRouter } from './auth/operator/operator.controller';
import {
  requireOperatorForReads,
  requireOperatorForWrites,
} from './auth/operator/operator.middleware';
import { config } from './config';
import { customersRouter } from './customers/customers.controller';
import { healthRouter } from './health/health.controller';
import { inventoryRouter } from './inventory/inventory.controller';
import { ordersRouter } from './orders/orders.controller';
import { pricingRouter } from './pricing/pricing.controller';
import { productsRouter } from './products/products.controller';
import { shopifyRouter } from './shopify/shopify.controller';
import { manualCostRouter } from './suppliers/manualCost.controller';
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
  //
  // credentials:true is required for the operator session cookie to be sent
  // cross-origin (local dev: :3000 -> :4000). It is safe ONLY because `origin`
  // is an explicit allowlist - the CORS spec forbids credentials with a wildcard
  // origin, and echoing an arbitrary origin here would defeat the whole policy.
  //
  // Note this is defence in depth, not authentication: CORS is enforced by the
  // browser and does nothing about curl. Authentication is requireOperator.
  app.use(
    cors({
      origin: [config.frontendUrl],
      // PUT/PATCH/DELETE are needed by the management API (e.g. PUT
      // /api/automation/rules, which existed but was unreachable from a browser
      // because preflight rejected the method).
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'X-CSRF-Token', 'Authorization'],
      credentials: true,
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

  // Health stays public: an uptime probe must not need a credential, and it
  // reports only booleans and connection state.
  app.use('/api', healthRouter);

  // Operator sign-in. NOT behind requireOperator - you cannot authenticate if
  // authenticating requires being authenticated.
  app.use('/api/operator', operatorRouter);

  // Shopify OAuth redirect flow. Public by necessity: Shopify itself calls
  // /callback and cannot present an operator credential. It is protected
  // instead by HMAC + a signed state nonce (see auth/oauth.hmac.ts).
  app.use('/api/auth', oauthRouter);

  // ---- Management surface: mutations require an authenticated operator -----
  //
  // requireOperatorForWrites leaves GETs readable while guarding every
  // state-changing method, so enabling auth cannot black out a dashboard whose
  // login screen is not deployed yet. Set OPERATOR_PROTECT_READS=true to
  // additionally require a session for reads.
  //
  // webhookAdminRouter is separate from webhooksRouter because the receiver must
  // stay ahead of express.json() for raw-body HMAC verification - and the
  // receiver must NOT be behind operator auth, since Shopify cannot sign in.
  app.use('/api', requireOperatorForWrites, webhookAdminRouter);
  app.use('/api', requireOperatorForWrites, automationRouter);

  // ---- Read surface --------------------------------------------------------
  app.use('/api/shopify', requireOperatorForReads, shopifyRouter);
  app.use('/api/shopify', requireOperatorForReads, productsRouter);
  app.use('/api/shopify', requireOperatorForReads, ordersRouter);
  app.use('/api/shopify', requireOperatorForReads, customersRouter);
  app.use('/api/shopify', requireOperatorForReads, inventoryRouter);
  app.use('/api', requireOperatorForReads, pricingRouter);
  app.use('/api', requireOperatorForReads, analyticsRouter);
  app.use('/api', requireOperatorForReads, suppliersRouter);
  // Manual supplier costs: GET is a read, PUT/DELETE are operator-protected
  // writes. Mounted with the write guard, which leaves GET open by default.
  app.use('/api', requireOperatorForWrites, manualCostRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
