/**
 * Manually entered or imported cost inputs used by the pricing engine.
 * Keeping these separate from Shopify data makes it obvious which numbers are
 * assumptions and which came from Shopify.
 */

import { Schema, model, type InferSchemaType } from 'mongoose';

const costRecordSchema = new Schema(
  {
    shopDomain: { type: String, required: true, index: true },
    /** Optional: a cost set can be store-wide (defaults) or product-specific. */
    shopifyProductId: { type: String, default: null, index: true },
    shopifyVariantId: { type: String, default: null },
    label: { type: String, default: null },
    supplierProductCost: { type: Number, default: null },
    supplierShippingCost: { type: Number, default: null },
    paymentFee: { type: Number, default: null },
    shopifyFee: { type: Number, default: null },
    advertisingCost: { type: Number, default: null },
    taxes: { type: Number, default: null },
    otherCosts: { type: Number, default: null },
    currencyCode: { type: String, default: null },
    source: {
      type: String,
      enum: ['MANUAL', 'SHOPIFY_UNIT_COST', 'SUPPLIER_API'],
      default: 'MANUAL',
    },
    note: { type: String, default: null },
  },
  { timestamps: true, collection: 'cost_records' },
);

export type CostRecord = InferSchemaType<typeof costRecordSchema>;
export const CostRecordModel = model('CostRecord', costRecordSchema);
