/**
 * `Idempotency-Key` support for mutating endpoints.
 *
 * HOW IT WORKS
 * ------------
 *   no header            -> pass through unchanged (opt-in, nothing breaks)
 *   new key              -> claim it, run the handler, store the response
 *   same key, same body  -> replay the stored response, do NOT run the handler
 *   same key, new body   -> 409 IDEMPOTENCY_CONFLICT
 *   same key, in flight  -> 409 IDEMPOTENCY_IN_PROGRESS
 *
 * The claim is a unique-index insert, so duplicate detection happens inside
 * Mongo. A read-then-write check would have a race exactly wide enough for two
 * simultaneous retries to both pass it, which is the case that matters most.
 *
 * WHY ONLY SUCCESSES ARE STORED
 * -----------------------------
 * A 5xx or a network-level failure is precisely what the client is retrying, and
 * replaying a stored 502 forever would make the retry useless. So a failed
 * attempt releases its key, leaving the next attempt free to do the work. A 4xx
 * IS stored: a validation error is deterministic, and replaying it is both
 * correct and cheaper than re-running the handler.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { createHash } from 'node:crypto';

import { AppError } from './errors';
import { logger } from './logger';
import { getContext, getRequestId } from './requestContext';
import { config } from '../config';
import { IdempotencyKeyModel } from '../database/models/IdempotencyKey';
import { getDatabaseStatus } from '../database/mongo';
import { stableStringify } from './stableStringify';

export const IDEMPOTENCY_HEADER = 'Idempotency-Key';

/** Accepted key shape. Narrow, because it lands in an index and in logs. */
const VALID_KEY = /^[A-Za-z0-9._~:-]{8,200}$/;

function isDuplicateKeyError(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  return code === 11000 || code === 11001;
}

/**
 * Fingerprints the request so a key cannot be reused for a different call.
 *
 * Body is stably stringified so key order in the JSON does not matter - a client
 * retrying with a re-serialised body must not be treated as a conflict.
 */
function hashRequest(req: Request): string {
  const payload = stableStringify({
    method: req.method,
    path: req.path,
    body: req.body ?? null,
  });
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

interface StoredRecord {
  status: string;
  requestHash: string;
  responseStatus: number | null;
  responseBody: unknown;
  requestId: string | null;
  createdAt: Date;
}

/**
 * Guards one route with idempotency.
 *
 * `operation` names the logical action and is part of the uniqueness key, so the
 * same client-generated key used on two different endpoints is not a conflict.
 */
export function idempotent(operation: string): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    void handle(operation, req, res, next).catch(next);
  };
}

async function handle(
  operation: string,
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const supplied = req.header(IDEMPOTENCY_HEADER);

  // Opt-in: a client that does not send the header behaves exactly as before.
  if (supplied === undefined || supplied.trim().length === 0) {
    next();
    return;
  }

  const key = supplied.trim();
  if (!VALID_KEY.test(key)) {
    throw new AppError(
      'VALIDATION_ERROR',
      `${IDEMPOTENCY_HEADER} must be 8-200 characters of letters, digits, dot, dash, underscore, tilde or colon. A UUID is a good choice.`,
    );
  }

  // Without a database the guarantee cannot be honoured. Being explicit about
  // that in a response header is better than silently accepting the key and
  // implying protection that is not there.
  if (getDatabaseStatus().status !== 'connected') {
    res.setHeader('X-Idempotency-Status', 'unsupported-no-database');
    logger.warn('Idempotency-Key ignored: no database is connected.', { operation });
    next();
    return;
  }

  const requestHash = hashRequest(req);
  const now = new Date();

  // ---- Claim the key -------------------------------------------------------
  try {
    await IdempotencyKeyModel.create({
      key,
      operation,
      requestHash,
      status: 'IN_PROGRESS',
      requestId: getRequestId(),
      actor: getContext()?.actor ?? null,
      createdAt: now,
      expiresAt: new Date(now.getTime() + config.retention.idempotencyKeyHours * 3_600_000),
    });
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;

    // Someone got here first. Decide what that means.
    const existing = (await IdempotencyKeyModel.findOne({ key, operation }).lean()) as
      | (StoredRecord & Record<string, unknown>)
      | null;

    if (existing === null) {
      // The record expired between the failed insert and this read. Treat it as a
      // fresh request rather than inventing an error.
      logger.info('Idempotency record vanished between insert and read; proceeding.', {
        operation,
      });
      next();
      return;
    }

    if (existing.requestHash !== requestHash) {
      throw new AppError(
        'IDEMPOTENCY_CONFLICT',
        `${IDEMPOTENCY_HEADER} "${key}" was already used for a DIFFERENT request on this endpoint. Reusing a key with a changed body would make the response meaningless, so it is refused. Generate a new key for a new request.`,
        {
          details: {
            key,
            operation,
            originalRequestId: existing.requestId,
            originalAt: new Date(String(existing.createdAt)).toISOString(),
          },
        },
      );
    }

    if (existing.status === 'IN_PROGRESS') {
      throw new AppError(
        'IDEMPOTENCY_IN_PROGRESS',
        `A request with ${IDEMPOTENCY_HEADER} "${key}" is still being processed. Wait for it to finish rather than retrying - retrying now could duplicate the effect.`,
        { details: { key, operation, originalRequestId: existing.requestId } },
      );
    }

    // COMPLETED: replay verbatim.
    logger.info('Replayed a stored idempotent response.', {
      operation,
      key,
      originalRequestId: existing.requestId,
      replayedStatus: existing.responseStatus,
    });
    res.setHeader('X-Idempotency-Status', 'replayed');
    if (existing.requestId !== null) {
      res.setHeader('X-Idempotency-Original-Request-Id', existing.requestId);
    }
    res.status(existing.responseStatus ?? 200).json(existing.responseBody);
    return;
  }

  // ---- We own the key: run the handler and capture the response ------------
  res.setHeader('X-Idempotency-Status', 'stored');

  const originalJson = res.json.bind(res);
  let captured: unknown = null;
  let capturedStatus = 200;

  // Wrapping res.json is how the response is captured without every handler
  // having to cooperate. The body is recorded, then passed through untouched.
  res.json = (body: unknown) => {
    captured = body;
    capturedStatus = res.statusCode;
    return originalJson(body);
  };

  res.on('finish', () => {
    void finalise();
  });

  async function finalise(): Promise<void> {
    const status = capturedStatus;

    // 5xx and 429 release the key. These are the failures a client legitimately
    // retries, and replaying them forever would defeat the retry entirely.
    const shouldRelease = status >= 500 || status === 429;

    try {
      if (shouldRelease) {
        await IdempotencyKeyModel.deleteOne({ key, operation, status: 'IN_PROGRESS' });
        logger.info('Released an idempotency key after a retryable failure.', {
          operation,
          key,
          status,
        });
        return;
      }

      await IdempotencyKeyModel.updateOne(
        { key, operation },
        {
          $set: {
            status: 'COMPLETED',
            responseStatus: status,
            responseBody: captured,
            completedAt: new Date(),
          },
        },
      );
    } catch (error) {
      // The response has already been sent, so this cannot be surfaced. Logged
      // loudly: a key left IN_PROGRESS will block retries until it expires.
      logger.error('Failed to finalise an idempotency record.', {
        operation,
        key,
        status,
        reason: error instanceof Error ? error.message : 'unknown',
      });
    }
  }

  next();
}
