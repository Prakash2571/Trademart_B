/**
 * GET /api/health        - the original combined probe (unchanged contract)
 * GET /api/health/live   - is the process alive?
 * GET /api/health/ready  - can it usefully serve traffic?
 *
 * WHY THE SPLIT MATTERS
 * ---------------------
 * A single endpoint forces one answer to two different questions, and a
 * container orchestrator does different things with each. Liveness failing means
 * RESTART ME; readiness failing means STOP SENDING TRAFFIC. Wiring readiness into
 * a Docker healthcheck that restarts the container turns a temporary Mongo blip
 * into a crash loop - the restart cannot fix a dependency that lives elsewhere.
 *
 * So /health/live checks nothing but this process, and never fails while the
 * event loop is turning. /health/ready checks dependencies.
 *
 * Neither probe calls Shopify. A probe that runs every few seconds must not spend
 * Shopify rate-limit budget, so readiness uses cached state observed from real
 * traffic instead.
 */

import { Router } from 'express';

import { getVersionInfo } from '../common/version';
import { config, isDatabaseConfigured, isShopifyConfigured } from '../config';
import { getDatabaseStatus } from '../database/mongo';
import { getBreakerState } from '../shopify/rateLimit.service';

export const healthRouter = Router();

/**
 * The original endpoint, kept byte-compatible.
 *
 * `status: 'ok'` stays at the top level and unwrapped because that is the
 * documented contract and existing probes read it.
 */
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

/**
 * Liveness. Deliberately trivial.
 *
 * If this responds at all, the process is up and the event loop is not blocked,
 * which is the only thing a restart could fix. It checks no dependency on
 * purpose: a database outage must not cause the container to be killed.
 */
healthRouter.get('/health/live', (_req, res) => {
  res.json({
    status: 'ok',
    live: true,
    uptimeSeconds: Math.round(process.uptime()),
  });
});

/**
 * Readiness. Can this instance do useful work right now?
 *
 * Mongo is required only when it is CONFIGURED. Trademart deliberately runs
 * without a database (Shopify reads and pricing still work), so treating an
 * absent MONGODB_URI as not-ready would report a supported configuration as
 * broken. A configured database that is failing is a real readiness problem.
 */
healthRouter.get('/health/ready', (_req, res) => {
  const database = getDatabaseStatus();
  const version = getVersionInfo();

  const databaseReady =
    !isDatabaseConfigured() || database.status === 'connected';
  const shopifyConfigured = isShopifyConfigured();
  // Cached breaker state, not a live call. 'open' means Shopify has been failing
  // repeatedly, which is worth reporting without making it a readiness failure:
  // reads may still work and the instance can still serve the console.
  const shopifyBreaker = getBreakerState();

  const ready = databaseReady && shopifyConfigured;

  res.status(ready ? 200 : 503).json({
    status: ready ? 'ok' : 'unavailable',
    ready,
    version: version.version,
    gitSha: version.gitShaShort,
    checks: {
      database: {
        required: isDatabaseConfigured(),
        configured: isDatabaseConfigured(),
        status: database.status,
        ready: databaseReady,
        error: database.error,
      },
      shopifyConfiguration: {
        configured: shopifyConfigured,
        authStrategy: config.shopify.authStrategy,
        ready: shopifyConfigured,
      },
      shopifyConnectivity: {
        // Explicit about provenance so nobody reads this as a live probe.
        source: 'cached-from-real-traffic',
        circuitBreaker: shopifyBreaker,
        degraded: shopifyBreaker === 'open',
      },
    },
    note: ready
      ? 'Dependencies are usable. Shopify is not probed by health checks - its state here is observed from real traffic.'
      : 'Not ready: see checks. Use /api/health/live for the liveness probe, which must not fail because a dependency is down.',
  });
});
