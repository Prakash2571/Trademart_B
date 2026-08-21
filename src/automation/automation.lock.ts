/**
 * Acquiring and releasing the per-store automation lock.
 *
 * Usage is always the same shape, so the lock cannot be leaked:
 *
 *     await withAutomationLock({ trigger: 'manual' }, async () => { ... });
 *
 * The callback runs holding the lock; the lock is released in a `finally`
 * whatever happens inside.
 *
 * Mongo is the real implementation - the unique index gives a mutex that works
 * across processes. Without a database an in-process flag is used, which still
 * protects the single Node process this app runs as (and therefore still stops
 * the double-click and the webhook race, which are the cases that actually
 * happen).
 */

import { AppError } from '../common/errors';
import { logger } from '../common/logger';
import { getContext, getRequestId } from '../common/requestContext';
import { config } from '../config';
import { AutomationLockModel } from '../database/models/AutomationLock';
import { getDatabaseStatus } from '../database/mongo';

/**
 * Maximum time a run may hold the lock before it is treated as abandoned.
 *
 * Comfortably longer than a full 250-product run against a throttled Shopify,
 * but short enough that a crashed container does not block automation for the
 * rest of the day.
 */
const LEASE_MS = 15 * 60_000;

export type AutomationTrigger = 'manual' | 'webhook' | 'scheduled';

export interface LockHolder {
  startedAt: string;
  trigger: string;
  requestId: string | null;
  actor: string | null;
  leaseExpiresAt: string;
}

/** In-process fallback holder, used only when Mongo is unavailable. */
let memoryLock: (LockHolder & { lockKey: string }) | null = null;

function lockKeyFor(shopDomain: string): string {
  return `automation:${shopDomain}`;
}

function usingDatabase(): boolean {
  return getDatabaseStatus().status === 'connected';
}

/** True for Mongo's duplicate-key error, which is how "already held" surfaces. */
function isDuplicateKeyError(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  return code === 11000 || code === 11001;
}

function conflictError(holder: LockHolder | null): AppError {
  const detail =
    holder === null
      ? 'Another automation run is already in progress for this store.'
      : `An automation run started at ${holder.startedAt} (trigger: ${holder.trigger}${holder.actor === null ? '' : `, by ${holder.actor}`}) is still in progress for this store.`;

  return new AppError(
    'AUTOMATION_ALREADY_RUNNING',
    `${detail} Refusing to start a second one - two concurrent runs would write to overlapping products and the final prices would depend on which finished last. Wait for it to finish, then preview again.`,
    { details: { holder } },
  );
}

/** Reads the current holder for diagnostics. Null when the lock is free. */
export async function getAutomationLockHolder(): Promise<LockHolder | null> {
  const lockKey = lockKeyFor(config.shopify.storeDomain);

  if (!usingDatabase()) {
    if (memoryLock === null) return null;
    if (new Date(memoryLock.leaseExpiresAt).getTime() <= Date.now()) return null;
    return memoryLock;
  }

  const doc = await AutomationLockModel.findOne({ lockKey }).lean();
  if (doc === null || doc === undefined) return null;
  const raw = doc as Record<string, unknown>;
  const leaseExpiresAt = new Date(String(raw['leaseExpiresAt']));
  if (leaseExpiresAt.getTime() <= Date.now()) return null;

  return {
    startedAt: new Date(String(raw['startedAt'])).toISOString(),
    trigger: String(raw['trigger']),
    requestId: (raw['requestId'] as string | null) ?? null,
    actor: (raw['actor'] as string | null) ?? null,
    leaseExpiresAt: leaseExpiresAt.toISOString(),
  };
}

/**
 * Runs `work` while holding the store's automation lock.
 *
 * Throws AUTOMATION_ALREADY_RUNNING (409) without running `work` if the lock is
 * held by a live run.
 */
export async function withAutomationLock<T>(
  options: { trigger: AutomationTrigger },
  work: () => Promise<T>,
): Promise<T> {
  const shopDomain = config.shopify.storeDomain;
  const lockKey = lockKeyFor(shopDomain);
  const now = new Date();
  const leaseExpiresAt = new Date(now.getTime() + LEASE_MS);
  const requestId = getRequestId();
  const actor = getContext()?.actor ?? null;

  const holder: LockHolder = {
    startedAt: now.toISOString(),
    trigger: options.trigger,
    requestId,
    actor,
    leaseExpiresAt: leaseExpiresAt.toISOString(),
  };

  // ---- Acquire -------------------------------------------------------------
  if (usingDatabase()) {
    try {
      // The filter matches only an ABANDONED lock (lease in the past). So:
      //   - live lock  -> filter misses, upsert attempts insert, unique index
      //                   rejects it, and we read the holder to explain why;
      //   - stale lock -> filter matches, $set takes it over;
      //   - no lock    -> filter misses, upsert inserts, we own it.
      await AutomationLockModel.findOneAndUpdate(
        { lockKey, leaseExpiresAt: { $lte: now } },
        {
          $set: {
            lockKey,
            shopDomain,
            startedAt: now,
            leaseExpiresAt,
            trigger: options.trigger,
            requestId,
            actor,
          },
        },
        { upsert: true, new: true },
      );
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        throw conflictError(await getAutomationLockHolder());
      }
      throw error;
    }
  } else {
    const existing = memoryLock;
    if (existing !== null && new Date(existing.leaseExpiresAt).getTime() > Date.now()) {
      throw conflictError(existing);
    }
    memoryLock = { ...holder, lockKey };
  }

  logger.info('Acquired the automation lock.', {
    lockKey,
    trigger: options.trigger,
    leaseExpiresAt: holder.leaseExpiresAt,
    persistence: usingDatabase() ? 'mongo' : 'memory',
  });

  // ---- Run and always release ---------------------------------------------
  try {
    return await work();
  } finally {
    try {
      if (usingDatabase()) {
        // Scoped to this holder's requestId so a run that overran its lease
        // cannot delete the lock a later run legitimately took over.
        await AutomationLockModel.deleteOne({ lockKey, requestId });
      } else if (memoryLock !== null && memoryLock.requestId === requestId) {
        memoryLock = null;
      }
      logger.info('Released the automation lock.', { lockKey });
    } catch (error) {
      // A leaked lock self-heals when the lease expires, so this must not mask
      // the outcome of the run itself.
      logger.error('Could not release the automation lock; it will expire on its lease.', {
        lockKey,
        leaseExpiresAt: holder.leaseExpiresAt,
        reason: error instanceof Error ? error.message : 'unknown',
      });
    }
  }
}

/** Test hook: clears the in-process fallback lock. */
export function clearAutomationLockMemory(): void {
  memoryLock = null;
}
