import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { AppError } from '../common/errors';
import {
  assertShopifyHealthyForBulkWrites,
  getBreakerSnapshot,
  getBreakerState,
  recordShopifyOutcome,
  resetBreakerForTest,
} from './shopify.breaker';

/** Records n consecutive infrastructure failures. */
function fail(times: number, code = 'SHOPIFY_THROTTLED'): void {
  for (let i = 0; i < times; i += 1) recordShopifyOutcome({ ok: false, code });
}

afterEach(() => {
  resetBreakerForTest();
});

describe('shopify circuit breaker', () => {
  it('starts closed', () => {
    assert.equal(getBreakerState(), 'closed');
  });

  it('stays closed below the failure threshold', () => {
    fail(4);
    assert.equal(getBreakerState(), 'closed');
    assert.equal(getBreakerSnapshot().consecutiveFailures, 4);
  });

  it('opens on the fifth consecutive infrastructure failure', () => {
    fail(5);
    assert.equal(getBreakerState(), 'open');
  });

  it('refuses bulk writes while open, and names the reason and the wait', () => {
    fail(5, 'SHOPIFY_TIMEOUT');

    let error: AppError | null = null;
    try {
      assertShopifyHealthyForBulkWrites();
    } catch (caught) {
      error = caught instanceof AppError ? caught : null;
    }

    if (error === null) {
      assert.fail('Expected a SHOPIFY_DEGRADED AppError while the breaker is open.');
      return;
    }
    assert.equal(error.code, 'SHOPIFY_DEGRADED');
    // An operator needs to know what failed and how long to wait, not just that
    // "Shopify is degraded".
    assert.match(error.message, /SHOPIFY_TIMEOUT/);
    assert.match(error.message, /5 times in a row/);
    const details = error.details as { retryAfterSeconds?: number };
    assert.ok((details.retryAfterSeconds ?? 0) > 0);
  });

  it('does not block bulk writes while closed', () => {
    fail(4);
    assert.doesNotThrow(() => {
      assertShopifyHealthyForBulkWrites();
    });
  });

  it('a success closes the breaker and clears the count', () => {
    fail(5);
    assert.equal(getBreakerState(), 'open');

    recordShopifyOutcome({ ok: true });

    assert.equal(getBreakerState(), 'closed');
    assert.equal(getBreakerSnapshot().consecutiveFailures, 0);
    assert.equal(getBreakerSnapshot().lastFailureCode, null);
  });

  it('ignores failures that retrying cannot fix', () => {
    // A missing scope or a rejected mutation is OUR problem, not a degraded
    // dependency. Pausing writes store-wide because one product had an invalid
    // price would be wrong.
    fail(10, 'SHOPIFY_SCOPE_MISSING');
    fail(10, 'SHOPIFY_USER_ERROR');
    fail(10, 'VALIDATION_ERROR');

    assert.equal(getBreakerState(), 'closed');
    assert.equal(getBreakerSnapshot().consecutiveFailures, 0);
  });

  it('ignores a failure with no code at all', () => {
    recordShopifyOutcome({ ok: false });
    assert.equal(getBreakerSnapshot().consecutiveFailures, 0);
  });

  it('counts a mix of infrastructure codes towards the same threshold', () => {
    // Shopify being unreachable, then slow, then 500ing is one outage, not three
    // unrelated single failures.
    fail(2, 'SHOPIFY_NETWORK_ERROR');
    fail(2, 'SHOPIFY_TIMEOUT');
    assert.equal(getBreakerState(), 'closed');
    fail(1, 'SHOPIFY_HTTP_ERROR');
    assert.equal(getBreakerState(), 'open');
    assert.equal(getBreakerSnapshot().lastFailureCode, 'SHOPIFY_HTTP_ERROR');
  });

  it('reports the threshold so the number is not hardcoded in the UI', () => {
    assert.equal(getBreakerSnapshot().threshold, 5);
  });

  it('reports lastFailureAt as an ISO string, or null before any failure', () => {
    assert.equal(getBreakerSnapshot().lastFailureAt, null);
    fail(1);
    const at = getBreakerSnapshot().lastFailureAt;
    if (at === null) {
      assert.fail('lastFailureAt should be set after a qualifying failure.');
      return;
    }
    assert.equal(new Date(at).toISOString(), at);
  });
});
