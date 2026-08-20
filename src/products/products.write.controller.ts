/**
 * PATCH /api/shopify/products/:id  - edit an existing product
 * POST  /api/shopify/products      - create a product (DRAFT by default)
 *
 * Product WRITE routes. Read routes live in products.controller.ts; this is a
 * separate router mounted behind the operator WRITE guard so mutations always
 * require an operator without affecting the read router's protect-reads setting.
 *
 * The frontend never talks to Shopify directly and never holds a token - every
 * product mutation goes through here.
 */

import { Router } from 'express';

import { asyncHandler, sendSuccess } from '../common/http';
import { toShopifyGid } from '../common/validate';
import { validateProductCreate } from './product.create';
import { validateProductEdit } from './product.write';
import { createProduct } from './products.create.service';
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

productsWriteRouter.post(
  '/products',
  asyncHandler(async (req, res) => {
    // Created as DRAFT unless the body explicitly asks for ACTIVE, so a new
    // product never lands on the storefront unreviewed.
    const request = validateProductCreate((req.body ?? {}) as Record<string, unknown>);
    const result = await createProduct(request);
    res.status(201);
    sendSuccess(res, result);
  }),
);
