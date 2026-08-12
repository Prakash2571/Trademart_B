/**
 * Stored aggregate for trend charts, so the dashboard does not have to re-poll
 * Shopify for history it has already computed.
 *
 * `window` records exactly what the figures cover - a snapshot must never be
 * presented as an all-time total when it is not.
 */

import { Schema, model, type InferSchemaType } from 'mongoose';

const analyticsSnapshotSchema = new Schema(
  {
    shopDomain: { type: String, required: true, index: true },
    /** Bucket this snapshot describes, e.g. "2026-08-12" for a daily rollup. */
    periodKey: { type: String, required: true, index: true },
    granularity: {
      type: String,
      enum: ['DAY', 'WEEK', 'MONTH', 'SAMPLE'],
      default: 'DAY',
    },
    windowFrom: { type: Date, default: null },
    windowTo: { type: Date, default: null },
    /** True when the source data was a truncated page rather than complete. */
    truncated: { type: Boolean, default: false },
    currencyCode: { type: String, default: null },
    orderCount: { type: Number, default: null },
    totalRevenue: { type: Number, default: null },
    averageOrderValue: { type: Number, default: null },
    totalDiscounts: { type: Number, default: null },
    totalShipping: { type: Number, default: null },
    totalTax: { type: Number, default: null },
    pendingFulfillmentCount: { type: Number, default: null },
    capturedAt: { type: Date, required: true, default: () => new Date() },
  },
  { timestamps: true, collection: 'analytics_snapshots' },
);

analyticsSnapshotSchema.index(
  { shopDomain: 1, granularity: 1, periodKey: 1 },
  { unique: true },
);

export type AnalyticsSnapshot = InferSchemaType<typeof analyticsSnapshotSchema>;
export const AnalyticsSnapshotModel = model('AnalyticsSnapshot', analyticsSnapshotSchema);
