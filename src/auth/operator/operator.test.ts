/**
 * Unit tests for the operator authentication primitives.
 *
 * These are the parts that must be right for the security layer to mean
 * anything: a tampered session must not verify, an expired one must not verify,
 * a wrong password must not verify, and a CSRF token must not be satisfiable by
 * an attacker who can only cause the cookie to be sent.
 *
 * Pure logic only - no Express, no network, no database.
 */

import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';

import { AppError } from '../../common/errors';
import {
  CSRF_COOKIE,
  SESSION_COOKIE,
  clearCookie,
  parseCookies,
  serialiseCookie,
} from './cookies';
import { createCsrfToken, csrfTokensMatch, methodRequiresCsrf } from './csrf';
import {
  DEFAULT_SCRYPT_PARAMS,
  apiKeyMatches,
  hashPassword,
  parsePasswordHash,
  verifyPassword,
} from './password';
import {
  createSessionToken,
  shouldRenewSession,
  verifySessionToken,
} from './session';

/** Cheap scrypt parameters so the suite stays fast; production uses N=16384. */
const FAST = { N: 1024, r: 8, p: 1 } as const;
const SECRET = 'a'.repeat(48);
const NOW = 1_700_000_000_000;

describe('password hashing', () => {
  it('round-trips a correct password', async () => {
    const hash = await hashPassword('correct horse battery staple', FAST);
    assert.equal(await verifyPassword('correct horse battery staple', hash), true);
  });

  it('rejects a wrong password', async () => {
    const hash = await hashPassword('correct horse', FAST);
    assert.equal(await verifyPassword('wrong horse', hash), false);
  });

  it('is case sensitive', async () => {
    const hash = await hashPassword('Secret', FAST);
    assert.equal(await verifyPassword('secret', hash), false);
  });

  it('never stores the password in the hash', async () => {
    const hash = await hashPassword('plaintext-leak-check', FAST);
    assert.ok(!hash.includes('plaintext-leak-check'));
  });

  it('salts, so the same password hashes differently every time', async () => {
    const a = await hashPassword('same', FAST);
    const b = await hashPassword('same', FAST);
    assert.notEqual(a, b);
    // Both must still verify - the salt travels with the hash.
    assert.equal(await verifyPassword('same', a), true);
    assert.equal(await verifyPassword('same', b), true);
  });

  it('embeds its parameters so they can be raised later', async () => {
    const hash = await hashPassword('x', FAST);
    const parsed = parsePasswordHash(hash);
    assert.equal(parsed.N, FAST.N);
    assert.equal(parsed.r, FAST.r);
    assert.equal(parsed.p, FAST.p);
  });

  it('verifies a hash written with different parameters', async () => {
    // Proves an existing hash keeps working after the defaults change.
    const hash = await hashPassword('portable', { N: 2048, r: 8, p: 1 });
    assert.equal(await verifyPassword('portable', hash), true);
  });

  it('uses memory-hard defaults in production', () => {
    assert.ok(DEFAULT_SCRYPT_PARAMS.N >= 16384);
  });

  it('rejects an empty password', async () => {
    await assert.rejects(() => hashPassword('', FAST));
  });

  it('reports a malformed hash as misconfiguration, not a bad password', async () => {
    // Otherwise an operator debugs their password instead of their env file.
    await assert.rejects(
      () => verifyPassword('anything', 'not-a-hash'),
      (error: unknown) =>
        error instanceof AppError && error.code === 'OPERATOR_NOT_CONFIGURED',
    );
  });

  it('rejects a hash with a non-scrypt algorithm', () => {
    assert.throws(() => parsePasswordHash('bcrypt$1$2$3$4$5'));
  });

  it('rejects a hash with nonsense parameters', () => {
    assert.throws(() => parsePasswordHash('scrypt$0$0$0$c2FsdA==$aGFzaA=='));
  });
});

describe('apiKeyMatches', () => {
  it('accepts an identical key', () => {
    assert.equal(apiKeyMatches('abc123def456', 'abc123def456'), true);
  });

  it('rejects a different key of equal length', () => {
    assert.equal(apiKeyMatches('abc123def456', 'abc123def457'), false);
  });

  it('rejects differing lengths without throwing', () => {
    assert.equal(apiKeyMatches('short', 'much-longer-key'), false);
  });

  it('never treats empty as a match', () => {
    assert.equal(apiKeyMatches('', ''), false);
    assert.equal(apiKeyMatches('', 'key'), false);
  });
});

describe('session tokens', () => {
  it('round-trips a valid session', () => {
    const token = createSessionToken('operator', SECRET, { now: NOW });
    const result = verifySessionToken(token, SECRET, { now: NOW + 1000 });
    assert.equal(result.valid, true);
    assert.equal(result.valid === true ? result.session.username : null, 'operator');
  });

  it('rejects a token signed with a different secret', () => {
    const token = createSessionToken('operator', 'b'.repeat(48), { now: NOW });
    const result = verifySessionToken(token, SECRET, { now: NOW });
    assert.equal(result.valid, false);
  });

  it('rejects a tampered username even with a valid-looking structure', () => {
    // The whole point: an attacker must not be able to promote themselves.
    const token = createSessionToken('operator', SECRET, { now: NOW });
    const [, signature] = token.split('.') as [string, string];
    const forged = Buffer.from(`v1:admin:${NOW}:${NOW + 1000}:x`, 'utf8').toString(
      'base64url',
    );
    const result = verifySessionToken(`${forged}.${signature}`, SECRET, { now: NOW });
    assert.equal(result.valid, false);
  });

  it('rejects an expired session', () => {
    const token = createSessionToken('operator', SECRET, { now: NOW, ttlMs: 1000 });
    const result = verifySessionToken(token, SECRET, { now: NOW + 1001 });
    assert.equal(result.valid, false);
    assert.match(result.valid === false ? result.reason : '', /expired/);
  });

  it('accepts a session one millisecond before expiry', () => {
    const token = createSessionToken('operator', SECRET, { now: NOW, ttlMs: 1000 });
    assert.equal(verifySessionToken(token, SECRET, { now: NOW + 999 }).valid, true);
  });

  it('rejects a session issued far in the future', () => {
    const token = createSessionToken('operator', SECRET, { now: NOW + 600_000 });
    assert.equal(verifySessionToken(token, SECRET, { now: NOW }).valid, false);
  });

  it('rejects a missing token', () => {
    assert.equal(verifySessionToken(undefined, SECRET, { now: NOW }).valid, false);
  });

  it('rejects a malformed token without throwing', () => {
    assert.equal(verifySessionToken('no-dot-here', SECRET, { now: NOW }).valid, false);
    assert.equal(verifySessionToken('payload.', SECRET, { now: NOW }).valid, false);
    assert.equal(verifySessionToken('payload.zzz', SECRET, { now: NOW }).valid, false);
  });

  it('refuses to verify when no secret is configured', () => {
    const token = createSessionToken('operator', SECRET, { now: NOW });
    assert.equal(verifySessionToken(token, null, { now: NOW }).valid, false);
  });

  it('rejects a correctly signed payload with the wrong field count', () => {
    const payload = Buffer.from('v1:only:three', 'utf8').toString('base64url');
    const signature = createHmac('sha256', SECRET).update(payload, 'utf8').digest('hex');
    const result = verifySessionToken(`${payload}.${signature}`, SECRET, { now: NOW });
    assert.equal(result.valid, false);
    assert.match(result.valid === false ? result.reason : '', /malformed/);
  });

  it('rejects an unknown session version', () => {
    const payload = Buffer.from(
      `v9:operator:${NOW}:${NOW + 1000}:nonce`,
      'utf8',
    ).toString('base64url');
    const signature = createHmac('sha256', SECRET).update(payload, 'utf8').digest('hex');
    const result = verifySessionToken(`${payload}.${signature}`, SECRET, { now: NOW });
    assert.equal(result.valid, false);
  });

  it('does not expose the username in cleartext', () => {
    const token = createSessionToken('very-distinctive-operator', SECRET, { now: NOW });
    assert.ok(!token.includes('very-distinctive-operator'));
  });

  it('refuses a username containing the payload separator', () => {
    assert.throws(() => createSessionToken('bad:name', SECRET, { now: NOW }));
  });

  it('issues a different token each time', () => {
    const a = createSessionToken('operator', SECRET, { now: NOW });
    const b = createSessionToken('operator', SECRET, { now: NOW });
    assert.notEqual(a, b, 'random nonce should make tokens unique');
  });
});

describe('shouldRenewSession', () => {
  const session = { username: 'operator', issuedAt: NOW, expiresAt: NOW + 1000 };

  it('does not renew early in the session', () => {
    assert.equal(shouldRenewSession(session, NOW + 100), false);
  });

  it('renews past the halfway point', () => {
    assert.equal(shouldRenewSession(session, NOW + 600), true);
  });
});

describe('CSRF double-submit', () => {
  it('accepts a matching cookie and header', () => {
    const token = createCsrfToken();
    assert.equal(csrfTokensMatch(token, token), true);
  });

  it('rejects a mismatch', () => {
    assert.equal(csrfTokensMatch(createCsrfToken(), createCsrfToken()), false);
  });

  it('rejects a missing header - the attacker cannot set one', () => {
    // This is the property that makes the pattern work: a cross-origin form post
    // sends the cookie but cannot add the header.
    assert.equal(csrfTokensMatch(createCsrfToken(), undefined), false);
  });

  it('rejects a missing cookie', () => {
    assert.equal(csrfTokensMatch(undefined, createCsrfToken()), false);
  });

  it('cannot be satisfied with empty values', () => {
    assert.equal(csrfTokensMatch('', ''), false);
  });

  it('generates high-entropy tokens', () => {
    const token = createCsrfToken();
    assert.ok(token.length >= 40, `token was only ${token.length} chars`);
    assert.notEqual(token, createCsrfToken());
  });

  it('requires CSRF for state-changing methods only', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      assert.equal(methodRequiresCsrf(method), true, method);
    }
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      assert.equal(methodRequiresCsrf(method), false, method);
    }
  });

  it('is case-insensitive about the method', () => {
    assert.equal(methodRequiresCsrf('post'), true);
  });
});

describe('cookies', () => {
  it('parses a normal cookie header', () => {
    const parsed = parseCookies('a=1; b=two; c=three');
    assert.deepEqual(parsed, { a: '1', b: 'two', c: 'three' });
  });

  it('parses the session and CSRF cookies together', () => {
    const parsed = parseCookies(`${SESSION_COOKIE}=abc.def; ${CSRF_COOKIE}=xyz`);
    assert.equal(parsed[SESSION_COOKIE], 'abc.def');
    assert.equal(parsed[CSRF_COOKIE], 'xyz');
  });

  it('returns an empty map for no header', () => {
    assert.deepEqual(parseCookies(undefined), {});
    assert.deepEqual(parseCookies(''), {});
  });

  it('skips malformed pairs rather than failing the request', () => {
    const parsed = parseCookies('good=1; garbage; =novalue; other=2');
    assert.equal(parsed['good'], '1');
    assert.equal(parsed['other'], '2');
  });

  it('percent-decodes values and tolerates a stray percent', () => {
    assert.equal(parseCookies('a=one%20two')['a'], 'one two');
    assert.equal(parseCookies('a=100%')['a'], '100%');
  });

  it('serialises a session cookie as HttpOnly, Secure, SameSite=Lax', () => {
    const header = serialiseCookie(SESSION_COOKIE, 'value', { maxAgeSeconds: 3600 });
    assert.match(header, /HttpOnly/);
    assert.match(header, /Secure/);
    assert.match(header, /SameSite=Lax/);
    assert.match(header, /Max-Age=3600/);
    assert.match(header, /Path=\//);
  });

  it('can omit HttpOnly for the CSRF cookie the frontend must read', () => {
    const header = serialiseCookie(CSRF_COOKIE, 'value', { httpOnly: false });
    assert.doesNotMatch(header, /HttpOnly/);
  });

  it('can omit Secure for local http development', () => {
    const header = serialiseCookie(SESSION_COOKIE, 'v', { secure: false });
    assert.doesNotMatch(header, /Secure/);
  });

  it('url-encodes the value', () => {
    assert.match(serialiseCookie('n', 'a b&c'), /n=a%20b%26c/);
  });

  it('clears a cookie with an empty value and Max-Age=0', () => {
    const header = clearCookie(SESSION_COOKIE);
    assert.match(header, /^trademart_session=;/);
    assert.match(header, /Max-Age=0/);
  });

  it('round-trips an encoded value', () => {
    const value = randomBytes(24).toString('base64');
    const serialised = serialiseCookie('t', value);
    const encoded = serialised.slice('t='.length, serialised.indexOf(';'));
    assert.equal(parseCookies(`t=${encoded}`)['t'], value);
  });
});
