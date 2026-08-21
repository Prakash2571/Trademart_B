/**
 * Automation preview tokens.
 *
 * A preview is the operator's review artefact: it records exactly which plan was
 * shown, against which store, rules and scope, and when it stops being valid.
 * `POST /api/automation/apply` will only execute a plan that still matches one of
 * these.
 *
 * Persisted rather than kept purely in memory for two reasons: a restart between
 * preview and apply should not silently turn "your plan is stale" into "no
 * preview exists", and `appliedAt` gives Mongo a place to enforce single use
 * atomically via findOneAndUpdate. The plan ITSELF is not stored - only its
 * fingerprint - so this collection stays small and holds no pricing data.
 */

import { Schema, model, type InferSchemaType } from 'mongoose';

const automationPreviewSchema = new Schema(
  {
    /** Opaque id handed to the client. Indexed unique below. */
    previewId: { type: String, required: true },
    shopDomain: { type: String, required: true },
    /** Fingerprint of the effective rules the plan was built from. */
    rulesHash: { type: String, required: true },
    /** Fingerprint of the action list the operator actually reviewed. */
    planHash: { type: String, required: true },
    scope: {
      query: { type: String, default: null },
      maxProducts: { type: Number, required: true },
      productIds: { type: [String], default: null },
    },
    /** Counts only, for showing "you approved 17 changes" in an error message. */
    summary: { type: Schema.Types.Mixed, default: null },
    generatedAt: { type: Date, required: true },
    /** TTL anchor - Mongo removes the document once this passes. */
    expiresAt: { type: Date, required: true },
    /** Non-null once consumed. The single-use guarantee lives on this field. */
    appliedAt: { type: Date, default: null },
    /** Correlation ids, so preview and apply are linkable in the logs. */
    createdRequestId: { type: String, default: null },
    appliedRequestId: { type: String, default: null },
    /** Operator who took the preview. Never a credential. */
    createdBy: { type: String, default: null },
  },
  { timestamps: true, collection: 'automation_previews' },
);

// Lookup key. Unique because a duplicate previewId would make the single-use
// claim ambiguous - two documents could each be claimed once.
automationPreviewSchema.index({ previewId: 1 }, { unique: true });

// TTL. expireAfterSeconds:0 means "delete when expiresAt is in the past", which
// puts the retention policy in the document rather than in a cleanup job.
automationPreviewSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// Supports the diagnostics view: recent previews for this shop, newest first.
automationPreviewSchema.index({ shopDomain: 1, generatedAt: -1 });

export type AutomationPreview = InferSchemaType<typeof automationPreviewSchema>;
export const AutomationPreviewModel = model('AutomationPreview', automationPreviewSchema);
