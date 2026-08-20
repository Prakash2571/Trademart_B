/**
 * Storefront automation routes.
 *
 * GET  /api/automation/status   - rules, kill switch, readiness
 * POST /api/automation/preview  - what WOULD change. Never writes.
 * POST /api/automation/apply    - actually change the store. Kill switch required.
 * GET  /api/automation/runs     - audit history
 *
 * `preview` and `apply` run identical decision logic; the only difference is
 * whether the resulting plan is executed. That is deliberate — a preview you
 * cannot trust is worse than no preview.
 */

import { Router } from 'express';

import { AppError } from '../common/errors';
import { asyncHandler, sendSuccess } from '../common/http';
import { parseIntParam, parseStringParam, toShopifyGid } from '../common/validate';
import { config, isAutomationEnabled, isAutomationOnWebhookEnabled } from '../config';
import { COST_SOURCE_ORDER, UNKNOWN_COST_POLICY } from '../suppliers/cost';
import {
  anySupplierCostApiAvailable,
  describeSupplierCostSupport,
} from '../suppliers/supplier.registry';
import {
  approveProduct,
  executePreparedPlan,
  getStoredRules,
  hashPlan,
  listAutomationRuns,
  prepareAutomationPlan,
  resolveEffectiveRules,
  saveRules,
} from './automation.service';
import {
  computeRulesHash,
  consumePreview,
  findApplicablePreview,
  recordPreview,
} from './preview.store';
import { validateAutomationRules, type AutomationRules } from './rules.types';

export const automationRouter = Router();

/**
 * Pulls rule overrides out of a request body.
 *
 * Only known keys are read, so an unexpected field cannot reach the rule set.
 * Types are checked here rather than trusted, because these values decide real
 * prices.
 */
function readRuleOverrides(body: Record<string, unknown>): Partial<AutomationRules> | undefined {
  const raw = body['rules'];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AppError('VALIDATION_ERROR', 'rules must be an object.');
  }

  const source = raw as Record<string, unknown>;
  const overrides: Partial<AutomationRules> = {};

  if (source['visibility'] !== undefined) {
    if (typeof source['visibility'] !== 'object' || source['visibility'] === null) {
      throw new AppError('VALIDATION_ERROR', 'rules.visibility must be an object.');
    }
    overrides.visibility = source['visibility'] as AutomationRules['visibility'];
  }
  if (source['price'] !== undefined) {
    if (typeof source['price'] !== 'object' || source['price'] === null) {
      throw new AppError('VALIDATION_ERROR', 'rules.price must be an object.');
    }
    overrides.price = source['price'] as AutomationRules['price'];
  }
  if (source['exemptTags'] !== undefined) {
    if (
      !Array.isArray(source['exemptTags']) ||
      source['exemptTags'].some((tag) => typeof tag !== 'string')
    ) {
      throw new AppError('VALIDATION_ERROR', 'rules.exemptTags must be an array of strings.');
    }
    overrides.exemptTags = source['exemptTags'] as string[];
  }
  if (source['selection'] !== undefined) {
    if (typeof source['selection'] !== 'object' || source['selection'] === null) {
      throw new AppError('VALIDATION_ERROR', 'rules.selection must be an object.');
    }
    overrides.selection = source['selection'] as AutomationRules['selection'];
  }
  if (source['maxItemsPerRun'] !== undefined) {
    if (typeof source['maxItemsPerRun'] !== 'number') {
      throw new AppError('VALIDATION_ERROR', 'rules.maxItemsPerRun must be a number.');
    }
    overrides.maxItemsPerRun = source['maxItemsPerRun'];
  }

  return overrides;
}

automationRouter.get(
  '/automation/status',
  asyncHandler(async (_req, res) => {
    // Effective, not default: the whole point is to show what a run would use.
    const rules = await resolveEffectiveRules();
    // False today: no registered provider has a documented cost API. Computed
    // rather than hardcoded so registering one flips this automatically.
    const supplierCostAvailable = anySupplierCostApiAvailable();
    sendSuccess(res, {
      /** False means preview works but nothing can be written. */
      writesEnabled: isAutomationEnabled(),
      storeDomain: config.shopify.storeDomain,
      effectiveRules: rules,
      ruleProblems: validateAutomationRules(rules),
      /**
       * The real cost hierarchy.
       *
       * This used to report a single `costSource` of inventoryItem.unitCost,
       * which was accurate for the original MVP and wrong once the supplier
       * registry and manual costs shipped. `order` is imported from
       * suppliers/cost.ts rather than restated, so it cannot drift from the
       * resolution logic.
       */
      costResolution: {
        order: COST_SOURCE_ORDER,
        manualCostSupported: true,
        unknownCostPolicy: UNKNOWN_COST_POLICY,
        tiers: [
          {
            source: 'SUPPLIER_API',
            description:
              "A supplier provider's getSupplierCost returned a positive value. Most current, and outranks a manual override.",
            available: supplierCostAvailable,
            requiresScope: null,
          },
          {
            source: 'SHOPIFY_UNIT_COST',
            description:
              'Shopify\'s "Cost per item" (variant.inventoryItem.unitCost). Dropshipping apps commonly write it on import, so Trademart reads one field and works with any of them.',
            available: true,
            requiresScope: 'read_inventory',
          },
          {
            source: 'MANUAL',
            description:
              'A cost entered in Trademart via PUT /api/costs. Ranks below Shopify by default; set override=true to make it win over a wrong Shopify value. Never beats a live SUPPLIER_API fetch.',
            available: true,
            requiresScope: null,
          },
          {
            source: 'UNKNOWN',
            description:
              'No usable cost from any tier. The product is SKIPPED for automatic pricing - a missing cost is never treated as 0, because that would compute an absurd margin and a nonsense price.',
            available: true,
            requiresScope: null,
          },
        ],
        /**
         * Per-provider honesty. Derived from which optional methods each
         * provider actually implements plus whether they can return a value,
         * so this cannot claim an integration that does not exist.
         */
        suppliers: describeSupplierCostSupport(),
      },
      writeScopeRequired: 'write_products',
      /** True when Shopify webhooks trigger runs without anyone asking. */
      webhookTriggersEnabled: isAutomationOnWebhookEnabled(),
      endpoints: {
        preview: 'POST /api/automation/preview',
        apply: 'POST /api/automation/apply',
        approve: 'POST /api/automation/approve',
        getRules: 'GET /api/automation/rules',
        saveRules: 'PUT /api/automation/rules',
        history: 'GET /api/automation/runs',
      },
      note: isAutomationEnabled()
        ? 'Writes are ENABLED. /api/automation/apply will change live product prices and visibility.'
        : 'Writes are disabled (AUTOMATION_ENABLED is not true). /api/automation/preview still reports exactly what would change.',
    });
  }),
);

automationRouter.post(
  '/automation/preview',
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const overrides = readRuleOverrides(body);
    const query = parseStringParam(body['query'], 'query', { maxLength: 500 });
    const maxProducts =
      body['maxProducts'] === undefined
        ? undefined
        : parseIntParam(String(body['maxProducts']), 'maxProducts', {
            min: 1,
            max: 250,
            fallback: 250,
          });

    // Prepare (read-only) then report the dry run over that exact plan, so the
    // token binds to the concrete plan the operator sees - not just the rules.
    const prepared = await prepareAutomationPlan({
      trigger: 'manual',
      query,
      rules: overrides,
      maxProducts,
    });
    const report = await executePreparedPlan(prepared, { dryRun: true, trigger: 'manual' });

    // Single-use token bound to the store, the effective rules AND the concrete
    // action plan, so a later apply can prove it corresponds to THIS preview
    // even if Shopify/cost data shifts underneath (see preview.store).
    const preview = recordPreview({
      rulesHash: computeRulesHash(prepared.rules),
      planHash: hashPlan(prepared.plan),
      storeDomain: report.shopDomain,
      query,
      maxProducts,
      overrides,
    });

    sendSuccess(res, report, { dryRun: true, preview });
  }),
);

automationRouter.post(
  '/automation/apply',
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;

    // Apply is only permitted for a valid, current, unused preview. This is the
    // server-side half of the preview gate: it cannot be bypassed by calling
    // the API directly. The rules/store are re-checked against NOW, so a rule
    // change or store switch after previewing invalidates the token.
    const previewId = parseStringParam(body['previewId'], 'previewId', { maxLength: 100 });
    const record = findApplicablePreview(previewId, config.shopify.storeDomain);

    // Re-prepare the plan NOW (read-only), from the preview's exact scope. If
    // the saved rules OR the underlying product/cost data changed since the
    // preview, the rules hash or the plan hash differs and consumePreview
    // rejects it as PREVIEW_STALE - nothing is applied.
    const prepared = await prepareAutomationPlan({
      trigger: 'manual',
      query: record.query,
      rules: record.overrides,
      maxProducts: record.maxProducts,
    });
    consumePreview(record.previewId, {
      rulesHash: computeRulesHash(prepared.rules),
      planHash: hashPlan(prepared.plan),
    });

    // Execute the SAME prepared plan that was just verified - no re-fetch or
    // re-plan between verification and execution. Takes the automation lock.
    const report = await executePreparedPlan(prepared, { dryRun: false, trigger: 'manual' });
    sendSuccess(res, report, { dryRun: false, previewId: record.previewId });
  }),
);

automationRouter.get(
  '/automation/rules',
  asyncHandler(async (_req, res) => {
    const stored = await getStoredRules();
    const effective = await resolveEffectiveRules();
    sendSuccess(res, {
      /** Only what has been explicitly saved. Null when nothing is saved. */
      stored,
      /** Defaults with the saved values applied - what a run will actually use. */
      effective,
      problems: validateAutomationRules(effective),
      source: stored === null ? 'defaults' : 'stored',
    });
  }),
);

automationRouter.put(
  '/automation/rules',
  asyncHandler(async (req, res) => {
    // Saving matters because webhook-triggered runs have no request body: these
    // are the rules an automatic run will use.
    const body = (req.body ?? {}) as Record<string, unknown>;
    const overrides = readRuleOverrides(body);
    if (overrides === undefined) {
      throw new AppError(
        'VALIDATION_ERROR',
        'A rules object is required, e.g. { "rules": { "price": { "enabled": true } } }.',
      );
    }
    const effective = await saveRules(overrides);
    sendSuccess(res, { stored: overrides, effective });
  }),
);

automationRouter.post(
  '/automation/approve',
  asyncHandler(async (req, res) => {
    // The deliberate human step: clears the review gate and publishes. Separate
    // from apply because approving is a decision, not a rule evaluation.
    const body = (req.body ?? {}) as Record<string, unknown>;
    const raw = parseStringParam(body['productId'], 'productId', { maxLength: 255 });
    if (raw === undefined) {
      throw new AppError('VALIDATION_ERROR', 'productId is required.');
    }
    const productId = toShopifyGid(raw, 'Product');

    // Structured result: activation and publication are reported separately, so
    // an ACTIVE-but-not-published outcome is visible rather than hidden behind a
    // blanket "approved: true".
    const result = await approveProduct(productId);
    sendSuccess(res, result);
  }),
);

automationRouter.get(
  '/automation/runs',
  asyncHandler(async (req, res) => {
    const limit = parseIntParam(req.query['limit'], 'limit', {
      min: 1,
      max: 50,
      fallback: 10,
    });
    const runs = await listAutomationRuns(limit);
    sendSuccess(res, { runs }, { count: runs.length });
  }),
);
