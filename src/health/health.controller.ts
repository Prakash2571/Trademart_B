/**
 * GET /api/health        - the original combined probe
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
 *
 * WHAT THESE ROUTES DISCLOSE
 * --------------------------
 * They are PUBLIC, because a load balancer cannot sign in - so they answer the
 * question they exist for and nothing else. The identifying detail (store domain,
 * API version, auth strategy, NODE_ENV, and the Mongo driver error, which leaks
 * hosts and sometimes URI fragments) is returned only when the caller proves they
 * are an operator. Same URL, same keys, same probe contract: see health.payload.ts.
 */

import { Router, type Request } from 'express';

import { resolveOperator } from '../auth/operator/operator.middleware';
import { getVersionInfo } from '../common/version';
import { config, isDatabaseConfigured, isShopifyConfigured } from '../config';
import { getDatabaseStatus } from '../database/mongo';
import { getBreakerState } from '../shopify/shopify.breaker';
import { buildHealthPayload, buildReadinessPayload, type HealthInputs } from './health.payload';

export const healthRouter = Router();

/**
 * Collects the probe inputs.
 *
 * `resolveOperator` is used WITHOUT a response object on purpose: a health probe
 * must never be given a refreshed session cookie, and it must never fail because
 * authentication is unconfigured. It only ever answers "is this an operator".
 */
function healthInputs(req: Request): HealthInputs {
  const database = getDatabaseStatus();
  return {
    detailed: resolveOperator(req) !== null,
    nodeEnv: config.nodeEnv,
    uptimeSeconds: Math.round(process.uptime()),
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
  };
}

healthRouter.get('/health', (req, res) => {
  res.json(buildHealthPayload(healthInputs(req)));
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

healthRouter.get('/health/ready', (req, res) => {
  const version = getVersionInfo();
  const { status, body } = buildReadinessPayload({
    ...healthInputs(req),
    version: version.version,
    gitSha: version.gitShaShort,
    // Cached breaker state, not a live call. 'open' means Shopify has been failing
    // repeatedly, which is worth reporting to an operator without making it a
    // readiness failure: reads may still work and the console is still usable.
    shopifyBreaker: getBreakerState(),
  });
  res.status(status).json(body);
});
