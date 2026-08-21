/**
 * Mongo-backed webhook work queue.
 *
 * Deliberately NOT Kafka or RabbitMQ. One Shopify store produces a handful of
 * webhooks a minute; a broker would add an operational dependency, a second thing
 * to back up, and a second thing to be down, in exchange for throughput nobody
 * needs. A collection with a status field and a lease is the right size for this
 * problem, and it inherits the database's backups for free.
 *
 * GUARANTEES
 * ----------
 * * At-least-once processing. `claimNextEvent` is an atomic findOneAndUpdate, so
 *   two workers cannot claim the same row.
 * * Crash recovery. A claim carries a lease; an expired lease means the worker
 *   died and the event becomes claimable again. Nothing is lost by a restart.
 * * Bounded retries: 1 min, 5 min, 30 min, then FAILED for a human to look at.
 *   A fourth automatic retry of a deterministic failure only delays discovery.
 * * The HTTP request never waits for processing.
 */

import { toAppError } from '../common/errors';
import { logger } from '../common/logger';
import {
  createContext,
  getRequestId,
  runWithContext,
} from '../common/requestContext';
import { config } from '../config';
import { getDatabaseStatus } from '../database/mongo';
import {
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_RETRY_DELAYS_MINUTES,
  WebhookEventModel,
} from '../database/models/WebhookEvent';

/** How long a worker may hold a claimed event before it is considered dead. */
const LEASE_MS = 5 * 60_000;
/** How often the worker looks for due work. */
const POLL_INTERVAL_MS = 15_000;
/** Events processed per tick, so one burst cannot monopolise the process. */
const BATCH_SIZE = 5;

export interface QueuedEvent {
  id: string;
  topic: string;
  shopDomain: string;
  webhookId: string | null;
  payload: unknown;
  attempts: number;
  requestId: string | null;
}

/** The processing function, injected so this module has no domain knowledge. */
export type WebhookProcessor = (event: QueuedEvent) => Promise<
  { outcome: 'processed' } | { outcome: 'ignored'; reason: string }
>;

let processor: WebhookProcessor | null = null;
let timer: NodeJS.Timeout | null = null;
let running = false;
let stopping = false;

export function registerWebhookProcessor(fn: WebhookProcessor): void {
  processor = fn;
}

function usingDatabase(): boolean {
  return getDatabaseStatus().status === 'connected';
}

/**
 * Records a verified delivery and returns whether it is new.
 *
 * The unique index on webhookId is what makes this safe: a duplicate insert is
 * rejected by Mongo rather than by a read-then-write check that two simultaneous
 * retries could both pass.
 */
export async function enqueueEvent(input: {
  shopDomain: string | undefined;
  topic: string;
  webhookId: string | null;
  payload: unknown;
}): Promise<{ stored: boolean; duplicate: boolean; id: string | null }> {
  if (!usingDatabase()) {
    return { stored: false, duplicate: false, id: null };
  }

  const now = new Date();
  try {
    const created = await WebhookEventModel.create({
      shopDomain: input.shopDomain ?? config.shopify.storeDomain,
      topic: input.topic,
      webhookId: input.webhookId,
      receivedAt: now,
      status: 'RECEIVED',
      attempts: 0,
      // Eligible immediately.
      nextAttemptAt: now,
      requestId: getRequestId(),
      payload: input.payload,
      expiresAt: new Date(
        now.getTime() + config.retention.webhookEventDays * 86_400_000,
      ),
    });
    return { stored: true, duplicate: false, id: String(created._id) };
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === 11000 || code === 11001) {
      // A Shopify retry of something already recorded. Acknowledging without
      // reprocessing is exactly the point of the dedupe key.
      return { stored: false, duplicate: true, id: null };
    }
    throw error;
  }
}

interface ClaimedRow {
  _id: unknown;
  topic: string;
  shopDomain: string;
  webhookId: string | null;
  payload: unknown;
  attempts: number;
  requestId: string | null;
}

/**
 * Atomically claims one due event.
 *
 * The filter is the whole design: an event is claimable when it is RECEIVED and
 * due, OR when it is PROCESSING with an expired lease (its worker died). Both
 * cases are handled in one query, so crash recovery needs no separate sweep.
 */
async function claimNextEvent(): Promise<ClaimedRow | null> {
  const now = new Date();
  const leaseExpiresAt = new Date(now.getTime() + LEASE_MS);

  const claimed = await WebhookEventModel.findOneAndUpdate(
    {
      $or: [
        { status: 'RECEIVED', nextAttemptAt: { $lte: now } },
        { status: 'PROCESSING', leaseExpiresAt: { $lte: now } },
      ],
    },
    {
      $set: {
        status: 'PROCESSING',
        leaseExpiresAt,
        processingRequestId: null,
      },
      $inc: { attempts: 1 },
    },
    // Oldest first: webhook order approximates the order events happened, and
    // processing a stock change before the product creation that preceded it
    // would be needlessly confusing.
    { sort: { receivedAt: 1 }, new: true },
  ).lean();

  return (claimed as ClaimedRow | null) ?? null;
}

async function markProcessed(id: unknown): Promise<void> {
  await WebhookEventModel.updateOne(
    { _id: id },
    {
      $set: {
        status: 'PROCESSED',
        processedAt: new Date(),
        leaseExpiresAt: null,
        nextAttemptAt: null,
        error: null,
        errorCode: null,
        processingRequestId: getRequestId(),
      },
    },
  );
}

async function markIgnored(id: unknown, reason: string): Promise<void> {
  await WebhookEventModel.updateOne(
    { _id: id },
    {
      $set: {
        status: 'IGNORED',
        processedAt: new Date(),
        leaseExpiresAt: null,
        nextAttemptAt: null,
        ignoredReason: reason,
        processingRequestId: getRequestId(),
      },
    },
  );
}

/**
 * Schedules a retry, or gives up.
 *
 * Giving up is a feature: FAILED is a state a human can find and act on, whereas
 * retrying forever hides the problem and keeps spending Shopify quota on it.
 */
async function markFailure(
  row: ClaimedRow,
  error: unknown,
  attempts: number,
): Promise<void> {
  const appError = toAppError(error);
  const delayIndex = attempts - 1;
  const delayMinutes = WEBHOOK_RETRY_DELAYS_MINUTES[delayIndex];

  const exhausted = attempts >= WEBHOOK_MAX_ATTEMPTS || delayMinutes === undefined;

  if (exhausted) {
    await WebhookEventModel.updateOne(
      { _id: row._id },
      {
        $set: {
          status: 'FAILED',
          leaseExpiresAt: null,
          nextAttemptAt: null,
          error: appError.message,
          errorCode: appError.code,
          processingRequestId: getRequestId(),
        },
      },
    );
    logger.error('Webhook processing failed permanently; needs a manual retry.', {
      topic: row.topic,
      webhookId: row.webhookId,
      attempts,
      code: appError.code,
    });
    return;
  }

  const nextAttemptAt = new Date(Date.now() + delayMinutes * 60_000);
  await WebhookEventModel.updateOne(
    { _id: row._id },
    {
      $set: {
        status: 'RECEIVED',
        leaseExpiresAt: null,
        nextAttemptAt,
        error: appError.message,
        errorCode: appError.code,
        processingRequestId: getRequestId(),
      },
    },
  );
  logger.warn('Webhook processing failed; scheduled a retry.', {
    topic: row.topic,
    webhookId: row.webhookId,
    attempts,
    retryInMinutes: delayMinutes,
    code: appError.code,
  });
}

/** Processes one claimed event inside its own correlation context. */
async function processRow(row: ClaimedRow): Promise<void> {
  if (processor === null) {
    logger.error('No webhook processor is registered; leaving the event queued.');
    return;
  }

  // A fresh context tagged as webhook work, seeded with the ORIGINAL delivery's
  // request id where available - so the delivery and its (possibly much later)
  // processing share one id and can be read as a single story.
  const context = createContext(row.requestId ?? `webhook-${String(row._id)}`, {
    source: 'webhook',
    actor: 'system',
    authMethod: 'SHOPIFY_HMAC',
  });

  await runWithContext(context, async () => {
    try {
      const result = await processor!({
        id: String(row._id),
        topic: row.topic,
        shopDomain: row.shopDomain,
        webhookId: row.webhookId,
        payload: row.payload,
        attempts: row.attempts,
        requestId: row.requestId,
      });

      if (result.outcome === 'ignored') {
        await markIgnored(row._id, result.reason);
        logger.info('Webhook event ignored.', {
          topic: row.topic,
          reason: result.reason,
        });
        return;
      }

      await markProcessed(row._id);
      logger.info('Webhook event processed.', {
        topic: row.topic,
        webhookId: row.webhookId,
        attempts: row.attempts,
      });
    } catch (error) {
      await markFailure(row, error, row.attempts);
    }
  });
}

/** Drains up to BATCH_SIZE due events. Returns how many were handled. */
export async function drainQueue(limit = BATCH_SIZE): Promise<number> {
  if (!usingDatabase() || processor === null) return 0;

  let handled = 0;
  for (let index = 0; index < limit; index += 1) {
    if (stopping) break;
    const row = await claimNextEvent();
    if (row === null) break;
    await processRow(row);
    handled += 1;
  }
  return handled;
}

async function tick(): Promise<void> {
  // Overlapping ticks would double-process nothing (the claim is atomic) but
  // would pile up work during a slow batch, so a tick is skipped rather than
  // queued.
  if (running || stopping) return;
  running = true;
  try {
    await drainQueue();
  } catch (error) {
    logger.error('Webhook queue tick failed.', {
      reason: error instanceof Error ? error.message : 'unknown',
    });
  } finally {
    running = false;
  }
}

/**
 * Starts the in-process worker.
 *
 * `unref()` so a pending timer never keeps the process alive during shutdown -
 * without it, `docker compose stop` would wait out the poll interval.
 */
export function startWebhookWorker(): void {
  if (timer !== null) return;
  stopping = false;
  timer = setInterval(() => {
    void tick();
  }, POLL_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();

  logger.info('Webhook queue worker started.', {
    pollIntervalMs: POLL_INTERVAL_MS,
    batchSize: BATCH_SIZE,
    retryDelaysMinutes: [...WEBHOOK_RETRY_DELAYS_MINUTES],
    maxAttempts: WEBHOOK_MAX_ATTEMPTS,
  });

  // Immediate first pass, so events that arrived while the process was down are
  // picked up on boot rather than after the first poll interval.
  void tick();
}

export function stopWebhookWorker(): void {
  stopping = true;
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

/**
 * Re-queues a FAILED event for one more attempt.
 *
 * Only FAILED events are eligible. Re-running a PROCESSED one would repeat a
 * side effect that already happened, which is the opposite of what a retry button
 * should do - so that is refused rather than silently allowed.
 */
export async function retryFailedEvent(
  id: string,
): Promise<{ retried: boolean; reason?: string }> {
  if (!usingDatabase()) {
    return { retried: false, reason: 'No database is connected.' };
  }

  const updated = await WebhookEventModel.findOneAndUpdate(
    { _id: id, status: 'FAILED' },
    {
      $set: {
        status: 'RECEIVED',
        // Reset so the full retry schedule is available again.
        attempts: 0,
        nextAttemptAt: new Date(),
        leaseExpiresAt: null,
        error: null,
        errorCode: null,
      },
    },
    { new: true },
  ).lean();

  if (updated === null || updated === undefined) {
    return {
      retried: false,
      reason:
        'Only a FAILED event can be retried. A PROCESSED event has already had its effect, and re-running it could duplicate that effect.',
    };
  }

  logger.info('Re-queued a failed webhook event.', { eventId: id });
  // Handled promptly rather than at the next poll.
  void tick();
  return { retried: true };
}

export interface WebhookQueueStats {
  counts: Record<string, number>;
  oldestPending: string | null;
  lastProcessedAt: string | null;
  failed: number;
  workerRunning: boolean;
}

/** Queue health, for the diagnostics dashboard. */
export async function getQueueStats(): Promise<WebhookQueueStats> {
  const stats: WebhookQueueStats = {
    counts: {},
    oldestPending: null,
    lastProcessedAt: null,
    failed: 0,
    workerRunning: timer !== null,
  };
  if (!usingDatabase()) return stats;

  const grouped = (await WebhookEventModel.aggregate([
    { $match: { shopDomain: config.shopify.storeDomain } },
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ])) as { _id: string; count: number }[];

  for (const row of grouped) stats.counts[row._id] = row.count;
  stats.failed = stats.counts['FAILED'] ?? 0;

  const oldest = (await WebhookEventModel.findOne({
    shopDomain: config.shopify.storeDomain,
    status: { $in: ['RECEIVED', 'PROCESSING'] },
  })
    .sort({ receivedAt: 1 })
    .select('receivedAt')
    .lean()) as { receivedAt?: Date } | null;
  if (oldest?.receivedAt !== undefined) {
    stats.oldestPending = new Date(oldest.receivedAt).toISOString();
  }

  const last = (await WebhookEventModel.findOne({
    shopDomain: config.shopify.storeDomain,
    status: 'PROCESSED',
  })
    .sort({ processedAt: -1 })
    .select('processedAt')
    .lean()) as { processedAt?: Date } | null;
  if (last?.processedAt !== undefined) {
    stats.lastProcessedAt = new Date(last.processedAt).toISOString();
  }

  return stats;
}
