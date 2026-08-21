/**
 * Publication (sales-channel) routes.
 *
 * Reads (list channels, read a product's publication state) and writes
 * (publish/unpublish) are two routers so app.ts can guard them differently:
 * reads behind requireOperatorForReads, writes behind requireOperatorForWrites -
 * the same split the product read/write routers use.
 *
 *   GET  /api/shopify/publications                    - list sales channels
 *   GET  /api/shopify/products/:id/publications        - a product's channels
 *   POST /api/shopify/products/:id/publish             - publish (Online Store default)
 *   POST /api/shopify/products/:id/unpublish           - unpublish
 */

import { Router } from 'express';

import { recordAudit } from '../../audit/audit.service';
import { AppError } from '../../common/errors';
import { asyncHandler, sendSuccess } from '../../common/http';
import { toShopifyGid } from '../../common/validate';
import {
  getProductVisibility,
  listPublications,
  publishProduct,
  unpublishProduct,
} from './publications.service';

export const publicationsRouter = Router();
export const publicationsWriteRouter = Router();

/** Optional array of publication GIDs from a request body. */
function readPublicationIds(body: Record<string, unknown>): string[] | undefined {
  const raw = body['publicationIds'];
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw) || raw.some((id) => typeof id !== 'string')) {
    throw new AppError('VALIDATION_ERROR', 'publicationIds must be an array of publication GID strings.');
  }
  const ids = (raw as string[]).map((id) => id.trim()).filter((id) => id.length > 0);
  return ids.length > 0 ? ids : undefined;
}

publicationsRouter.get(
  '/publications',
  asyncHandler(async (_req, res) => {
    const publications = await listPublications();
    sendSuccess(res, { publications }, { count: publications.length });
  }),
);

publicationsRouter.get(
  '/products/:id/publications',
  asyncHandler(async (req, res) => {
    const gid = toShopifyGid(req.params.id ?? '', 'Product');

    // Returns visibleToCustomers alongside the raw channel list so no caller has
    // to combine status and publication itself. Every place that re-derives it is
    // a place the two halves can disagree, and the failure mode is telling an
    // operator a product is on sale when customers cannot see it.
    //
    // `publications` keeps its original shape and key, so existing readers are
    // unaffected; the visibility fields are additive.
    const visibility = await getProductVisibility(gid);
    sendSuccess(res, visibility, { count: visibility.publications.length });
  }),
);

publicationsWriteRouter.post(
  '/products/:id/publish',
  asyncHandler(async (req, res) => {
    const gid = toShopifyGid(req.params.id ?? '', 'Product');
    const publicationIds = readPublicationIds((req.body ?? {}) as Record<string, unknown>);
    const result = await publishProduct(gid, publicationIds);

    // Publishing is what makes a product visible to customers - the change most
    // likely to be asked about after the fact ("who put this on sale?"). The
    // verified read-back state is recorded, not the request, so the trail says
    // what Shopify ended up believing rather than what was asked for.
    await recordAudit({
      action: 'PRODUCT_PUBLISH',
      resourceType: 'PRODUCT',
      resourceId: gid,
      after: {
        publishedTo: result.published.map((entry) => entry.name),
        visibleToCustomers: result.state.some((entry) => entry.isPublished),
      },
      metadata: { state: result.state, requestedPublicationIds: publicationIds ?? null },
    });

    sendSuccess(res, result);
  }),
);

publicationsWriteRouter.post(
  '/products/:id/unpublish',
  asyncHandler(async (req, res) => {
    const gid = toShopifyGid(req.params.id ?? '', 'Product');
    const publicationIds = readPublicationIds((req.body ?? {}) as Record<string, unknown>);
    const result = await unpublishProduct(gid, publicationIds);

    // Removing a product from sale is equally consequential and equally likely to
    // need explaining later.
    await recordAudit({
      action: 'PRODUCT_UNPUBLISH',
      resourceType: 'PRODUCT',
      resourceId: gid,
      after: {
        // `published` names the publications the call acted on; after an
        // unpublish those are the ones it was REMOVED from.
        removedFrom: result.published.map((entry) => entry.name),
        visibleToCustomers: result.state.some((entry) => entry.isPublished),
      },
      metadata: { state: result.state, requestedPublicationIds: publicationIds ?? null },
    });

    sendSuccess(res, result);
  }),
);
