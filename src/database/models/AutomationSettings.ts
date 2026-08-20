/**
 * Persisted automation rules — one document per shop.
 *
 * Why this exists: rules used to be supplied per request, which is fine for a
 * human calling /preview but useless for a webhook-triggered run, which has no
 * request body to read. Without persistence an automatic run would fall back to
 * the defaults (where price automation is OFF) and would therefore never
 * reprice anything — the feature would look wired up but do nothing.
 *
 * Stored as a partial rule set, not a full one. Only the fields a merchant
 * actually changed are kept, so new rules added in future code pick up their new
 * defaults instead of being pinned to whatever existed when the doc was written.
 */

import { Schema, model, type InferSchemaType } from 'mongoose';

const automationSettingsSchema = new Schema(
  {
    // One settings document per shop; `unique` already creates the index.
    shopDomain: { type: String, required: true, unique: true },
    /**
     * Partial AutomationRules. Mixed because the rule shape is defined and
     * validated in TypeScript (validateAutomationRules), and duplicating it as a
     * Mongoose schema would give two sources of truth that could disagree.
     */
    rules: { type: Schema.Types.Mixed, default: {} },
    /** Who last changed them, for the audit trail. */
    updatedBy: { type: String, default: null },
  },
  { timestamps: true, collection: 'automation_settings' },
);

export type AutomationSettings = InferSchemaType<typeof automationSettingsSchema>;
export const AutomationSettingsModel = model(
  'AutomationSettings',
  automationSettingsSchema,
);
