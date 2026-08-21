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
import { recordAudit } from '../audit/audit.service';
import { idempotent } from '../common/idempotency';

export const productsWriteRouter = Router();

productsWriteRouter.patch(
  '/products/:id',
  asyncHandler(async (req, res) => {
    const productGid = toShopifyGid(req.params.id ?? '', 'Product');
    const request = validateProductEdit((req.body ?? {}) as Record<string, unknown>);

    try {
      const result = await editProduct(productGid, request);

      // PRICE_UPDATE and PRODUCT_UPDATE are separate actions so "show me every
      // price change" is one filter rather than a search through generic edits.
      const pricedVariants = request.variants.filter((v) => v.price !== undefined);
      await recordAudit({
        action: pricedVariants.length > 0 ? 'PRICE_UPDATE' : 'PRODUCT_UPDATE',
        resourceType: 'PRODUCT',
        resourceId: productGid,
        // The expected* values ARE the before-state: they are what the operator
        // was looking at when they made the change.
        before: {
          expectedStatus: request.expectedStatus ?? null,
          variants: pricedVariants.map((v) => ({ id: v.id, price: v.expectedPrice ?? null })),
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
      // Refusals are audited too. A rejected stale write (PRODUCT_CHANGED) is
      // exactly the entry that answers "why did my change not save?".
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
    // Created as DRAFT unless the body explicitly asks for ACTIVE, so a new
    // product never lands on the storefront unreviewed.
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
        published: result.published,
        visibleToCustomers: result.visibleToCustomers,
      },
      // A partial create is recorded as a FAILURE even though a product exists:
      // the requested outcome was not reached, and that is what someone scanning
      // the audit log needs to notice.
      result: result.partialSuccess ? 'FAILURE' : 'SUCCESS',
      metadata: { warnings: result.warnings, publishError: result.publishError },
    });

    // 201 for a clean create, 207 Multi-Status when the product exists but did
    // not reach the requested end state. Reporting a partial outcome with the
    // same status code as a complete one is how a caller ends up believing a
    // half-finished product is live.
    res.status(result.partialSuccess ? 207 : 201);
    sendSuccess(res, result, { partialSuccess: result.partialSuccess });
  }),
);
