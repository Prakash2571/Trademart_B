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
import { parseIntParam, parseStringParam } from '../common/validate';
import { config, isAutomationEnabled } from '../config';
import {
  listAutomationRuns,
  resolveRules,
  runAutomation,
} from './automation.service';
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
    const rules = resolveRules();
    sendSuccess(res, {
      /** False means preview works but nothing can be written. */
      writesEnabled: isAutomationEnabled(),
      storeDomain: config.shopify.storeDomain,
      defaultRules: rules,
      ruleProblems: validateAutomationRules(rules),
      costSource: {
        field: 'inventoryItem.unitCost',
        description:
          'Shopify\'s "Cost per item". Dropshipping apps (Tradelle, DSers, Zendrop, CJ, AutoDS) write into this field, so Trademart reads one place and works with any of them - no supplier API needed.',
        requiresScope: 'read_inventory',
      },
      writeScopeRequired: 'write_products',
      endpoints: {
        preview: 'POST /api/automation/preview',
        apply: 'POST /api/automation/apply',
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
    const report = await runAutomation({
      // Hardcoded, not read from input: this route must never be able to write,
      // whatever the caller sends.
      dryRun: true,
      trigger: 'manual',
      query: parseStringParam(body['query'], 'query', { maxLength: 500 }),
      rules: readRuleOverrides(body),
      maxProducts:
        body['maxProducts'] === undefined
          ? undefined
          : parseIntParam(String(body['maxProducts']), 'maxProducts', {
              min: 1,
              max: 250,
              fallback: 250,
            }),
    });
    sendSuccess(res, report, { dryRun: true });
  }),
);

automationRouter.post(
  '/automation/apply',
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    // runAutomation enforces the kill switch itself; checking here as well would
    // duplicate the rule and let the two drift apart.
    const report = await runAutomation({
      dryRun: false,
      trigger: 'manual',
      query: parseStringParam(body['query'], 'query', { maxLength: 500 }),
      rules: readRuleOverrides(body),
      maxProducts:
        body['maxProducts'] === undefined
          ? undefined
          : parseIntParam(String(body['maxProducts']), 'maxProducts', {
              min: 1,
              max: 250,
              fallback: 250,
            }),
    });
    sendSuccess(res, report, { dryRun: false });
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
