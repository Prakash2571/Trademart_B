/**
 * PUT /api/dropshipping/settings - change the thresholds and pricing rules
 *
 * A SEPARATE ROUTER from dropshippingRouter, which is read-only by design and asserted to
 * be so by dropshipping.routes.test.ts. This one is mounted behind
 * requireOperatorForWrites; on the read router it would be world-writable whenever
 * OPERATOR_PROTECT_READS is false.
 *
 * WHAT THIS DOES NOT DO
 * --------------------
 * It changes no prices. These settings decide which orders are FLAGGED, what is folded
 * into commercial cost, and what price Research RECOMMENDS. Nothing here writes to Shopify.
 * Repricing existing variants remains the automation module's job, behind its own preview
 * and apply steps.
 *
 * Mounted at /api, so the path starts with /dropshipping.
 */

import { Router } from 'express';

import { recordAudit } from '../audit/audit.service';
import { AppError } from '../common/errors';
import { asyncHandler, sendSuccess } from '../common/http';
import { pricingPolicyFrom } from './dropshipping.pricing';
import { describeDropshipSettingsRisks, type DropshipSettingsPatch } from './dropshipping.settings';
import { loadSettings, saveSettings } from './dropshipping.settings.service';

export const dropshippingWriteRouter = Router();

/**
 * Replaces the settings a patch mentions, leaving the rest alone.
 *
 * PUT rather than PATCH because the body is a complete statement of the sections it
 * contains - `cost` supplied means "these are the cost settings" - while sections omitted
 * entirely are untouched. That is how the settings form works: it submits the section
 * being edited.
 */
dropshippingWriteRouter.put(
  '/dropshipping/settings',
  asyncHandler(async (req, res) => {
    const raw = req.body;
    if (raw === undefined || raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new AppError('VALIDATION_ERROR', 'The request body must be a JSON object.');
    }

    const patch = raw as DropshipSettingsPatch;
    if (
      patch.cost === undefined &&
      patch.sla === undefined &&
      patch.pricing === undefined
    ) {
      throw new AppError(
        'VALIDATION_ERROR',
        'Supply at least one of cost, sla or pricing. An empty body would be a no-op that still wrote an audit entry.',
      );
    }

    const before = await loadSettings();
    const { settings, changed } = await saveSettings(patch, null);

    // A no-op is not audited. Recording saves that changed nothing fills the trail with
    // entries that hide the ones that matter.
    if (changed.length > 0) {
      await recordAudit({
        action: 'DROPSHIPPING_SETTINGS_UPDATE',
        resourceType: 'SETTINGS',
        resourceId: null,
        // The field-level diff rather than two whole documents, so the entry reads as a
        // change instead of something a human has to compare by eye.
        after: { changed },
        metadata: {
          minimumMarginPercentage: settings.cost.minimumMarginPercentage,
          minimumProfitAmount: settings.cost.minimumProfitAmount,
          wasStored: before.stored,
        },
      });
    }

    sendSuccess(
      res,
      {
        ...settings,
        // The policy these settings actually produce, echoed so an operator can see the
        // consequence of what they just saved rather than having to derive it.
        effectivePricingPolicy: pricingPolicyFrom(settings.cost, settings.pricing),
      },
      {
        changed,
        // Valid configurations that are still likely to mislead. They do not block the
        // save - the operator may know something the software does not - but staying
        // silent is how a dashboard ends up reporting margins nobody can explain.
        risks: describeDropshipSettingsRisks(settings),
        note: 'These settings change which orders are flagged and what price Research recommends. They do not change any price in Shopify.',
      },
    );
  }),
);
