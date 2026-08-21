/**
 * Idempotency records for mutating requests.
 *
 * The failure this prevents: a client sends "create product", the response is
 * lost to a timeout or a flaky connection, the client retries, and the store ends
 * up with two products. The operator sees one success and one error, and has no
 * way to know a duplicate was created.
 *
 * With an `Idempotency-Key`, the second request returns the FIRST request's
 * stored response instead of doing the work again.
 *
 * `requestHash` is what stops a key being reused for a different request - the
 * same key with a different body is a client bug, and returning the original
 * response for it would be worse than an error.
 */

import { Schema, model, type InferSchemaType } from 'mongoose';

const idempotencyKeySchema = new Schema(
  {
    /** The client-supplied Idempotency-Key header value. */
    key: { type: String, required: true },
    /**
     * Logical operation, e.g. 'POST /api/shopify/products'. Part of the unique
     * index so the same key on two different endpoints is not a conflict - a
     * client that generates one key per user action should not be punished for
     * reusing it across unrelated calls.
     */
    operation: { type: String, required: true },
    /** Hash of method + path + body. Detects a key reused for a different request. */
    requestHash: { type: String, required: true },
    status: {
      type: String,
      required: true,
      enum: ['IN_PROGRESS', 'COMPLETED'],
      default: 'IN_PROGRESS',
    },
    /** Captured response, replayed verbatim for a duplicate. */
    responseStatus: { type: Number, default: null },
    responseBody: { type: Schema.Types.Mixed, default: null },
    /** Correlation ids of the original request and of any replayed duplicates. */
    requestId: { type: String, default: null },
    actor: { type: String, default: null },
    createdAt: { type: Date, required: true, default: () => new Date() },
    completedAt: { type: Date, default: null },
    /** TTL anchor. Set from RETENTION_IDEMPOTENCY_HOURS (default 48h). */
    expiresAt: { type: Date, required: true },
  },
  { timestamps: false, collection: 'idempotency_keys' },
);

// The mutex. An insert that violates this index IS the duplicate detection - no
// read-then-write race, because the uniqueness check happens inside Mongo.
idempotencyKeySchema.index({ key: 1, operation: 1 }, { unique: true });

// Retention: long enough to outlast any realistic client retry storm, short
// enough that this collection never becomes large.
idempotencyKeySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type IdempotencyKey = InferSchemaType<typeof idempotencyKeySchema>;
export const IdempotencyKeyModel = model('IdempotencyKey', idempotencyKeySchema);
