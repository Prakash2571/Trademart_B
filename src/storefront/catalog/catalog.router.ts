/** Public, read-only storefront catalog routes. Mount under `/api` without operator auth. */

import { Router } from 'express';

import { AppError } from '../../common/errors';
import { asyncHandler, sendSuccess } from '../../common/http';
import { parseIntParam, parseStringParam } from '../../common/validate';
import {
  getStorefrontCollectionProducts,
  getStorefrontProduct,
  listStorefrontCatalog,
  listStorefrontCollections,
} from './catalog.service';
import type { StorefrontSort } from './types';

export const storefrontCatalogRouter = Router();

storefrontCatalogRouter.get(
  '/storefront/catalog',
  asyncHandler(async (req, res) => {
    const data = await listStorefrontCatalog({
      limit: parseIntParam(req.query['limit'], 'limit', { min: 1, max: 50, fallback: 24 }),
      cursor: optionalString(req.query['cursor'], 'cursor', 500),
      query: optionalString(req.query['query'], 'query', 80),
      collection: optionalHandle(req.query['collection'], 'collection'),
      productType: optionalString(req.query['productType'], 'productType', 100),
      availability: availability(req.query['availability']),
      sort: sort(req.query['sort']),
    });
    sendSuccess(res, data);
  }),
);

storefrontCatalogRouter.get(
  '/storefront/products/:handle',
  asyncHandler(async (req, res) => {
    sendSuccess(res, await getStorefrontProduct(requiredHandle(req.params.handle, 'handle')));
  }),
);

storefrontCatalogRouter.get(
  '/storefront/collections',
  asyncHandler(async (_req, res) => {
    sendSuccess(res, { collections: await listStorefrontCollections() });
  }),
);

storefrontCatalogRouter.get(
  '/storefront/collections/:handle',
  asyncHandler(async (req, res) => {
    const data = await getStorefrontCollectionProducts({
      handle: requiredHandle(req.params.handle, 'handle'),
      limit: parseIntParam(req.query['limit'], 'limit', { min: 1, max: 50, fallback: 24 }),
      cursor: optionalString(req.query['cursor'], 'cursor', 500),
      sort: sort(req.query['sort']),
    });
    sendSuccess(res, data);
  }),
);

function requiredHandle(raw: unknown, field: string): string {
  const value = parseStringParam(raw, field, { maxLength: 255 });
  if (value === undefined || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) {
    throw new AppError('VALIDATION_ERROR', `${field} must be a valid lowercase Shopify handle.`);
  }
  return value;
}

function optionalHandle(raw: unknown, field: string): string | null {
  const value = parseStringParam(raw, field, { maxLength: 255 });
  return value === undefined ? null : requiredHandle(value, field);
}

function availability(raw: unknown): 'SELLABLE' | 'OUT_OF_STOCK' | null {
  const value = parseStringParam(raw, 'availability', { maxLength: 20 });
  if (value === undefined) return null;
  if (value === 'SELLABLE' || value === 'OUT_OF_STOCK') return value;
  throw new AppError(
    'VALIDATION_ERROR',
    'availability must be SELLABLE or OUT_OF_STOCK.',
  );
}

function sort(raw: unknown): StorefrontSort {
  const value = parseStringParam(raw, 'sort', { maxLength: 20 });
  if (value === undefined) return 'FEATURED';
  if (
    value === 'FEATURED' ||
    value === 'NEWEST' ||
    value === 'PRICE_ASC' ||
    value === 'PRICE_DESC'
  ) {
    return value;
  }
  throw new AppError(
    'VALIDATION_ERROR',
    'sort must be FEATURED, NEWEST, PRICE_ASC, or PRICE_DESC.',
  );
}

function optionalString(raw: unknown, field: string, maxLength: number): string | null {
  return parseStringParam(raw, field, { maxLength }) ?? null;
}
