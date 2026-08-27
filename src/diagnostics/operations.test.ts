/**
 * Operational counters and the queue-age calculation behind
 * GET /api/diagnostics/operations.
 *
 * The endpoint exists because there was previously no way to learn that the webhook
 * queue was stuck, that payments were failing signature verification, or that paid
 * orders were not reaching Shopify without knowing which log line to grep for -
 * which requires already suspecting the answer.
 *
 * Two properties are worth pinning: the counter set is CLOSED (no per-order or
 * per-customer label can ever be added, because that is how a metrics surface turns
 * into an unbounded memory leak and an accidental PII export), and queue AGE is
 * reported rather than depth alone.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import {
  COUNTER_NAMES,
  incrementCounter,
  resetCounters,
  snapshotCounters,
} from '../common/metrics';
import { oldestPendingAgeSeconds } from './queueAge';

beforeEach(() => {
  resetCounters();
});

describe('counters', () => {
  it('starts at zero for every counter, and reports the zeroes', () => {
    // Absence is not information: a dashboard showing nothing for
    // storefront.payment.signature_invalid must be distinguishable from one that is
    // not wired up.
    const snapshot = snapshotCounters();

    for (const name of COUNTER_NAMES) {
      assert.equal(snapshot.counters[name], 0, `${name} should be reported as 0`);
    }
  });

  it('counts', () => {
    incrementCounter('webhook.delivery.not_persisted');
    incrementCounter('webhook.delivery.not_persisted');
    incrementCounter('storefront.order.creation_failed', 3);

    const { counters } = snapshotCounters();
    assert.equal(counters['webhook.delivery.not_persisted'], 2);
    assert.equal(counters['storefront.order.creation_failed'], 3);
    assert.equal(counters['shopify.request.failed'], 0);
  });

  it('reports when the counters were last reset', () => {
    // Process-local counters read as historical totals would be actively
    // misleading, so the reset point is part of the payload.
    assert.match(snapshotCounters().since, /^\d{4}-\d{2}-\d{2}T/);
  });

  it('covers the failures that cost money or lose data', () => {
    // Not an exhaustive list - a guard on the ones whose absence was the actual gap.
    for (const name of [
      'webhook.delivery.not_persisted',
      'webhook.event.failed',
      'storefront.payment.signature_invalid',
      'storefront.order.creation_failed',
      'write.refused_no_durable_safety',
    ] as const) {
      assert.ok(COUNTER_NAMES.includes(name), `${name} must be a counter`);
    }
  });

  it('has no counter name that could carry an id', () => {
    // The closed union is the safeguard. This asserts the shape of the names, so a
    // future "storefront.checkout.failed.<publicId>" style addition is caught.
    for (const name of COUNTER_NAMES) {
      assert.match(
        name,
        /^[a-z]+(\.[a-z_]+)+$/,
        `${name} must be a fixed dotted name with no interpolated value`,
      );
    }
  });
});

describe('oldestPendingAgeSeconds', () => {
  const now = new Date('2026-08-27T12:00:00.000Z');

  it('is null when nothing is pending', () => {
    assert.equal(oldestPendingAgeSeconds(null, now), null);
  });

  it('reports the age of the oldest pending delivery', () => {
    // The number that distinguishes "busy" from "stuck": a queue of 400 draining in
    // a second is healthy, a queue of 1 stuck for an hour is an incident, and depth
    // alone cannot tell them apart.
    assert.equal(oldestPendingAgeSeconds('2026-08-27T11:30:00.000Z', now), 1800);
    assert.equal(oldestPendingAgeSeconds('2026-08-27T11:59:30.000Z', now), 30);
  });

  it('never reports a negative age', () => {
    // Clock skew between the app and Mongo is normal and must not surface as a
    // nonsensical negative number.
    assert.equal(oldestPendingAgeSeconds('2026-08-27T12:00:05.000Z', now), 0);
  });

  it('tolerates an unparseable timestamp', () => {
    assert.equal(oldestPendingAgeSeconds('not-a-date', now), null);
  });
});
