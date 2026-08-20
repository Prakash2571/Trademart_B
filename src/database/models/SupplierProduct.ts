/**
 * Links a Shopify product to a supplier-side product.
 *
 * `costSource` records HOW a cost was obtained so the UI can distinguish a real
 * Shopify "cost per item" from a value a human typed in. Unknown costs stay
 * null - they are never defaulted to 0.
 */

import { Schema, model, type InferSchemaType } from 'mongoose';

const supplierProductSchema = new Schema(
  {
    shopDomain: { type: String, required: true, index: true },
    provider: {
      type: String,
      required: true,
      enum: ['TRADELLE', 'OTHER', 'UNKNOWN'],
      default: 'UNKNOWN',
    },
    shopifyProductId: { type: String, required: true, index: true },
    shopifyVariantId: { type: String, default: null },
    /** Supplier's own identifier, when one is discoverable. */
    supplierProductRef: { type: String, default: null },
    sku: { type: String, default: null },
    supplierProductCost: { type: Number, default: null },
    supplierShippingCost: { type: Number, default: null },
    currencyCode: { type: String, default: null },
    costSource: {
      type: String,
      enum: ['SHOPIFY_UNIT_COST', 'MANUAL', 'SUPPLIER_API', 'UNKNOWN'],
      default: 'UNKNOWN',
    },
    /**
     * When costSource is MANUAL, whether this hand-entered value should override
     * Shopify's cost per item rather than only being used as a fallback.
     */
    manualOverride: { type: Boolean, default: false },
    /** Free-text note for a manual cost (why it was set, its source, etc.). */
    note: { type: String, default: null },
    /** Why this product was attributed to the provider. */
    evidence: { type: [String], default: [] },
    lastVerifiedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'supplier_products' },
);

supplierProductSchema.index(
  { shopDomain: 1, shopifyProductId: 1, shopifyVariantId: 1 },
  { unique: true },
);

export type SupplierProduct = InferSchemaType<typeof supplierProductSchema>;
export const SupplierProductModel = model('SupplierProduct', supplierProductSchema);
