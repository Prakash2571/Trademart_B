/**
 * Circuit breaker for Shopify writes.
 *
 * WHY
 * ---
 * When Shopify is throttling or erroring persistently, firing a 250-product bulk
 * apply at it produces hundreds of individual failures, a useless audit trail and
 * a half-applied plan that somebody then has to reason about. The breaker turns
 * that into one clear SHOPIFY_DEGRADED refusal before any of it happens.
 *
 * SCOPE - WRITES ONLY, AND ONLY BULK ONES
 * ---------------------------------------
 * Reads are never blocked. A preview only needs reads, and being able to look at
 * the store while writes are paused is far more useful than failing everything.
 *
 * Individual operator actions are also not blocked: a single deliberate edit is
 * one request, the operator is watching it, and they can see it fail and decide
 * what to do. It is the unattended 250-request run that needs stopping.
 *
 * WHY THIS FILE IS SEPARATE FROM rateLimit.service.ts
 * ---------------------------------------------------
 * shopify.client.ts must report outcomes here, and rateLimit.service.ts must read
 * the last throttle status out of shopify.client.ts. Putting the breaker in
 * rateLimit.service.ts would make client -> service -> client an import cycle.
 * Keeping the state machine here leaves it a leaf module: no Shopify imports, and
 * therefore trivially unit-testable with no network and no fakes.
 */

import { AppError } from '../common/errors';
import { logger } from '../common/logger';

/** Consecutive qualifying failures before bulk writes are refused. */
const FAILURE_THRESHOLD = 5;
/** How long the breaker stays open before allowing a trial write again. */
const OPEN_MS = 60_000;
/**
 * Quiet period after which the failure count decays back to zero.
 *
 * Without this, five unrelated blips spread over a working day would eventually
 * trip the breaker. "Consecutive" has to mean "consecutive and close together"
 * or it is just a lifetime error counter.
 */
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

/**
 * Only INFRASTRUCTURE failures count.
 *
 * A missing scope or a rejected mutation must never trip the breaker: retrying
 * will not help, and pausing writes store-wide because one product had an invalid
 * price would be actively wrong. Those are our problem, not Shopify's.
 */
const BREAKER_CODES = new Set([
  'SHOPIFY_THROTTLED',
  'SHOPIFY_TIMEOUT',
  'SHOPIFY_NETWORK_ERROR',
  'SHOPIFY_HTTP_ERROR',
]);

/** Records the outcome of a Shopify call. Called by shopify.client.ts. */
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

/**
 * Current state, with the half-open transition built in.
 *
 * After the cooldown the breaker closes so the NEXT attempt is let through as a
 * trial. If that trial fails, the failure count is still at the threshold, so it
 * re-opens immediately - no separate half-open bookkeeping is needed.
 */
export function getBreakerState(): BreakerState {
  if (breaker.openedAt === null) return 'closed';
  if (Date.now() - breaker.openedAt >= OPEN_MS) {
    breaker.openedAt = null;
    logger.info('Circuit breaker cooldown elapsed; allowing a trial Shopify write.');
    return 'closed';
  }
  return 'open';
}

export interface BreakerSnapshot {
  state: BreakerState;
  consecutiveFailures: number;
  lastFailureCode: string | null;
  lastFailureAt: string | null;
  threshold: number;
}

export function getBreakerSnapshot(): BreakerSnapshot {
  return {
    // Called first so a lapsed cooldown is reflected in the reported numbers.
    state: getBreakerState(),
    consecutiveFailures: breaker.consecutiveFailures,
    lastFailureCode: breaker.lastFailureCode,
    lastFailureAt:
      breaker.lastFailureAt === null
        ? null
        : new Date(breaker.lastFailureAt).toISOString(),
    threshold: FAILURE_THRESHOLD,
  };
}

/**
 * Refuses a bulk write while Shopify is degraded.
 *
 * The message states the count, the last code and the wait, because
 * "Shopify is degraded" on its own gives an operator nothing to act on or wait
 * for.
 */
export function assertShopifyHealthyForBulkWrites(): void {
  if (getBreakerState() === 'closed') return;

  const waitMs =
    breaker.openedAt === null
      ? OPEN_MS
      : Math.max(0, OPEN_MS - (Date.now() - breaker.openedAt));
  const retryAfterSeconds = Math.ceil(waitMs / 1000);

  throw new AppError(
    'SHOPIFY_DEGRADED',
    `Shopify has failed ${breaker.consecutiveFailures} times in a row (last: ${breaker.lastFailureCode ?? 'unknown'}), so bulk writes are paused for about ${retryAfterSeconds}s rather than sending hundreds of requests that will also fail and leave a half-applied plan. Previews still work while reads are succeeding.`,
    {
      retryable: true,
      details: {
        consecutiveFailures: breaker.consecutiveFailures,
        lastFailureCode: breaker.lastFailureCode,
        retryAfterSeconds,
      },
    },
  );
}

/** Test hook. Never called by application code. */
export function resetBreakerForTest(): void {
  breaker.consecutiveFailures = 0;
  breaker.lastFailureAt = null;
  breaker.openedAt = null;
  breaker.lastFailureCode = null;
}
