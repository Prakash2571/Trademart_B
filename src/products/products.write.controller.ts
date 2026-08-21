/**
 * PATCH /api/shopify/products/:id            - edit an existing product
 * POST  /api/shopify/products                - create a product (DRAFT, then publish)
 * POST  /api/shopify/products/:id/publish     - publish to the Online Store
 * POST  /api/shopify/products/:id/unpublish   - remove from the Online Store
 * GET   /api/shopify/products/:id/publication - verified publication state
 *
 * Product WRITE routes. Read routes live in products.controller.ts; this is a
 * separate router mounted behind the operator WRITE guard so mutations always
 * require an operator without affecting the read router's protect-reads setting.
 *
 * The frontend never talks to Shopify directly and never holds a token - every
 * product mutation goes through here.
 *
 * PUBLICATION IS A SEPARATE, EXPLICIT ACTION. Setting `status: ACTIVE` through
 * PATCH does NOT put a product on the storefront, and this API no longer pretends
 * it does; publishing has its own route, its own scope (write_publications) and
 * its own verification.
 */

import { Router } from 'express';

import { AppError } from '../common/errors';
import { asyncHandler, sendSuccess } from '../common/http';
import { toShopifyGid } from '../common/validate';
import {
  getProductPublicationState,
  publishToOnlineStore,
  unpublishFromOnlineStore,
} from '../shopify/publication.service';
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
    // Always created as a DRAFT first. `status` expresses the DESIRED end state
    // and `publish` the storefront intent; createProduct only grants either once
    // the earlier steps have been verified.
    const request = validateProductCreate((req.body ?? {}) as Record<string, unknown>);
    const result = await createProduct(request);

    // 201 for a clean create, 207 Multi-Status when the product exists but did
    // not reach the requested end state. A partial outcome must not be reported
    // with the same status code as a complete one - the caller has work left.
    res.status(result.partialSuccess ? 207 : 201);
    sendSuccess(res, result, { partialSuccess: result.partialSuccess });
  }),
);

/**
 * Publishing is its own route because it is its own decision.
 *
 * The response reports Shopify's VERIFIED state, so a client can never conclude
 * "customers can see it" from the fact that the call returned 200.
 */
productsWriteRouter.post(
  '/products/:id/publish',
  asyncHandler(async (req, res) => {
    const productGid = toShopifyGid(req.params.id ?? '', 'Product');
    const state = await publishToOnlineStore(productGid);
    sendSuccess(res, state);
  }),
);

productsWriteRouter.post(
  '/products/:id/unpublish',
  asyncHandler(async (req, res) => {
    const productGid = toShopifyGid(req.params.id ?? '', 'Product');
    const state = await unpublishFromOnlineStore(productGid);
    sendSuccess(res, state);
  }),
);

/**
 * The authoritative "is this visible?" read.
 *
 * Deliberately NOT best-effort: this endpoint exists to answer the question
 * definitively, so a missing read_publications scope must surface as an error
 * rather than as a comfortable-looking false.
 */
productsWriteRouter.get(
  '/products/:id/publication',
  asyncHandler(async (req, res) => {
    const raw = req.params.id ?? '';
    if (raw.length === 0) {
      throw new AppError('VALIDATION_ERROR', 'A product id is required.');
    }
    const state = await getProductPublicationState(toShopifyGid(raw, 'Product'));
    sendSuccess(res, state);
  }),
);
