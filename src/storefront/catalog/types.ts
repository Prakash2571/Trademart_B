/** Safe, customer-facing storefront catalog DTOs. No admin economics or supplier data. */

export type StorefrontCurrency = 'INR';
export type StorefrontAvailability = 'SELLABLE' | 'OUT_OF_STOCK' | 'UNAVAILABLE';

export interface StorefrontMoney {
  /** Normalized decimal string; payment code converts this to integer paise server-side. */
  amount: string;
  currencyCode: StorefrontCurrency;
}

export interface StorefrontPriceRange {
  min: StorefrontMoney;
  max: StorefrontMoney;
}

export interface StorefrontImage {
  url: string;
  alt: string;
  width?: number | null;
  height?: number | null;
}

export interface StorefrontSelectedOption {
  name: string;
  value: string;
}

export interface StorefrontCollectionReference {
  id: string;
  handle: string;
  title: string;
}

export interface StorefrontProductVariant {
  /** Opaque durable mapping id, never a supplier id or Shopify GID. */
  id: string;
  /** Shopify variant GID (public, exposed by Shopify's own Storefront API). */
  shopifyVariantId: string;
  title: string;
  selectedOptions: StorefrontSelectedOption[];
  skuPublic?: string | null;
  availableForSale: boolean;
  availability: StorefrontAvailability;
  price: StorefrontMoney;
  compareAtPrice?: StorefrontMoney | null;
  image?: StorefrontImage | null;
}

export interface StorefrontProductSummary {
  /** Opaque public id, not a Shopify GID. */
  id: string;
  /** Shopify product GID (public, exposed by Shopify's own Storefront API). */
  shopifyProductId: string;
  handle: string;
  title: string;
  /** Plain-text excerpt, truncated, no HTML. */
  descriptionExcerpt: string;
  productType: string | null;
  vendorPublicName?: string | null;
  images: StorefrontImage[];
  priceRange: StorefrontPriceRange;
  compareAtPriceRange?: StorefrontPriceRange | null;
  availableForSale: boolean;
  availability: StorefrontAvailability;
  collections: StorefrontCollectionReference[];
  /** Present only when one and only one variant can be added without a choice. */
  quickAddVariant?: StorefrontProductVariant | null;
}

export interface StorefrontProduct extends StorefrontProductSummary {
  description: string;
  variants: StorefrontProductVariant[];
  options: { name: string; values: string[] }[];
  seo: { title?: string | null; description?: string | null } | null;
}

export interface StorefrontCollection {
  /** Opaque public id, not a Shopify GID. */
  id: string;
  handle: string;
  title: string;
  description?: string;
  image?: StorefrontImage | null;
  seo: { title?: string | null; description?: string | null } | null;
}

export interface StorefrontPageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

export type StorefrontSort = 'FEATURED' | 'NEWEST' | 'PRICE_ASC' | 'PRICE_DESC';

export interface StorefrontCatalogFilters {
  collections: StorefrontCollectionReference[];
  productTypes: string[];
  priceRange?: StorefrontPriceRange | null;
}

export interface StorefrontCatalogData {
  products: StorefrontProductSummary[];
  pageInfo: StorefrontPageInfo;
  filters: StorefrontCatalogFilters;
}

export interface StorefrontCollectionDetailData {
  collection: StorefrontCollection;
  products: StorefrontProductSummary[];
  pageInfo: StorefrontPageInfo;
}
