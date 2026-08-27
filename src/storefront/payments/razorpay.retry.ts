/**
 * Retry policy for outbound Razorpay calls.
 *
 * THE ONLY INTERESTING QUESTION HERE IS WHAT NOT TO RETRY
 * ------------------------------------------------------
 * Razorpay calls fall into two categories and they must be treated differently:
 *
 *   READ  (`GET /payments/:id`, `GET /orders?receipt=`)
 *         Safe to retry. Nothing changes on Razorpay's side, and the caller is in the
 *         middle of deciding whether a customer's money moved - giving up on the
 *         first 503 leaves a paid order stuck in ORDER_PENDING for a retry cycle when
 *         a second attempt 200ms later would have answered.
 *
 *   WRITE (`POST /orders`)
 *         NOT retried here, deliberately. A blind retry of an order creation can
 *         create a second Razorpay order for one purchase. Recovery is by IDENTITY
 *         instead: the receipt is the idempotency key, so a lost response is resolved
 *         by looking up the order carrying that receipt (see createOrRecoverOrder).
 *         That is a correctness mechanism, not a retry, and it must stay the only one.
 *
 * So this module exports a classifier and a delay schedule, and the client applies
 * them to reads only. Everything is pure, because "would this retry have created a
 * second charge?" is not a question to answer by reading a stack trace later.
 */

/** What to do about a failed attempt. */
export type RetryVerdict =
  | { retry: false; reason: string }
  | { retry: true; reason: string };

export interface RazorpayAttemptOutcome {
  /** HTTP status, or null for a transport-level failure (DNS, reset, timeout). */
  status: number | null;
  /** Retry-After header value, if the response carried one. */
  retryAfterSeconds?: number | null;
}

/**
 * Whether a READ may be retried.
 *
 * 429 and 5xx are transient by definition. A transport failure (`status: null`) is
 * the same class: no response means no evidence the request was even processed, and a
 * read has nothing to double up on.
 *
 * 4xx other than 429 is NEVER retried: a 400/401/404 means the request or the
 * credential is wrong, and repeating it identically cannot fix either - it just turns
 * a clear error into a slow one.
 */
export function shouldRetryRead(outcome: RazorpayAttemptOutcome): RetryVerdict {
  if (outcome.status === null) {
    return { retry: true, reason: 'transport failure - no response, so nothing happened' };
  }
  if (outcome.status === 429) {
    return { retry: true, reason: 'rate limited' };
  }
  if (outcome.status >= 500) {
    return { retry: true, reason: 'upstream server error' };
  }
  return {
    retry: false,
    reason: `status ${outcome.status} is deterministic - retrying cannot change it`,
  };
}

/** Writes are never retried automatically. See the header. */
export function shouldRetryWrite(): RetryVerdict {
  return {
    retry: false,
    reason:
      'a payment-order creation is not safe to retry blindly; recovery is by receipt lookup',
  };
}

export const MAX_READ_ATTEMPTS = 3;
const BASE_DELAY_MS = 200;
const MAX_DELAY_MS = 2_000;

/**
 * Delay before attempt N (1-based), with full jitter.
 *
 * Jitter matters even for one client: without it, a burst of checkouts that all hit
 * the same Razorpay blip retries in lockstep and arrives as a second synchronised
 * burst. `Retry-After` wins when Razorpay sends one - it is the upstream telling us
 * exactly what it wants - but it is capped, because a provider asking for a 30-second
 * wait must not hold an HTTP request open for 30 seconds while a customer watches a
 * spinner.
 */
export function retryDelayMs(
  attempt: number,
  outcome: RazorpayAttemptOutcome,
  random: () => number = Math.random,
): number {
  const retryAfter = outcome.retryAfterSeconds;
  if (retryAfter !== undefined && retryAfter !== null && retryAfter > 0) {
    return Math.min(Math.ceil(retryAfter * 1000), MAX_DELAY_MS);
  }
  const ceiling = Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS);
  // Full jitter with a floor, so a retry is never effectively immediate.
  return Math.max(Math.floor(ceiling / 4), Math.floor(random() * ceiling));
}

/** Parses a Retry-After header. Seconds only; Razorpay does not send HTTP dates. */
export function parseRetryAfterSeconds(headerValue: string | null): number | null {
  if (headerValue === null) return null;
  const seconds = Number(headerValue.trim());
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}
