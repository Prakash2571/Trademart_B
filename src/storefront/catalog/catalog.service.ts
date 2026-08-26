/** Typed public catalog service. Shopify supplies commerce data; Trademart gates sale. */

import { AppError } from '../../common/errors';
import { loadCatalogEvidenceByProductIds } from './catalog.repository';
import type { CatalogCandidateEvidence } from './catalog.repository';
import {
  buildCatalogFilters,
  projectStorefrontCollection,
  projectStorefrontProduct,
} from './projection';
import {
  getRawStorefrontCollectionByHandle,
  getRawStorefrontProductByHandle,
  listRawStorefrontCollections,
  listRawStorefrontProducts,
  type RawCatalogCollection,
  type RawCatalogProduct,
  type RawCollectionProductPage,
  type RawProductPage,
} from './shopify.catalog';
import type {
  StorefrontAvailability,
  StorefrontCatalogData,
  StorefrontCollection,
  StorefrontCollectionDetailData,
  StorefrontProduct,
  StorefrontProductSummary,
  StorefrontSort,
} from './types';

export interface StorefrontCatalogPorts {
  now(): Date;
  listProducts(input: {
    limit: number;
    cursor: string | null;
    query: string | null;
    sort: StorefrontSort;
  }): Promise<RawProductPage>;
  getProductByHandle(handle: string): Promise<{
    currencyCode: string;
    product: RawCatalogProduct | null;
  }>;
  listCollections(): Promise<RawCatalogCollection[]>;
  getCollectionByHandle(input: {
    handle: string;
    limit: number;
    cursor: string | null;
    sort: StorefrontSort;
  }): Promise<RawCollectionProductPage>;
  loadEvidence(ids: readonly string[]): Promise<Map<string, CatalogCandidateEvidence>>;
}

export interface CatalogListInput {
  limit: number;
  cursor: string | null;
  query: string | null;
  collection: string | null;
  productType: string | null;
  availability: Exclude<StorefrontAvailability, 'UNAVAILABLE'> | null;
  sort: StorefrontSort;
}

export function createStorefrontCatalogService(ports: StorefrontCatalogPorts) {
  async function listCatalog(input: CatalogListInput): Promise<StorefrontCatalogData> {
    const page =
      input.collection === null
        ? await ports.listProducts({
            limit: input.limit,
            cursor: input.cursor,
            query: buildShopifyQuery(input.query, input.productType),
            sort: input.sort,
          })
        : await collectionProductPage(input.collection, input.limit, input.cursor, input.sort);

    let products = await projectPage(page.currencyCode, page.products);
    if (input.query !== null && input.collection !== null) {
      const terms = searchableTerms(input.query);
      products = products.filter((product) => matchesTerms(product, terms));
    }
    if (input.productType !== null) {
      const wanted = input.productType.trim().toLowerCase();
      products = products.filter((product) => product.productType?.toLowerCase() === wanted);
    }
    if (input.availability === 'SELLABLE') {
      products = products.filter((product) => product.availableForSale);
    } else if (input.availability === 'OUT_OF_STOCK') {
      products = products.filter((product) => !product.availableForSale);
    }

    return {
      products,
      pageInfo: page.pageInfo,
      filters: buildCatalogFilters(products),
    };
  }

  async function getProduct(handle: string): Promise<StorefrontProduct> {
    const raw = await ports.getProductByHandle(handle);
    if (raw.product === null) throw productNotFound();
    const evidence = await ports.loadEvidence([raw.product.id]);
    const projected = projectStorefrontProduct({
      product: raw.product,
      shopCurrencyCode: raw.currencyCode,
      evidence: evidence.get(raw.product.id) ?? null,
      now: ports.now(),
    });
    if (projected === null) throw productNotFound();
    return projected.detail;
  }

  async function listCollections(): Promise<StorefrontCollection[]> {
    return (await ports.listCollections()).flatMap((collection) => {
      const projected = projectStorefrontCollection(collection);
      return projected === null ? [] : [projected];
    });
  }

  async function getCollectionProducts(input: {
    handle: string;
    limit: number;
    cursor: string | null;
    sort: StorefrontSort;
  }): Promise<StorefrontCollectionDetailData> {
    const page = await ports.getCollectionByHandle(input);
    if (page.collection === null) throw collectionNotFound();
    const collection = projectStorefrontCollection(page.collection);
    if (collection === null) throw collectionNotFound();
    return {
      collection,
      products: await projectPage(page.currencyCode, page.products),
      pageInfo: page.pageInfo,
    };
  }

  async function projectPage(
    currencyCode: string,
    rawProducts: readonly RawCatalogProduct[],
  ): Promise<StorefrontProductSummary[]> {
    const evidence = await ports.loadEvidence(rawProducts.map((product) => product.id));
    const now = ports.now();
    return rawProducts.flatMap((product) => {
      const projected = projectStorefrontProduct({
        product,
        shopCurrencyCode: currencyCode,
        evidence: evidence.get(product.id) ?? null,
        now,
      });
      return projected === null ? [] : [projected.summary];
    });
  }

  async function collectionProductPage(
    handle: string,
    limit: number,
    cursor: string | null,
    sort: StorefrontSort,
  ): Promise<RawProductPage> {
    const page = await ports.getCollectionByHandle({ handle, limit, cursor, sort });
    if (page.collection === null || projectStorefrontCollection(page.collection) === null) {
      throw collectionNotFound();
    }
    return {
      currencyCode: page.currencyCode,
      products: page.products,
      pageInfo: page.pageInfo,
    };
  }

  return { listCatalog, getProduct, listCollections, getCollectionProducts };
}

const realService = createStorefrontCatalogService({
  now: () => new Date(),
  listProducts: listRawStorefrontProducts,
  getProductByHandle: getRawStorefrontProductByHandle,
  listCollections: listRawStorefrontCollections,
  getCollectionByHandle: getRawStorefrontCollectionByHandle,
  loadEvidence: loadCatalogEvidenceByProductIds,
});

export const listStorefrontCatalog = realService.listCatalog;
export const getStorefrontProduct = realService.getProduct;
export const listStorefrontCollections = realService.listCollections;
export const getStorefrontCollectionProducts = realService.getCollectionProducts;

function buildShopifyQuery(query: string | null, productType: string | null): string {
  const clauses = ['status:active'];
  const terms = searchableTerms(query);
  if (terms.length > 0) clauses.push(terms.join(' '));
  const typeTerms = searchableTerms(productType);
  if (typeTerms.length > 0) clauses.push(`product_type:${typeTerms.join(' ')}`);
  return clauses.join(' AND ');
}

function searchableTerms(value: string | null): string[] {
  if (value === null) return [];
  return value
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 0)
    .slice(0, 8);
}

function matchesTerms(product: StorefrontProductSummary, terms: readonly string[]): boolean {
  if (terms.length === 0) return true;
  const haystack = `${product.title} ${product.productType ?? ''}`.toLocaleLowerCase('en-IN');
  return terms.every((term) => haystack.includes(term.toLocaleLowerCase('en-IN')));
}

function productNotFound(): AppError {
  return new AppError('NOT_FOUND', 'This product is not available.', { status: 404 });
}

function collectionNotFound(): AppError {
  return new AppError('NOT_FOUND', 'This collection is not available.', { status: 404 });
}
