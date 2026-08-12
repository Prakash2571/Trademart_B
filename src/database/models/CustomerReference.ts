/**
 * Customer REFERENCE - intentionally not a customer record.
 *
 * Protected customer data rules mean Trademart should not accumulate PII it
 * does not need. Only the Shopify GID plus non-identifying aggregates are
 * stored: no email, no phone, no name, no address.
 * https://shopify.dev/docs/apps/launch/protected-customer-data
 */

import { Schema, model, type InferSchemaType } from 'mongoose';

const customerReferenceSchema = new Schema(
  {
    shopDomain: { type: String, required: true, index: true },
    shopifyCustomerId: { type: String, required: true, index: true },
    ordersCount: { type: Number, default: null },
    amountSpent: { type: Number, default: null },
    currencyCode: { type: String, default: null },
    state: { type: String, default: null },
    /** Country only - coarse enough not to identify an individual. */
    countryCode: { type: String, default: null },
    shopifyCreatedAt: { type: Date, default: null },
    capturedAt: { type: Date, required: true, default: () => new Date() },
  },
  { timestamps: true, collection: 'customer_references' },
);

customerReferenceSchema.index({ shopDomain: 1, shopifyCustomerId: 1 }, { unique: true });

export type CustomerReference = InferSchemaType<typeof customerReferenceSchema>;
export const CustomerReferenceModel = model('CustomerReference', customerReferenceSchema);
