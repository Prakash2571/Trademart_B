/**
 * GET  /api/shopify/locations        - active locations (pick where to stock)
 * POST /api/shopify/inventory/set     - set an absolute quantity at a location
 *
 * Inventory WRITE lives in its own router, mounted behind the operator write
 * guard, so setting stock always requires an operator while the read inventory
 * router stays open by default.
 */

import { Router } from 'express';

import { asyncHandler, sendSuccess } from '../common/http';
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
  asyncHandler(async (req, res) => {
    const request = validateInventorySet((req.body ?? {}) as Record<string, unknown>);
    const result = await setInventoryQuantity(request);
    sendSuccess(res, result);
  }),
);
