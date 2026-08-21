/**
 * MongoDB connection (test version).
 *
 * Connecting is intentionally NON-FATAL: this milestone is about proving the
 * Shopify integration works. If MONGODB_URI is absent or the server is
 * unreachable, the API still boots and /api/health reports the degraded state
 * instead of crash-looping.
 */

import mongoose from 'mongoose';

import { logger } from '../common/logger';
import { config } from '../config';
import { AuditLogModel } from './models/AuditLog';
import { IdempotencyKeyModel } from './models/IdempotencyKey';
import { WebhookEventModel } from './models/WebhookEvent';

export type DatabaseStatus = 'disabled' | 'connecting' | 'connected' | 'error';

let status: DatabaseStatus = 'disabled';
let lastError: string | null = null;

export function getDatabaseStatus(): { status: DatabaseStatus; error: string | null } {
  // mongoose.connection.readyState: 0 disconnected, 1 connected, 2 connecting, 3 disconnecting
  if (status === 'connected' && mongoose.connection.readyState !== 1) {
    return { status: 'error', error: 'Connection lost.' };
  }
  return { status, error: lastError };
}

export async function connectDatabase(): Promise<DatabaseStatus> {
  if (config.mongoUri === null) {
    logger.warn('MONGODB_URI is not set - starting without a database.');
    status = 'disabled';
    return status;
  }

  status = 'connecting';
  mongoose.set('strictQuery', true);

  try {
    await mongoose.connect(config.mongoUri, {
      serverSelectionTimeoutMS: 8000,
      // Trademart stores only small snapshots; keep the pool modest.
      maxPoolSize: 10,
    });
    status = 'connected';
    lastError = null;
    // Log the database name only - never the URI, which embeds credentials.
    logger.info('MongoDB connected.', { database: mongoose.connection.name });
  } catch (error) {
    status = 'error';
    lastError = error instanceof Error ? error.message : 'Unknown connection error.';
    logger.error('MongoDB connection failed - continuing without persistence.', {
      reason: lastError,
    });
  }

  mongoose.connection.on('disconnected', () => {
    if (status === 'connected') {
      status = 'error';
      lastError = 'Disconnected from MongoDB.';
      logger.warn('MongoDB disconnected.');
    }
  });

  mongoose.connection.on('reconnected', () => {
    status = 'connected';
    lastError = null;
    logger.info('MongoDB reconnected.');
  });

  return status;
}

/**
 * Models whose indexes this app's CORRECTNESS depends on.
 *
 * Imported here so they are registered with Mongoose before anything queries
 * them, and so syncIndexes actually runs against each one at startup.
 */
const INDEXED_MODELS = [
  { name: 'AuditLog', model: AuditLogModel },
  { name: 'IdempotencyKey', model: IdempotencyKeyModel },
  { name: 'WebhookEvent', model: WebhookEventModel },
];

/**
 * Creates or updates the indexes the application relies on.
 *
 * Mongoose's default autoIndex builds indexes lazily, asynchronously, and says
 * nothing when it fails. That is fine for a performance index and NOT fine for a
 * unique one: webhook deduplication and the idempotency claim are both ENFORCED by
 * unique indexes, and an index that has not finished building yet does not
 * enforce anything. So they are created deliberately and failures are reported.
 *
 * Non-fatal, consistent with the rest of the database handling: the API still
 * serves Shopify reads without Mongo, so refusing to boot over an index would be
 * a worse outcome than running degraded. Each failure is logged at error level,
 * because a missing unique index silently weakens a guarantee rather than
 * breaking visibly.
 *
 * syncIndexes also DROPS indexes no longer declared in a schema, which stops a
 * long-lived deployment accumulating dead ones.
 */
export async function ensureIndexes(): Promise<void> {
  if (getDatabaseStatus().status !== 'connected') {
    logger.info('Skipping index creation - no database connection.');
    return;
  }

  for (const entry of INDEXED_MODELS) {
    try {
      await entry.model.syncIndexes();
    } catch (error) {
      logger.error(
        `Could not sync indexes for ${entry.name}. Uniqueness and TTL guarantees for this collection may not be enforced.`,
        { model: entry.name, reason: error instanceof Error ? error.message : 'unknown' },
      );
    }
  }

  logger.info('Database indexes synchronised.', {
    models: INDEXED_MODELS.map((entry) => entry.name),
  });
}

export async function disconnectDatabase(): Promise<void> {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
  status = 'disabled';
}
