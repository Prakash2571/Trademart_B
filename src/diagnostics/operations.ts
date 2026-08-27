/**
 * One place that answers "is anything wrong right now?".
 *
 * WHAT THIS REPLACES
 * ------------------
 * Nothing. Before this, the only way to learn that the webhook queue was backing
 * up, that payments were failing signature verification, or that paid orders were
 * failing to reach Shopify was to read the logs - which requires knowing what to
 * grep for, and therefore requires already suspecting the answer.
 *
 * WHAT IT IS NOT
 * --------------
 * Not a metrics platform. The numbers come from two cheap sources: process-local
 * counters (common/metrics.ts) and a small number of aggregate queries the queue
 * modules already run for the operator UI. There are no per-order or per-customer
 * labels anywhere - both because they would be unbounded, and because a metric that
 * names a customer is a PII export with a dashboard in front of it.
 *
 * ACCESS
 * ------
 * Operator-only, unconditionally (see the mount in app.ts). It reports failure
 * counts, queue depths and dependency state, which together describe how to hurt
 * this deployment; unlike the other read routes it is never left open by
 * OPERATOR_PROTECT_READS=false.
 */

import { snapshotCounters, type CounterSnapshot } from '../common/metrics';
import { getDatabaseStatus, getIndexSyncReport } from '../database/mongo';
import { getBreakerSnapshot } from '../shopify/shopify.breaker';
import { getQueueStats, type WebhookQueueStats } from '../webhooks/webhook.queue';
import { oldestPendingAgeSeconds } from './queueAge';

export interface OperationsReport {
  observedAt: string;
  /** Process-local, reset on restart. Stated so nobody reads them as totals. */
  countersNote: string;
  counters: CounterSnapshot;
  database: {
    status: string;
    /** Whether index synchronisation succeeded at startup, and for which models. */
    indexes: ReturnType<typeof getIndexSyncReport>;
  };
  shopify: {
    breaker: ReturnType<typeof getBreakerSnapshot>;
  };
  webhooks: {
    queue: WebhookQueueStats;
    /** Age of the oldest unprocessed delivery, in seconds. Null when the queue is empty. */
    oldestPendingAgeSeconds: number | null;
  };
}

export async function buildOperationsReport(now = new Date()): Promise<OperationsReport> {
  // Queue stats degrade to zeroes without a database rather than throwing: an
  // operator checking diagnostics BECAUSE the database is down must still get an
  // answer, and "database: error" is the answer.
  const queue = await getQueueStats();

  return {
    observedAt: now.toISOString(),
    countersNote:
      'Counters are process-local and reset when the container restarts. Use them for "is this happening now", not as historical totals.',
    counters: snapshotCounters(),
    database: {
      status: getDatabaseStatus().status,
      indexes: getIndexSyncReport(),
    },
    shopify: {
      breaker: getBreakerSnapshot(),
    },
    webhooks: {
      queue,
      oldestPendingAgeSeconds: oldestPendingAgeSeconds(queue.oldestPending, now),
    },
  };
}
