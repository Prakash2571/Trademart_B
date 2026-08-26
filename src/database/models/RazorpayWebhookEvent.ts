import { Schema, model, type InferSchemaType } from 'mongoose';

export const RAZORPAY_WEBHOOK_STATES = [
  'RECEIVED',
  'PROCESSING',
  'PROCESSED',
  'IGNORED',
  'FAILED',
] as const;

const razorpayWebhookEventSchema = new Schema(
  {
    eventId: { type: String, required: true },
    eventType: { type: String, required: true },
    receivedAt: { type: Date, required: true, default: () => new Date() },
    processedAt: { type: Date, default: null },
    status: { type: String, required: true, enum: RAZORPAY_WEBHOOK_STATES, default: 'RECEIVED' },
    attempts: { type: Number, required: true, default: 0 },
    nextAttemptAt: { type: Date, required: true, default: () => new Date() },
    leaseExpiresAt: { type: Date, default: null },
    ignoredReason: { type: String, default: null },
    errorCode: { type: String, default: null },
    errorMessage: { type: String, default: null },
    /** Minimal verified projection. Raw webhooks can carry card/contact PII and are not retained. */
    payment: {
      razorpayOrderId: { type: String, default: null },
      razorpayPaymentId: { type: String, default: null },
      amountPaise: { type: Number, default: null },
      currency: { type: String, default: null },
      status: { type: String, default: null },
      captured: { type: Boolean, default: false },
      failureCode: { type: String, default: null },
    },
  },
  { timestamps: true, collection: 'razorpay_webhook_events' },
);

razorpayWebhookEventSchema.index({ eventId: 1 }, { unique: true });
razorpayWebhookEventSchema.index({ status: 1, nextAttemptAt: 1 });
razorpayWebhookEventSchema.index(
  { status: 1, leaseExpiresAt: 1 },
  { partialFilterExpression: { leaseExpiresAt: { $type: 'date' } } },
);

export type RazorpayWebhookEvent = InferSchemaType<typeof razorpayWebhookEventSchema>;
export const RazorpayWebhookEventModel = model(
  'RazorpayWebhookEvent',
  razorpayWebhookEventSchema,
);
