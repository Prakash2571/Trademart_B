/**
 * POST /api/webhooks/shopify          - receives Shopify webhook deliveries
 * GET  /api/webhooks/status           - what is configured / registered
 * GET  /api/webhooks/subscriptions    - subscriptions as Shopify reports them
 * POST /api/webhooks/register         - reconcile subscriptions (idempotent)
 * POST /api/webhooks/unregister       - delete one subscription by id
 *
 * Two routers are exported on purpose:
 *
 *   webhooksRouter     - the RECEIVER. Mounted before express.json() in app.ts
 *                        because HMAC verification needs the exact raw bytes.
 *   webhookAdminRouter - management routes. Mounted after express.json(), since
 *                        they read and write JSON like any other endpoint.
 *
 * Security order of operations on a delivery (never reordered):
 *   1. verify HMAC over the raw body
 *   2. verify the shop domain
 *   3. only then parse and act on the payload
 */

import { Router, raw } from 'express';

import { AppError } from '../common/errors';
import { asyncHandler, sendSuccess } from '../common/http';
import { logger } from '../common/logger';
import { parseStringParam } from '../common/validate';
import { clearOfflineToken } from '../auth/oauth.service';
import { config, isWebhookRegistrationConfigured } from '../config';
import { getDatabaseStatus } from '../database/mongo';
import { WebhookEventModel } from '../database/models/WebhookEvent';
import { topicHeaderToEnum } from './webhook.registration';
import {
  deleteWebhookSubscription,
  listWebhookSubscriptions,
  registerWebhookSubscriptions,
} from './webhooks.service';
import {
  PLANNED_WEBHOOK_TOPICS,
  isExpectedShopDomain,
  verifyWebhookSignature,
} from './webhook.verify';

export const webhooksRouter = Router();
export const webhookAdminRouter = Router();

/** Topic (header form) that means the merchant removed the app. */
const APP_UNINSTALLED_TOPIC = 'app/uninstalled';

/**
 * The raw body parser must be mounted on this route specifically - HMAC is
 * computed over the exact bytes Shopify sent, so a JSON-parsed body is useless.
 */
webhooksRouter.post(
  '/webhooks/shopify',
  raw({ type: '*/*', limit: '2mb' }),
  asyncHandler(async (req, res) => {
    const signature = req.header('X-Shopify-Hmac-Sha256');
    const topic = req.header('X-Shopify-Topic') ?? 'unknown';
    const shopDomain = req.header('X-Shopify-Shop-Domain');
    const webhookId = req.header('X-Shopify-Webhook-Id') ?? null;

    const rawBody = Buffer.isBuffer(req.body) ? req.body : undefined;
    const verification = verifyWebhookSignature(
      rawBody,
      signature,
      config.shopify.webhookSecret,
    );

    if (!verification.valid) {
      // Log the rejection but never the body or the secret.
      logger.warn('Rejected Shopify webhook.', {
        topic,
        shopDomain,
        reason: verification.reason,
      });
      const code =
        config.shopify.webhookSecret === null
          ? 'WEBHOOK_NOT_CONFIGURED'
          : 'WEBHOOK_INVALID_SIGNATURE';
      throw new AppError(code, verification.reason);
    }

    if (!isExpectedShopDomain(shopDomain, config.shopify.storeDomain)) {
      logger.warn('Webhook rejected: unexpected shop domain.', { shopDomain, topic });
      throw new AppError(
        'WEBHOOK_INVALID_SIGNATURE',
        'Webhook shop domain does not match the configured store.',
      );
    }

    let payload: unknown = null;
    try {
      payload = JSON.parse(rawBody!.toString('utf8'));
    } catch {
      throw new AppError('VALIDATION_ERROR', 'Webhook body was not valid JSON.');
    }

    const normalisedShop = shopDomain?.toLowerCase();
    const persistenceAvailable = getDatabaseStatus().status === 'connected';

    // Idempotency. Shopify retries a delivery until it gets a 2xx, and a retry
    // carries the SAME X-Shopify-Webhook-Id. Acknowledging a duplicate without
    // re-processing is what stops one order being counted twice.
    if (persistenceAvailable && webhookId !== null) {
      try {
        const seen = await WebhookEventModel.findOne({ webhookId })
          .select('_id')
          .lean();
        if (seen !== null) {
          logger.info('Ignoring duplicate webhook delivery.', { topic, webhookId });
          res.status(200).json({ success: true, duplicate: true });
          return;
        }
      } catch (error) {
        // A failed idempotency check must not reject the delivery; the unique
        // index on webhookId is still there as a backstop.
        logger.warn('Could not check webhook for duplication; continuing.', {
          topic,
          reason: error instanceof Error ? error.message : 'unknown',
        });
      }
    }

    // Handled inline because it must work even with no database: an uninstall
    // has to invalidate the stored token, not just be filed away.
    let processed = false;
    let processingError: string | null = null;
    if (topic.toLowerCase() === APP_UNINSTALLED_TOPIC) {
      try {
        if (normalisedShop !== undefined) {
          await clearOfflineToken(normalisedShop);
        }
        processed = true;
        logger.info('Processed app/uninstalled webhook.', { shopDomain: normalisedShop });
      } catch (error) {
        processingError =
          error instanceof Error ? error.message : 'Failed to clear stored token.';
        logger.error('Failed to process app/uninstalled webhook.', {
          reason: processingError,
        });
      }
    }

    // Persist for replay/inspection when a database is available. Shopify
    // retries on non-2xx, so storage problems must not fail the delivery.
    if (persistenceAvailable) {
      try {
        await WebhookEventModel.create({
          shopDomain: normalisedShop,
          topic,
          webhookId,
          receivedAt: new Date(),
          // Only genuinely handled topics are marked processed. Everything else
          // is stored unprocessed rather than pretending it was actioned.
          processed,
          processedAt: processed ? new Date() : null,
          error: processingError,
          payload,
        });
      } catch (error) {
        logger.error('Failed to persist webhook event.', {
          topic,
          reason: error instanceof Error ? error.message : 'unknown',
        });
      }
    } else {
      logger.info('Webhook received (not persisted - no database).', { topic });
    }

    // Acknowledge fast; Shopify expects a 2xx within a few seconds.
    res.status(200).json({ success: true });
  }),
);

webhooksRouter.get(
  '/webhooks/status',
  asyncHandler(async (_req, res) => {
    // Reports local configuration only, and never fails: this endpoint is what
    // an operator checks WHEN something is wrong, so it must answer even if
    // Shopify is unreachable. Use /api/webhooks/subscriptions for live state.
    sendSuccess(res, {
      receiverPath: '/api/webhooks/shopify',
      callbackUrl: config.shopify.webhookCallbackUrl,
      secretConfigured: config.shopify.webhookSecret !== null,
      registrationConfigured: isWebhookRegistrationConfigured(),
      persistenceAvailable: getDatabaseStatus().status === 'connected',
      plannedTopics: PLANNED_WEBHOOK_TOPICS,
      note:
        config.shopify.webhookCallbackUrl === null
          ? 'APP_URL is not set, so subscriptions cannot be registered. Shopify cannot reach localhost - use a tunnel for local testing (see docs/OAUTH_AND_WEBHOOKS.md).'
          : 'POST /api/webhooks/register to reconcile subscriptions with Shopify. Add ?dryRun=1 to preview.',
    });
  }),
);

webhookAdminRouter.get(
  '/webhooks/subscriptions',
  asyncHandler(async (_req, res) => {
    const subscriptions = await listWebhookSubscriptions();
    sendSuccess(
      res,
      { subscriptions },
      { count: subscriptions.length, expectedCallbackUrl: config.shopify.webhookCallbackUrl },
    );
  }),
);

webhookAdminRouter.post(
  '/webhooks/register',
  asyncHandler(async (req, res) => {
    // ?dryRun=1 reports the plan without changing anything.
    const dryRun = req.query['dryRun'] === '1';
    const report = await registerWebhookSubscriptions({ dryRun });
    sendSuccess(res, report, { dryRun });
  }),
);

webhookAdminRouter.post(
  '/webhooks/unregister',
  asyncHandler(async (req, res) => {
    // POST rather than DELETE because a subscription id is a GID containing
    // slashes (gid://shopify/WebhookSubscription/123), which does not fit a path
    // segment - and the app's CORS policy only permits GET/POST/OPTIONS.
    const body = (req.body ?? {}) as Record<string, unknown>;
    const id = parseStringParam(body['id'], 'id', { maxLength: 255 });
    if (id === undefined) {
      throw new AppError('VALIDATION_ERROR', 'id is required.');
    }
    if (!id.startsWith('gid://shopify/WebhookSubscription/')) {
      throw new AppError(
        'VALIDATION_ERROR',
        'id must be a gid://shopify/WebhookSubscription/... value, as returned by GET /api/webhooks/subscriptions.',
      );
    }

    const deletedId = await deleteWebhookSubscription(id);
    sendSuccess(res, { deletedId });
  }),
);

/**
 * Re-exported so callers that need to correlate a delivery header with a
 * subscription topic do not have to reach into the pure module.
 */
export { topicHeaderToEnum };
