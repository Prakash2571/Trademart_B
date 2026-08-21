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
import { parseIntParam, parseStringParam } from '../common/validate';
import {
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_RETRY_DELAYS_MINUTES,
  WEBHOOK_STATES,
} from '../database/models/WebhookEvent';
import { clearOfflineToken } from '../auth/oauth.service';
import { recordAudit } from '../audit/audit.service';
import { config, isWebhookRegistrationConfigured } from '../config';
import { getDatabaseStatus } from '../database/mongo';
import { WebhookEventModel } from '../database/models/WebhookEvent';
import { topicHeaderToEnum } from './webhook.registration';
import {
  drainQueue,
  enqueueEvent,
  getQueueStats,
  retryFailedEvent,
} from './webhook.queue';
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

    // ---- Persist, then acknowledge. Never process inline. -------------------
    //
    // The old flow did the work after res.json() on a detached promise, which
    // meant a crash or a restart between acknowledgement and completion silently
    // dropped the event: Shopify had its 2xx and would never redeliver.
    //
    // Now the delivery is durably queued BEFORE the 200, so the only thing that
    // has to succeed within Shopify's timeout is a single insert.
    //
    // Dedupe is the unique index on webhookId, not a read-then-write check: two
    // simultaneous Shopify retries can both pass a read, and only one can win an
    // insert.
    let enqueued: { stored: boolean; duplicate: boolean; id: string | null } = {
      stored: false,
      duplicate: false,
      id: null,
    };

    if (persistenceAvailable) {
      try {
        enqueued = await enqueueEvent({
          shopDomain: normalisedShop,
          topic,
          webhookId,
          payload,
        });
      } catch (error) {
        // A storage failure must not produce a non-2xx: Shopify would retry, and
        // the retry would hit the same broken storage. Fall through to the
        // inline path below so an uninstall is still honoured.
        logger.error('Failed to queue the webhook event.', {
          topic,
          reason: error instanceof Error ? error.message : 'unknown',
        });
      }
    }

    if (enqueued.duplicate) {
      logger.info('Ignoring duplicate webhook delivery.', { topic, webhookId });
      res.status(200).json({ success: true, duplicate: true });
      return;
    }

    // Acknowledge fast; Shopify expects a 2xx within a few seconds.
    res.status(200).json({
      success: true,
      queued: enqueued.stored,
    });

    if (enqueued.stored) {
      // Nudge the worker so a delivery is handled in about a second rather than
      // waiting for the next poll. Fire-and-forget: the event is already durable,
      // so a failure here only delays it to the next tick.
      void drainQueue(1).catch((error: unknown) => {
        logger.warn('Immediate webhook drain failed; the poller will retry.', {
          reason: error instanceof Error ? error.message : 'unknown',
        });
      });
      return;
    }

    // ---- No-database fallback ------------------------------------------------
    //
    // An uninstall must invalidate the stored token even with no persistence -
    // leaving a revoked token in place is a security problem, not a bookkeeping
    // one. Everything else is dropped with a loud log, because without storage
    // there is nowhere to retry from.
    if (topic.toLowerCase() === APP_UNINSTALLED_TOPIC) {
      try {
        if (normalisedShop !== undefined) await clearOfflineToken(normalisedShop);
        logger.info('Processed app/uninstalled inline (no database).', {
          shopDomain: normalisedShop,
        });
      } catch (error) {
        logger.error('Failed to clear the stored token after an uninstall.', {
          reason: error instanceof Error ? error.message : 'unknown',
        });
      }
      return;
    }

    logger.warn(
      'Webhook acknowledged but NOT queued - no database. It will not be processed or retried.',
      { topic, webhookId },
    );
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

/**
 * GET /api/webhooks/events - delivery history and queue state.
 *
 * The diagnostic that answers "did Shopify tell us, and did we act on it?". The
 * payload is omitted by default because it is the bulky part and is rarely what
 * the operator is looking for; ?includePayload=1 opts in for one lookup.
 */
webhookAdminRouter.get(
  '/webhooks/events',
  asyncHandler(async (req, res) => {
    const limit = parseIntParam(req.query['limit'], 'limit', {
      min: 1,
      max: 200,
      fallback: 50,
    });
    const status = parseStringParam(req.query['status'], 'status', { maxLength: 20 });
    if (status !== undefined && !(WEBHOOK_STATES as readonly string[]).includes(status)) {
      throw new AppError(
        'VALIDATION_ERROR',
        `status must be one of ${WEBHOOK_STATES.join(', ')}.`,
      );
    }
    const topicFilter = parseStringParam(req.query['topic'], 'topic', { maxLength: 100 });
    const includePayload = req.query['includePayload'] === '1';

    if (getDatabaseStatus().status !== 'connected') {
      throw new AppError(
        'DATABASE_UNAVAILABLE',
        'Webhook delivery history requires MongoDB. Without it, deliveries are acknowledged but neither stored nor retried.',
      );
    }

    const filter: Record<string, unknown> = { shopDomain: config.shopify.storeDomain };
    if (status !== undefined) filter['status'] = status;
    if (topicFilter !== undefined) filter['topic'] = topicFilter;

    const projection = includePayload
      ? undefined
      : '-payload';

    const query = WebhookEventModel.find(filter).sort({ receivedAt: -1 }).limit(limit);
    const events = await (projection === undefined
      ? query.lean()
      : query.select(projection).lean());

    const stats = await getQueueStats();

    sendSuccess(
      res,
      { events, stats },
      {
        count: Array.isArray(events) ? events.length : 0,
        states: WEBHOOK_STATES,
        retryDelaysMinutes: [...WEBHOOK_RETRY_DELAYS_MINUTES],
        maxAttempts: WEBHOOK_MAX_ATTEMPTS,
      },
    );
  }),
);

/**
 * POST /api/webhooks/events/:id/retry - re-queue a FAILED delivery.
 *
 * Only FAILED events are eligible, enforced in the queue. Re-running a PROCESSED
 * event would repeat a side effect that already happened, which is the opposite of
 * what a retry button should do, so it is refused rather than quietly allowed.
 */
webhookAdminRouter.post(
  '/webhooks/events/:id/retry',
  asyncHandler(async (req, res) => {
    const id = parseStringParam(req.params['id'], 'id', { maxLength: 64 });
    if (id === undefined) {
      throw new AppError('VALIDATION_ERROR', 'An event id is required.');
    }
    // Mongo ObjectId shape. Checked here so a malformed id is a 400 rather than a
    // cast error surfacing as a 500.
    if (!/^[a-f0-9]{24}$/i.test(id)) {
      throw new AppError(
        'VALIDATION_ERROR',
        'id must be the 24-character event id from GET /api/webhooks/events.',
      );
    }

    const result = await retryFailedEvent(id);

    await recordAudit({
      action: 'WEBHOOK_RETRY',
      resourceType: 'WEBHOOK',
      resourceId: id,
      after: { requeued: result.retried },
      result: result.retried ? 'SUCCESS' : 'FAILURE',
      metadata: result.reason === undefined ? null : { reason: result.reason },
    });

    if (!result.retried) {
      throw new AppError(
        'VALIDATION_ERROR',
        result.reason ?? 'This event cannot be retried.',
        { details: { eventId: id } },
      );
    }

    sendSuccess(res, { eventId: id, requeued: true });
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
