/**
 * Store-level automation lock.
 *
 * Exactly one automation apply may be in flight per shop. Two concurrent applies
 * - an operator double-clicking Apply, or a manual apply racing a
 * webhook-triggered one - would interleave writes to overlapping products, and
 * the resulting prices would be whichever call happened to land last. The audit
 * trail would show two runs each believing it succeeded.
 *
 * The unique index on `lockKey` is the mutex. A `leaseExpiresAt` in the future is
 * what makes the lock held; a lease in the past is a lock abandoned by a crashed
 * process and is reclaimable, so a hard restart mid-run cannot wedge automation
 * permanently.
 */

import { Schema, model, type InferSchemaType } from 'mongoose';

const automationLockSchema = new Schema(
  {
    /** 'automation:<shopDomain>'. The uniqueness of this field IS the lock. */
    lockKey: { type: String, required: true },
    shopDomain: { type: String, required: true },
    startedAt: { type: Date, required: true },
    /**
     * Point after which the lock is considered abandoned and may be taken over.
     * Bounded so a crash cannot block automation forever.
     */
    leaseExpiresAt: { type: Date, required: true },
    trigger: { type: String, required: true },
    /** Correlation id of the holder, so "who is running?" is answerable. */
    requestId: { type: String, default: null },
    /** Operator who started it. Never a credential. */
    actor: { type: String, default: null },
  },
  { timestamps: true, collection: 'automation_locks' },
);

automationLockSchema.index({ lockKey: 1 }, { unique: true });

export type AutomationLock = InferSchemaType<typeof automationLockSchema>;
export const AutomationLockModel = model('AutomationLock', automationLockSchema);
