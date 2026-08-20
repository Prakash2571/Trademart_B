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
import {
  getProductPublications,
  publishProduct,
} from '../shopify/publications/publications.service';
import { getProduct, listProducts } from '../shopify/shopify.service';
import type { ProductDto } from '../shopify/shopify.types';
import { loadManualCostMap } from '../suppliers/manualCost.service';
import { buildAutomationPlan, type AutomationPlan, type PriceAction } from './plan';
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
 * Builds and optionally applies an automation plan.
 *
 * Preview (`dryRun: true`) works regardless of the kill switch; applying does not.
 */
export async function runAutomation(options: RunOptions): Promise<AutomationReport> {
  const rules = await resolveEffectiveRules(options.rules);
  const problems = validateAutomationRules(rules);
  if (problems.length > 0) {
    throw new AppError('AUTOMATION_RULES_INVALID', 'Automation rules are invalid.', {
      details: { problems },
    });
  }

  if (!options.dryRun && !isAutomationEnabled()) {
    throw new AppError(
      'AUTOMATION_DISABLED',
      'Storefront writes are disabled. Set AUTOMATION_ENABLED=true to allow Trademart to change prices and product visibility, or use POST /api/automation/preview to see what it would do.',
    );
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
  });

  logger.info(options.dryRun ? 'Automation preview complete.' : 'Automation run complete.', {
    dryRun: options.dryRun,
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
  };
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

/**
 * Structured result of an approval, so the UI can tell activation from
 * publication. These are two distinct Shopify operations and either can fail
 * independently: a product can be ACTIVE (draft flag cleared) yet still not
 * visible because it was never published to a sales channel.
 */
export interface ApproveResult {
  shopifyProductId: string;
  /** Review/auto-hidden tags removed and status set ACTIVE. */
  activated: boolean;
  tagsRemoved: string[];
  /** Whether publication to a sales channel succeeded. */
  published: boolean;
  /** Channels the product is currently published on (best-effort read-back). */
  publications: { publicationId: string; name: string; isPublished: boolean }[];
  /** Set when activation succeeded but publication did not. */
  publishError: string | null;
}

/**
 * Approves a held product: clears the review and auto-hidden tags, sets it
 * ACTIVE, and publishes it to the Online Store.
 *
 * Activation and publication are reported separately. If activation succeeds
 * but publication fails (e.g. write_publications not granted), the product is
 * ACTIVE-but-not-visible and the result says so - it does NOT pretend the whole
 * operation succeeded, and it does not roll back the activation (no rollback is
 * implemented; the operator can retry publish or unpublish deliberately).
 */
export async function approveProduct(shopifyProductId: string): Promise<ApproveResult> {
  if (!isAutomationEnabled()) {
    throw new AppError(
      'AUTOMATION_DISABLED',
      'Storefront writes are disabled, so a product cannot be published. Set AUTOMATION_ENABLED=true.',
    );
  }

  const tagsToRemove = [AUTOMATION_REVIEW_TAG, AUTOMATION_HIDDEN_TAG];
  const removal = await shopifyGraphql<{
    tagsRemove: { userErrors: { field?: string[] | null; message?: string }[] } | null;
  }>(
    TAGS_REMOVE_MUTATION,
    { id: shopifyProductId, tags: tagsToRemove },
    { operation: 'automationApproveTagsRemove' },
  );
  const removalError = mapUserErrors(removal.data.tagsRemove?.userErrors);
  if (removalError !== null) throw removalError;

  // applyVisibility also strips the auto-hidden tag; harmless and idempotent.
  await applyVisibility(shopifyProductId, 'ACTIVE');

  // Publish to the Online Store. ACTIVE alone does not make a product visible.
  let published = false;
  let publishError: string | null = null;
  let publications: ApproveResult['publications'] = [];
  try {
    const result = await publishProduct(shopifyProductId);
    published = true;
    publications = result.state.map((entry) => ({
      publicationId: entry.publicationId,
      name: entry.name,
      isPublished: entry.isPublished,
    }));
  } catch (error) {
    // Activation already happened; report the publication failure honestly
    // rather than throwing away the fact that the product is now ACTIVE.
    publishError = error instanceof AppError ? `${error.code}: ${error.message}` : 'Publication failed.';
    try {
      publications = await getProductPublications(shopifyProductId);
    } catch {
      publications = [];
    }
  }

  logger.info('Approved product for the storefront.', {
    shopifyProductId,
    published,
    publishError,
  });

  return {
    shopifyProductId,
    activated: true,
    tagsRemoved: tagsToRemove,
    published,
    publications,
    publishError,
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
