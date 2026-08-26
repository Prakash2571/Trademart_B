import { Schema, model, type InferSchemaType } from 'mongoose';

export const PAYMENT_ATTEMPT_STATUSES = [
  'AUTHORIZED',
  'CAPTURED',
  'PAID',
  'FAILED',
  'REFUNDED',
] as const;

const paymentAttemptSchema = new Schema(
  {
    checkoutPublicId: { type: String, required: true },
    razorpayOrderId: { type: String, required: true },
    razorpayPaymentId: { type: String, required: true },
    status: { type: String, required: true, enum: PAYMENT_ATTEMPT_STATUSES },
    amountPaise: { type: Number, required: true, min: 0 },
    currency: { type: String, required: true, enum: ['INR'] },
    captured: { type: Boolean, required: true, default: false },
    source: { type: String, required: true, enum: ['BROWSER_VERIFY', 'WEBHOOK'] },
    providerObservedAt: { type: Date, required: true },
    failureCode: { type: String, default: null },
    /** A customer-safe summary only. Raw gateway descriptions and PII are never stored. */
    failureMessage: { type: String, default: null },
  },
  { timestamps: true, collection: 'storefront_payment_attempts' },
);

paymentAttemptSchema.index({ razorpayPaymentId: 1 }, { unique: true });
paymentAttemptSchema.index({ checkoutPublicId: 1, createdAt: -1 });
paymentAttemptSchema.index({ razorpayOrderId: 1, status: 1 });

export type PaymentAttempt = InferSchemaType<typeof paymentAttemptSchema>;
export const PaymentAttemptModel = model('StorefrontPaymentAttempt', paymentAttemptSchema);
