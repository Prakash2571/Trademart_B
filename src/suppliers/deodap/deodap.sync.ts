/**
 * Updating recorded DeoDap costs from a newer price list - pure.
 *
 * DeoDap changes its prices. When it does, every margin Trademart shows for a DeoDap
 * product is wrong until the recorded cost is updated. This plans that update from a
 * newly uploaded DeoDap file:
 *
 *   1. Each product Trademart imported from DeoDap (the import ledger) is looked up in
 *      the file by its supplier reference, then each of its variants by SKU, option
 *      values, or - for a single-variant product - the only row there is. A variant
 *      whose product moved to a different reference is still found by its SKU.
 *   2. The new cost is compared with the cost recorded now.
 *
 * Only Trademart's recorded supplier cost changes. The Shopify selling price does not:
 * whether to reprice is the operator's decision, and the pricing and automation pages
 * already use the updated cost.
 *
 * A file with no shipping column keeps the recorded shipping as it is. Unknown is not
 * the same as free.
 */

import { AppError } from '../../common/errors';
import { assertMoney, moneyEquals, roundMoney, subtractMoney } from '../../common/money';
import { toShopifyGid } from '../../common/validate';
import { refKeyOf, type CatalogProduct, type CatalogVariant } from './deodap.catalog';
import { validateCurrencyCode } from './deodap.settings';

export interface LedgerVariantRef {
  shopifyVariantId: string;
  sku: string | null;
  optionValues: string[];
}

export interface LedgerProductRef {
  supplierRef: string;
  title: string;
  shopifyProductId: string;
  variants: LedgerVariantRef[];
}

/** The cost Trademart has recorded for a variant now. */
export interface StoredCost {
  amount: number;
  shippingCost: number | null;
  currencyCode: string | null;
}

export type SyncChangeKind = 'COST_CHANGED' | 'UNCHANGED' | 'NO_COST_IN_FILE';

export interface SyncChange {
  supplierRef: string;
  title: string;
  shopifyProductId: string;
  shopifyVariantId: string;
  sku: string | null;
  line: number;
  currentCost: number | null;
  currentShipping: number | null;
  currentCurrency: string | null;
  newCost: number | null;
  newShipping: number | null;
  /** Percentage change in the product cost. Null when there is nothing to compare. */
  changePercent: number | null;
  kind: SyncChangeKind;
  stock: number | null;
  inStock: boolean | null;
}

export interface SyncPlan {
  currencyCode: string;
  changes: SyncChange[];
  /** Products in the file that match nothing imported from DeoDap. */
  unmatched: { line: number; ref: string | null; title: string | null }[];
  /** Imported DeoDap products the file does not mention. */
  missing: { supplierRef: string; title: string; shopifyProductId: string }[];
  summary: {
    changed: number;
    unchanged: number;
    noCost: number;
    unmatched: number;
    missing: number;
    outOfStock: number;
  };
}

function skuKey(sku: string | null): string | null {
  const key = (sku ?? '').trim().toLowerCase();
  return key.length > 0 ? key : null;
}

function sameOptions(a: readonly string[], b: readonly string[]): boolean {
  return (
    a.length > 0 &&
    a.length === b.length &&
    a.every((value, index) => value.toLowerCase() === (b[index] ?? '').toLowerCase())
  );
}

function findVariant(
  product: CatalogProduct,
  wanted: LedgerVariantRef,
  ledgerVariantCount: number,
): CatalogVariant | null {
  const wantedSku = skuKey(wanted.sku);
  if (wantedSku !== null) {
    const bySku = product.variants.find((variant) => skuKey(variant.sku) === wantedSku);
    if (bySku !== undefined) return bySku;
  }
  const byOptions = product.variants.find((variant) =>
    sameOptions(variant.optionValues, wanted.optionValues),
  );
  if (byOptions !== undefined) return byOptions;
  if (product.variants.length === 1 && ledgerVariantCount === 1) return product.variants[0] ?? null;
  return null;
}

function nullableEqual(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return a === b;
  return moneyEquals(a, b);
}

function describeChange(
  ledger: LedgerProductRef,
  ledgerVariant: LedgerVariantRef,
  variant: CatalogVariant,
  stored: StoredCost | null,
  currencyCode: string,
): SyncChange {
  const newCost = variant.cost;
  // No shipping in the file means keep what is recorded. Zero means free, which a
  // manual cost stores as "not recorded" (manualCost.validate.ts never stores 0).
  const newShipping =
    variant.shippingCost === null
      ? (stored?.shippingCost ?? null)
      : variant.shippingCost > 0
        ? variant.shippingCost
        : null;

  const sameCurrency = stored !== null && stored.currencyCode === currencyCode;
  let kind: SyncChangeKind;
  if (newCost === null) kind = 'NO_COST_IN_FILE';
  else if (
    sameCurrency &&
    stored !== null &&
    moneyEquals(stored.amount, newCost) &&
    nullableEqual(stored.shippingCost, newShipping)
  ) {
    kind = 'UNCHANGED';
  } else kind = 'COST_CHANGED';

  const changePercent =
    newCost !== null && sameCurrency && stored !== null && stored.amount > 0
      ? Math.round((subtractMoney(newCost, stored.amount) / stored.amount) * 1000) / 10
      : null;

  return {
    supplierRef: ledger.supplierRef,
    title: ledger.title,
    shopifyProductId: ledger.shopifyProductId,
    shopifyVariantId: ledgerVariant.shopifyVariantId,
    sku: ledgerVariant.sku ?? variant.sku,
    line: variant.line,
    currentCost: stored?.amount ?? null,
    currentShipping: stored?.shippingCost ?? null,
    currentCurrency: stored?.currencyCode ?? null,
    newCost,
    newShipping,
    changePercent,
    kind,
    stock: variant.stock,
    inStock: variant.inStock,
  };
}

/** Matches a price list against what was imported and says what would change. */
export function planCostSync(
  catalog: readonly CatalogProduct[],
  ledger: readonly LedgerProductRef[],
  storedCosts: ReadonlyMap<string, StoredCost>,
  currencyCode: string,
): SyncPlan {
  const byRef = new Map<string, CatalogProduct>();
  const bySku = new Map<string, { product: CatalogProduct; variant: CatalogVariant }>();
  for (const product of catalog) {
    if (product.ref !== null) {
      const key = refKeyOf(product.ref);
      if (!byRef.has(key)) byRef.set(key, product);
    }
    for (const variant of product.variants) {
      const key = skuKey(variant.sku);
      if (key !== null && !bySku.has(key)) bySku.set(key, { product, variant });
    }
  }

  const matchedProducts = new Set<CatalogProduct>();
  const changes: SyncChange[] = [];
  const missing: SyncPlan['missing'] = [];

  for (const entry of ledger) {
    const product = byRef.get(refKeyOf(entry.supplierRef)) ?? null;
    let found = false;
    for (const ledgerVariant of entry.variants) {
      let variant: CatalogVariant | null = null;
      let source: CatalogProduct | null = null;
      if (product !== null) {
        variant = findVariant(product, ledgerVariant, entry.variants.length);
        if (variant !== null) source = product;
      }
      if (variant === null) {
        const key = skuKey(ledgerVariant.sku);
        const hit = key === null ? undefined : bySku.get(key);
        if (hit !== undefined) {
          variant = hit.variant;
          source = hit.product;
        }
      }
      if (variant === null || source === null) continue;
      found = true;
      matchedProducts.add(source);
      changes.push(
        describeChange(
          entry,
          ledgerVariant,
          variant,
          storedCosts.get(ledgerVariant.shopifyVariantId) ?? null,
          currencyCode,
        ),
      );
    }
    if (!found) {
      missing.push({
        supplierRef: entry.supplierRef,
        title: entry.title,
        shopifyProductId: entry.shopifyProductId,
      });
    }
  }

  const unmatched = catalog
    .filter((product) => !matchedProducts.has(product))
    .map((product) => ({ line: product.lines[0] ?? 0, ref: product.ref, title: product.title }));

  return {
    currencyCode,
    changes,
    unmatched,
    missing,
    summary: {
      changed: changes.filter((change) => change.kind === 'COST_CHANGED').length,
      unchanged: changes.filter((change) => change.kind === 'UNCHANGED').length,
      noCost: changes.filter((change) => change.kind === 'NO_COST_IN_FILE').length,
      unmatched: unmatched.length,
      missing: missing.length,
      outOfStock: changes.filter((change) => change.inStock === false).length,
    },
  };
}

/* ===========================================================================
 * Applying
 * ======================================================================== */

export const MAX_SYNC_UPDATES = 200;

export interface SyncUpdate {
  shopifyVariantId: string;
  cost: number;
  /** Null records no shipping. Zero is stored as null, like any manual cost. */
  shippingCost: number | null;
}

export interface SyncRequest {
  updates: SyncUpdate[];
  currencyCode: string;
}

function fail(message: string): never {
  throw new AppError('VALIDATION_ERROR', message);
}

export function validateSyncRequest(body: Record<string, unknown>): SyncRequest {
  const rawUpdates = body['updates'];
  if (!Array.isArray(rawUpdates) || rawUpdates.length === 0) {
    fail('updates must be a non-empty list of cost changes from the preview.');
  }
  if (rawUpdates.length > MAX_SYNC_UPDATES) {
    fail(`At most ${MAX_SYNC_UPDATES} costs can be updated per request.`);
  }
  const currencyCode = validateCurrencyCode(body['currencyCode']);

  const seen = new Set<string>();
  const updates = rawUpdates.map((raw: unknown, index) => {
    const label = `Update ${index + 1}`;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) fail(`${label} must be an object.`);
    const entry = raw as Record<string, unknown>;

    const rawVariant = entry['shopifyVariantId'];
    if (typeof rawVariant !== 'string') fail(`${label} needs a shopifyVariantId.`);
    const shopifyVariantId = toShopifyGid(rawVariant, 'ProductVariant');
    if (seen.has(shopifyVariantId)) fail(`${label} repeats variant ${shopifyVariantId}.`);
    seen.add(shopifyVariantId);

    const rawCost = entry['cost'];
    if (typeof rawCost !== 'number') fail(`${label} cost must be a number.`);
    const cost = roundMoney(assertMoney(rawCost, `${label} cost`));
    if (cost <= 0) fail(`${label} cost must be greater than 0. A cost is never recorded as zero.`);

    const rawShipping = entry['shippingCost'];
    let shippingCost: number | null = null;
    if (rawShipping !== undefined && rawShipping !== null) {
      if (typeof rawShipping !== 'number') fail(`${label} shippingCost must be a number.`);
      const value = roundMoney(assertMoney(rawShipping, `${label} shippingCost`));
      if (value < 0) fail(`${label} shippingCost cannot be negative.`);
      shippingCost = value > 0 ? value : null;
    }

    return { shopifyVariantId, cost, shippingCost };
  });

  return { updates, currencyCode };
}
