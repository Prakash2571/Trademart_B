/**
 * POST /api/webhooks/shopify   - receives Shopify webhook deliveries
 * GET  /api/webhooks/status    - what is configured / planned
 *
 * Webhooks are NOT required for the first milestone; this is the receiving
 * architecture, ready for when subscriptions are registered.
 *
 * Security order of operations (never reordered):
 *   1. verify HMAC over the raw body
 *   2. verify the shop domain
 *   3. only then parse and act on the payload
 */

import { Router, raw } from 'express';

import { AppError } from '../common/errors';
import { asyncHandler, sendSuccess } from '../common/http';
import { logger } from '../common/logger';
import { config } from '../config';
import { getDatabaseStatus } from '../database/mongo';
import { WebhookEventModel } from '../database/models/WebhookEvent';
import {
  PLANNED_WEBHOOK_TOPICS,
  isExpectedShopDomain,
  verifyWebhookSignature,
} from './webhook.verify';

export const webhooksRouter = Router();

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

    // Persist for replay/inspection when a database is available. Shopify
    // retries on non-2xx, so storage problems must not fail the delivery.
    if (getDatabaseStatus().status === 'connected') {
      try {
        await WebhookEventModel.create({
          shopDomain: shopDomain?.toLowerCase(),
          topic,
          webhookId,
          receivedAt: new Date(),
          processed: false,
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
    sendSuccess(res, {
      receiverPath: '/api/webhooks/shopify',
      secretConfigured: config.shopify.webhookSecret !== null,
      persistenceAvailable: getDatabaseStatus().status === 'connected',
      plannedTopics: PLANNED_WEBHOOK_TOPICS,
      note: 'No subscriptions are registered yet. localhost is not reachable by Shopify - use a Shopify CLI tunnel for local testing (see backend README).',
    });
  }),
);
