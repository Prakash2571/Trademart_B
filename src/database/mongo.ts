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

export async function disconnectDatabase(): Promise<void> {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
  status = 'disabled';
}
