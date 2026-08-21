/**
 * Operator audit trail.
 *
 * Answers, for any change Trademart made: what changed, who changed it, when,
 * from what value to what value, and which request caused it.
 *
 * Distinct from `automation_runs`, which records automation's own decisions in
 * far more detail (plans, reasons, skipped items). This collection covers
 * everything a HUMAN did - logins, product edits, cost overrides, stock changes,
 * publications - so that "who set this price?" has an answer even when automation
 * was not involved.
 *
 * FAILURES ARE RECORDED TOO. An attempt that was refused is often the more
 * interesting entry: a blocked live-store write or a rejected stale update is
 * exactly what an operator needs to see when reconstructing an incident.
 *
 * NOTHING SECRET IS STORED HERE. `before`/`after` are redacted before writing;
 * see audit.service.ts.
 */

import { Schema, model, type InferSchemaType } from 'mongoose';

const auditLogSchema = new Schema(
  {
    shopDomain: { type: String, required: true },
    /** Operator username, or 'system' for automation and webhook-driven work. */
    actor: { type: String, required: true },
    /** SESSION | API_KEY | SHOPIFY_HMAC | SYSTEM - how the actor was identified. */
    authMethod: { type: String, default: null },
    at: { type: Date, required: true, default: () => new Date() },
    /** e.g. PRODUCT_PUBLISH, COST_UPDATE, AUTOMATION_APPLY. */
    action: { type: String, required: true },
    /** PRODUCT | VARIANT | INVENTORY | COST | AUTOMATION | SESSION | WEBHOOK. */
    resourceType: { type: String, required: true },
    /** Shopify GID or internal id. Null for store-wide actions such as LOGIN. */
    resourceId: { type: String, default: null },
    /**
     * Values before and after. Only the fields that changed, so an entry stays
     * small and readable, and so a diff is obvious without comparing whole
     * documents.
     */
    before: { type: Schema.Types.Mixed, default: null },
    after: { type: Schema.Types.Mixed, default: null },
    /** Correlation id - ties this entry to the log lines for the same request. */
    requestId: { type: String, default: null },
    result: {
      type: String,
      required: true,
      enum: ['SUCCESS', 'FAILURE'],
      default: 'SUCCESS',
    },
    /** Taxonomy code when result is FAILURE. */
    errorCode: { type: String, default: null },
    errorMessage: { type: String, default: null },
    /** Extra context that does not fit before/after (e.g. previewId, location). */
    metadata: { type: Schema.Types.Mixed, default: null },
    /** TTL anchor. Set from RETENTION_AUDIT_DAYS (default 730). */
    expiresAt: { type: Date, required: true },
  },
  { timestamps: false, collection: 'audit_logs' },
);

// The default view: this shop's entries, newest first.
auditLogSchema.index({ shopDomain: 1, at: -1 });

// "Show me every price change" / "every login" - the primary filter in the UI.
auditLogSchema.index({ shopDomain: 1, action: 1, at: -1 });

// "What has happened to THIS product?" Partial, because store-wide actions have
// no resourceId and indexing thousands of nulls buys nothing.
auditLogSchema.index(
  { shopDomain: 1, resourceId: 1, at: -1 },
  { partialFilterExpression: { resourceId: { $type: 'string' } } },
);

// "Everything that happened during the request that failed."
auditLogSchema.index(
  { requestId: 1 },
  { partialFilterExpression: { requestId: { $type: 'string' } } },
);

// Retention, expressed in the document rather than in a cleanup job.
auditLogSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type AuditLog = InferSchemaType<typeof auditLogSchema>;
export const AuditLogModel = model('AuditLog', auditLogSchema);
