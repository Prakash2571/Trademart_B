/**
 * Retry classification for Razorpay.
 *
 * The dangerous half of retrying is not "did we give up too early", it is "did we
 * create a second charge". So the split is asserted explicitly: reads are retried,
 * order creation is not, and no future edit can quietly make a write retryable
 * without this test failing.
 *
 * Before this, the client made exactly one attempt at everything. That is safe for the
 * write and needlessly fragile for the read: `GET /payments/:id` is what decides
 * whether a customer's money moved, and abandoning it on a single 503 leaves a paid
 * checkout sitting in ORDER_PENDING until the next worker tick.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MAX_READ_ATTEMPTS,
  parseRetryAfterSeconds,
  retryDelayMs,
  shouldRetryRead,
  shouldRetryWrite,
} from './razorpay.retry';

describe('reads', () => {
  it('retries a transport failure, where nothing can have happened', () => {
    const verdict = shouldRetryRead({ status: null });
    assert.equal(verdict.retry, true);
    assert.match(verdict.reason, /transport/);
  });

  it('retries 429 and 5xx', () => {
    for (const status of [429, 500, 502, 503, 504]) {
      assert.equal(shouldRetryRead({ status }).retry, true, `status ${status}`);
    }
  });

  it('does NOT retry a deterministic 4xx', () => {
    // A 400/401/403/404 means the request or the credential is wrong. Repeating it
    // identically cannot fix either - it only turns a clear error into a slow one.
    for (const status of [400, 401, 403, 404, 409, 422]) {
      const verdict = shouldRetryRead({ status });
      assert.equal(verdict.retry, false, `status ${status} must not be retried`);
      assert.match(verdict.reason, /deterministic/);
    }
  });

  it('is bounded', () => {
    // Unbounded retries against a degraded provider turn one slow checkout into a
    // pile of held connections.
    assert.equal(MAX_READ_ATTEMPTS, 3);
  });
});

describe('writes', () => {
  it('is never retried automatically', () => {
    // The whole point: a blind retry of POST /orders can create a SECOND Razorpay
    // order for one purchase. Recovery is by receipt lookup, which is idempotent by
    // identity.
    const verdict = shouldRetryWrite();
    assert.equal(verdict.retry, false);
    assert.match(verdict.reason, /receipt lookup/);
  });
});

describe('delay', () => {
  it('grows with the attempt number', () => {
    // Compared with jitter pinned to its maximum, so the schedule is what is under
    // test rather than the randomness.
    const max = () => 0.999_999;
    const first = retryDelayMs(1, { status: 503 }, max);
    const second = retryDelayMs(2, { status: 503 }, max);
    const third = retryDelayMs(3, { status: 503 }, max);

    assert.ok(second > first, `${second} should exceed ${first}`);
    assert.ok(third > second, `${third} should exceed ${second}`);
  });

  it('is never effectively zero, even with the unluckiest jitter', () => {
    // A "retry" that fires immediately is not a retry, it is a second simultaneous
    // request into something that just failed.
    const zero = () => 0;
    for (const attempt of [1, 2, 3]) {
      assert.ok(retryDelayMs(attempt, { status: 503 }, zero) > 0);
    }
  });

  it('honours Retry-After when the provider sends one', () => {
    // The upstream saying what it wants beats our guess.
    assert.equal(retryDelayMs(1, { status: 429, retryAfterSeconds: 1 }), 1000);
  });

  it('caps a long Retry-After rather than holding the request open', () => {
    // A provider asking for 30 seconds must not mean a customer watches a spinner for
    // 30 seconds. Cap and fail; the caller retries at a higher level.
    assert.equal(retryDelayMs(1, { status: 429, retryAfterSeconds: 30 }), 2000);
  });

  it('ignores a nonsensical Retry-After', () => {
    const delay = retryDelayMs(1, { status: 429, retryAfterSeconds: null });
    assert.ok(delay > 0 && delay <= 200);
  });

  it('is bounded overall', () => {
    const max = () => 0.999_999;
    assert.ok(retryDelayMs(10, { status: 503 }, max) <= 2000);
  });
});

describe('parseRetryAfterSeconds', () => {
  it('reads a seconds value', () => {
    assert.equal(parseRetryAfterSeconds('2'), 2);
    assert.equal(parseRetryAfterSeconds(' 0.5 '), 0.5);
    assert.equal(parseRetryAfterSeconds('0'), 0);
  });

  it('rejects anything else, rather than guessing', () => {
    assert.equal(parseRetryAfterSeconds(null), null);
    assert.equal(parseRetryAfterSeconds('soon'), null);
    assert.equal(parseRetryAfterSeconds('-3'), null);
    // Razorpay does not send HTTP-date form; treating one as a number would produce a
    // NaN delay, so it is refused explicitly.
    assert.equal(parseRetryAfterSeconds('Wed, 21 Oct 2026 07:28:00 GMT'), null);
  });
});
