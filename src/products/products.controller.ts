/**
 * GET /api/shopify/products
 * GET /api/shopify/products/:id
 *
 * Read-only. No bulk edit / price-write operations are exposed in this
 * milestone by design.
 */

import { Router } from 'express';

import { asyncHandler, sendSuccess } from '../common/http';
import { parseIntParam, parseStringParam, toShopifyGid } from '../common/validate';
import { getProduct, listProducts } from '../shopify/shopify.service';

export const productsRouter = Router();

productsRouter.get(
  '/products',
  asyncHandler(async (req, res) => {
    const first = parseIntParam(req.query['limit'], 'limit', {
      min: 1,
      max: 100,
      fallback: 25,
    });
    const after = parseStringParam(req.query['cursor'], 'cursor', { maxLength: 500 });
    // Shopify search syntax, e.g. status:active vendor:Tradelle
    const query = parseStringParam(req.query['query'], 'query', { maxLength: 300 });

    const result = await listProducts({ first, after, query });
    sendSuccess(res, result.items, result.meta);
  }),
);

productsRouter.get(
  '/products/:id',
  asyncHandler(async (req, res) => {
    const gid = toShopifyGid(req.params.id ?? '', 'Product');
    const product = await getProduct(gid);
    sendSuccess(res, product);
  }),
);
