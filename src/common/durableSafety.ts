/**
 * Whether a dangerous write may proceed while the durable safety systems are down.
 *
 * Kept in its own import-free module (AppError only) for the same reason the rest
 * of the pure logic here is: `idempotency.ts` imports config, Mongoose models and
 * the connection state, so a test that imported it would boot the whole
 * configuration layer. The POLICY is the part that must be provably right, so the
 * policy lives where it can be tested directly.
 *
 * FAIL CLOSED. Every route wrapped in `idempotent()` performs a real, expensive,
 * externally visible mutation (creating a Shopify product, setting stock, pushing
 * a draft). Two things make such a write safe to accept - duplicate suppression,
 * so a retry cannot apply it twice, and an audit row naming who did it. Both live
 * in Mongo. With Mongo unreachable there is neither, so a "successful" write would
 * be unattributable and a client retry could silently create a second product or
 * apply a stock change twice.
 *
 * The behaviour this replaces set an `X-Idempotency-Status: unsupported-no-database`
 * response header and carried on. That is not a safeguard: nothing rejects a
 * request on a response header, and the caller that most needs the guarantee - an
 * automated retry - is exactly the one that will not read it.
 */

import { AppError } from './errors';

/**
 * Returns the refusal to throw, or null when the write may proceed.
 *
 * 503 + retryable is the honest answer: nothing was attempted, the condition is
 * transient, and the same request is safe to send again once storage is back.
 */
export function durableSafetyGate(databaseConnected: boolean): AppError | null {
  if (databaseConnected) return null;
  return new AppError(
    'DATABASE_UNAVAILABLE',
    'This endpoint changes the store, and the systems that make such a change safe to retry - idempotency records and the audit trail - both require MongoDB, which is not currently connected. The request was NOT attempted. Retry once storage is available.',
    { details: { requires: ['idempotency', 'audit'] } },
  );
}
