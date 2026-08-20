/**
 * Unit tests for the signed OAuth state nonce.
 *
 * The clock and nonce are injected so expiry and replay behaviour are tested
 * deterministically, with no timers and no network.
 */

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  OAUTH_STATE_TTL_MS,
  createOAuthState,
  verifyOAuthState,
} from './oauth.state';

const SECRET = 'shpss_test_client_secret';
const SHOP = 'demo.myshopify.com';
const NOW = 1_700_000_000_000;

describe('createOAuthState', () => {
  it('produces a payload.signature pair', () => {
    const state = createOAuthState(SHOP, SECRET, { now: NOW, nonce: 'abc' });
    const parts = state.split('.');
    assert.equal(parts.length, 2);
    assert.match(parts[1] as string, /^[0-9a-f]{64}$/);
  });

  it('is deterministic for a fixed clock and nonce', () => {
    const a = createOAuthState(SHOP, SECRET, { now: NOW, nonce: 'abc' });
    const b = createOAuthState(SHOP, SECRET, { now: NOW, nonce: 'abc' });
    assert.equal(a, b);
  });

  it('differs per call in production use (random nonce)', () => {
    const a = createOAuthState(SHOP, SECRET);
    const b = createOAuthState(SHOP, SECRET);
    assert.notEqual(a, b);
  });

  it('never leaks the raw shop domain in cleartext', () => {
    // base64url encoded, so a naive log scrape does not show the domain verbatim.
    const state = createOAuthState(SHOP, SECRET, { now: NOW, nonce: 'abc' });
    assert.doesNotMatch(state, /myshopify/);
  });
});

describe('verifyOAuthState', () => {
  it('accepts a freshly created state and returns the bound shop', () => {
    const state = createOAuthState(SHOP, SECRET, { now: NOW, nonce: 'abc' });
    const result = verifyOAuthState(state, SECRET, { now: NOW + 1000 });
    assert.equal(result.valid, true);
    assert.equal(result.valid === true ? result.shopDomain : null, SHOP);
    assert.equal(result.valid === true ? result.issuedAt : null, NOW);
  });

  it('rejects a state signed with a different secret', () => {
    const state = createOAuthState(SHOP, 'other-secret', { now: NOW, nonce: 'abc' });
    const result = verifyOAuthState(state, SECRET, { now: NOW });
    assert.equal(result.valid, false);
    assert.match(result.valid === false ? result.reason : '', /signature is invalid/);
  });

  it('rejects a tampered shop domain', () => {
    // The whole point: an attacker swapping the shop must invalidate the signature.
    const state = createOAuthState(SHOP, SECRET, { now: NOW, nonce: 'abc' });
    const [payload, signature] = state.split('.') as [string, string];
    const forgedPayload = Buffer.from(`evil.myshopify.com:${NOW}:abc`, 'utf8').toString(
      'base64url',
    );
    const result = verifyOAuthState(`${forgedPayload}.${signature}`, SECRET, { now: NOW });
    assert.equal(result.valid, false);
    assert.notEqual(payload, forgedPayload);
  });

  it('rejects an expired state', () => {
    const state = createOAuthState(SHOP, SECRET, { now: NOW, nonce: 'abc' });
    const result = verifyOAuthState(state, SECRET, { now: NOW + OAUTH_STATE_TTL_MS + 1 });
    assert.equal(result.valid, false);
    assert.match(result.valid === false ? result.reason : '', /expired/);
  });

  it('accepts a state at the very edge of the TTL', () => {
    const state = createOAuthState(SHOP, SECRET, { now: NOW, nonce: 'abc' });
    const result = verifyOAuthState(state, SECRET, { now: NOW + OAUTH_STATE_TTL_MS });
    assert.equal(result.valid, true);
  });

  it('rejects a state timestamped far in the future', () => {
    const state = createOAuthState(SHOP, SECRET, { now: NOW + 600_000, nonce: 'abc' });
    const result = verifyOAuthState(state, SECRET, { now: NOW });
    assert.equal(result.valid, false);
    assert.match(result.valid === false ? result.reason : '', /future/);
  });

  it('tolerates small negative clock skew', () => {
    const state = createOAuthState(SHOP, SECRET, { now: NOW + 5_000, nonce: 'abc' });
    assert.equal(verifyOAuthState(state, SECRET, { now: NOW }).valid, true);
  });

  it('rejects a missing state', () => {
    const result = verifyOAuthState(undefined, SECRET, { now: NOW });
    assert.equal(result.valid, false);
    assert.match(result.valid === false ? result.reason : '', /Missing state/);
  });

  it('rejects a state with no signature separator', () => {
    assert.equal(verifyOAuthState('no-separator-here', SECRET, { now: NOW }).valid, false);
  });

  it('rejects a state with an empty signature', () => {
    assert.equal(verifyOAuthState('payload.', SECRET, { now: NOW }).valid, false);
  });

  it('rejects a non-hex signature without throwing', () => {
    assert.equal(verifyOAuthState('payload.zzzz', SECRET, { now: NOW }).valid, false);
  });

  it('reports a clear reason when the secret is not configured', () => {
    const state = createOAuthState(SHOP, SECRET, { now: NOW, nonce: 'abc' });
    const result = verifyOAuthState(state, null, { now: NOW });
    assert.equal(result.valid, false);
    assert.match(result.valid === false ? result.reason : '', /SHOPIFY_CLIENT_SECRET/);
  });

  it('rejects a correctly signed payload with the wrong field count', () => {
    // Guards the parser: a signed but structurally wrong payload must not pass.
    const payload = Buffer.from('only-one-field', 'utf8').toString('base64url');
    // Re-sign the malformed payload with the real secret to isolate the parser.
    const signature = createHmac('sha256', SECRET).update(payload, 'utf8').digest('hex');
    const result = verifyOAuthState(`${payload}.${signature}`, SECRET, { now: NOW });
    assert.equal(result.valid, false);
    assert.match(result.valid === false ? result.reason : '', /malformed/);
  });
});
