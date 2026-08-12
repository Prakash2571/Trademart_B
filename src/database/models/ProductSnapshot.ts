/**
 * A point-in-time copy of the product fields Trademart actually needs.
 * Shopify remains the source of truth - this is not a full mirror.
 */

import { Schema, model, type InferSchemaType } from 'mongoose';

const variantSnapshotSchema = new Schema(
  {
    shopifyVariantId: { type: String, required: true },
    title: { type: String, default: null },
    sku: { type: String, default: null },
    price: { type: Number, default: null },
    compareAtPrice: { type: Number, default: null },
    inventoryQuantity: { type: Number, default: null },
    unitCost: { type: Number, default: null },
  },
  { _id: false },
);

const productSnapshotSchema = new Schema(
  {
    shopDomain: { type: String, required: true, index: true },
    // GID string, e.g. gid://shopify/Product/123 - never a number.
    shopifyProductId: { type: String, required: true, index: true },
    title: { type: String, required: true },
    handle: { type: String, default: null },
    status: { type: String, default: null },
    vendor: { type: String, default: null },
    productType: { type: String, default: null },
    tags: { type: [String], default: [] },
    supplier: {
      type: String,
      enum: ['TRADELLE', 'OTHER', 'UNKNOWN'],
      default: 'UNKNOWN',
    },
    supplierEvidence: { type: [String], default: [] },
    minPrice: { type: Number, default: null },
    maxPrice: { type: Number, default: null },
    currencyCode: { type: String, default: null },
    totalInventory: { type: Number, default: null },
    variants: { type: [variantSnapshotSchema], default: [] },
    shopifyCreatedAt: { type: Date, default: null },
    shopifyUpdatedAt: { type: Date, default: null },
    capturedAt: { type: Date, required: true, default: () => new Date() },
  },
  { timestamps: true, collection: 'product_snapshots' },
);

productSnapshotSchema.index({ shopDomain: 1, shopifyProductId: 1 }, { unique: true });

export type ProductSnapshot = InferSchemaType<typeof productSnapshotSchema>;
export const ProductSnapshotModel = model('ProductSnapshot', productSnapshotSchema);
