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

import { AppError } from '../../common/errors';
import { asyncHandler, sendSuccess } from '../../common/http';
import { toShopifyGid } from '../../common/validate';
import {
  getProductPublications,
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
  '/shopify/publications',
  asyncHandler(async (_req, res) => {
    const publications = await listPublications();
    sendSuccess(res, { publications }, { count: publications.length });
  }),
);

publicationsRouter.get(
  '/shopify/products/:id/publications',
  asyncHandler(async (req, res) => {
    const gid = toShopifyGid(req.params.id ?? '', 'Product');
    const state = await getProductPublications(gid);
    sendSuccess(res, { publications: state }, { count: state.length });
  }),
);

publicationsWriteRouter.post(
  '/shopify/products/:id/publish',
  asyncHandler(async (req, res) => {
    const gid = toShopifyGid(req.params.id ?? '', 'Product');
    const publicationIds = readPublicationIds((req.body ?? {}) as Record<string, unknown>);
    const result = await publishProduct(gid, publicationIds);
    sendSuccess(res, result);
  }),
);

publicationsWriteRouter.post(
  '/shopify/products/:id/unpublish',
  asyncHandler(async (req, res) => {
    const gid = toShopifyGid(req.params.id ?? '', 'Product');
    const publicationIds = readPublicationIds((req.body ?? {}) as Record<string, unknown>);
    const result = await unpublishProduct(gid, publicationIds);
    sendSuccess(res, result);
  }),
);
