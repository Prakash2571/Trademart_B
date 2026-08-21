/**
 * Audit trail for automation runs.
 *
 * This is what makes automated storefront changes defensible: every run records
 * what it changed, what the value was BEFORE, and the reasons that produced the
 * decision. Without `before` a run is not reversible, so it is required on every
 * applied action.
 *
 * Dry runs are persisted too (with `dryRun: true`), so a preview can be compared
 * against what was later applied.
 */

import { Schema, model, type InferSchemaType } from 'mongoose';

const actionSchema = new Schema(
  {
    type: { type: String, required: true, enum: ['visibility', 'price'] },
    shopifyProductId: { type: String, required: true },
    shopifyVariantId: { type: String, default: null },
    title: { type: String, default: null },
    /** Previous value as a string, so one field serves status and price. */
    fromValue: { type: String, default: null },
    toValue: { type: String, default: null },
    currencyCode: { type: String, default: null },
    /** Why automation decided this. Never empty for an applied action. */
    reasons: { type: [String], default: [] },
    status: {
      type: String,
      required: true,
      enum: ['planned', 'applied', 'failed'],
      default: 'planned',
    },
    /** Error code/message when status is 'failed'. */
    error: { type: String, default: null },
  },
  { _id: false },
);

const automationRunSchema = new Schema(
  {
    shopDomain: { type: String, required: true, index: true },
    startedAt: { type: Date, required: true, default: () => new Date() },
    finishedAt: { type: Date, default: null },
    /** True when nothing was written - a preview. */
    dryRun: { type: Boolean, required: true, default: true },
    /** How the run was started, for accountability. */
    trigger: {
      type: String,
      required: true,
      enum: ['manual', 'webhook', 'scheduled'],
      default: 'manual',
    },
    /** The exact rule set used, snapshotted so a past run stays explainable. */
    rules: { type: Schema.Types.Mixed, default: null },
    actions: { type: [actionSchema], default: [] },
    /** Items deliberately not acted on, with reasons. */
    skipped: { type: Schema.Types.Mixed, default: [] },
    summary: { type: Schema.Types.Mixed, default: null },
    /** Set when the whole run aborted rather than individual actions failing. */
    error: { type: String, default: null },
    /**
     * Fingerprint of the rules, and of the exact action list, that this run used.
     *
     * Stored so an applied run can be matched against the preview an operator
     * approved: identical planHash values are proof the two were the same plan,
     * which is the question "was the automation preview still current?" answered
     * from the audit trail rather than from memory.
     */
    rulesHash: { type: String, default: null },
    planHash: { type: String, default: null },
    /** The preview token that authorised this apply. Null for previews/webhooks. */
    previewId: { type: String, default: null },
    /** Correlation id, tying this run to the request and log lines that caused it. */
    requestId: { type: String, default: null },
    /** Operator who started it, when there was one. Never a credential. */
    actor: { type: String, default: null },
  },
  { timestamps: true, collection: 'automation_runs' },
);

// The dashboard's most common query: this shop's runs, newest first.
automationRunSchema.index({ shopDomain: 1, startedAt: -1 });

// "Which run applied the plan I approved?" - used by the audit view and by the
// integrity checks that compare a preview against what was actually written.
automationRunSchema.index(
  { shopDomain: 1, planHash: 1 },
  { partialFilterExpression: { planHash: { $type: 'string' } } },
);

export type AutomationRun = InferSchemaType<typeof automationRunSchema>;
export const AutomationRunModel = model('AutomationRun', automationRunSchema);
