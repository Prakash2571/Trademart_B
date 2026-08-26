import { Schema, model, type InferSchemaType } from 'mongoose';

import { CHECKOUT_STATUSES } from '../../storefront/checkout/checkout.types';

const selectedOptionSchema = new Schema(
  { name: { type: String, required: true }, value: { type: String, required: true } },
  { _id: false },
);

const checkoutLineSchema = new Schema(
  {
    publicProductId: { type: String, required: true },
    publicVariantId: { type: String, required: true },
    shopifyProductId: { type: String, required: true },
    shopifyVariantId: { type: String, required: true },
    title: { type: String, required: true },
    variantTitle: { type: String, default: null },
    selectedOptions: { type: [selectedOptionSchema], default: [] },
    image: {
      type: new Schema(
        { url: { type: String, required: true }, alt: { type: String, default: null } },
        { _id: false },
      ),
      default: null,
    },
    quantity: { type: Number, required: true, min: 1, max: 10 },
    unitPricePaise: { type: Number, required: true, min: 1 },
    lineTotalPaise: { type: Number, required: true, min: 1 },
    currencyCode: { type: String, required: true, enum: ['INR'] },
    availableQuantity: { type: Number, default: null },
    sellability: { type: String, required: true, enum: ['SELLABLE'] },
  },
  { _id: false },
);

const customerSchema = new Schema(
  {
    fullName: { type: String, required: true },
    email: { type: String, required: true },
    phone: { type: String, required: true },
  },
  { _id: false },
);

const addressSchema = new Schema(
  {
    addressLine1: { type: String, required: true },
    addressLine2: { type: String, default: null },
    city: { type: String, required: true },
    state: { type: String, required: true },
    pinCode: { type: String, required: true },
    countryCode: { type: String, required: true, enum: ['IN'] },
  },
  { _id: false },
);

const checkoutSessionSchema = new Schema(
  {
    publicId: { type: String, required: true },
    idempotencyKey: { type: String, required: true },
    requestHash: { type: String, required: true },
    status: {
      type: String,
      required: true,
      enum: CHECKOUT_STATUSES,
      default: 'CREATED',
    },
    snapshot: {
      lines: { type: [checkoutLineSchema], required: true },
      subtotalPaise: { type: Number, required: true, min: 0 },
      shippingPaise: { type: Number, required: true, min: 0 },
      discountPaise: { type: Number, required: true, min: 0 },
      taxPaise: { type: Number, required: true, min: 0 },
      totalPaise: { type: Number, required: true, min: 10 },
      currency: { type: String, required: true, enum: ['INR'] },
      customer: { type: customerSchema, required: true },
      shippingAddress: { type: addressSchema, required: true },
    },
    /** Only SHA-256 hashes are stored. A database dump cannot produce public status URLs. */
    statusTokenHash: { type: String, required: true },
    trackingTokenHash: { type: String, required: true },
    razorpayOrderId: { type: String, default: null },
    razorpayPaymentId: { type: String, default: null },
    razorpayOrderStatus: { type: String, default: null },
    paidAt: { type: Date, default: null },
    refundedAt: { type: Date, default: null },
    /** Stable dedupe/reconciliation key written to Shopify's sourceIdentifier. */
    shopifySourceIdentifier: { type: String, required: true },
    shopifyOrderId: { type: String, default: null },
    shopifyOrderName: { type: String, default: null },
    shopifyOrderCreatedAt: { type: Date, default: null },
    orderAttempts: { type: Number, required: true, default: 0 },
    nextOrderAttemptAt: { type: Date, default: null },
    orderLeaseExpiresAt: { type: Date, default: null },
    orderErrorCode: { type: String, default: null },
    orderErrorMessage: { type: String, default: null },
  },
  { timestamps: true, collection: 'storefront_checkout_sessions' },
);

checkoutSessionSchema.index({ publicId: 1 }, { unique: true });
checkoutSessionSchema.index({ idempotencyKey: 1 }, { unique: true });
checkoutSessionSchema.index({ publicId: 1, statusTokenHash: 1 }, { unique: true });
checkoutSessionSchema.index({ trackingTokenHash: 1 }, { unique: true });
checkoutSessionSchema.index(
  { razorpayOrderId: 1 },
  { unique: true, partialFilterExpression: { razorpayOrderId: { $type: 'string' } } },
);
checkoutSessionSchema.index(
  { razorpayPaymentId: 1 },
  { unique: true, partialFilterExpression: { razorpayPaymentId: { $type: 'string' } } },
);
checkoutSessionSchema.index({ status: 1, nextOrderAttemptAt: 1 });
checkoutSessionSchema.index(
  { status: 1, orderLeaseExpiresAt: 1 },
  { partialFilterExpression: { orderLeaseExpiresAt: { $type: 'date' } } },
);

export type CheckoutSessionDocument = InferSchemaType<typeof checkoutSessionSchema>;
export const CheckoutSessionModel = model('StorefrontCheckoutSession', checkoutSessionSchema);
