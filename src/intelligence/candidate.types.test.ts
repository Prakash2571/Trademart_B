/**
 * Candidate banding and push eligibility.
 *
 * These two helpers carry most of the module's safety:
 *
 *   bandFor  refuses to call something a STRONG_CANDIDATE on data nobody observed
 *
 * Both are pure, so they are tested directly rather than through a service.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RECOMMENDATION_BANDS, bandFor } from './candidate.types';

describe('bandFor maps score to recommendation', () => {
  it('uses the published bands when confidence is adequate', () => {
    assert.equal(bandFor(90, 80).recommendation, 'STRONG_CANDIDATE');
    assert.equal(bandFor(70, 80).recommendation, 'GOOD_CANDIDATE');
    assert.equal(bandFor(55, 80).recommendation, 'WATCH');
    assert.equal(bandFor(40, 80).recommendation, 'WEAK');
    assert.equal(bandFor(10, 80).recommendation, 'REJECT');
  });

  it('is inclusive at each boundary', () => {
    assert.equal(bandFor(80, 90).recommendation, 'STRONG_CANDIDATE');
    assert.equal(bandFor(65, 90).recommendation, 'GOOD_CANDIDATE');
    assert.equal(bandFor(50, 90).recommendation, 'WATCH');
    assert.equal(bandFor(35, 90).recommendation, 'WEAK');
  });

  it('covers zero, so there is always a band', () => {
    assert.equal(bandFor(0, 0).recommendation, 'REJECT');
    assert.ok(RECOMMENDATION_BANDS[RECOMMENDATION_BANDS.length - 1]?.atLeast === 0);
  });
});

describe('bandFor downgrades a good score built on thin data', () => {
  it('holds a high score at WATCH when confidence is low', () => {
    // The central safety property: 88 on guesses is not a recommendation to buy.
    const result = bandFor(88, 40);
    assert.equal(result.recommendation, 'WATCH');
    assert.equal(result.downgraded, true);
    assert.match(result.reason ?? '', /data confidence is only 40/);
    assert.match(result.reason ?? '', /nobody has observed/);
  });

  it('downgrades GOOD as well as STRONG', () => {
    assert.equal(bandFor(70, 30).recommendation, 'WATCH');
  });

  it('does NOT downgrade below WATCH - thin data is not evidence against', () => {
    // Treating unknown as damning would discard good opportunities for being new.
    const result = bandFor(88, 5);
    assert.equal(result.recommendation, 'WATCH');
    assert.notEqual(result.recommendation, 'REJECT');
    assert.notEqual(result.recommendation, 'WEAK');
  });

  it('leaves an already-weak score alone - there is nothing to protect against', () => {
    const weak = bandFor(40, 10);
    assert.equal(weak.recommendation, 'WEAK');
    assert.equal(weak.downgraded, false);
    assert.equal(weak.reason, null);

    const reject = bandFor(10, 10);
    assert.equal(reject.recommendation, 'REJECT');
    assert.equal(reject.downgraded, false);
  });

  it('does not downgrade when confidence clears the threshold', () => {
    const result = bandFor(90, 60);
    assert.equal(result.recommendation, 'STRONG_CANDIDATE');
    assert.equal(result.downgraded, false);
  });

  it('honours a configured confidence threshold', () => {
    // A store that trusts its own data can lower the bar; one that does not can raise it.
    assert.equal(bandFor(90, 50, 40).recommendation, 'STRONG_CANDIDATE');
    assert.equal(bandFor(90, 50, 80).recommendation, 'WATCH');
  });
});

/*
 * The canPush tests moved to candidate.transitions.test.ts along with the function.
 *
 * canPush() could only see `status` and `pushedShopifyProductId`, so it approved a push
 * for a candidate whose push was already running. candidate.transitions.ts now owns every
 * "may I?" question and can see `pushState` too, and its tests cover the cases these did
 * plus the concurrency ones these could not express.
 */
