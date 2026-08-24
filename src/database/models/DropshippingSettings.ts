/**
 * The store's dropshipping and pricing settings.
 *
 * One document per shop. These are commercial JUDGEMENTS, not observations - what to fold
 * into commercial cost, when to call an order late, what margin is too thin - so they
 * belong to the operator and must survive a redeploy. Holding them in environment
 * variables would mean changing a fee rate required a deploy, and would make the
 * "settings" screen read-only in practice.
 *
 * STORED AS Mixed, VALIDATED IN TYPESCRIPT
 * ---------------------------------------
 * Following AutomationSettings, whose comment explains the reasoning: duplicating the
 * field rules in a Mongoose schema creates a second source of truth that drifts from the
 * validator. dropshipping.settings.ts owns the rules, is pure, and is unit tested;
 * re-stating them here in a form nothing tests would be worse than not stating them.
 *
 * The saved document is validated BEFORE it is written, so a malformed record cannot get
 * in through this collection.
 */

import { Schema, model, type InferSchemaType } from 'mongoose';

const dropshippingSettingsSchema = new Schema(
  {
    shopDomain: { type: String, required: true, unique: true },
    /** DropshipCostConfig: inclusions, fee rates and the two alerting floors. */
    cost: { type: Schema.Types.Mixed, default: null },
    /** ShippingSla: the thresholds that turn elapsed time into a delay. */
    sla: { type: Schema.Types.Mixed, default: null },
    /**
     * Partial PricingPolicy overrides.
     *
     * Deliberately partial: the fees and floors already live in `cost`, and a full copy
     * would give the minimum margin two homes that disagree within a week.
     */
    pricing: { type: Schema.Types.Mixed, default: null },
    /** Who last changed them, so the settings screen can say. */
    updatedBy: { type: String, default: null },
  },
  { timestamps: true, collection: 'dropshipping_settings' },
);

export type DropshippingSettingsDocument = InferSchemaType<
  typeof dropshippingSettingsSchema
>;
export const DropshippingSettingsModel = model(
  'DropshippingSettings',
  dropshippingSettingsSchema,
);
