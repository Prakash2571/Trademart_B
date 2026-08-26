import { logger } from '../../common/logger';
import type { CheckoutSessionRepository } from '../checkout/checkout.types';
import { asStorefrontError } from '../checkout/storefront.error';
import type { ShopifyOrderCreationPort } from './shopify-order.adapter';

const RETRY_MINUTES = [1, 5, 30, 120, 360] as const;

export class PaidOrderOrchestrator {
  public constructor(
    private readonly sessions: CheckoutSessionRepository,
    private readonly shopify: ShopifyOrderCreationPort,
  ) {}

  public async processOne(publicId?: string): Promise<boolean> {
    const session = await this.sessions.claimOrder(publicId);
    if (!session) return false;
    try {
      const order = await this.shopify.ensureOrder(session);
      await this.sessions.markOrderCreated({
        publicId: session.publicId,
        shopifyOrderId: order.id,
        shopifyOrderName: order.name,
        createdAt: order.createdAt,
      });
      logger.info('Paid Kanay checkout linked to Shopify order.', {
        checkoutPublicId: session.publicId,
        shopifyOrderId: order.id,
      });
      return true;
    } catch (error) {
      const safe = asStorefrontError(error);
      const delayMinutes =
        RETRY_MINUTES[Math.min(session.orderAttempts - 1, RETRY_MINUTES.length - 1)] ?? 360;
      await this.sessions.releaseOrderForRetry({
        publicId: session.publicId,
        nextAttemptAt: new Date(Date.now() + delayMinutes * 60_000),
        errorCode: safe.code,
        errorMessage: safe.message,
      });
      logger.warn('Paid Kanay checkout remains pending Shopify order creation.', {
        checkoutPublicId: session.publicId,
        attempt: session.orderAttempts,
        code: safe.code,
        retryInMinutes: delayMinutes,
      });
      return false;
    }
  }

  public async drain(limit = 5): Promise<number> {
    let processed = 0;
    while (processed < limit && (await this.processOne())) processed += 1;
    return processed;
  }
}

let worker: NodeJS.Timeout | null = null;
let registered: PaidOrderOrchestrator | null = null;
let draining = false;

export function registerPaidOrderOrchestrator(orchestrator: PaidOrderOrchestrator): void {
  registered = orchestrator;
}

export async function drainPaidOrderQueue(limit = 5): Promise<number> {
  if (!registered || draining) return 0;
  draining = true;
  try {
    return await registered.drain(limit);
  } finally {
    draining = false;
  }
}

export function startPaidOrderWorker(): void {
  if (worker) return;
  worker = setInterval(() => void drainPaidOrderQueue().catch(() => undefined), 15_000);
  worker.unref();
  void drainPaidOrderQueue().catch(() => undefined);
}

export function stopPaidOrderWorker(): void {
  if (worker) clearInterval(worker);
  worker = null;
}
