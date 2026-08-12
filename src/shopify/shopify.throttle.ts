/**
 * Throttle / retry policy for the Shopify Admin API.
 *
 * Pure functions so the backoff policy can be unit tested deterministically.
 *
 * Shopify GraphQL uses a leaky-bucket calculated-query-cost model and reports
 * the bucket state in `extensions.cost.throttleStatus`.
 * Reference: https://shopify.dev/docs/api/usage/rate-limits
 */

export interface ThrottleStatus {
  maximumAvailable?: number;
  currentlyAvailable?: number;
  restoreRate?: number;
}

export interface ShopifyCostExtension {
  requestedQueryCost?: number;
  actualQueryCost?: number | null;
  throttleStatus?: ThrottleStatus;
}

export const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 8000;

/**
 * Exponential backoff with full jitter.
 * `attempt` is 1-based: the delay to wait *after* attempt N fails.
 *
 * `random` is injectable purely so tests can pin it.
 */
export function computeBackoffDelay(
  attempt: number,
  options: { retryAfterSeconds?: number | null; random?: () => number } = {},
): number {
  // Shopify's Retry-After header is authoritative when present.
  if (options.retryAfterSeconds !== undefined && options.retryAfterSeconds !== null) {
    const fromHeader = Math.ceil(options.retryAfterSeconds * 1000);
    if (Number.isFinite(fromHeader) && fromHeader > 0) {
      return Math.min(fromHeader, MAX_DELAY_MS);
    }
  }

  const safeAttempt = Math.max(1, Math.floor(attempt));
  const ceiling = Math.min(BASE_DELAY_MS * 2 ** (safeAttempt - 1), MAX_DELAY_MS);
  const random = options.random ?? Math.random;
  // Full jitter, but never less than a quarter of the ceiling so we always
  // actually back off.
  return Math.round(ceiling * (0.25 + 0.75 * random()));
}

/**
 * How long to wait before a follow-up query, given the reported bucket state.
 * Returns 0 when there are enough points for the next request.
 */
export function computeThrottleWait(
  cost: ShopifyCostExtension | null | undefined,
  nextQueryCost: number,
): number {
  const status = cost?.throttleStatus;
  if (!status) return 0;
  const available = status.currentlyAvailable;
  const restoreRate = status.restoreRate;
  if (available === undefined || restoreRate === undefined || restoreRate <= 0) return 0;
  if (available >= nextQueryCost) return 0;
  const deficit = nextQueryCost - available;
  return Math.min(Math.ceil((deficit / restoreRate) * 1000), MAX_DELAY_MS);
}

/** Parses a Retry-After header value (seconds, possibly fractional). */
export function parseRetryAfter(headerValue: string | null): number | null {
  if (headerValue === null) return null;
  const seconds = Number(headerValue.trim());
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
