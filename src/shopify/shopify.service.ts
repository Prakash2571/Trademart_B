/**
 * Shopify read operations.
 *
 * Two behaviours worth calling out:
 *
 * 1. Scope fallback. Several useful fields are gated behind extra scopes
 *    (read_inventory) or Shopify's protected customer data approval. Rather
 *    than failing an entire page load, each read tries the richer document
 *    first and, on SHOPIFY_SCOPE_MISSING only, retries a reduced document and
 *    reports what was dropped in `meta.degraded`. Nothing is fabricated - the
 *    omitted fields come back as null.
 *
 * 2. Short-lived caching of shop info. Variant prices need the shop currency,
 *    and the dashboard asks for shop info on every load; caching avoids
 *    needless polling of Shopify (rate-limit hygiene).
 */

import { AppError, toAppError, type ErrorCode } from '../common/errors';
import { logger } from '../common/logger';
import { config } from '../config';
import { shopifyGraphql } from './shopify.client';
import {
  CUSTOMERS_COUNT_QUERY,
  CUSTOMERS_QUERY_BASIC,
  CUSTOMERS_QUERY_FULL,
} from './graphql/customer.queries';
import { COUNTS_QUERY, INVENTORY_ITEMS_QUERY } from './graphql/inventory.queries';
import {
  ORDERS_QUERY_BASIC,
  ORDERS_QUERY_FULL,
  ORDER_BY_ID_QUERY_BASIC,
  ORDER_BY_ID_QUERY_FULL,
} from './graphql/order.queries';
import {
  PRODUCTS_QUERY_BASIC,
  PRODUCTS_QUERY_FULL,
  PRODUCT_BY_ID_QUERY_BASIC,
  PRODUCT_BY_ID_QUERY_FULL,
} from './graphql/product.queries';
import { SHOP_QUERY_BASIC, SHOP_QUERY_FULL } from './graphql/shop.queries';
import {
  mapCustomer,
  mapInventoryItem,
  mapOrder,
  mapProduct,
  mapShop,
  nodes,
} from './shopify.mappers';
import type {
  CustomerDto,
  InventoryItemDto,
  OrderDto,
  PageMeta,
  ProductDto,
  RawConnection,
  RawCount,
  RawCustomer,
  RawInventoryItem,
  RawOrder,
  RawProduct,
  RawShop,
  ShopDto,
} from './shopify.types';

export interface Paginated<T> {
  items: T[];
  meta: PageMeta;
}

export interface ListParams {
  first?: number;
  after?: string | undefined;
  query?: string | undefined;
}

const SHOP_CACHE_TTL_MS = 60_000;
let shopCache: { value: ShopDto; expiresAt: number } | null = null;

/**
 * Runs `full`; if Shopify denies a scope, runs `reduced` instead and returns
 * the list of degraded field groups.
 */
async function withScopeFallback<T>(
  operation: string,
  full: string,
  reduced: string,
  variables: Record<string, unknown>,
  degradedFields: string[],
): Promise<{ data: T; degraded: string[] }> {
  try {
    const result = await shopifyGraphql<T>(full, variables, { operation });
    return { data: result.data, degraded: [] };
  } catch (error) {
    if (error instanceof AppError && error.code === 'SHOPIFY_SCOPE_MISSING') {
      logger.warn('Retrying Shopify query without scope-gated fields.', {
        operation,
        dropped: degradedFields,
      });
      const result = await shopifyGraphql<T>(reduced, variables, {
        operation: `${operation}:reduced`,
      });
      return { data: result.data, degraded: degradedFields };
    }
    throw error;
  }
}

function pageMeta<T>(
  connection: RawConnection<T> | null | undefined,
  items: unknown[],
  degraded: string[],
): PageMeta {
  const meta: PageMeta = {
    hasNextPage: connection?.pageInfo?.hasNextPage ?? false,
    endCursor: connection?.pageInfo?.endCursor ?? null,
    count: items.length,
  };
  if (degraded.length > 0) meta.degraded = degraded;
  return meta;
}

// ---------------------------------------------------------------------------
// Shop
// ---------------------------------------------------------------------------

export async function getShop(options: { useCache?: boolean } = {}): Promise<ShopDto> {
  const useCache = options.useCache ?? true;
  if (useCache && shopCache && shopCache.expiresAt > Date.now()) {
    return shopCache.value;
  }

  const { data } = await withScopeFallback<{ shop: RawShop }>(
    'getShop',
    SHOP_QUERY_FULL,
    SHOP_QUERY_BASIC,
    {},
    ['shop.email'],
  );

  const shop = mapShop(data.shop, config.shopify.apiVersion);
  shopCache = { value: shop, expiresAt: Date.now() + SHOP_CACHE_TTL_MS };
  return shop;
}

/** Shop currency, needed to attach a currency to variant price strings. */
async function getShopCurrency(): Promise<string> {
  try {
    const shop = await getShop();
    return shop.currencyCode;
  } catch {
    // Never let a currency lookup failure mask the real error downstream.
    return 'UNKNOWN';
  }
}

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

export async function listProducts(params: ListParams): Promise<Paginated<ProductDto>> {
  const currencyCode = await getShopCurrency();
  const { data, degraded } = await withScopeFallback<{
    products: RawConnection<RawProduct>;
  }>('listProducts', PRODUCTS_QUERY_FULL, PRODUCTS_QUERY_BASIC, {
    first: params.first ?? 25,
    after: params.after ?? null,
    query: params.query ?? null,
  }, ['product.totalInventory', 'variant.inventoryQuantity', 'variant.unitCost']);

  const raw = nodes(data.products);
  const items = raw.map((product) => mapProduct(product, currencyCode));
  return { items, meta: pageMeta(data.products, items, degraded) };
}

export async function getProduct(gid: string): Promise<ProductDto> {
  const currencyCode = await getShopCurrency();
  const { data } = await withScopeFallback<{ product: RawProduct | null }>(
    'getProduct',
    PRODUCT_BY_ID_QUERY_FULL,
    PRODUCT_BY_ID_QUERY_BASIC,
    { id: gid },
    ['product.totalInventory', 'variant.inventoryQuantity', 'variant.unitCost'],
  );

  if (data.product === null) {
    throw new AppError('SHOPIFY_NOT_FOUND', `No Shopify product found for id ${gid}.`);
  }
  return mapProduct(data.product, currencyCode);
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

export async function listOrders(params: ListParams): Promise<Paginated<OrderDto>> {
  const { data, degraded } = await withScopeFallback<{ orders: RawConnection<RawOrder> }>(
    'listOrders',
    ORDERS_QUERY_FULL,
    ORDERS_QUERY_BASIC,
    {
      first: params.first ?? 25,
      after: params.after ?? null,
      query: params.query ?? null,
    },
    ['order.customer', 'order.email'],
  );

  const items = nodes(data.orders).map(mapOrder);
  return { items, meta: pageMeta(data.orders, items, degraded) };
}

export async function getOrder(gid: string): Promise<OrderDto> {
  const { data } = await withScopeFallback<{ order: RawOrder | null }>(
    'getOrder',
    ORDER_BY_ID_QUERY_FULL,
    ORDER_BY_ID_QUERY_BASIC,
    { id: gid },
    ['order.customer', 'order.email'],
  );

  if (data.order === null) {
    throw new AppError('SHOPIFY_NOT_FOUND', `No Shopify order found for id ${gid}.`);
  }
  return mapOrder(data.order);
}

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

export async function listCustomers(params: ListParams): Promise<Paginated<CustomerDto>> {
  const { data, degraded } = await withScopeFallback<{
    customers: RawConnection<RawCustomer>;
  }>('listCustomers', CUSTOMERS_QUERY_FULL, CUSTOMERS_QUERY_BASIC, {
    first: params.first ?? 25,
    after: params.after ?? null,
    query: params.query ?? null,
  }, ['customer.displayName', 'customer.email', 'customer.defaultAddress']);

  const items = nodes(data.customers).map(mapCustomer);
  return { items, meta: pageMeta(data.customers, items, degraded) };
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

export async function listInventory(
  params: ListParams,
): Promise<Paginated<InventoryItemDto>> {
  const result = await shopifyGraphql<{ inventoryItems: RawConnection<RawInventoryItem> }>(
    INVENTORY_ITEMS_QUERY,
    {
      first: params.first ?? 25,
      after: params.after ?? null,
      query: params.query ?? null,
    },
    { operation: 'listInventory' },
  );

  const items = nodes(result.data.inventoryItems).map(mapInventoryItem);
  return { items, meta: pageMeta(result.data.inventoryItems, items, []) };
}

// ---------------------------------------------------------------------------
// Counts (dashboard)
// ---------------------------------------------------------------------------

export interface StoreCounts {
  products: number | null;
  orders: number | null;
  customers: number | null;
}

/** A per-section failure, carrying the REAL error code rather than a guess. */
export interface CountIssue {
  source: string;
  code: ErrorCode;
  message: string;
}

/**
 * Counts are fetched independently so one missing scope (e.g. read_customers)
 * does not blank the whole dashboard.
 *
 * Each failure keeps its own error code: an auth failure and a missing scope
 * need completely different fixes, so they must never be reported as the same
 * thing.
 */
export async function getCounts(): Promise<{
  counts: StoreCounts;
  issues: CountIssue[];
}> {
  const issues: CountIssue[] = [];
  const counts: StoreCounts = { products: null, orders: null, customers: null };

  try {
    const result = await shopifyGraphql<{
      productsCount: RawCount | null;
      ordersCount: RawCount | null;
    }>(COUNTS_QUERY, {}, { operation: 'getCounts' });
    counts.products = result.data.productsCount?.count ?? null;
    counts.orders = result.data.ordersCount?.count ?? null;
  } catch (error) {
    const appError = toAppError(error);
    issues.push({
      source: 'shopify.counts.products_orders',
      code: appError.code,
      message: `Product/order counts unavailable: ${appError.message}`,
    });
  }

  try {
    const result = await shopifyGraphql<{ customersCount: RawCount | null }>(
      CUSTOMERS_COUNT_QUERY,
      {},
      { operation: 'getCustomersCount' },
    );
    counts.customers = result.data.customersCount?.count ?? null;
  } catch (error) {
    const appError = toAppError(error);
    issues.push({
      source: 'shopify.counts.customers',
      code: appError.code,
      message: `Customer count unavailable: ${appError.message}`,
    });
  }

  return { counts, issues };
}

/** Clears the shop cache (used by tests and the manual ping script). */
export function clearShopCache(): void {
  shopCache = null;
}
