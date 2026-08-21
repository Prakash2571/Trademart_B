/**
 * Manual supplier-cost routes.
 *
 * GET    /api/costs?productId=<gid>   - list stored manual costs
 * PUT    /api/costs                   - create/update a manual cost
 * DELETE /api/costs?productId=&variantId=  - remove one
 *
 * Writes are protected by the operator middleware (mounted in app.ts). Nothing
 * here touches Shopify - it records Trademart's own knowledge of supplier cost,
 * which the pricing/automation engine then uses via the cost-source hierarchy.
 *
 * DELETE takes its ids from the query string rather than the path, because a
 * Shopify GID contains slashes and would not fit a path segment.
 */

import { Router } from 'express';

import { AppError } from '../common/errors';
import { asyncHandler, sendSuccess } from '../common/http';
import { parseStringParam, toShopifyGid } from '../common/validate';
import { recordAudit } from '../audit/audit.service';
import {
  deleteManualCost,
  findManualCost,
  listManualCosts,
  upsertManualCost,
} from './manualCost.service';
import { validateManualCostInput } from './manualCost.validate';

export const manualCostRouter = Router();

manualCostRouter.get(
  '/costs',
  asyncHandler(async (req, res) => {
    const productRaw = parseStringParam(req.query['productId'], 'productId', {
      maxLength: 255,
    });
    const productId =
      productRaw === undefined ? undefined : toShopifyGid(productRaw, 'Product');
    const costs = await listManualCosts(productId);
    sendSuccess(res, { costs }, { count: costs.length });
  }),
);

manualCostRouter.put(
  '/costs',
  asyncHandler(async (req, res) => {
    const input = validateManualCostInput((req.body ?? {}) as Record<string, unknown>);

    // Read the existing row FIRST so the audit entry can record what the cost
    // was. A manual cost is hand-entered and exists nowhere else, so "it used to
    // be 4.20" has to survive somebody changing it.
    const previous = await findManualCost(input.shopifyProductId, input.shopifyVariantId);
    const stored = await upsertManualCost(input);

    await recordAudit({
      action: 'COST_UPDATE',
      resourceType: 'COST',
      resourceId: input.shopifyVariantId ?? input.shopifyProductId,
      before: previous,
      after: stored,
      metadata: {
        shopifyProductId: input.shopifyProductId,
        shopifyVariantId: input.shopifyVariantId,
        created: previous === null,
      },
    });

    sendSuccess(res, stored);
  }),
);

manualCostRouter.delete(
  '/costs',
  asyncHandler(async (req, res) => {
    const productRaw = parseStringParam(req.query['productId'], 'productId', {
      maxLength: 255,
    });
    if (productRaw === undefined) {
      throw new AppError('VALIDATION_ERROR', 'productId query parameter is required.');
    }
    const shopifyProductId = toShopifyGid(productRaw, 'Product');

    const variantRaw = parseStringParam(req.query['variantId'], 'variantId', {
      maxLength: 255,
    });
    const shopifyVariantId =
      variantRaw === undefined ? null : toShopifyGid(variantRaw, 'ProductVariant');

    // Captured before deletion - afterwards there is nothing left to record.
    const previous = await findManualCost(shopifyProductId, shopifyVariantId);
    const deleted = await deleteManualCost(shopifyProductId, shopifyVariantId);

    await recordAudit({
      action: 'COST_DELETE',
      resourceType: 'COST',
      resourceId: shopifyVariantId ?? shopifyProductId,
      before: previous,
      after: null,
      metadata: { shopifyProductId, shopifyVariantId, deleted },
    });

    sendSuccess(res, { deleted });
  }),
);
