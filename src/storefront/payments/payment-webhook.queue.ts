import { logger } from '../../common/logger';
import { RazorpayWebhookEventModel } from '../../database/models/RazorpayWebhookEvent';
import { asStorefrontError } from '../checkout/storefront.error';
import type { StorefrontPaymentService } from './payment.service';
import type { SafeRazorpayWebhook } from './razorpay.webhook';

const RETRY_MINUTES = [1, 5, 30] as const;
const LEASE_MS = 3 * 60_000;

export async function enqueueRazorpayWebhook(
  event: SafeRazorpayWebhook,
): Promise<{ duplicate: boolean }> {
  try {
    await RazorpayWebhookEventModel.create({
      eventId: event.eventId,
      eventType: event.eventType,
      receivedAt: new Date(),
      status: 'RECEIVED',
      attempts: 0,
      nextAttemptAt: new Date(),
      payment: event.payment,
    });
    return { duplicate: false };
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === 11000 || code === 11001) return { duplicate: true };
    throw error;
  }
}

interface ClaimedWebhook {
  _id: unknown;
  eventId: string;
  eventType: string;
  attempts: number;
  payment: SafeRazorpayWebhook['payment'];
}

async function claim(): Promise<ClaimedWebhook | null> {
  const now = new Date();
  const row = await RazorpayWebhookEventModel.findOneAndUpdate(
    {
      $or: [
        { status: 'RECEIVED', nextAttemptAt: { $lte: now } },
        { status: 'PROCESSING', leaseExpiresAt: { $lte: now } },
      ],
    },
    {
      $set: { status: 'PROCESSING', leaseExpiresAt: new Date(now.getTime() + LEASE_MS) },
      $inc: { attempts: 1 },
    },
    { sort: { receivedAt: 1 }, new: true },
  ).lean();
  return row as ClaimedWebhook | null;
}

let paymentService: StorefrontPaymentService | null = null;
let timer: NodeJS.Timeout | null = null;
let draining = false;

export function registerRazorpayWebhookProcessor(service: StorefrontPaymentService): void {
  paymentService = service;
}

export async function drainRazorpayWebhookQueue(limit = 5): Promise<number> {
  if (!paymentService || draining) return 0;
  draining = true;
  let processed = 0;
  try {
    while (processed < limit) {
      const row = await claim();
      if (!row) break;
      try {
        const outcome = await paymentService.processWebhook({
          eventId: row.eventId,
          eventType: row.eventType,
          payment: row.payment,
        });
        await RazorpayWebhookEventModel.updateOne(
          { _id: row._id },
          {
            $set: {
              status: outcome === 'PROCESSED' ? 'PROCESSED' : 'IGNORED',
              processedAt: new Date(),
              leaseExpiresAt: null,
              nextAttemptAt: null,
              ignoredReason: outcome === 'IGNORED' ? 'Event was not actionable for a Kanay checkout.' : null,
            },
          },
        );
      } catch (error) {
        const safe = asStorefrontError(error);
        const delay = RETRY_MINUTES[row.attempts - 1];
        await RazorpayWebhookEventModel.updateOne(
          { _id: row._id },
          {
            $set: {
              status: delay === undefined ? 'FAILED' : 'RECEIVED',
              leaseExpiresAt: null,
              nextAttemptAt: delay === undefined ? null : new Date(Date.now() + delay * 60_000),
              errorCode: safe.code,
              errorMessage: safe.message.slice(0, 300),
            },
          },
        );
        logger.warn('Razorpay webhook reconciliation did not complete.', {
          eventId: row.eventId,
          eventType: row.eventType,
          attempt: row.attempts,
          code: safe.code,
        });
      }
      processed += 1;
    }
    return processed;
  } finally {
    draining = false;
  }
}

export function startRazorpayWebhookWorker(): void {
  if (timer) return;
  timer = setInterval(() => void drainRazorpayWebhookQueue().catch(() => undefined), 15_000);
  timer.unref();
  void drainRazorpayWebhookQueue().catch(() => undefined);
}

export function stopRazorpayWebhookWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
