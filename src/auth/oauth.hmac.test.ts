/**
 * Unit tests for the OAuth request HMAC verifier.
 *
 * Signatures are generated with node:crypto inside the tests rather than
 * hardcoded, so the tests assert the ALGORITHM (what gets signed, in what order)
 * rather than one frozen digest.
 */

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  buildSignatureBases,
  computeOAuthHmac,
  extractHmacParam,
  verifyOAuthHmac,
} from './oauth.hmac';

const SECRET = 'shpss_test_client_secret';

/** Signs a query string the way Shopify does, then appends the hmac param. */
function signQuery(rawQuery: string, secret = SECRET): string {
  const base = buildSignatureBases(rawQuery)[0] as string;
  const hmac = createHmac('sha256', secret).update(base, 'utf8').digest('hex');
  return `${rawQuery}&hmac=${hmac}`;
}

describe('buildSignatureBases', () => {
  it('sorts parameters lexicographically by key', () => {
    const bases = buildSignatureBases('shop=demo.myshopify.com&code=abc&timestamp=1700000000');
    assert.equal(bases[0], 'code=abc&shop=demo.myshopify.com&timestamp=1700000000');
  });

  it('excludes the hmac parameter from the signed material', () => {
    const bases = buildSignatureBases('code=abc&hmac=deadbeef&shop=demo.myshopify.com');
    assert.equal(bases[0], 'code=abc&shop=demo.myshopify.com');
  });

  it('excludes the legacy signature parameter', () => {
    const bases = buildSignatureBases('code=abc&signature=xyz&shop=demo.myshopify.com');
    assert.equal(bases[0], 'code=abc&shop=demo.myshopify.com');
  });

  it('tolerates a leading question mark', () => {
    const bases = buildSignatureBases('?b=2&a=1');
    assert.equal(bases[0], 'a=1&b=2');
  });

  it('offers an encoded and a decoded candidate when they differ', () => {
    // `host` is base64 and can carry '=' padding, encoded on the wire as %3D.
    const bases = buildSignatureBases('host=YWJj%3D%3D&shop=demo.myshopify.com');
    assert.equal(bases.length, 2);
    assert.equal(bases[0], 'host=YWJj%3D%3D&shop=demo.myshopify.com');
    assert.equal(bases[1], 'host=YWJj==&shop=demo.myshopify.com');
  });

  it('collapses to a single candidate when encoding is irrelevant', () => {
    assert.equal(buildSignatureBases('a=1&b=2').length, 1);
  });

  it('sorts by code unit, not by locale collation', () => {
    // A locale-aware comparison can order 'Z' after 'a'; Shopify does not.
    const bases = buildSignatureBases('a=1&Z=2');
    assert.equal(bases[0], 'Z=2&a=1');
  });
});

describe('extractHmacParam', () => {
  it('returns the hmac value', () => {
    assert.equal(extractHmacParam('shop=demo.myshopify.com&hmac=abc123'), 'abc123');
  });

  it('returns null when absent', () => {
    assert.equal(extractHmacParam('shop=demo.myshopify.com'), null);
  });

  it('returns null for an empty query string', () => {
    assert.equal(extractHmacParam(''), null);
  });
});

describe('verifyOAuthHmac', () => {
  it('accepts a correctly signed callback', () => {
    const query = signQuery(
      'code=authcode123&shop=demo.myshopify.com&state=abc.def&timestamp=1700000000',
    );
    assert.deepEqual(verifyOAuthHmac(query, SECRET), { valid: true });
  });

  it('accepts a signed request regardless of parameter order on the wire', () => {
    // Shopify signs the SORTED parameters, so the order they arrive in is
    // irrelevant. This is the regression guard for re-serialising a parsed query.
    const query = signQuery('timestamp=1700000000&shop=demo.myshopify.com&code=xyz');
    assert.deepEqual(verifyOAuthHmac(query, SECRET), { valid: true });
  });

  it('accepts a base64 host parameter with percent-encoded padding', () => {
    const query = signQuery('host=YWRtaW4%3D&shop=demo.myshopify.com');
    assert.deepEqual(verifyOAuthHmac(query, SECRET), { valid: true });
  });

  it('rejects a tampered parameter', () => {
    const query = signQuery('code=authcode123&shop=demo.myshopify.com');
    const tampered = query.replace('demo.myshopify.com', 'evil.myshopify.com');
    const result = verifyOAuthHmac(tampered, SECRET);
    assert.equal(result.valid, false);
  });

  it('rejects a signature made with a different secret', () => {
    const query = signQuery('code=abc&shop=demo.myshopify.com', 'a-different-secret');
    assert.equal(verifyOAuthHmac(query, SECRET).valid, false);
  });

  it('rejects a missing hmac parameter', () => {
    const result = verifyOAuthHmac('shop=demo.myshopify.com', SECRET);
    assert.equal(result.valid, false);
    assert.match(result.valid === false ? result.reason : '', /Missing hmac/);
  });

  it('rejects a non-hex hmac without throwing', () => {
    // Buffer.from(x, 'hex') silently truncates on invalid input, so this must be
    // rejected explicitly rather than compared.
    const result = verifyOAuthHmac('shop=demo.myshopify.com&hmac=not-hex!!', SECRET);
    assert.equal(result.valid, false);
    assert.match(result.valid === false ? result.reason : '', /not a hex digest/);
  });

  it('rejects a truncated hmac of otherwise valid hex', () => {
    const query = signQuery('code=abc&shop=demo.myshopify.com');
    const truncated = query.slice(0, query.length - 10);
    assert.equal(verifyOAuthHmac(truncated, SECRET).valid, false);
  });

  it('reports a clear reason when the secret is not configured', () => {
    const result = verifyOAuthHmac('shop=demo.myshopify.com&hmac=abc', null);
    assert.equal(result.valid, false);
    assert.match(result.valid === false ? result.reason : '', /SHOPIFY_CLIENT_SECRET/);
  });

  it('is case-insensitive about the hex digest', () => {
    const query = signQuery('code=abc&shop=demo.myshopify.com');
    const [base, hmac] = query.split('&hmac=') as [string, string];
    const upper = `${base}&hmac=${hmac.toUpperCase()}`;
    assert.deepEqual(verifyOAuthHmac(upper, SECRET), { valid: true });
  });
});

describe('computeOAuthHmac', () => {
  it('produces a 64-character hex digest', () => {
    const digest = computeOAuthHmac('a=1', SECRET);
    assert.match(digest, /^[0-9a-f]{64}$/);
  });

  it('uses hex, not base64 (the webhook scheme)', () => {
    assert.doesNotMatch(computeOAuthHmac('a=1', SECRET), /[+/=]/);
  });
});
