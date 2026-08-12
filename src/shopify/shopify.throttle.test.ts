/**
 * Retry/backoff policy tests.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  computeBackoffDelay,
  computeThrottleWait,
  parseRetryAfter,
} from './shopify.throttle';

describe('computeBackoffDelay', () => {
  it('grows exponentially across attempts', () => {
    const first = computeBackoffDelay(1, { random: () => 1 });
    const second = computeBackoffDelay(2, { random: () => 1 });
    const third = computeBackoffDelay(3, { random: () => 1 });

    assert.equal(first, 500);
    assert.equal(second, 1000);
    assert.equal(third, 2000);
  });

  it('always waits a non-trivial amount even with minimum jitter', () => {
    const delay = computeBackoffDelay(1, { random: () => 0 });
    assert.equal(delay, 125);
    assert.ok(delay > 0);
  });

  it('caps the delay', () => {
    const delay = computeBackoffDelay(20, { random: () => 1 });
    assert.equal(delay, 8000);
  });

  it('prefers the Retry-After header when present', () => {
    const delay = computeBackoffDelay(1, { retryAfterSeconds: 2, random: () => 1 });
    assert.equal(delay, 2000);
  });

  it('ignores a nonsensical Retry-After value', () => {
    const delay = computeBackoffDelay(1, { retryAfterSeconds: 0, random: () => 1 });
    assert.equal(delay, 500);
  });
});

describe('computeThrottleWait', () => {
  it('returns 0 when enough points remain', () => {
    const wait = computeThrottleWait(
      { throttleStatus: { currentlyAvailable: 900, restoreRate: 50 } },
      100,
    );
    assert.equal(wait, 0);
  });

  it('waits long enough for the bucket to refill', () => {
    // Need 100, have 50, restore 50/sec => 1 second.
    const wait = computeThrottleWait(
      { throttleStatus: { currentlyAvailable: 50, restoreRate: 50 } },
      100,
    );
    assert.equal(wait, 1000);
  });

  it('returns 0 when throttle information is absent', () => {
    assert.equal(computeThrottleWait(null, 100), 0);
    assert.equal(computeThrottleWait({}, 100), 0);
  });
});

describe('parseRetryAfter', () => {
  it('parses numeric seconds', () => {
    assert.equal(parseRetryAfter('2'), 2);
    assert.equal(parseRetryAfter(' 1.5 '), 1.5);
  });

  it('returns null for missing or invalid values', () => {
    assert.equal(parseRetryAfter(null), null);
    assert.equal(parseRetryAfter('soon'), null);
  });
});
