/**
 * Shopify webhook deliveries, as a durable work queue.
 *
 * WHY A QUEUE AND NOT JUST A LOG
 * ------------------------------
 * Shopify expects a 2xx within a few seconds and retries anything else. Doing the
 * real work (a Shopify lookup plus a write) inside the request risks exceeding
 * that, and a timeout makes Shopify redeliver an event that was in fact being
 * processed - so the work happens twice while the operator sees neither attempt
 * complete.
 *
 * So a delivery is verified, PERSISTED, and acknowledged immediately; processing
 * happens afterwards against this collection. That also means a backend restart
 * mid-processing loses nothing: the row is still RECEIVED (or PROCESSING with an
 * expired lease) and gets picked up again.
 *
 * STATES
 *   RECEIVED   verified and stored, not yet started
 *   PROCESSING claimed by a worker; `leaseExpiresAt` guards against a crash
 *   PROCESSED  finished successfully
 *   FAILED     all attempts exhausted; needs a human or a manual retry
 *   IGNORED    deliberately not actioned (unhandled topic, deleted product)
 *
 * Payloads are stored only AFTER HMAC verification, so nothing unverified is ever
 * written here.
 */

import { Schema, model, type InferSchemaType } from 'mongoose';

export const WEBHOOK_STATES = [
  'RECEIVED',
  'PROCESSING',
  'PROCESSED',
  'FAILED',
  'IGNORED',
] as const;

export type WebhookState = (typeof WEBHOOK_STATES)[number];

/**
 * Retry schedule, in minutes after the failure: 1, 5, then 30.
 *
 * Deliberately short then long. Most webhook processing failures are a transient
 * Shopify throttle that clears in seconds; the 30-minute attempt is for an outage.
 * After three attempts a human should look, because a fourth automatic retry of a
 * deterministic failure just delays the discovery.
 */
export const WEBHOOK_RETRY_DELAYS_MINUTES = [1, 5, 30] as const;
export const WEBHOOK_MAX_ATTEMPTS = WEBHOOK_RETRY_DELAYS_MINUTES.length + 1;

const webhookEventSchema = new Schema(
  {
    shopDomain: { type: String, required: true },
    topic: { type: String, required: true },
    /**
     * Shopify's delivery id - the dedupe key. A Shopify retry carries the SAME
     * id, which is what makes acknowledging a duplicate without reprocessing
     * correct rather than a guess.
     *
     * Indexed by the explicit partial unique index below, NOT with `index: true`
     * here: declaring both makes Mongoose warn about a duplicate index.
     */
    webhookId: { type: String, default: null },
    receivedAt: { type: Date, required: true, default: () => new Date() },
    processedAt: { type: Date, default: null },
    status: {
      type: String,
      required: true,
      enum: WEBHOOK_STATES,
      default: 'RECEIVED',
    },
    /** How many processing attempts have been made. */
    attempts: { type: Number, required: true, default: 0 },
    /** When the next attempt becomes eligible. Null when not scheduled. */
    nextAttemptAt: { type: Date, default: null },
    /** Set while PROCESSING; a lease in the past means the worker died. */
    leaseExpiresAt: { type: Date, default: null },
    /** Last failure, for diagnostics. Never a secret. */
    error: { type: String, default: null },
    errorCode: { type: String, default: null },
    /** Why an event was IGNORED, so "nothing happened" is explainable. */
    ignoredReason: { type: String, default: null },
    /** Correlation id of the delivery, and of the run that processed it. */
    requestId: { type: String, default: null },
    processingRequestId: { type: String, default: null },
    payload: { type: Schema.Types.Mixed, required: true },
    /**
     * Retained for a bounded period, because payloads are the bulky part and
     * their diagnostic value fades quickly. See RETENTION_WEBHOOK_EVENT_DAYS.
     */
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true, collection: 'webhook_events' },
);

// Dedupe. Shopify retries deliveries; the same webhookId must not be stored twice.
webhookEventSchema.index(
  { webhookId: 1 },
  { unique: true, partialFilterExpression: { webhookId: { $type: 'string' } } },
);

// The worker's claim query: which events are due? Compound so the scan is bounded
// to exactly the candidates rather than the whole collection.
webhookEventSchema.index({ status: 1, nextAttemptAt: 1 });

// The diagnostics view: this shop's events, newest first, filterable by status.
webhookEventSchema.index({ shopDomain: 1, status: 1, receivedAt: -1 });

// Recovery sweep: PROCESSING rows whose lease has expired.
webhookEventSchema.index(
  { status: 1, leaseExpiresAt: 1 },
  { partialFilterExpression: { leaseExpiresAt: { $type: 'date' } } },
);

// Retention.
webhookEventSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type WebhookEvent = InferSchemaType<typeof webhookEventSchema>;
export const WebhookEventModel = model('WebhookEvent', webhookEventSchema);
