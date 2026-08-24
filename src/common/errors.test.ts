/**
 * Error code to HTTP status mapping.
 *
 * These tests exist because defaultStatusForCode ends in `default: return 500`, so a
 * code added to the union but forgotten in the switch becomes a silent 500. A refusal
 * that should be a 409 arriving as a 500 tells the client "server broke, retry" when
 * the truth is "your request was fine, the state moved" - which is the difference
 * between a retry loop and a human reading the message.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AppError, defaultRetryableForCode, defaultStatusForCode } from './errors';

describe('research push safety codes', () => {
  it('maps every conflict-family code to 409', () => {
    // The reviewed decision moved, another operation owns the claim, or the product
    // already exists. All three are "the request was well-formed, the world was not".
    assert.equal(defaultStatusForCode('RECOMMENDATION_CHANGED'), 409);
    assert.equal(defaultStatusForCode('RESEARCH_PUSH_IN_PROGRESS'), 409);
    assert.equal(defaultStatusForCode('RESEARCH_ALREADY_PUSHED'), 409);
  });

  it('maps an unrepaired safety incident to 500, explicitly', () => {
    // A Shopify product exists that Trademart could not verify is hidden. That is a
    // server-side failure, not a client mistake.
    assert.equal(defaultStatusForCode('RESEARCH_PUSH_SAFETY'), 500);
  });

  it('makes none of them retryable', () => {
    // Each needs a person: review the new recommendation, wait for the lease, or
    // finish hiding the product by hand. An automatic retry would resubmit a rejected
    // decision forever or hammer a held claim.
    for (const code of [
      'RECOMMENDATION_CHANGED',
      'RESEARCH_PUSH_IN_PROGRESS',
      'RESEARCH_ALREADY_PUSHED',
      'RESEARCH_PUSH_SAFETY',
    ] as const) {
      assert.equal(defaultRetryableForCode(code), false, `${code} must not be retryable`);
    }
  });

  it('carries the status onto the thrown AppError', () => {
    assert.equal(new AppError('RECOMMENDATION_CHANGED', 'moved').status, 409);
    assert.equal(new AppError('RESEARCH_ALREADY_PUSHED', 'done').status, 409);
  });

  it('keeps details on the wire so the client can act on them', () => {
    // The stale-hash refusal has to tell the UI which product/candidate it concerned,
    // and a safety incident MUST carry the Shopify product id.
    const error = new AppError('RESEARCH_PUSH_SAFETY', 'unsafe', {
      details: { shopifyProductId: 'gid://shopify/Product/1' },
    });
    const body = error.toBody('req-1');
    assert.deepEqual(body.details, { shopifyProductId: 'gid://shopify/Product/1' });
    assert.equal(body.error.code, 'RESEARCH_PUSH_SAFETY');
    assert.equal(body.error.requestId, 'req-1');
  });
});

describe('the codes this hardening pass relies on already behaved correctly', () => {
  it('CURRENCY_MISMATCH is a 409 conflict, not a 500', () => {
    // Currency refusals are now load-bearing: a present amount with no currency blocks
    // a push. That must read as a client-fixable conflict.
    assert.equal(defaultStatusForCode('CURRENCY_MISMATCH'), 409);
  });

  it('COST_UNKNOWN is a 409', () => {
    assert.equal(defaultStatusForCode('COST_UNKNOWN'), 409);
  });

  it('idempotency refusals are 409', () => {
    assert.equal(defaultStatusForCode('IDEMPOTENCY_CONFLICT'), 409);
    assert.equal(defaultStatusForCode('IDEMPOTENCY_IN_PROGRESS'), 409);
  });
});
