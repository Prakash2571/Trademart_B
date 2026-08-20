/**
 * Operator session tokens.
 *
 * Signed and self-contained, deliberately mirroring auth/oauth.state.ts:
 *
 *   base64url(`v1:<username>:<issuedAtMs>:<expiresAtMs>:<nonce>`) + '.' + hexHMAC
 *
 * Why stateless rather than a sessions collection in Mongo: this codebase treats
 * Mongo as OPTIONAL (database/mongo.ts degrades to "no persistence" instead of
 * failing), so a database-backed session store would log the operator out
 * exactly when the database is down - i.e. when they most need to reach the
 * console. A signed cookie needs no storage at all.
 *
 * The trade-off is that a stateless session cannot be revoked individually
 * before it expires. It is bounded three ways instead: a short absolute TTL,
 * rotation of SESSION_SECRET invalidating every session at once, and the
 * `sessionEpoch` field, which lets a future "log out everywhere" bump a counter.
 *
 * Pure apart from node:crypto, so expiry and tampering are unit testable with
 * no clock and no network.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const VERSION = 'v1';
const NONCE_BYTES = 16;

/** Default session lifetime. Short enough to bound a stolen cookie. */
export const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * Renew the cookie once this fraction of the lifetime has elapsed, so an active
 * operator is not logged out mid-session while an idle one still expires.
 */
const RENEW_AFTER_FRACTION = 0.5;

export interface OperatorSession {
  username: string;
  issuedAt: number;
  expiresAt: number;
}

export type SessionVerification =
  | { valid: true; session: OperatorSession }
  | { valid: false; reason: string };

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
}

/**
 * Creates a signed session token.
 *
 * `username` must not contain ':' - it is the payload separator. Callers pass a
 * configured operator name, but it is validated rather than trusted so a future
 * caller cannot smuggle extra fields into the payload.
 */
export function createSessionToken(
  username: string,
  secret: string,
  options: { now?: number; ttlMs?: number; nonce?: string } = {},
): string {
  if (username.includes(':')) {
    throw new Error('Operator username must not contain a colon.');
  }
  const now = options.now ?? Date.now();
  const ttlMs = options.ttlMs ?? DEFAULT_SESSION_TTL_MS;
  const nonce = options.nonce ?? randomBytes(NONCE_BYTES).toString('hex');

  const payload = Buffer.from(
    `${VERSION}:${username}:${now}:${now + ttlMs}:${nonce}`,
    'utf8',
  ).toString('base64url');

  return `${payload}.${sign(payload, secret)}`;
}

/**
 * Verifies a session token.
 *
 * The signature is checked BEFORE the payload is parsed, so an unsigned payload
 * never influences control flow.
 */
export function verifySessionToken(
  token: string | undefined,
  secret: string | null,
  options: { now?: number } = {},
): SessionVerification {
  if (secret === null || secret.length === 0) {
    return { valid: false, reason: 'SESSION_SECRET is not configured.' };
  }
  if (token === undefined || token.length === 0) {
    return { valid: false, reason: 'No session cookie.' };
  }

  const separator = token.lastIndexOf('.');
  if (separator <= 0 || separator === token.length - 1) {
    return { valid: false, reason: 'Session token is malformed.' };
  }

  const payload = token.slice(0, separator);
  const provided = Buffer.from(token.slice(separator + 1).toLowerCase(), 'hex');
  const expected = Buffer.from(sign(payload, secret), 'hex');

  if (
    provided.length !== expected.length ||
    expected.length === 0 ||
    !timingSafeEqual(expected, provided)
  ) {
    return { valid: false, reason: 'Session signature is invalid.' };
  }

  // Signature verified - only now is the payload safe to read.
  let decoded: string;
  try {
    decoded = Buffer.from(payload, 'base64url').toString('utf8');
  } catch {
    return { valid: false, reason: 'Session payload is not valid base64url.' };
  }

  const parts = decoded.split(':');
  if (parts.length !== 5) {
    return { valid: false, reason: 'Session payload is malformed.' };
  }

  const [version, username, rawIssued, rawExpires] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];

  if (version !== VERSION) {
    return { valid: false, reason: `Unsupported session version "${version}".` };
  }
  if (username.length === 0) {
    return { valid: false, reason: 'Session payload has no username.' };
  }
  if (!/^\d+$/.test(rawIssued) || !/^\d+$/.test(rawExpires)) {
    return { valid: false, reason: 'Session payload has invalid timestamps.' };
  }

  const issuedAt = Number(rawIssued);
  const expiresAt = Number(rawExpires);
  const now = options.now ?? Date.now();

  if (now >= expiresAt) {
    return { valid: false, reason: 'Session has expired; sign in again.' };
  }
  // A session issued in the future means a forged or badly skewed timestamp.
  // A small allowance avoids spurious failures between hosts.
  if (issuedAt - now > 60_000) {
    return { valid: false, reason: 'Session timestamp is in the future.' };
  }

  return { valid: true, session: { username, issuedAt, expiresAt } };
}

/**
 * True when the cookie is past halfway through its life and should be reissued,
 * giving an active operator a sliding window without weakening the absolute cap.
 */
export function shouldRenewSession(
  session: OperatorSession,
  now: number = Date.now(),
): boolean {
  const lifetime = session.expiresAt - session.issuedAt;
  if (lifetime <= 0) return false;
  return now - session.issuedAt >= lifetime * RENEW_AFTER_FRACTION;
}
