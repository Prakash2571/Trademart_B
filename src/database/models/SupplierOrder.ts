/**
 * What has been done with the supplier for one Shopify order.
 *
 * One row per (shop, provider, Shopify order), enforced by a unique index. It records
 * the SUPPLIER side only - whether the order was placed with DeoDap, DeoDap's order
 * number and tracking. The order itself stays in Shopify, the system of record, and
 * no customer name, address or contact detail is stored here.
 *
 * `status` must match DEODAP_ORDER_STATUSES in suppliers/deodap/deodap.orders.ts.
 */

import { Schema, model, type InferSchemaType } from 'mongoose';

const supplierOrderLineSchema = new Schema(
  {
    shopifyLineItemId: { type: String, required: true },
    shopifyVariantId: { type: String, default: null },
    title: { type: String, default: null },
    sku: { type: String, default: null },
    supplierRef: { type: String, default: null },
    quantity: { type: Number, required: true },
  },
  { _id: false },
);

const supplierOrderSchema = new Schema(
  {
    shopDomain: { type: String, required: true },
    provider: { type: String, required: true, enum: ['DEODAP'] },
    shopifyOrderId: { type: String, required: true },
    shopifyOrderName: { type: String, default: null },
    status: {
      type: String,
      required: true,
      enum: ['NOT_PLACED', 'PLACED', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'PROBLEM'],
    },
    /** MANUAL today. API once a DeoDap order API exists (suppliers/deodap/deodap.api.ts). */
    placedVia: { type: String, enum: ['MANUAL', 'API'], default: 'MANUAL' },
    supplierOrderId: { type: String, default: null },
    trackingCompany: { type: String, default: null },
    trackingNumber: { type: String, default: null },
    trackingUrl: { type: String, default: null },
    note: { type: String, default: null },
    /** The supplier lines at the time of the last update. */
    lines: { type: [supplierOrderLineSchema], default: [] },
    placedAt: { type: Date, default: null },
    shippedAt: { type: Date, default: null },
    deliveredAt: { type: Date, default: null },
    updatedBy: { type: String, default: null },
  },
  { timestamps: true, collection: 'supplier_orders' },
);

supplierOrderSchema.index({ shopDomain: 1, provider: 1, shopifyOrderId: 1 }, { unique: true });

export type SupplierOrder = InferSchemaType<typeof supplierOrderSchema>;
export const SupplierOrderModel = model('SupplierOrder', supplierOrderSchema);
