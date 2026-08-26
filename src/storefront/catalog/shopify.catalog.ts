/** Shopify Admin reads for the public projection. Raw responses never leave this module. */

import { shopifyGraphql } from '../../shopify/shopify.client';
import type { RawPublication } from './publication';
import type { StorefrontSort } from './types';

/**
 * The pure publication predicates live in ./publication.ts, which imports nothing.
 * Re-exported here so existing callers keep working, but prefer importing them from
 * ./publication directly - this module pulls in the Shopify client, and with it the
 * config singleton that exits the process on invalid env.
 */
export {
  isPublishedToOnlineStore,
  isPublishedToChannelNamed,
  isPublishedToPublicationId,
  findPublicationById,
} from './publication';
export type { RawPublication, PublishableResource } from './publication';

interface RawImage {
  url: string;
  altText?: string | null;
}

export interface RawCatalogVariant {
  id: string;
  title: string;
  sku?: string | null;
  price?: string | null;
  compareAtPrice?: string | null;
  availableForSale?: boolean | null;
  selectedOptions?: { name: string; value: string }[] | null;
}

export interface RawCatalogProduct {
  id: string;
  handle: string;
  title: string;
  description?: string | null;
  status?: string | null;
  vendor?: string | null;
  productType?: string | null;
  createdAt: string;
  updatedAt: string;
  seo?: { title?: string | null; description?: string | null } | null;
  featuredMedia?: { image?: RawImage | null } | null;
  media?: { nodes?: { image?: RawImage | null }[] | null } | null;
  variants?: { nodes?: RawCatalogVariant[] | null } | null;
  collections?: {
    nodes?: (RawCatalogCollection & { description?: never; image?: never; seo?: never })[] | null;
  } | null;
  resourcePublicationsV2?: { nodes?: RawPublication[] | null } | null;
}

export interface RawCatalogCollection {
  id: string;
  handle: string;
  title: string;
  description?: string | null;
  image?: RawImage | null;
  seo?: { title?: string | null; description?: string | null } | null;
  resourcePublicationsV2?: { nodes?: RawPublication[] | null } | null;
}

interface RawPageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

export interface RawProductPage {
  currencyCode: string;
  products: RawCatalogProduct[];
  pageInfo: RawPageInfo;
}

export interface RawCollectionProductPage {
  currencyCode: string;
  collection: RawCatalogCollection | null;
  products: RawCatalogProduct[];
  pageInfo: RawPageInfo;
}

const PRODUCT_FIELDS = /* GraphQL */ `
  id
  handle
  title
  description
  status
  vendor
  productType
  createdAt
  updatedAt
  seo { title description }
  featuredMedia {
    ... on MediaImage { image { url altText } }
  }
  media(first: 12) {
    nodes { ... on MediaImage { image { url altText } } }
  }
  variants(first: 100) {
    nodes {
      id
      title
      sku
      price
      compareAtPrice
      availableForSale
      selectedOptions { name value }
    }
  }
  collections(first: 20) {
    nodes {
      id
      handle
      title
      resourcePublicationsV2(first: 50) {
        nodes { isPublished publication { id name } }
      }
    }
  }
  resourcePublicationsV2(first: 50) {
    nodes {
      isPublished
      publishDate
      publication { id name }
    }
  }
`;

const COLLECTION_FIELDS = /* GraphQL */ `
  id
  handle
  title
  description
  image { url altText }
  seo { title description }
  resourcePublicationsV2(first: 50) {
    nodes {
      isPublished
      publishDate
      publication { id name }
    }
  }
`;

const STOREFRONT_PRODUCTS_QUERY = /* GraphQL */ `
  query KanayStorefrontProducts(
    $first: Int!
    $after: String
    $query: String
    $sortKey: ProductSortKeys!
    $reverse: Boolean!
  ) {
    shop { currencyCode }
    products(first: $first, after: $after, query: $query, sortKey: $sortKey, reverse: $reverse) {
      pageInfo { hasNextPage endCursor }
      edges { node { ${PRODUCT_FIELDS} } }
    }
  }
`;

const STOREFRONT_PRODUCT_BY_HANDLE_QUERY = /* GraphQL */ `
  query KanayStorefrontProduct($identifier: ProductIdentifierInput!) {
    shop { currencyCode }
    productByIdentifier(identifier: $identifier) { ${PRODUCT_FIELDS} }
  }
`;

const STOREFRONT_COLLECTIONS_QUERY = /* GraphQL */ `
  query KanayStorefrontCollections($first: Int!) {
    collections(first: $first, sortKey: TITLE) {
      nodes { ${COLLECTION_FIELDS} }
    }
  }
`;

const STOREFRONT_COLLECTION_BY_HANDLE_QUERY = /* GraphQL */ `
  query KanayStorefrontCollection(
    $identifier: CollectionIdentifierInput!
    $first: Int!
    $after: String
    $sortKey: ProductCollectionSortKeys!
    $reverse: Boolean!
  ) {
    shop { currencyCode }
    collectionByIdentifier(identifier: $identifier) {
      ${COLLECTION_FIELDS}
      products(first: $first, after: $after, sortKey: $sortKey, reverse: $reverse) {
        pageInfo { hasNextPage endCursor }
        edges { node { ${PRODUCT_FIELDS} } }
      }
    }
  }
`;

export async function listRawStorefrontProducts(input: {
  limit: number;
  cursor: string | null;
  query: string | null;
  sort: StorefrontSort;
}): Promise<RawProductPage> {
  const sort = productSort(input.sort);
  const result = await shopifyGraphql<{
    shop: { currencyCode: string };
    products: {
      pageInfo: RawPageInfo;
      edges: { node: RawCatalogProduct }[];
    };
  }>(
    STOREFRONT_PRODUCTS_QUERY,
    {
      first: input.limit,
      after: input.cursor,
      query: input.query,
      sortKey: sort.sortKey,
      reverse: sort.reverse,
    },
    { operation: 'storefrontProducts' },
  );
  return {
    currencyCode: result.data.shop.currencyCode,
    products: result.data.products.edges.map((edge) => edge.node),
    pageInfo: result.data.products.pageInfo,
  };
}

export async function getRawStorefrontProductByHandle(handle: string): Promise<{
  currencyCode: string;
  product: RawCatalogProduct | null;
}> {
  const result = await shopifyGraphql<{
    shop: { currencyCode: string };
    productByIdentifier: RawCatalogProduct | null;
  }>(
    STOREFRONT_PRODUCT_BY_HANDLE_QUERY,
    { identifier: { handle } },
    { operation: 'storefrontProductByHandle' },
  );
  return {
    currencyCode: result.data.shop.currencyCode,
    product: result.data.productByIdentifier,
  };
}

export async function listRawStorefrontCollections(): Promise<RawCatalogCollection[]> {
  const result = await shopifyGraphql<{
    collections: { nodes: RawCatalogCollection[] };
  }>(
    STOREFRONT_COLLECTIONS_QUERY,
    { first: 100 },
    { operation: 'storefrontCollections' },
  );
  return result.data.collections.nodes;
}

export async function getRawStorefrontCollectionByHandle(input: {
  handle: string;
  limit: number;
  cursor: string | null;
  sort: StorefrontSort;
}): Promise<RawCollectionProductPage> {
  const sort = collectionProductSort(input.sort);
  const result = await shopifyGraphql<{
    shop: { currencyCode: string };
    collectionByIdentifier:
      | (RawCatalogCollection & {
          products: {
            pageInfo: RawPageInfo;
            edges: { node: RawCatalogProduct }[];
          };
        })
      | null;
  }>(
    STOREFRONT_COLLECTION_BY_HANDLE_QUERY,
    {
      identifier: { handle: input.handle },
      first: input.limit,
      after: input.cursor,
      sortKey: sort.sortKey,
      reverse: sort.reverse,
    },
    { operation: 'storefrontCollectionByHandle' },
  );
  const collection = result.data.collectionByIdentifier;
  return {
    currencyCode: result.data.shop.currencyCode,
    collection,
    products: collection?.products.edges.map((edge) => edge.node) ?? [],
    pageInfo: collection?.products.pageInfo ?? { hasNextPage: false, endCursor: null },
  };
}


function productSort(sort: StorefrontSort): { sortKey: string; reverse: boolean } {
  switch (sort) {
    case 'NEWEST':
      return { sortKey: 'CREATED_AT', reverse: true };
    case 'PRICE_ASC':
      return { sortKey: 'PRICE', reverse: false };
    case 'PRICE_DESC':
      return { sortKey: 'PRICE', reverse: true };
    case 'FEATURED':
      return { sortKey: 'UPDATED_AT', reverse: true };
  }
}

function collectionProductSort(
  sort: StorefrontSort,
): { sortKey: string; reverse: boolean } {
  switch (sort) {
    case 'NEWEST':
      return { sortKey: 'CREATED', reverse: true };
    case 'PRICE_ASC':
      return { sortKey: 'PRICE', reverse: false };
    case 'PRICE_DESC':
      return { sortKey: 'PRICE', reverse: true };
    case 'FEATURED':
      return { sortKey: 'COLLECTION_DEFAULT', reverse: false };
  }
}
