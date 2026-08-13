/**
 * Types for raw Shopify GraphQL payloads and the Trademart DTOs returned to
 * the frontend.
 *
 * Shopify ids are ALWAYS strings (GIDs such as gid://shopify/Product/123).
 * Money is kept as a string amount + currency code to avoid float drift, plus
 * a parsed number for convenience in the UI.
 */

// ---------------------------------------------------------------------------
// Shopify enums
//
// Only the enums Trademart actually reads. These were transcribed from
// Shopify's documentation, NOT generated from the schema, so they are split by
// how safe it is to treat them as exhaustive:
//
//   - CLOSED unions: small, long-stable enums. Safe to `switch` exhaustively.
//   - OPEN unions (`| (string & {})`): enums Shopify has added members to over
//     time. Known values still autocomplete, but callers MUST keep a default
//     branch - a version bump can introduce a status we have never seen.
//
// Replace all of these with generated types if the codegen migration lands.
// ---------------------------------------------------------------------------

/** Documents the known members while still accepting anything Shopify sends. */
type Open<TKnown extends string> = TKnown | (string & {});

export type ProductStatus = 'ACTIVE' | 'ARCHIVED' | 'DRAFT';

export type WeightUnit = 'GRAMS' | 'KILOGRAMS' | 'OUNCES' | 'POUNDS';

export type CustomerState = 'DECLINED' | 'DISABLED' | 'ENABLED' | 'INVITED';

export type CountPrecision = 'AT_LEAST' | 'EXACT';

export type OrderFinancialStatus = Open<
  | 'AUTHORIZED'
  | 'EXPIRED'
  | 'PAID'
  | 'PARTIALLY_PAID'
  | 'PARTIALLY_REFUNDED'
  | 'PENDING'
  | 'REFUNDED'
  | 'VOIDED'
>;

export type OrderFulfillmentStatus = Open<
  | 'FULFILLED'
  | 'IN_PROGRESS'
  | 'ON_HOLD'
  | 'OPEN'
  | 'PARTIALLY_FULFILLED'
  | 'PENDING_FULFILLMENT'
  | 'REQUEST_DECLINED'
  | 'RESTOCKED'
  | 'SCHEDULED'
  | 'UNFULFILLED'
>;

export type FulfillmentStatus = Open<
  'CANCELLED' | 'ERROR' | 'FAILURE' | 'OPEN' | 'PENDING' | 'SUCCESS'
>;

// ---------------------------------------------------------------------------
// Raw Shopify shapes (only the fields Trademart requests)
// ---------------------------------------------------------------------------

export interface RawMoney {
  amount: string;
  currencyCode: string;
}

export interface RawMoneyBag {
  shopMoney?: RawMoney | null;
}

export interface RawPageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

export interface RawConnection<T> {
  pageInfo?: RawPageInfo;
  edges: { node: T }[];
}

export interface RawShop {
  id: string;
  name: string;
  myshopifyDomain: string;
  email?: string | null;
  contactEmail?: string | null;
  currencyCode: string;
  ianaTimezone?: string | null;
  weightUnit?: WeightUnit | null;
  primaryDomain?: { host: string; url: string } | null;
  plan?: {
    displayName?: string | null;
    partnerDevelopment?: boolean | null;
    shopifyPlus?: boolean | null;
  } | null;
  billingAddress?: {
    city?: string | null;
    province?: string | null;
    country?: string | null;
    countryCodeV2?: string | null;
  } | null;
}

export interface RawVariant {
  id: string;
  title: string;
  sku?: string | null;
  price?: string | null;
  compareAtPrice?: string | null;
  barcode?: string | null;
  availableForSale?: boolean | null;
  inventoryQuantity?: number | null;
  inventoryItem?: {
    id: string;
    tracked?: boolean | null;
    unitCost?: RawMoney | null;
  } | null;
}

export interface RawProduct {
  id: string;
  title: string;
  handle: string;
  description?: string | null;
  descriptionHtml?: string | null;
  status: ProductStatus;
  vendor?: string | null;
  productType?: string | null;
  tags?: string[] | null;
  createdAt: string;
  updatedAt: string;
  totalInventory?: number | null;
  featuredImage?: { url: string; altText?: string | null } | null;
  priceRangeV2?: {
    minVariantPrice?: RawMoney | null;
    maxVariantPrice?: RawMoney | null;
  } | null;
  variants?: RawConnection<RawVariant> | null;
}

export interface RawLineItem {
  id: string;
  title: string;
  quantity: number;
  sku?: string | null;
  vendor?: string | null;
  variant?: { id: string; title?: string | null; sku?: string | null } | null;
  product?: {
    id: string;
    title?: string | null;
    vendor?: string | null;
    productType?: string | null;
    tags?: string[] | null;
  } | null;
  originalUnitPriceSet?: RawMoneyBag | null;
  discountedTotalSet?: RawMoneyBag | null;
}

export interface RawFulfillment {
  id: string;
  status?: FulfillmentStatus | null;
  createdAt?: string | null;
  trackingInfo?: {
    company?: string | null;
    number?: string | null;
    url?: string | null;
  }[] | null;
}

export interface RawOrder {
  id: string;
  name: string;
  createdAt: string;
  processedAt?: string | null;
  updatedAt?: string | null;
  displayFinancialStatus?: OrderFinancialStatus | null;
  displayFulfillmentStatus?: OrderFulfillmentStatus | null;
  currencyCode: string;
  tags?: string[] | null;
  note?: string | null;
  email?: string | null;
  customer?: {
    id: string;
    displayName?: string | null;
    email?: string | null;
    numberOfOrders?: string | null;
  } | null;
  currentSubtotalPriceSet?: RawMoneyBag | null;
  currentTotalPriceSet?: RawMoneyBag | null;
  currentTotalTaxSet?: RawMoneyBag | null;
  currentTotalDiscountsSet?: RawMoneyBag | null;
  totalShippingPriceSet?: RawMoneyBag | null;
  shippingLine?: {
    title?: string | null;
    carrierIdentifier?: string | null;
    originalPriceSet?: RawMoneyBag | null;
  } | null;
  fulfillments?: RawFulfillment[] | null;
  lineItems?: RawConnection<RawLineItem> | null;
}

export interface RawCustomer {
  id: string;
  createdAt: string;
  updatedAt: string;
  state?: CustomerState | null;
  numberOfOrders?: string | null;
  amountSpent?: RawMoney | null;
  tags?: string[] | null;
  displayName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  defaultAddress?: {
    city?: string | null;
    province?: string | null;
    country?: string | null;
    countryCodeV2?: string | null;
  } | null;
}

export interface RawInventoryItem {
  id: string;
  sku?: string | null;
  tracked?: boolean | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  unitCost?: RawMoney | null;
  variant?: {
    id: string;
    title?: string | null;
    sku?: string | null;
    product?: {
      id: string;
      title?: string | null;
      status?: ProductStatus | null;
      vendor?: string | null;
    } | null;
  } | null;
  inventoryLevels?: RawConnection<{
    id: string;
    location?: { id: string; name?: string | null; isActive?: boolean | null } | null;
    quantities?: { name: string; quantity: number }[] | null;
  }> | null;
}

export interface RawCount {
  count: number;
  precision?: CountPrecision | null;
}

// ---------------------------------------------------------------------------
// Trademart DTOs
// ---------------------------------------------------------------------------

export interface Money {
  amount: number;
  currencyCode: string;
  /** Original Shopify string, preserved to avoid rounding surprises. */
  raw: string;
}

export type SupplierClassification = 'TRADELLE' | 'OTHER' | 'UNKNOWN';

export interface ProductVariantDto {
  shopifyVariantId: string;
  title: string;
  sku: string | null;
  barcode: string | null;
  price: Money | null;
  compareAtPrice: Money | null;
  availableForSale: boolean | null;
  /** null when read_inventory is not granted - NOT zero. */
  inventoryQuantity: number | null;
  inventoryItemId: string | null;
  inventoryTracked: boolean | null;
  /** Shopify's "cost per item". Real data when present, otherwise null. */
  unitCost: Money | null;
}

export interface ProductDto {
  shopifyProductId: string;
  title: string;
  handle: string;
  description: string | null;
  status: ProductStatus;
  vendor: string | null;
  productType: string | null;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  featuredImageUrl: string | null;
  minPrice: Money | null;
  maxPrice: Money | null;
  totalInventory: number | null;
  variants: ProductVariantDto[];
  supplier: SupplierClassification;
  supplierEvidence: string[];
}

export interface OrderLineItemDto {
  shopifyLineItemId: string;
  title: string;
  quantity: number;
  sku: string | null;
  vendor: string | null;
  shopifyVariantId: string | null;
  shopifyProductId: string | null;
  unitPrice: Money | null;
  discountedTotal: Money | null;
  supplier: SupplierClassification;
}

export interface FulfillmentDto {
  id: string;
  status: FulfillmentStatus | null;
  createdAt: string | null;
  trackingCompany: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
}

export interface OrderDto {
  shopifyOrderId: string;
  name: string;
  createdAt: string;
  processedAt: string | null;
  financialStatus: OrderFinancialStatus | null;
  fulfillmentStatus: OrderFulfillmentStatus | null;
  currencyCode: string;
  customer: {
    shopifyCustomerId: string | null;
    displayName: string | null;
    email: string | null;
  } | null;
  subtotal: Money | null;
  totalDiscounts: Money | null;
  totalShipping: Money | null;
  totalTax: Money | null;
  total: Money | null;
  shippingLine: {
    title: string | null;
    carrier: string | null;
    price: Money | null;
  } | null;
  lineItems: OrderLineItemDto[];
  fulfillments: FulfillmentDto[];
  supplier: SupplierClassification;
}

export interface CustomerDto {
  shopifyCustomerId: string;
  createdAt: string;
  updatedAt: string;
  state: CustomerState | null;
  ordersCount: number | null;
  amountSpent: Money | null;
  tags: string[];
  /** Null unless protected customer data access is granted. */
  displayName: string | null;
  email: string | null;
  location: string | null;
}

export interface InventoryLevelDto {
  locationId: string | null;
  locationName: string | null;
  quantities: Record<string, number>;
}

export interface InventoryItemDto {
  inventoryItemId: string;
  sku: string | null;
  tracked: boolean | null;
  unitCost: Money | null;
  shopifyVariantId: string | null;
  shopifyProductId: string | null;
  productTitle: string | null;
  variantTitle: string | null;
  available: number | null;
  levels: InventoryLevelDto[];
}

export interface ShopDto {
  shopifyShopId: string;
  name: string;
  myshopifyDomain: string;
  primaryDomainUrl: string | null;
  email: string | null;
  currencyCode: string;
  timezone: string | null;
  weightUnit: WeightUnit | null;
  planDisplayName: string | null;
  isDevelopmentStore: boolean | null;
  isShopifyPlus: boolean | null;
  country: string | null;
  apiVersion: string;
  /**
   * Fields Shopify refused, so the reduced document was used instead. Absent
   * when nothing degraded.
   *
   * Without this, a withheld field is indistinguishable from a genuinely empty
   * one - `country: null` would read as "this store has no country" rather than
   * "we were not allowed to read it".
   */
  degraded?: string[];
}

export interface PageMeta {
  hasNextPage: boolean;
  endCursor: string | null;
  count: number;
  /** Fields dropped because Shopify denied them. Empty when nothing degraded. */
  degraded?: string[];
}
