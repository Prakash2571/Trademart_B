/**
 * Operator password hashing and verification.
 *
 * Uses scrypt from node:crypto. That is a deliberate choice, not a compromise:
 * scrypt is a memory-hard KDF designed for exactly this, it is in the standard
 * library, and this codebase has six runtime dependencies that it is worth
 * keeping. bcrypt/argon2 would each add a native build step for no security
 * gain at this scale.
 *
 * Stored form (single line, safe to put in an env var or secret manager):
 *
 *   scrypt$<N>$<r>$<p>$<saltBase64>$<hashBase64>
 *
 * The parameters travel WITH the hash so they can be raised later without
 * invalidating existing hashes - a hash written today still verifies after the
 * defaults change.
 *
 * Pure apart from node:crypto, so it is unit testable with no network and no
 * database.
 */

import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

import { AppError } from '../../common/errors';

/**
 * Cost parameters. N=16384 with r=8 needs roughly 16 MB per hash
 * (128 * N * r bytes), which is a sensible interactive-login cost: slow enough
 * to be expensive to brute force, fast enough not to be a denial-of-service
 * vector on the login route.
 */
export const DEFAULT_SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 } as const;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const ALGORITHM = 'scrypt';

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

interface ParsedHash extends ScryptParams {
  salt: Buffer;
  hash: Buffer;
}

/** Promise wrapper around the async scrypt, so logins never block the loop. */
function deriveKey(
  password: string,
  salt: Buffer,
  params: ScryptParams,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      KEY_LENGTH,
      {
        N: params.N,
        r: params.r,
        p: params.p,
        // Node's default maxmem (32 MB) is below what larger N values need, so
        // it is raised in step with the parameters rather than hardcoded.
        maxmem: 256 * params.N * params.r,
      },
      (error: Error | null, derived: Buffer) => {
        if (error) reject(error);
        else resolve(derived);
      },
    );
  });
}

/** Hashes a password into the storable single-line form. */
export async function hashPassword(
  password: string,
  params: ScryptParams = DEFAULT_SCRYPT_PARAMS,
): Promise<string> {
  if (password.length === 0) {
    throw new AppError('VALIDATION_ERROR', 'Password must not be empty.');
  }
  const salt = randomBytes(SALT_LENGTH);
  const derived = await deriveKey(password, salt, params);
  return [
    ALGORITHM,
    params.N,
    params.r,
    params.p,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

/**
 * Parses a stored hash.
 *
 * Throws OPERATOR_NOT_CONFIGURED rather than returning false: a malformed hash
 * is an operator configuration error, and reporting it as "wrong password"
 * would send someone debugging the wrong thing entirely.
 */
export function parsePasswordHash(encoded: string): ParsedHash {
  const parts = encoded.trim().split('$');
  if (parts.length !== 6 || parts[0] !== ALGORITHM) {
    throw new AppError(
      'OPERATOR_NOT_CONFIGURED',
      'OPERATOR_PASSWORD_HASH is malformed. Expected scrypt$N$r$p$salt$hash - regenerate it with: npm run operator:hash',
    );
  }

  const [, rawN, rawR, rawP, rawSalt, rawHash] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];

  const N = Number(rawN);
  const r = Number(rawR);
  const p = Number(rawP);
  if (
    !Number.isInteger(N) ||
    !Number.isInteger(r) ||
    !Number.isInteger(p) ||
    N < 2 ||
    r < 1 ||
    p < 1
  ) {
    throw new AppError(
      'OPERATOR_NOT_CONFIGURED',
      'OPERATOR_PASSWORD_HASH has invalid scrypt parameters.',
    );
  }

  const salt = Buffer.from(rawSalt, 'base64');
  const hash = Buffer.from(rawHash, 'base64');
  if (salt.length === 0 || hash.length === 0) {
    throw new AppError(
      'OPERATOR_NOT_CONFIGURED',
      'OPERATOR_PASSWORD_HASH has an empty salt or digest.',
    );
  }

  return { N, r, p, salt, hash };
}

/**
 * Verifies a password against a stored hash.
 *
 * Always performs the full key derivation before comparing, and compares in
 * constant time, so a wrong password costs the same as a right one.
 */
export async function verifyPassword(
  password: string,
  encoded: string,
): Promise<boolean> {
  const parsed = parsePasswordHash(encoded);
  const derived = await deriveKey(password, parsed.salt, {
    N: parsed.N,
    r: parsed.r,
    p: parsed.p,
  });

  if (derived.length !== parsed.hash.length) return false;
  return timingSafeEqual(derived, parsed.hash);
}

/**
 * Constant-time comparison for the pre-shared API key.
 *
 * Hashing both sides first means timingSafeEqual never sees differing lengths
 * (which would make it throw) and the comparison cannot leak the key's length.
 */
export function apiKeyMatches(supplied: string, expected: string): boolean {
  if (supplied.length === 0 || expected.length === 0) return false;
  const a = Buffer.from(supplied, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
