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

import { recordAudit } from '../audit/audit.service';
import { AppError } from '../common/errors';
import { idempotent } from '../common/idempotency';
import { asyncHandler, sendSuccess } from '../common/http';
import { toShopifyGid } from '../common/validate';
import {
  getProductPublicationState,
  publishToOnlineStore,
  tryGetProductPublicationState,
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

    try {
      const result = await editProduct(productGid, request);

      // PRICE_UPDATE and PRODUCT_UPDATE are separate actions so "show me every
      // price change" is a single filter rather than a search through edits.
      const changedPrices = request.variants.filter((v) => v.price !== undefined);
      await recordAudit({
        action: changedPrices.length > 0 ? 'PRICE_UPDATE' : 'PRODUCT_UPDATE',
        resourceType: 'PRODUCT',
        resourceId: productGid,
        // The request IS the before/after pair here: expectedPrice/expectedStatus
        // are what the operator saw, and the new values are what they asked for.
        before: {
          expectedStatus: request.expectedStatus ?? null,
          variants: changedPrices.map((v) => ({
            id: v.id,
            price: v.expectedPrice ?? null,
          })),
        },
        after: {
          fields: request.fields,
          addTags: request.addTags,
          removeTags: request.removeTags,
          variants: request.variants.map((v) => ({
            id: v.id,
            price: v.price ?? null,
            compareAtPrice: v.compareAtPrice ?? null,
          })),
        },
        metadata: { applied: result.applied },
      });

      sendSuccess(res, result);
    } catch (error) {
      // Refusals are audited too. A blocked stale write is exactly the entry an
      // operator needs when reconstructing "why did my change not save?".
      await recordAudit({
        action: 'PRODUCT_UPDATE',
        resourceType: 'PRODUCT',
        resourceId: productGid,
        after: { fields: request.fields, variants: request.variants },
        result: 'FAILURE',
        error,
      });
      throw error;
    }
  }),
);

productsWriteRouter.post(
  '/products',
  // Creating a product is the clearest case for idempotency: a lost response
  // followed by a client retry would otherwise leave two products in the store.
  idempotent('POST /api/shopify/products'),
  asyncHandler(async (req, res) => {
    // Always created as a DRAFT first. `status` expresses the DESIRED end state
    // and `publish` the storefront intent; createProduct only grants either once
    // the earlier steps have been verified.
    const request = validateProductCreate((req.body ?? {}) as Record<string, unknown>);
    const result = await createProduct(request);

    await recordAudit({
      action: 'PRODUCT_CREATE',
      resourceType: 'PRODUCT',
      resourceId: result.shopifyProductId,
      before: null,
      after: {
        title: result.title,
        status: result.status,
        desiredStatus: result.desiredStatus,
        variantsCreated: result.variantsCreated,
        publishedToOnlineStore: result.publication.published,
        visibleToCustomers: result.visibleToCustomers,
      },
      // A partial create is recorded as a FAILURE even though a product exists:
      // the requested outcome was not reached, and that is what an operator
      // scanning the audit log needs to notice.
      result: result.partialSuccess ? 'FAILURE' : 'SUCCESS',
      metadata: { warnings: result.warnings },
    });

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
  idempotent('POST /api/shopify/products/:id/publish'),
  asyncHandler(async (req, res) => {
    const productGid = toShopifyGid(req.params.id ?? '', 'Product');

    // The prior state is read for the audit entry, so an unexpected publication
    // can be undone with confidence about what it was before.
    const before = await tryGetProductPublicationState(productGid);
    try {
      const state = await publishToOnlineStore(productGid);
      await recordAudit({
        action: 'PRODUCT_PUBLISH',
        resourceType: 'PRODUCT',
        resourceId: productGid,
        before: before === null ? null : {
          status: before.status,
          publishedToOnlineStore: before.publishedToOnlineStore,
        },
        after: {
          status: state.status,
          publishedToOnlineStore: state.publishedToOnlineStore,
          visibleToCustomers: state.visibleToCustomers,
        },
        metadata: { publicationId: state.publicationId },
      });
      sendSuccess(res, state);
    } catch (error) {
      await recordAudit({
        action: 'PRODUCT_PUBLISH',
        resourceType: 'PRODUCT',
        resourceId: productGid,
        before: before === null ? null : { publishedToOnlineStore: before.publishedToOnlineStore },
        result: 'FAILURE',
        error,
      });
      throw error;
    }
  }),
);

productsWriteRouter.post(
  '/products/:id/unpublish',
  idempotent('POST /api/shopify/products/:id/unpublish'),
  asyncHandler(async (req, res) => {
    const productGid = toShopifyGid(req.params.id ?? '', 'Product');
    const before = await tryGetProductPublicationState(productGid);
    try {
      const state = await unpublishFromOnlineStore(productGid);
      await recordAudit({
        action: 'PRODUCT_UNPUBLISH',
        resourceType: 'PRODUCT',
        resourceId: productGid,
        before: before === null ? null : {
          status: before.status,
          publishedToOnlineStore: before.publishedToOnlineStore,
        },
        after: {
          status: state.status,
          publishedToOnlineStore: state.publishedToOnlineStore,
          visibleToCustomers: state.visibleToCustomers,
        },
      });
      sendSuccess(res, state);
    } catch (error) {
      await recordAudit({
        action: 'PRODUCT_UNPUBLISH',
        resourceType: 'PRODUCT',
        resourceId: productGid,
        result: 'FAILURE',
        error,
      });
      throw error;
    }
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
