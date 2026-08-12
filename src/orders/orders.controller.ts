/**
 * GET /api/shopify/orders
 * GET /api/shopify/orders/:id
 *
 * All financial values come straight from Shopify money fields. Nothing is
 * recomputed or synthesised.
 */

import { Router } from 'express';

import { asyncHandler, sendSuccess } from '../common/http';
import { parseIntParam, parseStringParam, toShopifyGid } from '../common/validate';
import { getOrder, listOrders } from '../shopify/shopify.service';

export const ordersRouter = Router();

ordersRouter.get(
  '/orders',
  asyncHandler(async (req, res) => {
    const first = parseIntParam(req.query['limit'], 'limit', {
      min: 1,
      max: 100,
      fallback: 25,
    });
    const after = parseStringParam(req.query['cursor'], 'cursor', { maxLength: 500 });
    const query = parseStringParam(req.query['query'], 'query', { maxLength: 300 });

    const result = await listOrders({ first, after, query });
    sendSuccess(res, result.items, result.meta);
  }),
);

ordersRouter.get(
  '/orders/:id',
  asyncHandler(async (req, res) => {
    const gid = toShopifyGid(req.params.id ?? '', 'Order');
    const order = await getOrder(gid);
    sendSuccess(res, order);
  }),
);
