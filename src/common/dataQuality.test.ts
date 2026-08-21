/**
 * Data quality: confidence and freshness.
 *
 * The theme is that "we do not know" must survive every transformation. Confidence
 * degrades to the weakest input, freshness degrades to the oldest, and UNKNOWN is
 * never quietly upgraded into a number or downgraded into STALE.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  FRESHNESS_POLICIES,
  makeEvidence,
  resolveFreshness,
  worstConfidence,
  worstFreshness,
} from './dataQuality';

const NOW = new Date('2026-04-01T12:00:00Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** An ISO timestamp `ms` before NOW. */
function ago(ms: number): string {
  return new Date(NOW.getTime() - ms).toISOString();
}

describe('worstConfidence', () => {
  it('degrades to the weakest input', () => {
    assert.equal(worstConfidence('KNOWN', 'KNOWN'), 'KNOWN');
    assert.equal(worstConfidence('KNOWN', 'ESTIMATED'), 'ESTIMATED');
    assert.equal(worstConfidence('ESTIMATED', 'UNKNOWN'), 'UNKNOWN');
    assert.equal(worstConfidence('KNOWN', 'UNKNOWN', 'ESTIMATED'), 'UNKNOWN');
  });

  it('is KNOWN for no inputs', () => {
    // A sum of nothing is exactly zero, and nothing about it is uncertain.
    assert.equal(worstConfidence(), 'KNOWN');
  });
});

describe('resolveFreshness', () => {
  const policy = FRESHNESS_POLICIES.SUPPLIER_COST; // fresh <= 14d, aging <= 45d

  it('is FRESH inside the fresh window', () => {
    const result = resolveFreshness(ago(2 * DAY), NOW, policy);
    assert.equal(result.freshness, 'FRESH');
    assert.ok(result.ageHours !== null && Math.round(result.ageHours) === 48);
  });

  it('is AGING past fresh but inside aging', () => {
    const result = resolveFreshness(ago(20 * DAY), NOW, policy);
    assert.equal(result.freshness, 'AGING');
    assert.match(result.note, /worth re-checking/);
  });

  it('is STALE past the aging window', () => {
    const result = resolveFreshness(ago(60 * DAY), NOW, policy);
    assert.equal(result.freshness, 'STALE');
    assert.match(result.note, /risk/);
  });

  it('UNKNOWN is NOT the same as STALE when no timestamp exists', () => {
    // "We never recorded when this was measured" is a plumbing gap; "we measured it
    // four months ago" is a refresh. Different problems, different fixes.
    const result = resolveFreshness(null, NOW, policy);
    assert.equal(result.freshness, 'UNKNOWN');
    assert.equal(result.ageHours, null);
    assert.match(result.note, /not evidence that it is old/);
  });

  it('treats an unparseable timestamp as UNKNOWN, not as ancient', () => {
    const result = resolveFreshness('not-a-date', NOW, policy);
    assert.equal(result.freshness, 'UNKNOWN');
    assert.match(result.note, /not a valid date/);
  });

  it('tolerates clock skew rather than rejecting a future timestamp', () => {
    // Skew between Shopify, a provider and this process is normal; refusing to trust
    // a value because it is two seconds ahead would be pedantic.
    const result = resolveFreshness(new Date(NOW.getTime() + 5_000).toISOString(), NOW, policy);
    assert.equal(result.freshness, 'FRESH');
    assert.match(result.note, /clock skew/);
  });

  it('applies per-kind windows, so trend ages faster than a supplier cost', () => {
    const fiveDaysAgo = ago(5 * DAY);
    // Same observation, different kind of data, different verdict.
    assert.equal(
      resolveFreshness(fiveDaysAgo, NOW, FRESHNESS_POLICIES.TREND).freshness,
      'AGING',
    );
    assert.equal(
      resolveFreshness(fiveDaysAgo, NOW, FRESHNESS_POLICIES.SUPPLIER_COST).freshness,
      'FRESH',
    );
  });

  it('accepts a Date as well as a string', () => {
    assert.equal(
      resolveFreshness(new Date(NOW.getTime() - DAY), NOW, policy).freshness,
      'FRESH',
    );
  });
});

describe('worstFreshness', () => {
  it('degrades to the oldest input, with UNKNOWN worst of all', () => {
    assert.equal(worstFreshness('FRESH', 'FRESH'), 'FRESH');
    assert.equal(worstFreshness('FRESH', 'AGING'), 'AGING');
    assert.equal(worstFreshness('AGING', 'STALE'), 'STALE');
    assert.equal(worstFreshness('STALE', 'UNKNOWN'), 'UNKNOWN');
  });

  it('is FRESH for no inputs', () => {
    assert.equal(worstFreshness(), 'FRESH');
  });
});

describe('makeEvidence', () => {
  it('ages from observedAt, not fetchedAt', () => {
    // A March measurement fetched today is three months old, not current. Reporting
    // the fetch time would make stale data look fresh.
    const evidence = makeEvidence({
      code: 'SEARCH_VOLUME',
      label: 'Average monthly searches',
      source: 'Google Ads',
      observedAt: ago(40 * DAY),
      fetchedAt: NOW.toISOString(),
      value: '12,000',
      now: NOW,
      kind: 'KEYWORD_METRICS', // fresh <= 7d, aging <= 30d
    });
    assert.equal(evidence.freshness, 'STALE');
  });

  it('falls back to fetchedAt when the source gives no observation time', () => {
    const evidence = makeEvidence({
      code: 'X',
      label: 'X',
      source: 'Provider',
      fetchedAt: ago(2 * HOUR),
      now: NOW,
      kind: 'TREND',
    });
    assert.equal(evidence.freshness, 'FRESH');
  });

  it('is UNKNOWN freshness when neither timestamp exists', () => {
    const evidence = makeEvidence({
      code: 'X',
      label: 'X',
      source: 'Operator',
      now: NOW,
      kind: 'SUPPLIER_COST',
    });
    assert.equal(evidence.freshness, 'UNKNOWN');
    assert.equal(evidence.observedAt, null);
    assert.equal(evidence.fetchedAt, null);
  });

  it('defaults confidence to KNOWN but lets a provider say otherwise', () => {
    assert.equal(
      makeEvidence({ code: 'A', label: 'A', source: 'S', now: NOW, kind: 'TREND' }).confidence,
      'KNOWN',
    );
    assert.equal(
      makeEvidence({
        code: 'A',
        label: 'A',
        source: 'S',
        confidence: 'ESTIMATED',
        now: NOW,
        kind: 'TREND',
      }).confidence,
      'ESTIMATED',
    );
  });
});
