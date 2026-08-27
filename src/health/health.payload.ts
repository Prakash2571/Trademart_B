/**
 * What a health probe is allowed to say, and to whom.
 *
 * WHY THIS IS A PURE MODULE, AND WHY THE SPLIT EXISTS
 * --------------------------------------------------
 * /api/health and /api/health/ready are PUBLIC - a load balancer and an uptime
 * probe cannot sign in. They were also reporting, to anyone who asked:
 *
 *   * the exact Shopify store domain (which merchant this is)
 *   * the Admin API version and auth strategy (which attack surface applies)
 *   * NODE_ENV
 *   * the Mongo connection error string, which routinely contains the host, the
 *     replica-set name and - in a driver message - fragments of the URI
 *
 * None of that is needed to decide "restart me" or "stop sending traffic", and
 * together it is a free reconnaissance report on the deployment. Health probes now
 * answer the question they exist for and nothing more; the detail is still there
 * for an authenticated operator, on the same URL.
 *
 * The shape is deliberately kept backwards compatible: `status: 'ok'` stays at the
 * top level and unwrapped, and every previously present KEY still exists for an
 * operator. Anonymous callers get the same keys with the identifying values
 * removed rather than a different document, so a probe asserting
 * `checks.database.status` keeps working.
 */

export type DatabaseProbeStatus = string;

export interface HealthInputs {
  /** True when the caller proved they are an operator. */
  detailed: boolean;
  nodeEnv: string;
  uptimeSeconds: number;
  database: {
    configured: boolean;
    status: DatabaseProbeStatus;
    /** Driver message. Operator-only: it leaks hosts and sometimes URI fragments. */
    error: string | null;
  };
  shopify: {
    configured: boolean;
    authStrategy: string;
    storeDomain: string;
    apiVersion: string;
  };
}

export interface ReadinessInputs extends HealthInputs {
  version: string;
  gitSha: string | null;
  /** Cached circuit-breaker state. Never a live Shopify call. */
  shopifyBreaker: string;
}

/** Value shown instead of a detail an anonymous caller may not see. */
export const WITHHELD = null;

export function buildHealthPayload(input: HealthInputs): Record<string, unknown> {
  return {
    status: 'ok',
    service: 'trademart-backend',
    // NODE_ENV tells an attacker whether they are looking at a hardened target.
    environment: input.detailed ? input.nodeEnv : WITHHELD,
    uptimeSeconds: input.uptimeSeconds,
    checks: {
      database: {
        configured: input.database.configured,
        // Kept for everyone: "is storage up" is the point of the probe.
        status: input.database.status,
        error: input.detailed ? input.database.error : WITHHELD,
      },
      shopify: {
        configured: input.shopify.configured,
        authStrategy: input.detailed ? input.shopify.authStrategy : WITHHELD,
        storeDomain: input.detailed ? input.shopify.storeDomain : WITHHELD,
        apiVersion: input.detailed ? input.shopify.apiVersion : WITHHELD,
      },
    },
    ...(input.detailed ? {} : { note: DETAIL_NOTE }),
  };
}

/**
 * Readiness.
 *
 * `ready` is the only field a load balancer needs, and it stays public. The
 * reasons behind it are operator-only for the same reason as above.
 *
 * Mongo counts only when CONFIGURED: Trademart deliberately runs without a
 * database (Shopify reads and pricing still work), so treating an absent
 * MONGODB_URI as not-ready would report a supported configuration as broken.
 */
export function computeReadiness(input: {
  databaseConfigured: boolean;
  databaseStatus: DatabaseProbeStatus;
  shopifyConfigured: boolean;
}): { ready: boolean; databaseReady: boolean } {
  const databaseReady = !input.databaseConfigured || input.databaseStatus === 'connected';
  return { ready: databaseReady && input.shopifyConfigured, databaseReady };
}

export function buildReadinessPayload(input: ReadinessInputs): {
  status: number;
  body: Record<string, unknown>;
} {
  const { ready, databaseReady } = computeReadiness({
    databaseConfigured: input.database.configured,
    databaseStatus: input.database.status,
    shopifyConfigured: input.shopify.configured,
  });

  const body: Record<string, unknown> = {
    status: ready ? 'ok' : 'unavailable',
    ready,
    // Build identity is public elsewhere (/api/version, by design), so repeating
    // it here discloses nothing new.
    version: input.version,
    gitSha: input.gitSha,
    checks: {
      database: {
        required: input.database.configured,
        configured: input.database.configured,
        status: input.database.status,
        ready: databaseReady,
        error: input.detailed ? input.database.error : WITHHELD,
      },
      shopifyConfiguration: {
        configured: input.shopify.configured,
        authStrategy: input.detailed ? input.shopify.authStrategy : WITHHELD,
        ready: input.shopify.configured,
      },
      shopifyConnectivity: {
        // Explicit about provenance so nobody reads this as a live probe.
        source: 'cached-from-real-traffic',
        circuitBreaker: input.detailed ? input.shopifyBreaker : WITHHELD,
        degraded: input.detailed ? input.shopifyBreaker === 'open' : WITHHELD,
      },
    },
    note: ready
      ? 'Dependencies are usable. Shopify is not probed by health checks - its state here is observed from real traffic.'
      : 'Not ready: see checks. Use /api/health/live for the liveness probe, which must not fail because a dependency is down.',
  };

  if (!input.detailed) body['detail'] = DETAIL_NOTE;
  return { status: ready ? 200 : 503, body };
}

const DETAIL_NOTE =
  'Some fields are withheld from unauthenticated callers. Sign in as an operator to see store domain, API version, environment and dependency error detail.';
