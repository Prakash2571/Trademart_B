/**
 * Shopify rate-limit observability and the failure circuit breaker.
 *
 * Both read from data Shopify already gave us on real requests. Nothing here
 * ever calls Shopify just to ask how much quota is left - that would spend the
 * very budget it is reporting on.
 *
 * THE CIRCUIT BREAKER
 * -------------------
 * When Shopify is throttling or erroring persistently, continuing to fire a
 * 250-product bulk apply at it produces hundreds of individual failures, a
 * useless audit trail and a partially-applied plan. The breaker turns that into
 * one clear SHOPIFY_DEGRADED refusal.
 *
 * Reads are deliberately NOT blocked while the breaker is open. A preview only
 * needs reads, and being able to look at the store while writes are paused is
 * more useful than failing everything.
 */

import { AppError } from '../common/errors';
import { logger } from '../common/logger';
import { getLastThrottleStatus } from './shopify.client';
import type { ShopifyCostExtension } from './shopify.throttle';

/** Consecutive qualifying failures before writes are refused. */
const FAILURE_THRESHOLD = 5;
/** How long the breaker stays open before allowing a trial write again. */
const OPEN_MS = 60_000;
/** A quiet period after which the failure count decays back to zero. */
const FAILURE_DECAY_MS = 120_000;

export type BreakerState = 'closed' | 'open';

interface BreakerData {
  consecutiveFailures: number;
  lastFailureAt: number | null;
  openedAt: number | null;
  lastFailureCode: string | null;
}

const breaker: BreakerData = {
  consecutiveFailures: 0,
  lastFailureAt: null,
  openedAt: null,
  lastFailureCode: null,
};

/** Only infrastructure failures trip the breaker. */
const BREAKER_CODES = new Set([
  'SHOPIFY_THROTTLED',
  'SHOPIFY_TIMEOUT',
  'SHOPIFY_NETWORK_ERROR',
  'SHOPIFY_HTTP_ERROR',
]);

/**
 * Records the outcome of a Shopify call.
 *
 * A missing scope or a rejected mutation is NOT a breaker failure: retrying will
 * not help, and pausing writes store-wide because one product was invalid would
 * be wrong.
 */
export function recordShopifyOutcome(outcome: {
  ok: boolean;
  code?: string | undefined;
}): void {
  const now = Date.now();

  if (outcome.ok) {
    if (breaker.consecutiveFailures > 0 || breaker.openedAt !== null) {
      logger.info('Shopify recovered; closing the circuit breaker.', {
        previousFailures: breaker.consecutiveFailures,
      });
    }
    breaker.consecutiveFailures = 0;
    breaker.openedAt = null;
    breaker.lastFailureCode = null;
    return;
  }

  if (outcome.code === undefined || !BREAKER_CODES.has(outcome.code)) return;

  // Decay: isolated failures hours apart are not a degraded dependency.
  if (breaker.lastFailureAt !== null && now - breaker.lastFailureAt > FAILURE_DECAY_MS) {
    breaker.consecutiveFailures = 0;
  }

  breaker.consecutiveFailures += 1;
  breaker.lastFailureAt = now;
  breaker.lastFailureCode = outcome.code;

  if (breaker.consecutiveFailures >= FAILURE_THRESHOLD && breaker.openedAt === null) {
    breaker.openedAt = now;
    logger.error('Shopify looks degraded; pausing bulk writes.', {
      consecutiveFailures: breaker.consecutiveFailures,
      code: outcome.code,
      reopenAfterMs: OPEN_MS,
    });
  }
}

export function getBreakerState(): BreakerState {
  if (breaker.openedAt === null) return 'closed';
  if (Date.now() - breaker.openedAt >= OPEN_MS) {
    // Half-open: let the next attempt through. If it fails, the count is already
    // at the threshold and the breaker re-opens immediately.
    breaker.openedAt = null;
    logger.info('Circuit breaker cooldown elapsed; allowing a trial Shopify write.');
    return 'closed';
  }
  return 'open';
}

/**
 * Refuses a bulk write while Shopify is degraded.
 *
 * Called by automation apply, not by individual operator actions: a single
 * deliberate edit is cheap and the operator can see it fail, whereas a bulk run
 * would produce a wall of noise and a half-applied plan.
 */
export function assertShopifyHealthyForBulkWrites(): void {
  if (getBreakerState() === 'closed') return;

  const waitMs =
    breaker.openedAt === null ? OPEN_MS : Math.max(0, OPEN_MS - (Date.now() - breaker.openedAt));

  throw new AppError(
    'SHOPIFY_DEGRADED',
    `Shopify has failed ${breaker.consecutiveFailures} times in a row (last: ${breaker.lastFailureCode ?? 'unknown'}), so bulk writes are paused for about ${Math.ceil(waitMs / 1000)}s rather than sending hundreds of requests that will also fail. Previews still work if reads are succeeding.`,
    {
      details: {
        consecutiveFailures: breaker.consecutiveFailures,
        lastFailureCode: breaker.lastFailureCode,
        retryAfterSeconds: Math.ceil(waitMs / 1000),
      },
    },
  );
}

export interface RateLimitReport {
  /** Null until a Shopify request has actually been made. */
  throttle: {
    currentlyAvailable: number | null;
    maximumAvailable: number | null;
    restoreRate: number | null;
    /** Percentage of the bucket still available, for a progress bar. */
    availablePercentage: number | null;
    lastRequestedQueryCost: number | null;
    lastActualQueryCost: number | null;
  } | null;
  breaker: {
    state: BreakerState;
    consecutiveFailures: number;
    lastFailureCode: string | null;
    lastFailureAt: string | null;
  };
  /** Where the numbers came from, so nobody mistakes them for a live probe. */
  source: 'last-shopify-response' | 'none';
  note: string;
}

/** Builds the diagnostics payload from the last real Shopify response. */
export function getRateLimitReport(): RateLimitReport {
  const cost: ShopifyCostExtension | null = getLastThrottleStatus();
  const status = cost?.throttleStatus;

  const currentlyAvailable = status?.currentlyAvailable ?? null;
  const maximumAvailable = status?.maximumAvailable ?? null;

  return {
    throttle:
      cost === null
        ? null
        : {
            currentlyAvailable,
            maximumAvailable,
            restoreRate: status?.restoreRate ?? null,
            availablePercentage:
              currentlyAvailable !== null && maximumAvailable !== null && maximumAvailable > 0
                ? Math.round((currentlyAvailable / maximumAvailable) * 100)
                : null,
            lastRequestedQueryCost: cost.requestedQueryCost ?? null,
            lastActualQueryCost: cost.actualQueryCost ?? null,
          },
    breaker: {
      state: getBreakerState(),
      consecutiveFailures: breaker.consecutiveFailures,
      lastFailureCode: breaker.lastFailureCode,
      lastFailureAt:
        breaker.lastFailureAt === null ? null : new Date(breaker.lastFailureAt).toISOString(),
    },
    source: cost === null ? 'none' : 'last-shopify-response',
    note:
      cost === null
        ? 'No Shopify request has been made yet, so there is no throttle data. This is never fetched on demand - polling Shopify to ask about quota would consume the quota it reports.'
        : 'Taken from the extensions.cost block of the most recent real Shopify response.',
  };
}

/** Test hook. */
export function resetBreakerForTest(): void {
  breaker.consecutiveFailures = 0;
  breaker.lastFailureAt = null;
  breaker.openedAt = null;
  breaker.lastFailureCode = null;
}
