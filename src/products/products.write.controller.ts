/**
 * PATCH /api/shopify/products/:id
 *
 * The first product-EDIT endpoint. Read routes live in products.controller.ts;
 * this is a separate router so it can be mounted behind the operator WRITE guard
 * without affecting the read router's protect-reads behaviour.
 *
 * The frontend never talks to Shopify directly and never holds a token - every
 * product mutation goes through here.
 */

import { Router } from 'express';

import { asyncHandler, sendSuccess } from '../common/http';
import { toShopifyGid } from '../common/validate';
import { validateProductEdit } from './product.write';
import { editProduct } from './products.write.service';

export const productsWriteRouter = Router();

productsWriteRouter.patch(
  '/products/:id',
  asyncHandler(async (req, res) => {
    const productGid = toShopifyGid(req.params.id ?? '', 'Product');
    const request = validateProductEdit((req.body ?? {}) as Record<string, unknown>);
    const result = await editProduct(productGid, request);
    sendSuccess(res, result);
  }),
);
