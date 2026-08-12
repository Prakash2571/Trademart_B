/**
 * GET /api/shopify/inventory
 *
 * Read-only. Inventory writes (adjustments, activation) are intentionally not
 * implemented in this milestone.
 */

import { Router } from 'express';

import { asyncHandler, sendSuccess } from '../common/http';
import { parseIntParam, parseStringParam } from '../common/validate';
import { listInventory } from '../shopify/shopify.service';

export const inventoryRouter = Router();

inventoryRouter.get(
  '/inventory',
  asyncHandler(async (req, res) => {
    const first = parseIntParam(req.query['limit'], 'limit', {
      min: 1,
      max: 100,
      fallback: 25,
    });
    const after = parseStringParam(req.query['cursor'], 'cursor', { maxLength: 500 });
    const query = parseStringParam(req.query['query'], 'query', { maxLength: 300 });

    const result = await listInventory({ first, after, query });
    sendSuccess(res, result.items, result.meta);
  }),
);
