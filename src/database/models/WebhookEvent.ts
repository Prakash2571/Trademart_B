/**
 * Raw webhook deliveries, kept for replay and debugging.
 * Payloads are stored as-is only after HMAC verification.
 */

import { Schema, model, type InferSchemaType } from 'mongoose';

const webhookEventSchema = new Schema(
  {
    shopDomain: { type: String, required: true, index: true },
    topic: { type: String, required: true, index: true },
    /**
     * Shopify's delivery id - used to make retries idempotent.
     * Indexed by the explicit partial unique index below, NOT with `index: true`
     * here: declaring both makes Mongoose warn about a duplicate index.
     */
    webhookId: { type: String, default: null },
    receivedAt: { type: Date, required: true, default: () => new Date() },
    processed: { type: Boolean, required: true, default: false },
    processedAt: { type: Date, default: null },
    error: { type: String, default: null },
    payload: { type: Schema.Types.Mixed, required: true },
  },
  { timestamps: true, collection: 'webhook_events' },
);

// Shopify retries deliveries; the same webhookId must not be stored twice.
webhookEventSchema.index(
  { webhookId: 1 },
  { unique: true, partialFilterExpression: { webhookId: { $type: 'string' } } },
);

export type WebhookEvent = InferSchemaType<typeof webhookEventSchema>;
export const WebhookEventModel = model('WebhookEvent', webhookEventSchema);
