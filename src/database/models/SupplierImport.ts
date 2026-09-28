/**
 * The import ledger: every supplier product Trademart has created in Shopify.
 *
 * One row per (shop, provider, supplier reference). The unique index is the claim
 * that stops the same DeoDap product being imported twice: an import INSERTS a
 * CLAIMED row before its first Shopify write, so two simultaneous imports of one
 * product cannot both pass - the second insert fails inside Mongo. A read-then-write
 * check would have a race exactly wide enough for a double-click.
 *
 *   CLAIMED  an import is running (or crashed; the claim is taken over after a lease)
 *   CREATED  the Shopify draft exists and every variant's cost was recorded
 *   PARTIAL  the draft exists, but a variant or cost did not go to plan
 *   FAILED   the create failed; importing again retries it
 *
 * The ledger is also how later work finds DeoDap products without trusting Shopify
 * tags: cost sync matches price-list rows to `variants`, and the orders page maps a
 * sold variant back to its DeoDap reference.
 */

import { Schema, model, type InferSchemaType } from 'mongoose';

const importedVariantSchema = new Schema(
  {
    shopifyVariantId: { type: String, default: null },
    sku: { type: String, default: null },
    optionValues: { type: [String], default: [] },
    /** The DeoDap cost recorded at import, or at the last cost sync. */
    cost: { type: Number, default: null },
    shippingCost: { type: Number, default: null },
  },
  { _id: false },
);

const supplierImportSchema = new Schema(
  {
    shopDomain: { type: String, required: true },
    provider: { type: String, required: true, enum: ['DEODAP'] },
    /** The supplier's reference as it appeared in the file. */
    supplierRef: { type: String, required: true },
    /** supplierRef trimmed and lowercased: what uniqueness is decided on. */
    refKey: { type: String, required: true },
    status: {
      type: String,
      required: true,
      enum: ['CLAIMED', 'CREATED', 'PARTIAL', 'FAILED'],
    },
    title: { type: String, required: true },
    shopifyProductId: { type: String, default: null },
    currencyCode: { type: String, default: null },
    variants: { type: [importedVariantSchema], default: [] },
    source: { type: String, enum: ['CSV'], default: 'CSV' },
    sourceFile: { type: String, default: null },
    sourceLine: { type: Number, default: null },
    claimedAt: { type: Date, default: null },
    error: { type: String, default: null },
    errorCode: { type: String, default: null },
    requestId: { type: String, default: null },
    lastCostSyncAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'supplier_imports' },
);

supplierImportSchema.index({ shopDomain: 1, provider: 1, refKey: 1 }, { unique: true });
supplierImportSchema.index({ shopDomain: 1, provider: 1, 'variants.shopifyVariantId': 1 });
supplierImportSchema.index({ shopDomain: 1, provider: 1, updatedAt: -1 });

export type SupplierImport = InferSchemaType<typeof supplierImportSchema>;
export const SupplierImportModel = model('SupplierImport', supplierImportSchema);
