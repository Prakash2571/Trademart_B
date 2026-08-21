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
import { getAutomationLockHolder } from './automation.lock';
import {
  applyAutomation,
  approveProduct,
  getStoredRules,
  listAutomationRuns,
  previewAutomation,
  resolveEffectiveRules,
  saveRules,
} from './automation.service';
import { listRecentPreviews } from './preview.store';
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
    sendSuccess(res, {
      /** False means preview works but nothing can be written. */
      writesEnabled: isAutomationEnabled(),
      storeDomain: config.shopify.storeDomain,
      effectiveRules: rules,
      ruleProblems: validateAutomationRules(rules),
      costSource: {
        field: 'inventoryItem.unitCost',
        description:
          'Shopify\'s "Cost per item". Dropshipping apps (Tradelle, DSers, Zendrop, CJ, AutoDS) write into this field, so Trademart reads one place and works with any of them - no supplier API needed.',
        requiresScope: 'read_inventory',
      },
      writeScopeRequired: 'write_products',
      /** True when Shopify webhooks trigger runs without anyone asking. */
      webhookTriggersEnabled: isAutomationOnWebhookEnabled(),
      /**
       * Apply is gated on a preview, and the gate is server-side. Advertised here
       * so a client cannot be written against the old contract by accident.
       */
      applyRequiresPreview: true,
      previewTtlMinutes: config.retention.previewMinutes,
      endpoints: {
        preview: 'POST /api/automation/preview',
        apply: 'POST /api/automation/apply (requires previewId)',
        approve: 'POST /api/automation/approve',
        getRules: 'GET /api/automation/rules',
        saveRules: 'PUT /api/automation/rules',
        history: 'GET /api/automation/runs',
        lock: 'GET /api/automation/lock',
        previews: 'GET /api/automation/previews',
      },
      note: isAutomationEnabled()
        ? 'Writes are ENABLED. /api/automation/apply will change live product prices and visibility, but only for a plan that a preview recorded and that still matches current Shopify data.'
        : 'Writes are disabled (AUTOMATION_ENABLED is not true). /api/automation/preview still reports exactly what would change.',
    });
  }),
);

/**
 * Scope parsing shared by preview and apply.
 *
 * The same function on both routes is what makes the scope comparison meaningful:
 * if the two parsed their inputs differently, an identical request could produce
 * two different scopes and a spurious PREVIEW_STALE.
 */
function readScope(body: Record<string, unknown>): {
  query: string | undefined;
  maxProducts: number | undefined;
} {
  return {
    query: parseStringParam(body['query'], 'query', { maxLength: 500 }),
    maxProducts:
      body['maxProducts'] === undefined
        ? undefined
        : parseIntParam(String(body['maxProducts']), 'maxProducts', {
            min: 1,
            max: 250,
            fallback: 250,
          }),
  };
}

automationRouter.post(
  '/automation/preview',
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const scope = readScope(body);
    // previewAutomation cannot write: it only ever calls executePreparedPlan with
    // dryRun true. There is no flag on this route a caller could flip.
    const report = await previewAutomation({
      trigger: 'manual',
      query: scope.query,
      rules: readRuleOverrides(body),
      maxProducts: scope.maxProducts,
    });
    sendSuccess(res, report, {
      dryRun: true,
      // Surfaced in meta as well as the body so a client cannot miss that this is
      // the value it must send back in order to apply.
      previewId: report.preview?.previewId ?? null,
      expiresAt: report.preview?.expiresAt ?? null,
    });
  }),
);

automationRouter.post(
  '/automation/apply',
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const scope = readScope(body);

    // previewId is mandatory. applyAutomation re-derives the plan from current
    // data, compares its fingerprint against the reviewed one, and refuses with
    // PREVIEW_STALE if anything moved - so this endpoint can only ever execute a
    // plan a human actually looked at.
    const report = await applyAutomation({
      trigger: 'manual',
      previewId: parseStringParam(body['previewId'], 'previewId', { maxLength: 100 }),
      query: scope.query,
      rules: readRuleOverrides(body),
      maxProducts: scope.maxProducts,
    });

    sendSuccess(res, report, {
      dryRun: false,
      previewId: report.preview?.previewId ?? null,
      planHash: report.planHash,
    });
  }),
);

/**
 * Who, if anyone, is running automation right now.
 *
 * Exists so a 409 AUTOMATION_ALREADY_RUNNING is explainable in the UI: the
 * operator can see the run that is blocking theirs rather than just being
 * refused.
 */
automationRouter.get(
  '/automation/lock',
  asyncHandler(async (_req, res) => {
    const holder = await getAutomationLockHolder();
    sendSuccess(res, { locked: holder !== null, holder });
  }),
);

/** Recent previews, for diagnosing a rejected apply. */
automationRouter.get(
  '/automation/previews',
  asyncHandler(async (req, res) => {
    const limit = parseIntParam(req.query['limit'], 'limit', {
      min: 1,
      max: 50,
      fallback: 10,
    });
    const previews = await listRecentPreviews(limit);
    sendSuccess(res, { previews }, { count: previews.length });
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

    // The result is returned verbatim rather than being flattened into
    // `{ approved: true }`. Approval can legitimately end with the product live
    // but still tagged, or published but not visible, and the caller has to be
    // able to tell those apart. A hard-coded status:'ACTIVE' - which is what this
    // used to return - was a claim, not an observation.
    const result = await approveProduct(productId);
    sendSuccess(res, result, {
      approved: result.visibleToCustomers,
      partialSuccess: result.warnings.length > 0,
    });
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
