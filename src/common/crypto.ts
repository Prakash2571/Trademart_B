/**
 * Authenticated encryption for secrets stored at rest.
 *
 * The only current use is the per-merchant OAuth offline access token. Store.ts
 * states the rule plainly: tokens must never be persisted in plaintext.
 *
 * AES-256-GCM is used rather than AES-CBC because GCM is authenticated - a
 * tampered ciphertext fails to decrypt instead of yielding attacker-influenced
 * plaintext. Every encryption uses a fresh random 12-byte IV (the size GCM is
 * specified for), and the auth tag is stored alongside it.
 *
 * Serialised form (all base64, dot-separated, versioned):
 *
 *   v1.<iv>.<authTag>.<ciphertext>
 *
 * The version prefix exists so the key or algorithm can be rotated later
 * without having to guess how an existing row was written.
 *
 * Uses only node:crypto, so it is unit testable with no npm dependencies.
 */

import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

import { AppError } from './errors';

const ALGORITHM = 'aes-256-gcm';
const VERSION = 'v1';
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const KEY_BYTES = 32;

/**
 * Decodes a hex or base64 key into raw bytes.
 *
 * The encoding precedence (hex first, then base64) must stay identical to
 * `decodeKeyLength` in src/config/env.validation.ts, otherwise a key could pass
 * boot validation and then fail here. That validator is kept separate only
 * because it is deliberately import-free.
 */
export function decodeEncryptionKey(value: string): Buffer {
  let key: Buffer;
  if (/^[0-9a-fA-F]+$/.test(value) && value.length % 2 === 0) {
    key = Buffer.from(value, 'hex');
  } else if (/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    key = Buffer.from(value, 'base64');
  } else {
    throw new AppError(
      'ENCRYPTION_NOT_CONFIGURED',
      'TOKEN_ENCRYPTION_KEY is neither valid hex nor valid base64.',
    );
  }

  if (key.length !== KEY_BYTES) {
    throw new AppError(
      'ENCRYPTION_NOT_CONFIGURED',
      `TOKEN_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes (got ${key.length}).`,
    );
  }
  return key;
}

/**
 * Encrypts a UTF-8 string. `key` is the raw 32 bytes, not the encoded form, so
 * callers decode once at startup rather than per operation.
 */
export function encryptSecret(plaintext: string, key: Buffer): string {
  if (key.length !== KEY_BYTES) {
    throw new AppError(
      'ENCRYPTION_NOT_CONFIGURED',
      `Encryption key must be ${KEY_BYTES} bytes.`,
    );
  }

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return [
    VERSION,
    iv.toString('base64'),
    authTag.toString('base64'),
    ciphertext.toString('base64'),
  ].join('.');
}

/**
 * Reverses `encryptSecret`.
 *
 * Throws (rather than returning null) on any structural problem or auth-tag
 * mismatch: a token that cannot be decrypted is unusable, and silently treating
 * it as "absent" would look like the merchant had never installed the app.
 */
export function decryptSecret(serialised: string, key: Buffer): string {
  const parts = serialised.split('.');
  if (parts.length !== 4) {
    throw new AppError(
      'ENCRYPTION_NOT_CONFIGURED',
      'Stored ciphertext is malformed (expected 4 dot-separated segments).',
    );
  }

  const [version, ivB64, authTagB64, ciphertextB64] = parts as [
    string,
    string,
    string,
    string,
  ];

  if (version !== VERSION) {
    throw new AppError(
      'ENCRYPTION_NOT_CONFIGURED',
      `Unsupported ciphertext version "${version}"; this build understands ${VERSION}.`,
    );
  }

  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(authTagB64, 'base64');
  if (iv.length !== IV_BYTES || authTag.length !== AUTH_TAG_BYTES) {
    throw new AppError(
      'ENCRYPTION_NOT_CONFIGURED',
      'Stored ciphertext has an invalid IV or authentication tag length.',
    );
  }

  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextB64, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    // Deliberately opaque: the underlying message ("unable to authenticate
    // data") tells an attacker whether the key or the payload was wrong.
    throw new AppError(
      'ENCRYPTION_NOT_CONFIGURED',
      'Stored token could not be decrypted. The TOKEN_ENCRYPTION_KEY may have changed since it was written - the merchant must reinstall the app.',
    );
  }
}

/**
 * Constant-time string comparison for secrets.
 *
 * Exposed here so callers never reach for `===` on a secret. Length is compared
 * first because timingSafeEqual throws on differing lengths; that leak is
 * unavoidable and harmless compared with a byte-by-byte early exit.
 */
export function secretsMatch(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  if (bufferA.length !== bufferB.length || bufferA.length === 0) return false;
  return timingSafeEqual(bufferA, bufferB);
}
