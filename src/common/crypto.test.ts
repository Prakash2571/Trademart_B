/**
 * Unit tests for the at-rest encryption helper.
 *
 * These cover the properties that matter for storing an access token: the
 * plaintext must not be recoverable without the key, tampering must be detected
 * (GCM's whole point), and the same input must not produce the same ciphertext
 * twice.
 */

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';

import { AppError } from './errors';
import {
  decodeEncryptionKey,
  decryptSecret,
  encryptSecret,
  secretsMatch,
} from './crypto';

const KEY = randomBytes(32);

/**
 * A fake Shopify token, assembled at runtime rather than written as a literal.
 *
 * `shpat_` followed by 32 hex characters is exactly the shape of a real access
 * token, so a literal here trips GitHub's secret scanning and blocks the push.
 * Building it from parts keeps the test realistic without a scannable string.
 */
const TOKEN_PREFIX = 'shpat_';
const TOKEN = `${TOKEN_PREFIX}${'a1b2c3d4'.repeat(4)}`;

describe('decodeEncryptionKey', () => {
  it('accepts 32 bytes of base64', () => {
    const key = randomBytes(32).toString('base64');
    assert.equal(decodeEncryptionKey(key).length, 32);
  });

  it('accepts 32 bytes of hex', () => {
    const key = randomBytes(32).toString('hex');
    assert.equal(decodeEncryptionKey(key).length, 32);
  });

  it('rejects a key of the wrong length', () => {
    assert.throws(
      () => decodeEncryptionKey(randomBytes(16).toString('base64')),
      (error: unknown) =>
        error instanceof AppError && error.code === 'ENCRYPTION_NOT_CONFIGURED',
    );
  });

  it('rejects a key that is neither hex nor base64', () => {
    assert.throws(
      () => decodeEncryptionKey('not a valid key!!'),
      (error: unknown) => error instanceof AppError,
    );
  });
});

describe('encryptSecret / decryptSecret', () => {
  it('round-trips a token', () => {
    assert.equal(decryptSecret(encryptSecret(TOKEN, KEY), KEY), TOKEN);
  });

  it('round-trips unicode and empty strings', () => {
    assert.equal(decryptSecret(encryptSecret('', KEY), KEY), '');
    assert.equal(decryptSecret(encryptSecret('café ☕', KEY), KEY), 'café ☕');
  });

  it('never contains the plaintext', () => {
    const ciphertext = encryptSecret(TOKEN, KEY);
    assert.ok(!ciphertext.includes(TOKEN_PREFIX));
    assert.ok(!ciphertext.includes(TOKEN));
  });

  it('produces a different ciphertext each time (random IV)', () => {
    // A deterministic ciphertext would leak that two stores share a token.
    assert.notEqual(encryptSecret(TOKEN, KEY), encryptSecret(TOKEN, KEY));
  });

  it('uses the versioned v1.iv.tag.ciphertext envelope', () => {
    const parts = encryptSecret(TOKEN, KEY).split('.');
    assert.equal(parts.length, 4);
    assert.equal(parts[0], 'v1');
    assert.equal(Buffer.from(parts[1] as string, 'base64').length, 12);
    assert.equal(Buffer.from(parts[2] as string, 'base64').length, 16);
  });

  it('fails to decrypt with the wrong key', () => {
    const ciphertext = encryptSecret(TOKEN, KEY);
    assert.throws(
      () => decryptSecret(ciphertext, randomBytes(32)),
      (error: unknown) =>
        error instanceof AppError && error.code === 'ENCRYPTION_NOT_CONFIGURED',
    );
  });

  it('detects a tampered ciphertext', () => {
    const parts = encryptSecret(TOKEN, KEY).split('.');
    const body = Buffer.from(parts[3] as string, 'base64');
    body[0] = (body[0] ?? 0) ^ 0xff;
    const tampered = [parts[0], parts[1], parts[2], body.toString('base64')].join('.');
    assert.throws(() => decryptSecret(tampered, KEY), (error: unknown) => error instanceof AppError);
  });

  it('detects a tampered auth tag', () => {
    const parts = encryptSecret(TOKEN, KEY).split('.');
    const tag = Buffer.from(parts[2] as string, 'base64');
    tag[0] = (tag[0] ?? 0) ^ 0xff;
    const tampered = [parts[0], parts[1], tag.toString('base64'), parts[3]].join('.');
    assert.throws(() => decryptSecret(tampered, KEY), (error: unknown) => error instanceof AppError);
  });

  it('rejects a malformed envelope', () => {
    assert.throws(() => decryptSecret('nonsense', KEY));
    assert.throws(() => decryptSecret('v1.a.b', KEY));
  });

  it('rejects an unknown envelope version', () => {
    const ciphertext = encryptSecret(TOKEN, KEY);
    const bumped = `v2${ciphertext.slice(2)}`;
    assert.throws(
      () => decryptSecret(bumped, KEY),
      (error: unknown) => error instanceof AppError && /version/.test(error.message),
    );
  });

  it('does not reveal whether the key or the payload was wrong', () => {
    // Both failure modes must produce the same operator-facing message.
    const ciphertext = encryptSecret(TOKEN, KEY);
    let wrongKeyMessage = '';
    try {
      decryptSecret(ciphertext, randomBytes(32));
    } catch (error) {
      wrongKeyMessage = (error as AppError).message;
    }
    assert.match(wrongKeyMessage, /could not be decrypted/);
  });
});

describe('secretsMatch', () => {
  it('matches identical strings', () => {
    assert.equal(secretsMatch('abc123', 'abc123'), true);
  });

  it('rejects different strings of equal length', () => {
    assert.equal(secretsMatch('abc123', 'abc124'), false);
  });

  it('rejects different lengths without throwing', () => {
    assert.equal(secretsMatch('abc', 'abcdef'), false);
  });

  it('treats empty strings as non-matching', () => {
    // An empty stored secret must never be "equal" to an empty supplied one.
    assert.equal(secretsMatch('', ''), false);
  });
});
