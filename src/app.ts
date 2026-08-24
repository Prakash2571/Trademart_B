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
import { httpLogger } from './common/httpLogger';
import { REQUEST_ID_HEADER, requestIdMiddleware } from './common/requestId';
import { helmetOptions } from './common/securityHeaders';
import { analyticsRouter } from './analytics/analytics.controller';
import { automationRouter } from './automation/automation.controller';
import { oauthRouter } from './auth/oauth.controller';
import { operatorRouter } from './auth/operator/operator.controller';
import {
  requireOperator,
  requireOperatorForReads,
  requireOperatorForWrites,
} from './auth/operator/operator.middleware';
import { auditRouter } from './audit/audit.controller';
import { config } from './config';
import { customersRouter } from './customers/customers.controller';
import { dropshippingRouter } from './dropshipping/dropshipping.controller';
import { dropshippingWriteRouter } from './dropshipping/dropshipping.write.controller';
import { intelligenceRouter } from './intelligence/intelligence.controller';
import { intelligenceWriteRouter } from './intelligence/intelligence.write.controller';
import {
  diagnosticsRouter,
  publicDiagnosticsRouter,
} from './diagnostics/diagnostics.controller';
import { healthRouter } from './health/health.controller';
import { inventoryRouter } from './inventory/inventory.controller';
import { inventoryWriteRouter } from './inventory/inventory.write.controller';
import { ordersRouter } from './orders/orders.controller';
import { pricingRouter } from './pricing/pricing.controller';
import { productsRouter } from './products/products.controller';
import { productsWriteRouter } from './products/products.write.controller';
import {
  publicationsRouter,
  publicationsWriteRouter,
} from './shopify/publications/publications.controller';
import { shopifyRouter } from './shopify/shopify.controller';
import { themesRouter } from './shopify/themes/themes.controller';
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

  // FIRST, before anything that can fail. Every log line, error body and audit
  // row produced while serving this request needs the correlation id - including
  // failures raised inside body parsing, CORS and rate limiting below.
  app.use(requestIdMiddleware());
  app.use(httpLogger());

  // Restrictive CSP is safe here because this app serves ONLY JSON: nginx routes
  // `/` and `/_next/static/` to the Next.js container and only `/api/` here, so
  // these directives can never apply to the UI. The frontend's own CSP is a
  // separate concern and is NOT set from this process.
  app.use(helmet(helmetOptions()));

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
      // Idempotency-Key and X-Request-ID must be listed or the browser preflight
      // rejects them, which would silently disable both features for every
      // cross-origin request from the console.
      allowedHeaders: [
        'Content-Type',
        'X-CSRF-Token',
        'Authorization',
        'Idempotency-Key',
        REQUEST_ID_HEADER,
      ],
      credentials: true,
      maxAge: 86400,
      // Lets the browser READ the correlation id off the response, so the UI can
      // show an id the operator can quote. Without this a cross-origin fetch
      // cannot see the header at all and it would be backend-only.
      exposedHeaders: [REQUEST_ID_HEADER],
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
  // reports only booleans and connection state. /health/live is the container
  // liveness probe; /health/ready is for a load balancer or a deploy gate.
  app.use('/api', healthRouter);

  // Also public: build identity only (version, commit, build time), all of which
  // is in the repository anyway. A deploy check has to read it before sign-in.
  app.use('/api', publicDiagnosticsRouter);

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
  // Product EDIT (PATCH). Separate router behind the write guard so mutations
  // always require an operator, while the read router above can stay open.
  app.use('/api/shopify', requireOperatorForWrites, productsWriteRouter);
  // Publication (sales-channel) reads stay open like other reads; publish /
  // unpublish are mutations behind the write guard.
  app.use('/api/shopify', requireOperatorForReads, publicationsRouter);
  app.use('/api/shopify', requireOperatorForWrites, publicationsWriteRouter);
  app.use('/api/shopify', requireOperatorForReads, ordersRouter);
  app.use('/api/shopify', requireOperatorForReads, customersRouter);
  app.use('/api/shopify', requireOperatorForReads, inventoryRouter);
  // Inventory writes (set quantity) + locations. Behind the write guard so
  // setting stock always requires an operator; the GET locations stays open.
  app.use('/api/shopify', requireOperatorForWrites, inventoryWriteRouter);
  // Storefront/theme reads. Read-only: no write path exists yet, and the live
  // theme is never modified directly (see themes/theme.guard.ts).
  app.use('/api', requireOperatorForReads, themesRouter);
  app.use('/api', requireOperatorForReads, pricingRouter);
  app.use('/api', requireOperatorForReads, analyticsRouter);
  app.use('/api', requireOperatorForReads, suppliersRouter);
  // Manual supplier costs: GET is a read, PUT/DELETE are operator-protected
  // writes. Mounted with the write guard, which leaves GET open by default.
  app.use('/api', requireOperatorForWrites, manualCostRouter);
  // The audit trail is a read, but a privileged one: it records who changed what.
  // Always behind the full operator requirement, never the writes-only guard, so
  // it cannot be read anonymously even with OPERATOR_PROTECT_READS left at false.
  app.use('/api', requireOperator, auditRouter);
  // Integrity findings name products and their visibility, so they follow the
  // normal read guard.
  app.use('/api', requireOperatorForReads, diagnosticsRouter);
  // Dropshipping is a READ-ONLY view over Shopify orders - there is no write
  // surface, so the read guard is the whole story. Fulfilling, refunding and
  // cancelling deliberately stay in Shopify.
  app.use('/api', requireOperatorForReads, dropshippingRouter);
  // Dropshipping SETTINGS are a write, on their own router. They change which orders
  // are flagged and what price Research recommends - never a price in Shopify.
  app.use('/api', requireOperatorForWrites, dropshippingWriteRouter);
  // Product research reads: the candidate shortlist, scores and duplicate checks.
  app.use('/api', requireOperatorForReads, intelligenceRouter);
  // Research writes, including Push as Draft. That route creates a DRAFT and can never
  // publish (see intelligence/push.draft.ts); publishing stays in the publications
  // module, done by an operator who has read the listing.
  app.use('/api', requireOperatorForWrites, intelligenceWriteRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
