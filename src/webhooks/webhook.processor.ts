/**
 * What a webhook delivery actually DOES, once the queue hands it over.
 *
 * Separated from the queue so the queue has no domain knowledge, and separated
 * from the receiver so the receiver only has to verify and acknowledge.
 *
 * THROWING IS MEANINGFUL HERE. The queue interprets a thrown error as "retry me
 * later", and a returned `ignored` as "there was nothing to do". Getting that
 * distinction right is what stops the queue from either retrying a deleted
 * product forever or quietly dropping a real failure:
 *
 *   throw            -> transient, retry (Shopify throttle, network, 5xx)
 *   return ignored   -> deliberate no-op (unhandled topic, product gone)
 *   return processed -> done
 */

import { AppError, toAppError } from '../common/errors';
import { logger } from '../common/logger';
import { clearOfflineToken } from '../auth/oauth.service';
import {
  holdProductForReview,
  resolveEffectiveRules,
  resolveProductFromInventoryItem,
  runAutomation,
} from '../automation/automation.service';
import { decideTrigger } from '../automation/automation.triggers';
import { isAutomationOnWebhookEnabled } from '../config';
import type { QueuedEvent } from './webhook.queue';

export type ProcessOutcome =
  | { outcome: 'processed' }
  | { outcome: 'ignored'; reason: string };

/** Topic (header form) that means the merchant removed the app. */
const APP_UNINSTALLED_TOPIC = 'app/uninstalled';

/**
 * Handles one queued delivery.
 *
 * Registered with the queue at startup (see server.ts).
 */
export async function processWebhookEvent(event: QueuedEvent): Promise<ProcessOutcome> {
  const topic = event.topic.toLowerCase();

  // ---- Uninstall: always handled, regardless of automation settings --------
  if (topic === APP_UNINSTALLED_TOPIC) {
    // Invalidating the stored token is a security action, not an automation one,
    // so it is never gated on AUTOMATION_ON_WEBHOOK.
    await clearOfflineToken(event.shopDomain);
    logger.info('Processed app/uninstalled: cleared the stored offline token.', {
      shopDomain: event.shopDomain,
    });
    return { outcome: 'processed' };
  }

  // ---- Everything else is automation ---------------------------------------
  if (!isAutomationOnWebhookEnabled()) {
    return {
      outcome: 'ignored',
      reason:
        'AUTOMATION_ON_WEBHOOK is not enabled, so this delivery was recorded but not acted on.',
    };
  }

  const decision = decideTrigger(event.topic, event.payload);
  if (!decision.run) {
    return { outcome: 'ignored', reason: decision.reason };
  }

  let productId = decision.shopifyProductId;
  if (productId === null && decision.inventoryItemId !== null) {
    productId = await resolveProductFromInventoryItem(decision.inventoryItemId);
    if (productId === null) {
      return {
        outcome: 'ignored',
        reason:
          'The stock change did not resolve to a product - the variant was probably deleted.',
      };
    }
  }

  if (productId === null) {
    return { outcome: 'ignored', reason: 'The payload named no product to act on.' };
  }

  // Uses the SAVED rules: a webhook has no request body, so without this an
  // automatic run would use price.enabled = false and reprice nothing.
  const rules = await resolveEffectiveRules();

  // A brand-new import is gated before anything else, so it cannot reach the
  // storefront in the window between import and review.
  if (topic === 'products/create' && rules.selection.newProductPolicy === 'draft') {
    try {
      await holdProductForReview(productId);
    } catch (error) {
      // Non-fatal: the product is still worth pricing even if the gate failed.
      // Not rethrown, because retrying the whole delivery for this would also
      // re-run the pricing below.
      logger.warn('Could not hold the new product for review.', {
        shopifyProductId: productId,
        code: toAppError(error).code,
      });
    }
  }

  try {
    const report = await runAutomation({
      dryRun: false,
      trigger: 'webhook',
      productIds: [productId],
    });

    logger.info('Webhook-triggered automation finished.', {
      topic: event.topic,
      shopifyProductId: productId,
      applied: report.summary.applied,
      failed: report.summary.failed,
    });
    return { outcome: 'processed' };
  } catch (error) {
    const appError = error instanceof AppError ? error : toAppError(error);

    // An operator's bulk apply holds the lock and will cover this product anyway.
    // Ignored rather than retried: a retry would just contend for the lock again.
    if (appError.code === 'AUTOMATION_ALREADY_RUNNING') {
      return {
        outcome: 'ignored',
        reason:
          'An automation run was already in progress for this store, and it covers this product.',
      };
    }

    // Deliberate refusals are deterministic. Retrying them changes nothing and
    // would burn the retry budget that a transient failure needs.
    if (
      appError.code === 'AUTOMATION_DISABLED' ||
      appError.code === 'AUTOMATION_RULES_INVALID' ||
      appError.code === 'AUTOMATION_PRECONDITION_FAILED' ||
      appError.code === 'SHOPIFY_SCOPE_MISSING'
    ) {
      return {
        outcome: 'ignored',
        reason: `${appError.code}: ${appError.message}`,
      };
    }

    // Everything else (throttling, timeouts, 5xx) is worth another attempt.
    throw appError;
  }
}
