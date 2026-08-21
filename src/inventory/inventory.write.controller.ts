/**
 * GET  /api/shopify/locations        - active locations (pick where to stock)
 * POST /api/shopify/inventory/set     - set an absolute quantity at a location
 *
 * Inventory WRITE lives in its own router, mounted behind the operator write
 * guard, so setting stock always requires an operator while the read inventory
 * router stays open by default.
 */

import { Router } from 'express';

import { recordAudit } from '../audit/audit.service';
import { asyncHandler, sendSuccess } from '../common/http';
import { idempotent } from '../common/idempotency';
import { config } from '../config';
import {
  listLocations,
  setInventoryQuantity,
} from './inventory.write.service';
import { validateInventorySet } from './inventory.write';

export const inventoryWriteRouter = Router();

inventoryWriteRouter.get(
  '/locations',
  asyncHandler(async (_req, res) => {
    const locations = await listLocations();
    sendSuccess(res, { locations }, { count: locations.length });
  }),
);

inventoryWriteRouter.post(
  '/inventory/set',
  // A retried stock write is not naturally safe from the client's point of view:
  // it sets an ABSOLUTE value, so a duplicate that lands after another change
  // would silently undo that change. Replaying the original response is safer.
  idempotent('POST /api/shopify/inventory/set'),
  asyncHandler(async (req, res) => {
    const request = validateInventorySet((req.body ?? {}) as Record<string, unknown>);

    try {
      const result = await setInventoryQuantity(request);

      await recordAudit({
        action: 'INVENTORY_UPDATE',
        resourceType: 'INVENTORY',
        // Keyed by variant where known, so a product's stock history is findable
        // from the product page rather than only by inventory item id.
        resourceId: result.shopifyVariantId ?? result.inventoryItemId,
        before: { quantity: result.quantityBefore },
        after: { quantity: result.quantityAfter },
        metadata: {
          inventoryItemId: result.inventoryItemId,
          locationId: result.locationId,
          locationName: result.locationName,
          quantityName: result.name,
          delta: result.delta,
          largeChangeConfirmed: result.largeChangeConfirmed,
          maxInventoryDelta: config.maxInventoryDelta,
          sku: result.sku,
          shopifyProductId: result.shopifyProductId,
        },
      });

      sendSuccess(res, result);
    } catch (error) {
      // A refused change is worth recording: a blocked oversized adjustment or a
      // rejected stale write is what explains "my stock update did not save".
      await recordAudit({
        action: 'INVENTORY_UPDATE',
        resourceType: 'INVENTORY',
        resourceId: request.inventoryItemId,
        after: { quantity: request.quantity },
        metadata: {
          inventoryItemId: request.inventoryItemId,
          locationId: request.locationId,
          quantityName: request.name,
          expectedQuantity: request.expectedQuantity ?? null,
          confirmLargeChange: request.confirmLargeChange,
        },
        result: 'FAILURE',
        error,
      });
      throw error;
    }
  }),
);
