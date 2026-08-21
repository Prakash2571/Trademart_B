/**
 * Manual supplier-cost persistence.
 *
 * Lets an operator attach a cost/shipping figure to a Shopify product or variant
 * when no supplier API and no Shopify "cost per item" is available - so a
 * product can still be priced, with the source honestly recorded as MANUAL.
 *
 * Stored on the existing SupplierProduct document (which already has
 * `costSource: MANUAL` and a unique (shop, product, variant) index). Nothing
 * here writes to Shopify; it only records Trademart's own knowledge of cost.
 */

import { AppError } from '../common/errors';
import { logger } from '../common/logger';
import { config } from '../config';
import { getDatabaseStatus } from '../database/mongo';
import { SupplierProductModel } from '../database/models/SupplierProduct';
import type { ManualCost } from './cost';
import type { ManualCostInput } from './manualCost.validate';

function requireDatabase(): void {
  if (getDatabaseStatus().status !== 'connected') {
    throw new AppError(
      'DATABASE_UNAVAILABLE',
      'Manual costs are stored in MongoDB, which is not connected. Set MONGODB_URI and retry.',
    );
  }
}

export interface StoredManualCost {
  shopifyProductId: string;
  shopifyVariantId: string | null;
  provider: string;
  supplierProductCost: number | null;
  supplierShippingCost: number | null;
  currencyCode: string | null;
  costSource: string;
  note: string | null;
  updatedAt: string | null;
}

/** Lists stored manual costs, optionally scoped to one product. */
export async function listManualCosts(
  shopifyProductId?: string,
): Promise<StoredManualCost[]> {
  requireDatabase();
  const filter: Record<string, unknown> = {
    shopDomain: config.shopify.storeDomain,
    costSource: 'MANUAL',
  };
  if (shopifyProductId !== undefined) filter['shopifyProductId'] = shopifyProductId;

  const rows = await SupplierProductModel.find(filter).sort({ updatedAt: -1 }).lean();
  return rows.map((row) => ({
    shopifyProductId: row.shopifyProductId,
    shopifyVariantId: row.shopifyVariantId ?? null,
    provider: row.provider,
    supplierProductCost: row.supplierProductCost ?? null,
    supplierShippingCost: row.supplierShippingCost ?? null,
    currencyCode: row.currencyCode ?? null,
    costSource: row.costSource,
    note: (row as { note?: string | null }).note ?? null,
    updatedAt:
      (row as { updatedAt?: Date }).updatedAt instanceof Date
        ? (row as { updatedAt: Date }).updatedAt.toISOString()
        : null,
  }));
}

/**
 * Reads one stored manual cost, or null.
 *
 * Exists so a write can record what the value WAS before changing it. A manual
 * cost is a hand-entered number that exists nowhere else - not in Shopify, not
 * with the supplier - so without a `before` value an audit entry cannot make the
 * change reversible.
 *
 * Returns null rather than throwing when there is no database: the caller is
 * about to fail on its own write anyway, and an audit lookup must never be the
 * thing that reports the problem.
 */
export async function findManualCost(
  shopifyProductId: string,
  shopifyVariantId: string | null,
): Promise<StoredManualCost | null> {
  if (getDatabaseStatus().status !== 'connected') return null;

  const row = await SupplierProductModel.findOne({
    shopDomain: config.shopify.storeDomain,
    shopifyProductId,
    shopifyVariantId,
    costSource: 'MANUAL',
  }).lean();

  if (row === null || row === undefined) return null;

  return {
    shopifyProductId: row.shopifyProductId,
    shopifyVariantId: row.shopifyVariantId ?? null,
    provider: row.provider,
    supplierProductCost: row.supplierProductCost ?? null,
    supplierShippingCost: row.supplierShippingCost ?? null,
    currencyCode: row.currencyCode ?? null,
    costSource: row.costSource,
    note: (row as { note?: string | null }).note ?? null,
    updatedAt:
      (row as { updatedAt?: Date }).updatedAt instanceof Date
        ? (row as { updatedAt: Date }).updatedAt.toISOString()
        : null,
  };
}

/** Creates or updates the manual cost for a product/variant. */
export async function upsertManualCost(input: ManualCostInput): Promise<StoredManualCost> {
  requireDatabase();

  const key = {
    shopDomain: config.shopify.storeDomain,
    shopifyProductId: input.shopifyProductId,
    shopifyVariantId: input.shopifyVariantId,
  };

  await SupplierProductModel.updateOne(
    key,
    {
      $set: {
        ...key,
        provider: input.provider,
        supplierProductCost: input.supplierProductCost,
        supplierShippingCost: input.supplierShippingCost,
        currencyCode: input.currencyCode,
        // Recording the source is the whole point - a later reader must know
        // this was hand-entered, not fetched.
        costSource: 'MANUAL',
        note: input.note,
        manualOverride: input.override,
        lastVerifiedAt: new Date(),
      },
    },
    { upsert: true },
  );

  logger.info('Stored manual supplier cost.', {
    shopifyProductId: input.shopifyProductId,
    shopifyVariantId: input.shopifyVariantId,
    override: input.override,
  });

  const [stored] = await listManualCosts(input.shopifyProductId);
  // updateOne + re-read keeps one code path for the returned shape.
  return (
    stored ?? {
      shopifyProductId: input.shopifyProductId,
      shopifyVariantId: input.shopifyVariantId,
      provider: input.provider,
      supplierProductCost: input.supplierProductCost,
      supplierShippingCost: input.supplierShippingCost,
      currencyCode: input.currencyCode,
      costSource: 'MANUAL',
      note: input.note,
      updatedAt: new Date().toISOString(),
    }
  );
}

/** Removes a manual cost. Returns whether a row was deleted. */
export async function deleteManualCost(
  shopifyProductId: string,
  shopifyVariantId: string | null,
): Promise<boolean> {
  requireDatabase();
  const result = await SupplierProductModel.deleteOne({
    shopDomain: config.shopify.storeDomain,
    shopifyProductId,
    shopifyVariantId,
    costSource: 'MANUAL',
  });
  return result.deletedCount > 0;
}

/**
 * Loads manual costs for a set of products as a map keyed by variant GID, for
 * the automation engine to consume. A product-level manual cost (variant null)
 * applies to every variant of that product that has no variant-specific entry.
 *
 * Returns an empty map when the database is unavailable, so automation degrades
 * to Shopify's cost per item rather than failing.
 */
export async function loadManualCostMap(
  products: readonly { shopifyProductId: string; variantIds: string[] }[],
): Promise<Map<string, ManualCost>> {
  const map = new Map<string, ManualCost>();
  if (getDatabaseStatus().status !== 'connected' || products.length === 0) return map;

  const productIds = products.map((p) => p.shopifyProductId);
  const rows = await SupplierProductModel.find({
    shopDomain: config.shopify.storeDomain,
    costSource: 'MANUAL',
    shopifyProductId: { $in: productIds },
  }).lean();

  // Index by product, splitting variant-specific from product-level entries.
  const productLevel = new Map<string, ManualCost>();
  const variantLevel = new Map<string, ManualCost>();
  for (const row of rows) {
    if (row.supplierProductCost === null || row.currencyCode === null) continue;
    const cost: ManualCost = {
      amount: row.supplierProductCost,
      currencyCode: row.currencyCode,
      updatedAt:
        (row as { updatedAt?: Date }).updatedAt instanceof Date
          ? (row as { updatedAt: Date }).updatedAt.toISOString()
          : null,
      override: (row as { manualOverride?: boolean }).manualOverride === true,
    };
    if (row.shopifyVariantId) variantLevel.set(row.shopifyVariantId, cost);
    else productLevel.set(row.shopifyProductId, cost);
  }

  for (const product of products) {
    const fallback = productLevel.get(product.shopifyProductId);
    for (const variantId of product.variantIds) {
      const specific = variantLevel.get(variantId);
      const chosen = specific ?? fallback;
      if (chosen !== undefined) map.set(variantId, chosen);
    }
  }

  return map;
}
