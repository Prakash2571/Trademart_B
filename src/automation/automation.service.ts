/**
 * Automation execution.
 *
 * Everything that DECIDES lives in the pure modules (rules.types, price.rules,
 * visibility.rules, plan). This module only fetches, writes and audits — so a
 * dry run and a real run take an identical decision path and a preview is a
 * truthful prediction rather than a separate code path that might disagree.
 *
 * Safety properties, in order of importance:
 *   1. Writes require the AUTOMATION_ENABLED kill switch. Preview never does.
 *   2. If Shopify degraded away `unitCost` (no read_inventory), price automation
 *      REFUSES to run rather than concluding "no product has a cost" and
 *      skipping the catalogue silently.
 *   3. One failing product never aborts the run; each action is isolated.
 *   4. Every applied action records its previous value, so a run is reversible.
 */

import { AppError, toAppError } from '../common/errors';
import { logger } from '../common/logger';
import { getContext, getRequestId } from '../common/requestContext';
import { config, isAutomationEnabled } from '../config';
import { AutomationRunModel } from '../database/models/AutomationRun';
import { AutomationSettingsModel } from '../database/models/AutomationSettings';
import { getDatabaseStatus } from '../database/mongo';
import {
  PRODUCT_STATUS_UPDATE_MUTATION,
  PRODUCT_VARIANTS_PRICE_UPDATE_MUTATION,
  TAGS_ADD_MUTATION,
  TAGS_REMOVE_MUTATION,
} from '../shopify/graphql/product.mutations';
import { shopifyGraphql } from '../shopify/shopify.client';
import { mapUserErrors } from '../shopify/shopify.errors';
import { INVENTORY_ITEM_PRODUCT_QUERY } from '../shopify/graphql/inventory.queries';
import { assertShopifyHealthyForBulkWrites } from '../shopify/rateLimit.service';
import {
  tryGetProductPublicationState,
  tryPublishToOnlineStore,
} from '../shopify/publication.service';
import { getProduct, listProducts } from '../shopify/shopify.service';
import type { ProductDto } from '../shopify/shopify.types';
import { loadManualCostMap } from '../suppliers/manualCost.service';
import { withAutomationLock } from './automation.lock';
import { buildAutomationPlan, type AutomationPlan, type PriceAction } from './plan';
import {
  hashPlan,
  hashRules,
  normaliseScope,
  shortHash,
  type PlanScope,
} from './plan.hash';
import {
  consumePreview,
  issuePreview,
  type PreviewRecord,
} from './preview.store';
import {
  AUTOMATION_HIDDEN_TAG,
  AUTOMATION_REVIEW_TAG,
  DEFAULT_AUTOMATION_RULES,
  validateAutomationRules,
  type AutomationRules,
} from './rules.types';

/** Products fetched per Shopify page. */
const PAGE_SIZE = 50;
/** Hard ceiling on products inspected in one run, regardless of catalogue size. */
const MAX_PRODUCTS = 250;
/** The degraded-field marker listProducts reports when read_inventory is absent. */
const UNIT_COST_FIELD = 'variant.unitCost';

export interface RunOptions {
  dryRun: boolean;
  trigger?: 'manual' | 'webhook' | 'scheduled';
  /** Shopify product search syntax, to scope a run to part of the catalogue. */
  query?: string | undefined;
  /**
   * Exact products to act on. Used by webhook-triggered runs so a single changed
   * product costs one lookup instead of a catalogue scan.
   */
  productIds?: readonly string[] | undefined;
  /** Overrides merged over DEFAULT_AUTOMATION_RULES. */
  rules?: Partial<AutomationRules> | undefined;
  maxProducts?: number | undefined;
}

export interface AppliedAction {
  type: 'visibility' | 'price';
  shopifyProductId: string;
  shopifyVariantId: string | null;
  title: string;
  fromValue: string;
  toValue: string;
  currencyCode: string | null;
  reasons: string[];
  status: 'planned' | 'applied' | 'failed';
  error: string | null;
}

export interface AutomationReport {
  dryRun: boolean;
  shopDomain: string;
  rules: AutomationRules;
  plan: AutomationPlan;
  actions: AppliedAction[];
  /** Fields Shopify refused, propagated from the product read. */
  degraded: string[];
  summary: AutomationPlan['summary'] & { applied: number; failed: number };
  auditRunId: string | null;
  notes: string[];
  /** Fingerprint of the rules this run used. */
  rulesHash: string;
  /**
   * Fingerprint of the exact action list. For a preview this is what the operator
   * is approving; for an apply it is proof the executed plan matched it.
   */
  planHash: string;
  scope: PlanScope;
  /**
   * The preview token. Present on a preview (the client must send its previewId
   * back to apply) and on an apply (the token that authorised it). Null for
   * internal unreviewed runs.
   */
  preview: PreviewRecord | null;
}

/**
 * Merges caller overrides over a base rule set.
 *
 * Nested objects are merged one level deep so a caller can send just
 * `{ price: { targetMarginPercentage: 40 } }` without having to restate every
 * other price rule (and accidentally reset a guardrail to undefined).
 */
export function resolveRules(
  overrides?: Partial<AutomationRules>,
  base: AutomationRules = DEFAULT_AUTOMATION_RULES,
): AutomationRules {
  if (overrides === undefined) return base;
  return {
    ...base,
    ...overrides,
    visibility: { ...base.visibility, ...(overrides.visibility ?? {}) },
    price: { ...base.price, ...(overrides.price ?? {}) },
    selection: { ...base.selection, ...(overrides.selection ?? {}) },
  };
}

/**
 * The saved rule set for this shop, or null when none is stored.
 * Never throws: automation must still work with no database.
 */
export async function getStoredRules(): Promise<Partial<AutomationRules> | null> {
  if (getDatabaseStatus().status !== 'connected') return null;
  try {
    const doc = await AutomationSettingsModel.findOne({
      shopDomain: config.shopify.storeDomain,
    })
      .select('rules')
      .lean();
    return (doc?.rules as Partial<AutomationRules> | undefined) ?? null;
  } catch (error) {
    logger.warn('Could not read stored automation rules; falling back to defaults.', {
      reason: error instanceof Error ? error.message : 'unknown',
    });
    return null;
  }
}

/**
 * Effective rules: defaults <- stored <- per-request overrides.
 *
 * This precedence is what lets a webhook-triggered run (which has no request
 * body) behave the way the merchant configured, while still allowing a one-off
 * manual run to try different numbers without saving them.
 */
export async function resolveEffectiveRules(
  overrides?: Partial<AutomationRules>,
): Promise<AutomationRules> {
  const stored = await getStoredRules();
  const base = stored === null ? DEFAULT_AUTOMATION_RULES : resolveRules(stored);
  return resolveRules(overrides, base);
}

/** Saves a partial rule set after validating the result it would produce. */
export async function saveRules(
  overrides: Partial<AutomationRules>,
): Promise<AutomationRules> {
  const effective = resolveRules(overrides);
  const problems = validateAutomationRules(effective);
  if (problems.length > 0) {
    throw new AppError('AUTOMATION_RULES_INVALID', 'Automation rules are invalid.', {
      details: { problems },
    });
  }
  if (getDatabaseStatus().status !== 'connected') {
    throw new AppError(
      'DATABASE_UNAVAILABLE',
      'Saving automation rules requires MongoDB. Set MONGODB_URI, or pass rules per request instead.',
    );
  }

  await AutomationSettingsModel.updateOne(
    { shopDomain: config.shopify.storeDomain },
    { $set: { shopDomain: config.shopify.storeDomain, rules: overrides } },
    { upsert: true },
  );

  logger.info('Saved automation rules.', {
    priceEnabled: effective.price.enabled,
    pricingMode: effective.price.pricingMode,
    selectionMode: effective.selection.mode,
  });
  return effective;
}

/** Reads specific products by id, skipping any that no longer exist. */
async function fetchProductsByIds(
  productIds: readonly string[],
): Promise<{ products: ProductDto[]; degraded: string[] }> {
  const products: ProductDto[] = [];
  for (const id of productIds) {
    try {
      products.push(await getProduct(id));
    } catch (error) {
      // A deleted product is normal in a webhook-triggered run: the delivery can
      // arrive after the product is gone. Not an error worth failing the run for.
      logger.info('Skipping product that could not be read.', {
        shopifyProductId: id,
        code: error instanceof AppError ? error.code : 'INTERNAL_ERROR',
      });
    }
  }
  // getProduct applies the same scope fallback as listProducts but does not
  // report degraded fields, so cost availability is inferred from the data.
  const degraded =
    products.length > 0 &&
    products.every((product) => product.variants.every((v) => v.unitCost === null))
      ? [UNIT_COST_FIELD]
      : [];
  return { products, degraded };
}

/** Reads up to `maxProducts` products, collecting any degraded fields. */
async function fetchProducts(
  query: string | undefined,
  maxProducts: number,
): Promise<{ products: ProductDto[]; degraded: string[] }> {
  const products: ProductDto[] = [];
  const degraded = new Set<string>();
  let after: string | undefined;

  while (products.length < maxProducts) {
    const remaining = maxProducts - products.length;
    const page = await listProducts({
      first: Math.min(PAGE_SIZE, remaining),
      after,
      query,
    });

    products.push(...page.items);
    for (const field of page.meta.degraded ?? []) degraded.add(field);

    if (!page.meta.hasNextPage || page.meta.endCursor === null) break;
    after = page.meta.endCursor;
  }

  return { products, degraded: [...degraded] };
}

/** Applies one visibility change: status, plus the ownership tag. */
async function applyVisibility(
  productId: string,
  to: 'ACTIVE' | 'DRAFT',
): Promise<void> {
  const result = await shopifyGraphql<{
    productUpdate: {
      product: { id: string; status: string } | null;
      userErrors: { field?: string[] | null; message?: string }[];
    } | null;
  }>(
    PRODUCT_STATUS_UPDATE_MUTATION,
    { product: { id: productId, status: to } },
    { operation: 'automationProductStatusUpdate' },
  );

  const userError = mapUserErrors(result.data.productUpdate?.userErrors);
  if (userError !== null) throw userError;

  // The tag records that automation owns this hide, which is what lets a later
  // run distinguish it from a product a human drafted. Tag failure must not
  // leave the status change looking failed, but it IS logged loudly: without the
  // tag the product will not be auto-restored.
  try {
    if (to === 'DRAFT') {
      const tagResult = await shopifyGraphql<{
        tagsAdd: { userErrors: { field?: string[] | null; message?: string }[] } | null;
      }>(
        TAGS_ADD_MUTATION,
        { id: productId, tags: [AUTOMATION_HIDDEN_TAG] },
        { operation: 'automationTagsAdd' },
      );
      const tagError = mapUserErrors(tagResult.data.tagsAdd?.userErrors);
      if (tagError !== null) throw tagError;
    } else {
      const tagResult = await shopifyGraphql<{
        tagsRemove: { userErrors: { field?: string[] | null; message?: string }[] } | null;
      }>(
        TAGS_REMOVE_MUTATION,
        { id: productId, tags: [AUTOMATION_HIDDEN_TAG] },
        { operation: 'automationTagsRemove' },
      );
      const tagError = mapUserErrors(tagResult.data.tagsRemove?.userErrors);
      if (tagError !== null) throw tagError;
    }
  } catch (error) {
    logger.warn(
      `Status changed to ${to} but the ${AUTOMATION_HIDDEN_TAG} tag could not be updated. Automatic restore may not work for this product.`,
      {
        shopifyProductId: productId,
        code: error instanceof AppError ? error.code : 'INTERNAL_ERROR',
      },
    );
  }
}

/** Applies price changes for one product in a single bulk mutation. */
async function applyPrices(productId: string, actions: PriceAction[]): Promise<void> {
  const result = await shopifyGraphql<{
    productVariantsBulkUpdate: {
      productVariants: { id: string; price: string }[] | null;
      userErrors: { field?: string[] | null; message?: string }[];
    } | null;
  }>(
    PRODUCT_VARIANTS_PRICE_UPDATE_MUTATION,
    {
      productId,
      variants: actions.map((action) => ({
        id: action.shopifyVariantId,
        // Money is a String scalar; sending a float is rejected.
        price: action.to.toFixed(2),
      })),
    },
    { operation: 'automationVariantPriceUpdate' },
  );

  const userError = mapUserErrors(result.data.productVariantsBulkUpdate?.userErrors);
  if (userError !== null) throw userError;
}

/**
 * A plan built from freshly fetched data, together with its fingerprints.
 *
 * The point of this type is that it is a VALUE. Once a PreparedPlan exists, the
 * plan it holds is fixed: verifying its hash and then executing it cannot
 * disagree, because nothing is re-fetched or re-decided in between. That is what
 * makes the preview -> apply guarantee airtight rather than merely likely.
 */
export interface PreparedPlan {
  rules: AutomationRules;
  plan: AutomationPlan;
  /** Fingerprint of the rules the plan was built from. */
  rulesHash: string;
  /** Fingerprint of the action list. Compared against the reviewed preview. */
  planHash: string;
  scope: PlanScope;
  /** Fields Shopify refused, propagated from the product read. */
  degraded: string[];
  notes: string[];
}

/**
 * Fetches data and builds a plan. NEVER writes.
 *
 * Shared verbatim by preview and apply, which is what makes a preview a truthful
 * prediction rather than a separate code path that might disagree with what apply
 * would do.
 */
export async function prepareAutomationPlan(
  options: Omit<RunOptions, 'dryRun'>,
): Promise<PreparedPlan> {
  const rules = await resolveEffectiveRules(options.rules);
  const problems = validateAutomationRules(rules);
  if (problems.length > 0) {
    throw new AppError('AUTOMATION_RULES_INVALID', 'Automation rules are invalid.', {
      details: { problems },
    });
  }

  const notes: string[] = [];
  const maxProducts = Math.min(options.maxProducts ?? MAX_PRODUCTS, MAX_PRODUCTS);
  const { products, degraded } =
    options.productIds !== undefined && options.productIds.length > 0
      ? await fetchProductsByIds(options.productIds.slice(0, maxProducts))
      : await fetchProducts(options.query, maxProducts);

  // Manual costs let a product be priced when Shopify has no cost per item, so
  // they are loaded before the honesty check below.
  const manualCosts = await loadManualCostMap(
    products.map((product) => ({
      shopifyProductId: product.shopifyProductId,
      variantIds: product.variants.map((v) => v.shopifyVariantId),
    })),
  );

  // Critical honesty check. Without read_inventory every variant reports a null
  // unitCost, so the plan would be "nothing to do" for a reason that has nothing
  // to do with the catalogue. Refuse instead of misleading - UNLESS manual costs
  // are available, in which case pricing can still proceed from those.
  if (
    rules.price.enabled &&
    degraded.includes(UNIT_COST_FIELD) &&
    manualCosts.size === 0
  ) {
    throw new AppError(
      'AUTOMATION_PRECONDITION_FAILED',
      'Shopify did not return cost per item (read_inventory is not granted) and no manual costs are stored, so no product has a usable cost and no price could be calculated. Add the read_inventory scope, enter manual costs, or disable price rules for this run.',
      { details: { degraded } },
    );
  }
  if (degraded.length > 0) {
    notes.push(`Shopify withheld: ${degraded.join(', ')}.`);
  }
  if (manualCosts.size > 0) {
    notes.push(`Applied ${manualCosts.size} manual cost(s) where present.`);
  }
  if (products.length === maxProducts) {
    notes.push(
      `Inspected the first ${maxProducts} products only. Use the query parameter to target a subset.`,
    );
  }

  const plan = buildAutomationPlan(products, rules, manualCosts);

  return {
    rules,
    plan,
    rulesHash: hashRules(rules),
    planHash: hashPlan(plan),
    scope: normaliseScope({
      query: options.query,
      maxProducts,
      productIds: options.productIds,
    }),
    degraded,
    notes,
  };
}

/**
 * Executes (or, for a dry run, merely reports) an ALREADY PREPARED plan.
 *
 * Takes the prepared plan rather than re-deriving one, so the plan that was
 * verified against the operator's preview is byte-for-byte the plan that gets
 * written. Nothing between the hash comparison and the Shopify mutations can
 * change what is about to happen.
 */
export async function executePreparedPlan(
  prepared: PreparedPlan,
  options: { dryRun: boolean; trigger?: RunOptions['trigger']; previewId?: string | null },
): Promise<AutomationReport> {
  const { rules, plan, degraded } = prepared;
  const notes = [...prepared.notes];

  if (!options.dryRun && !isAutomationEnabled()) {
    throw new AppError(
      'AUTOMATION_DISABLED',
      'Storefront writes are disabled. Set AUTOMATION_ENABLED=true to allow Trademart to change prices and product visibility, or use POST /api/automation/preview to see what it would do.',
    );
  }

  const actions: AppliedAction[] = [];
  let applied = 0;
  let failed = 0;

  if (options.dryRun) {
    for (const action of plan.actions) {
      actions.push({
        type: action.type,
        shopifyProductId: action.shopifyProductId,
        shopifyVariantId: action.type === 'price' ? action.shopifyVariantId : null,
        title: action.title,
        fromValue: action.type === 'price' ? action.from.toFixed(2) : action.from,
        toValue: action.type === 'price' ? action.to.toFixed(2) : action.to,
        currencyCode: action.type === 'price' ? action.currencyCode : null,
        reasons: action.reasons,
        status: 'planned',
        error: null,
      });
    }
  } else {
    // Visibility first: if the run dies midway, a loss-making or out-of-stock
    // product is already hidden rather than left on sale mid-update.
    for (const action of plan.actions) {
      if (action.type !== 'visibility') continue;
      try {
        await applyVisibility(action.shopifyProductId, action.to);
        applied += 1;
        actions.push({
          type: 'visibility',
          shopifyProductId: action.shopifyProductId,
          shopifyVariantId: null,
          title: action.title,
          fromValue: action.from,
          toValue: action.to,
          currencyCode: null,
          reasons: action.reasons,
          status: 'applied',
          error: null,
        });
      } catch (error) {
        failed += 1;
        const appError = toAppError(error);
        logger.warn('Automation visibility change failed.', {
          shopifyProductId: action.shopifyProductId,
          code: appError.code,
        });
        actions.push({
          type: 'visibility',
          shopifyProductId: action.shopifyProductId,
          shopifyVariantId: null,
          title: action.title,
          fromValue: action.from,
          toValue: action.to,
          currencyCode: null,
          reasons: action.reasons,
          status: 'failed',
          error: `${appError.code}: ${appError.message}`,
        });
      }
    }

    // Group price changes per product - productVariantsBulkUpdate takes one
    // productId, and one call per product beats one per variant against the
    // Shopify cost limit.
    const byProduct = new Map<string, PriceAction[]>();
    for (const action of plan.actions) {
      if (action.type !== 'price') continue;
      const existing = byProduct.get(action.shopifyProductId);
      if (existing === undefined) byProduct.set(action.shopifyProductId, [action]);
      else existing.push(action);
    }

    for (const [productId, priceActions] of byProduct) {
      try {
        await applyPrices(productId, priceActions);
        applied += priceActions.length;
        for (const action of priceActions) {
          actions.push({
            type: 'price',
            shopifyProductId: productId,
            shopifyVariantId: action.shopifyVariantId,
            title: action.title,
            fromValue: action.from.toFixed(2),
            toValue: action.to.toFixed(2),
            currencyCode: action.currencyCode,
            reasons: action.reasons,
            status: 'applied',
            error: null,
          });
        }
      } catch (error) {
        failed += priceActions.length;
        const appError = toAppError(error);
        logger.warn('Automation price change failed.', {
          shopifyProductId: productId,
          variantCount: priceActions.length,
          code: appError.code,
        });
        for (const action of priceActions) {
          actions.push({
            type: 'price',
            shopifyProductId: productId,
            shopifyVariantId: action.shopifyVariantId,
            title: action.title,
            fromValue: action.from.toFixed(2),
            toValue: action.to.toFixed(2),
            currencyCode: action.currencyCode,
            reasons: action.reasons,
            status: 'failed',
            error: `${appError.code}: ${appError.message}`,
          });
        }
      }
    }
  }

  const summary = { ...plan.summary, applied, failed };
  const auditRunId = await persistRun({
    dryRun: options.dryRun,
    trigger: options.trigger ?? 'manual',
    rules,
    actions,
    plan,
    summary,
    rulesHash: prepared.rulesHash,
    planHash: prepared.planHash,
    previewId: options.previewId ?? null,
  });

  logger.info(options.dryRun ? 'Automation preview complete.' : 'Automation run complete.', {
    dryRun: options.dryRun,
    planHash: shortHash(prepared.planHash),
    previewId: options.previewId ?? null,
    ...summary,
  });

  return {
    dryRun: options.dryRun,
    shopDomain: config.shopify.storeDomain,
    rules,
    plan,
    actions,
    degraded,
    summary,
    auditRunId,
    notes,
    rulesHash: prepared.rulesHash,
    planHash: prepared.planHash,
    scope: prepared.scope,
    preview: null,
  };
}

/**
 * Builds a plan, reports it, and issues a single-use token bound to it.
 *
 * The token is what `applyAutomation` demands. Its planHash is the operator's
 * receipt: it says "this exact set of changes is what I approved".
 */
export async function previewAutomation(
  options: Omit<RunOptions, 'dryRun'>,
): Promise<AutomationReport> {
  const prepared = await prepareAutomationPlan(options);
  const report = await executePreparedPlan(prepared, {
    dryRun: true,
    trigger: options.trigger ?? 'manual',
  });

  const preview = await issuePreview({
    rulesHash: prepared.rulesHash,
    planHash: prepared.planHash,
    scope: prepared.scope,
    summary: report.summary,
  });

  if (preview === null) {
    report.notes.push(
      'This preview could not be recorded, so it cannot be applied. The report above is still accurate. Check the database connection and preview again.',
    );
  }

  return { ...report, preview };
}

/**
 * Applies automation, but ONLY the exact plan a preview recorded.
 *
 * The sequence is the safety property:
 *
 *   1. take the store-level lock          (no two concurrent applies)
 *   2. build a plan from CURRENT data
 *   3. compare its fingerprint to the reviewed preview, and consume the token
 *   4. execute THAT SAME prepared plan
 *
 * Step 2 before step 3 is deliberate: the comparison has to be against fresh
 * data, otherwise it proves nothing. Step 4 reusing the object from step 2 is
 * equally deliberate: re-preparing after verification would reintroduce exactly
 * the gap this whole mechanism exists to close.
 */
export async function applyAutomation(
  options: Omit<RunOptions, 'dryRun'> & { previewId: string | undefined },
): Promise<AutomationReport> {
  if (options.previewId === undefined || options.previewId.length === 0) {
    throw new AppError(
      'PREVIEW_REQUIRED',
      'Applying automation requires the previewId returned by POST /api/automation/preview. Apply can only execute a plan that has been reviewed, so there is nothing to apply without one.',
    );
  }
  const previewId = options.previewId;

  // The kill switch is checked before taking the lock so a disabled deployment
  // fails immediately and cannot block a legitimate run.
  if (!isAutomationEnabled()) {
    throw new AppError(
      'AUTOMATION_DISABLED',
      'Storefront writes are disabled. Set AUTOMATION_ENABLED=true to allow Trademart to change prices and product visibility, or use POST /api/automation/preview to see what it would do.',
    );
  }

  // Refuse a bulk write while Shopify is failing persistently. Checked before the
  // lock so a degraded dependency does not also block the store for other work.
  //
  // Preview is deliberately NOT gated on this: a preview only needs reads, and
  // being able to look at the store while writes are paused is more useful than
  // failing everything at once.
  assertShopifyHealthyForBulkWrites();

  return withAutomationLock({ trigger: options.trigger ?? 'manual' }, async () => {
    const prepared = await prepareAutomationPlan(options);

    // Throws PREVIEW_REQUIRED / PREVIEW_EXPIRED / PREVIEW_STALE /
    // PREVIEW_ALREADY_APPLIED. Nothing has been written at this point, so every
    // refusal leaves the store untouched.
    const preview = await consumePreview({
      previewId,
      storeDomain: config.shopify.storeDomain,
      rulesHash: prepared.rulesHash,
      planHash: prepared.planHash,
      scope: prepared.scope,
    });

    const report = await executePreparedPlan(prepared, {
      dryRun: false,
      trigger: options.trigger ?? 'manual',
      previewId,
    });

    return { ...report, preview };
  });
}

/**
 * Runs automation without a preview. INTERNAL USE ONLY.
 *
 * Webhook-triggered runs have no human to review a preview, so they cannot
 * satisfy the preview gate - but they are also narrowly scoped (a single changed
 * product) and driven by the merchant's own saved rules, which is a different
 * risk profile from a bulk catalogue apply. They still take the store lock, so
 * they can never interleave with an operator's apply.
 *
 * Not reachable from the HTTP API: the apply route requires a previewId.
 */
export async function runAutomationUnreviewed(
  options: Omit<RunOptions, 'dryRun'>,
): Promise<AutomationReport> {
  return withAutomationLock({ trigger: options.trigger ?? 'webhook' }, async () => {
    const prepared = await prepareAutomationPlan(options);
    return executePreparedPlan(prepared, {
      dryRun: false,
      trigger: options.trigger ?? 'webhook',
    });
  });
}

/**
 * Writes the audit row. Never throws: losing the audit record must not fail a
 * run that already changed the store, but it is logged as an error because an
 * unaudited write is a real problem.
 */
async function persistRun(input: {
  dryRun: boolean;
  trigger: 'manual' | 'webhook' | 'scheduled';
  rules: AutomationRules;
  actions: AppliedAction[];
  plan: AutomationPlan;
  summary: AutomationReport['summary'];
  rulesHash: string;
  planHash: string;
  previewId: string | null;
}): Promise<string | null> {
  if (getDatabaseStatus().status !== 'connected') {
    if (!input.dryRun) {
      logger.warn(
        'Automation applied changes but no database is available, so no audit record was written.',
      );
    }
    return null;
  }

  try {
    const run = await AutomationRunModel.create({
      shopDomain: config.shopify.storeDomain,
      startedAt: new Date(),
      finishedAt: new Date(),
      dryRun: input.dryRun,
      trigger: input.trigger,
      rules: input.rules,
      actions: input.actions,
      skipped: input.plan.skipped,
      summary: input.summary,
      // Recorded so a historical run can be tied back to the preview that
      // authorised it - "what did the operator approve?" stays answerable.
      rulesHash: input.rulesHash,
      planHash: input.planHash,
      previewId: input.previewId,
      requestId: getRequestId(),
      actor: getContext()?.actor ?? null,
    });
    return String(run._id);
  } catch (error) {
    logger.error('Failed to persist the automation audit record.', {
      reason: error instanceof Error ? error.message : 'unknown',
    });
    return null;
  }
}

/**
 * Resolves an inventory item GID to its product GID.
 *
 * The `inventory_levels/update` webhook only names an inventory item, so a stock
 * change cannot be acted on without this hop. Returns null rather than throwing:
 * a webhook for a deleted variant is normal, not an error.
 */
export async function resolveProductFromInventoryItem(
  inventoryItemGid: string,
): Promise<string | null> {
  try {
    const result = await shopifyGraphql<{
      inventoryItem: { variant: { product: { id: string } | null } | null } | null;
    }>(
      INVENTORY_ITEM_PRODUCT_QUERY,
      { id: inventoryItemGid },
      { operation: 'automationResolveInventoryItem' },
    );
    return result.data.inventoryItem?.variant?.product?.id ?? null;
  } catch (error) {
    logger.info('Could not resolve inventory item to a product.', {
      inventoryItemId: inventoryItemGid,
      code: error instanceof AppError ? error.code : 'INTERNAL_ERROR',
    });
    return null;
  }
}

/**
 * Holds a newly imported product back from the storefront pending review.
 *
 * This is the "show only my desired products" gate: a dropshipping app can
 * import hundreds of products at once, and without this they would appear in the
 * shop immediately, unreviewed and at whatever price the importer set.
 *
 * Sets DRAFT and tags for review. Requires the kill switch, because it writes.
 */
export async function holdProductForReview(shopifyProductId: string): Promise<void> {
  if (!isAutomationEnabled()) {
    throw new AppError(
      'AUTOMATION_DISABLED',
      'Storefront writes are disabled, so new products cannot be held for review. Set AUTOMATION_ENABLED=true.',
    );
  }

  await applyVisibility(shopifyProductId, 'DRAFT');

  const result = await shopifyGraphql<{
    tagsAdd: { userErrors: { field?: string[] | null; message?: string }[] } | null;
  }>(
    TAGS_ADD_MUTATION,
    { id: shopifyProductId, tags: [AUTOMATION_REVIEW_TAG] },
    { operation: 'automationHoldForReview' },
  );
  const userError = mapUserErrors(result.data.tagsAdd?.userErrors);
  if (userError !== null) throw userError;

  logger.info('Held new product for review.', { shopifyProductId });
}

export interface ApprovalResult {
  shopifyProductId: string;
  /** Shopify's reported status after the attempt. */
  status: string;
  /** Verified against the Online Store publication, never inferred. */
  publishedToOnlineStore: boolean;
  /** The only field that may be shown as "customers can see it". */
  visibleToCustomers: boolean;
  /** False means the product is still held for review - deliberately. */
  reviewTagRemoved: boolean;
  /** True while the product remains in /products/review. */
  stillInReviewQueue: boolean;
  warnings: string[];
}

/**
 * Approves a held product. The deliberate human step that lets a product into
 * the shop.
 *
 * ORDER IS THE SAFETY PROPERTY
 * ----------------------------
 *     product stays DRAFT + review tag
 *          -> publish to the Online Store
 *          -> VERIFY publication
 *          -> set ACTIVE
 *          -> VERIFY final state
 *          -> only now remove the review / auto-hidden tags
 *
 * The review tag is removed LAST, and only after the product is genuinely live.
 * Removing it first - which is what this function used to do - meant that any
 * later failure dropped the product out of /products/review while leaving it
 * DRAFT: invisible to customers, invisible to the operator, and remembered by
 * nobody. An imported product could be silently lost that way.
 *
 * So every failure path here leaves the product in exactly the state it started
 * in: DRAFT, tagged, and still in the queue to be tried again.
 */
export async function approveProduct(shopifyProductId: string): Promise<ApprovalResult> {
  if (!isAutomationEnabled()) {
    throw new AppError(
      'AUTOMATION_DISABLED',
      'Storefront writes are disabled, so a product cannot be published. Set AUTOMATION_ENABLED=true.',
    );
  }

  const warnings: string[] = [];

  // ---- Publish first, and verify ------------------------------------------
  //
  // If this fails the function returns early WITHOUT touching tags or status, so
  // the product is untouched and stays in the review queue.
  const attempt = await tryPublishToOnlineStore(shopifyProductId);
  if (!attempt.outcome.published) {
    logger.warn('Approval failed at publication; product remains DRAFT and in review.', {
      shopifyProductId,
      code: attempt.outcome.error?.code ?? 'PUBLICATION_FAILED',
    });
    throw new AppError(
      'PUBLICATION_FAILED',
      `Could not publish this product to the Online Store (${attempt.outcome.error?.code ?? 'PUBLICATION_FAILED'}: ${attempt.outcome.error?.message ?? 'unknown reason'}). It has been left as a DRAFT with the ${AUTOMATION_REVIEW_TAG} tag, so it is still in the review queue and nothing is visible to customers. Fix the cause and approve it again.`,
      {
        details: {
          shopifyProductId,
          status: 'DRAFT',
          reviewTagRemoved: false,
          stillInReviewQueue: true,
          publication: attempt.outcome,
        },
      },
    );
  }

  // ---- Then activate, and verify ------------------------------------------
  try {
    await applyVisibility(shopifyProductId, 'ACTIVE');
  } catch (error) {
    const appError = toAppError(error);
    logger.warn('Approval published the product but could not set it ACTIVE.', {
      shopifyProductId,
      code: appError.code,
    });
    // Published but still DRAFT = still invisible. Keep the review tag so the
    // operator can find it, and say precisely what happened.
    throw new AppError(
      'PUBLICATION_FAILED',
      `The product was published to the Online Store but its status could not be set to ACTIVE (${appError.code}: ${appError.message}). A DRAFT product is not visible to customers, so it has been left in the review queue with the ${AUTOMATION_REVIEW_TAG} tag.`,
      {
        details: {
          shopifyProductId,
          reviewTagRemoved: false,
          stillInReviewQueue: true,
          publishedToOnlineStore: true,
        },
      },
    );
  }

  const finalState = await tryGetProductPublicationState(shopifyProductId);
  const status = finalState?.status ?? 'ACTIVE';
  const publishedToOnlineStore = finalState?.publishedToOnlineStore ?? true;
  const visibleToCustomers = finalState?.visibleToCustomers ?? false;

  if (finalState === null) {
    warnings.push(
      'The final state could not be re-read from Shopify, so visibility is unconfirmed. The review tag was left in place until it can be verified.',
    );
    // Unverified means unfinished: keep it in the queue rather than claiming a
    // clean approval.
    return {
      shopifyProductId,
      status,
      publishedToOnlineStore,
      visibleToCustomers: false,
      reviewTagRemoved: false,
      stillInReviewQueue: true,
      warnings,
    };
  }

  if (!finalState.visibleToCustomers) {
    warnings.push(
      `Shopify reports status=${finalState.status} and publishedToOnlineStore=${finalState.publishedToOnlineStore}, so the product is not visible to customers. It stays in the review queue.`,
    );
    return {
      shopifyProductId,
      status,
      publishedToOnlineStore,
      visibleToCustomers: false,
      reviewTagRemoved: false,
      stillInReviewQueue: true,
      warnings,
    };
  }

  // ---- Only now clear the gate --------------------------------------------
  let reviewTagRemoved = false;
  try {
    const removal = await shopifyGraphql<{
      tagsRemove: { userErrors: { field?: string[] | null; message?: string }[] } | null;
    }>(
      TAGS_REMOVE_MUTATION,
      { id: shopifyProductId, tags: [AUTOMATION_REVIEW_TAG, AUTOMATION_HIDDEN_TAG] },
      { operation: 'automationApproveTagsRemove' },
    );
    const removalError = mapUserErrors(removal.data.tagsRemove?.userErrors);
    if (removalError !== null) throw removalError;
    reviewTagRemoved = true;
  } catch (error) {
    const appError = toAppError(error);
    // The product IS live and correct. Failing to remove a bookkeeping tag is the
    // harmless direction: it reappears in the queue, which is confusing but not
    // damaging, and approving again is idempotent.
    logger.warn('Product is live but the review tag could not be removed.', {
      shopifyProductId,
      code: appError.code,
    });
    warnings.push(
      `The product is published and ACTIVE, but the ${AUTOMATION_REVIEW_TAG} tag could not be removed (${appError.code}: ${appError.message}), so it will still appear in the review queue. Approving it again is safe.`,
    );
  }

  logger.info('Approved product for the storefront.', {
    shopifyProductId,
    status,
    publishedToOnlineStore,
    visibleToCustomers,
    reviewTagRemoved,
  });

  return {
    shopifyProductId,
    status,
    publishedToOnlineStore,
    visibleToCustomers,
    reviewTagRemoved,
    stillInReviewQueue: !reviewTagRemoved,
    warnings,
  };
}

/** Most recent runs, newest first — the "what did automation just do?" view. */
export async function listAutomationRuns(limit: number): Promise<unknown[]> {
  if (getDatabaseStatus().status !== 'connected') {
    throw new AppError(
      'DATABASE_UNAVAILABLE',
      'Automation history requires MongoDB. Set MONGODB_URI to keep an audit trail.',
    );
  }
  return AutomationRunModel.find({ shopDomain: config.shopify.storeDomain })
    .sort({ startedAt: -1 })
    .limit(limit)
    .lean();
}
