/**
 * Bridges verified webhook deliveries to automation runs.
 *
 * Kept out of webhooks.controller.ts so the receiver stays focused on
 * verification, and out of automation.service.ts so the service has no opinion
 * about webhooks. The decision of WHETHER to run is pure and lives in
 * automation.triggers.ts.
 *
 * Fire-and-forget by design: the caller has already sent Shopify its 2xx, so
 * nothing here may throw into the request lifecycle. Every failure is logged and
 * swallowed — a failed automation run must never turn into a webhook retry,
 * because Shopify would redeliver an event we already accepted.
 */

import { toAppError } from '../common/errors';
import { logger } from '../common/logger';
import { isAutomationOnWebhookEnabled } from '../config';
import {
  holdProductForReview,
  resolveEffectiveRules,
  resolveProductFromInventoryItem,
  runAutomation,
} from './automation.service';
import { TriggerCooldown, decideTrigger } from './automation.triggers';

/**
 * Module-level so the window is shared across deliveries.
 *
 * In-memory: see the note in automation.triggers.ts. It is a thrash guard, not
 * the correctness mechanism — idempotence is what guarantees the loop ends.
 */
const cooldown = new TriggerCooldown();

/** Exposed for tests and diagnostics. */
export function cooldownSize(): number {
  return cooldown.size();
}

/**
 * Decides and, if warranted, runs automation for a delivery.
 *
 * Returns immediately; the run happens on a detached promise.
 */
export function scheduleAutomationForWebhook(topic: string, payload: unknown): void {
  if (!isAutomationOnWebhookEnabled()) return;

  const decision = decideTrigger(topic, payload);
  if (!decision.run) {
    logger.debug('Webhook did not trigger automation.', { topic, reason: decision.reason });
    return;
  }

  // Keyed by whichever id we have. An inventory item and its product get
  // separate keys, which is acceptable: the worst case is one extra run.
  const key = decision.shopifyProductId ?? decision.inventoryItemId ?? topic;
  if (!cooldown.tryAcquire(key)) {
    logger.debug('Automation trigger suppressed by cooldown.', { topic, key });
    return;
  }

  void execute(decision.topic, decision.shopifyProductId, decision.inventoryItemId).catch(
    (error: unknown) => {
      const appError = toAppError(error);
      logger.error('Webhook-triggered automation failed.', {
        topic,
        code: appError.code,
        reason: appError.message,
      });
    },
  );
}

async function execute(
  topic: string,
  productIdFromPayload: string | null,
  inventoryItemId: string | null,
): Promise<void> {
  let productId = productIdFromPayload;

  if (productId === null && inventoryItemId !== null) {
    productId = await resolveProductFromInventoryItem(inventoryItemId);
    if (productId === null) {
      logger.info('Stock change did not resolve to a product; nothing to do.', {
        inventoryItemId,
      });
      return;
    }
  }

  if (productId === null) return;

  // Uses the SAVED rules, not the defaults: a webhook has no request body, so
  // without this an automatic run would silently use price.enabled = false and
  // never reprice anything.
  const rules = await resolveEffectiveRules();

  // A brand-new import is gated before anything else, so it cannot reach the
  // storefront in the window between import and review.
  if (topic === 'products/create' && rules.selection.newProductPolicy === 'draft') {
    try {
      await holdProductForReview(productId);
    } catch (error) {
      // Non-fatal: still worth pricing the product even if the gate failed.
      logger.warn('Could not hold the new product for review.', {
        shopifyProductId: productId,
        code: toAppError(error).code,
      });
    }
  }

  const report = await runAutomation({
    dryRun: false,
    trigger: 'webhook',
    productIds: [productId],
  });

  logger.info('Webhook-triggered automation finished.', {
    topic,
    shopifyProductId: productId,
    applied: report.summary.applied,
    failed: report.summary.failed,
  });
}
