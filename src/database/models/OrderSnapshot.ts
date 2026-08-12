/**
 * Order snapshot.
 *
 * Financial values are copied verbatim from Shopify - never recomputed.
 * Customer PII is deliberately NOT stored; only the customer GID is kept so the
 * record can be correlated back to Shopify on demand.
 */

import { Schema, model, type InferSchemaType } from 'mongoose';

const lineItemSnapshotSchema = new Schema(
  {
    shopifyLineItemId: { type: String, required: true },
    title: { type: String, default: null },
    quantity: { type: Number, required: true },
    sku: { type: String, default: null },
    vendor: { type: String, default: null },
    shopifyProductId: { type: String, default: null },
    shopifyVariantId: { type: String, default: null },
    unitPrice: { type: Number, default: null },
    discountedTotal: { type: Number, default: null },
    supplier: {
      type: String,
      enum: ['TRADELLE', 'OTHER', 'UNKNOWN'],
      default: 'UNKNOWN',
    },
  },
  { _id: false },
);

const fulfillmentSnapshotSchema = new Schema(
  {
    shopifyFulfillmentId: { type: String, required: true },
    status: { type: String, default: null },
    trackingCompany: { type: String, default: null },
    trackingNumber: { type: String, default: null },
    trackingUrl: { type: String, default: null },
  },
  { _id: false },
);

const orderSnapshotSchema = new Schema(
  {
    shopDomain: { type: String, required: true, index: true },
    shopifyOrderId: { type: String, required: true, index: true },
    name: { type: String, required: true },
    /** GID only - no email, no name, no address. */
    shopifyCustomerId: { type: String, default: null },
    financialStatus: { type: String, default: null },
    fulfillmentStatus: { type: String, default: null },
    currencyCode: { type: String, default: null },
    subtotal: { type: Number, default: null },
    totalDiscounts: { type: Number, default: null },
    totalShipping: { type: Number, default: null },
    totalTax: { type: Number, default: null },
    total: { type: Number, default: null },
    supplier: {
      type: String,
      enum: ['TRADELLE', 'OTHER', 'UNKNOWN'],
      default: 'UNKNOWN',
    },
    lineItems: { type: [lineItemSnapshotSchema], default: [] },
    fulfillments: { type: [fulfillmentSnapshotSchema], default: [] },
    shopifyCreatedAt: { type: Date, default: null, index: true },
    capturedAt: { type: Date, required: true, default: () => new Date() },
  },
  { timestamps: true, collection: 'order_snapshots' },
);

orderSnapshotSchema.index({ shopDomain: 1, shopifyOrderId: 1 }, { unique: true });

export type OrderSnapshot = InferSchemaType<typeof orderSnapshotSchema>;
export const OrderSnapshotModel = model('OrderSnapshot', orderSnapshotSchema);
