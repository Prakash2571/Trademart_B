/** Pure projection from Shopify + Trademart evidence to safe customer-facing DTOs. */

import { createHash } from 'node:crypto';

import { computeSourceability } from '../../intelligence/sourceability';
import type { PushedVariantMapping } from '../../intelligence/variant.mapping';
import type { CatalogCandidateEvidence } from './catalog.repository';
// From ./publication, NOT ./shopify.catalog: the latter imports the Shopify client
// and therefore the config singleton, which this pure projection must not require.
import { resolveChannelPublicationStatus, ONLINE_STORE_SELECTOR } from './publication';
import type { SalesChannelSelector } from '../../shopify/publications/publications.types';
import type {
  RawCatalogCollection,
  RawCatalogProduct,
  RawCatalogVariant,
} from './shopify.catalog';
import {
  evaluateStorefrontSellability,
  inrAmountToPaise,
  normalizeInrAmount,
} from './sellability';
import type {
  StorefrontAvailability,
  StorefrontCatalogFilters,
  StorefrontCollection,
  StorefrontCollectionReference,
  StorefrontImage,
  StorefrontMoney,
  StorefrontPriceRange,
  StorefrontProduct,
  StorefrontProductSummary,
  StorefrontProductVariant,
  StorefrontSelectedOption,
} from './types';

export interface ProjectedProduct {
  summary: StorefrontProductSummary;
  detail: StorefrontProduct;
}

/** Maximum length of the plain-text description excerpt (chars). */
const EXCERPT_MAX_LENGTH = 200;

export function projectStorefrontProduct(input: {
  product: RawCatalogProduct;
  shopCurrencyCode: string;
  evidence: CatalogCandidateEvidence | null;
  now: Date;
  /**
   * The sales channel THIS storefront sells through.
   *
   * Defaults to the themed Online Store, which is what this projection always
   * implicitly assumed. A headless storefront passes its own publication instead,
   * so a product published to the Online Store but absent from the headless channel
   * is correctly not sellable there.
   */
  sellingChannel?: SalesChannelSelector;
}): ProjectedProduct | null {
  const { product, evidence, now } = input;
  if (evidence === null || evidence.supplier === null) return null;

  const channelPublication = resolveChannelPublicationStatus(
    product,
    input.sellingChannel ?? ONLINE_STORE_SELECTOR,
  );

  const sourceability = computeSourceability(evidence.supplier, now);
  const mappingByVariant = uniqueMappingByShopifyVariant(evidence.variantMappings);
  const variants: StorefrontProductVariant[] = [];

  for (const rawVariant of product.variants?.nodes ?? []) {
    const mapping = mappingByVariant.get(rawVariant.id) ?? null;
    if (mapping === null) continue;

    const normalizedPrice = normalizeInrAmount(rawVariant.price ?? null);
    if (normalizedPrice === null) continue;

    const sellability = evaluateStorefrontSellability({
      productStatus: product.status ?? null,
      channelPublication,
      sourceability,
      mapping,
      shopifyVariantAvailableForSale: rawVariant.availableForSale ?? null,
      priceAmount: rawVariant.price ?? null,
      priceCurrencyCode: input.shopCurrencyCode,
      now,
    });

    const selectedOptions: StorefrontSelectedOption[] =
      (rawVariant.selectedOptions ?? [])
        .filter((option) => option.name.trim().length > 0 && option.value.trim().length > 0)
        .map((option) => ({ name: option.name.trim(), value: option.value.trim() }));

    const variant: StorefrontProductVariant = {
      id: mapping.publicVariantId,
      shopifyVariantId: rawVariant.id,
      title: rawVariant.title,
      selectedOptions,
      availableForSale: sellability.availableForSale,
      availability: sellability.availability,
      price: { amount: normalizedPrice, currencyCode: 'INR' },
    };

    const compareAt = approvedCompareAt(rawVariant.compareAtPrice ?? null, normalizedPrice);
    if (compareAt !== null) {
      variant.compareAtPrice = { amount: compareAt, currencyCode: 'INR' };
    }

    // Variant-level image: use selectedOptions match from product media if possible
    // (Shopify GraphQL Admin does not return per-variant image directly in this schema)
    // variant.image is left undefined here; it can be populated from product images downstream
    variants.push(variant);
  }

  // A product with no commercially valid variant is not a public product. Out-of-stock
  // remains displayable because every authority gate passed and only inventory is false.
  const commerciallyValid = variants.filter((variant) => variant.availability !== 'UNAVAILABLE');
  if (commerciallyValid.length === 0) return null;

  const prices = commerciallyValid.map((variant) => variant.price.amount);
  const compareAtPrices = commerciallyValid.flatMap((variant) =>
    variant.compareAtPrice == null ? [] : [variant.compareAtPrice.amount],
  );
  const priceRange = moneyRange(prices);
  if (priceRange === null) return null;

  // Collections are gated on the SAME channel as the product. Listing a collection
  // the storefront's channel cannot serve produces links to an empty or 404 page.
  const collections: StorefrontCollectionReference[] = (product.collections?.nodes ?? [])
    .filter(
      (collection) =>
        resolveChannelPublicationStatus(
          collection,
          input.sellingChannel ?? ONLINE_STORE_SELECTOR,
        ) === 'PUBLISHED',
    )
    .map((collection) => ({
      id: publicId('collection', collection.id),
      handle: collection.handle,
      title: collection.title,
    }));

  const images = uniqueImages(
    (product.media?.nodes ?? []).flatMap((node) =>
      node.image === null || node.image === undefined
        ? []
        : [{ url: node.image.url, alt: node.image.altText ?? product.title }],
    ),
  );
  const featured = product.featuredMedia?.image;
  const featuredImage =
    featured === null || featured === undefined
      ? images[0]
      : safeImage(featured.url, featured.altText ?? product.title);

  // Derive product-level availability from per-variant sellability (fail-closed)
  const availability = deriveProductAvailability(commerciallyValid);

  const sellable = variants.filter((variant) => variant.availability === 'SELLABLE');

  const description = clean(product.description) ?? '';
  const descriptionExcerpt = plainTextExcerpt(description);

  const summary: StorefrontProductSummary = {
    id: publicId('product', product.id),
    shopifyProductId: product.id,
    handle: product.handle,
    title: product.title,
    descriptionExcerpt,
    productType: clean(product.productType),
    images:
      images.length > 0
        ? images
        : featuredImage !== undefined
          ? [featuredImage]
          : [],
    priceRange,
    availableForSale: sellable.length > 0,
    availability,
    collections,
  };
  const compareAtRange = moneyRange(compareAtPrices);
  if (compareAtRange !== null) {
    summary.compareAtPriceRange = compareAtRange;
  }
  if (sellable.length === 1) summary.quickAddVariant = sellable[0];

  const detail: StorefrontProduct = {
    ...summary,
    description,
    variants,
    options: optionDefinitions(variants),
    seo: {
      title: clean(product.seo?.title) ?? product.title,
      description: clean(product.seo?.description) ?? description,
    },
  };
  return { summary, detail };
}

export function projectStorefrontCollection(
  collection: RawCatalogCollection,
  sellingChannel: SalesChannelSelector = ONLINE_STORE_SELECTOR,
): StorefrontCollection | null {
  // UNKNOWN is withheld exactly like UNPUBLISHED: without confirmation the
  // storefront must not advertise a collection it may not be able to serve.
  if (resolveChannelPublicationStatus(collection, sellingChannel) !== 'PUBLISHED') return null;
  const description = clean(collection.description);
  const image =
    collection.image === null || collection.image === undefined
      ? undefined
      : safeImage(collection.image.url, collection.image.altText ?? collection.title);
  return {
    id: publicId('collection', collection.id),
    handle: collection.handle,
    title: collection.title,
    ...(description === null ? {} : { description }),
    ...(image === undefined ? {} : { image }),
    seo: {
      title: clean(collection.seo?.title) ?? collection.title,
      description: clean(collection.seo?.description) ?? description ?? '',
    },
  };
}

/**
 * Build catalog filters from projected products.
 * Uses the collection references already present in the summaries.
 */
export function buildCatalogFilters(
  products: readonly StorefrontProductSummary[],
): StorefrontCatalogFilters {
  const productTypes = [...new Set(products.flatMap((product) => product.productType ?? []))].sort();
  const collectionByHandle = new Map<string, StorefrontCollectionReference>();
  for (const product of products) {
    for (const collection of product.collections) {
      collectionByHandle.set(collection.handle, collection);
    }
  }
  return { productTypes, collections: [...collectionByHandle.values()] };
}

function uniqueMappingByShopifyVariant(
  mappings: readonly PushedVariantMapping[],
): Map<string, PushedVariantMapping> {
  const grouped = new Map<string, PushedVariantMapping[]>();
  for (const mapping of mappings) {
    const entries = grouped.get(mapping.shopifyVariantId) ?? [];
    entries.push(mapping);
    grouped.set(mapping.shopifyVariantId, entries);
  }
  return new Map(
    [...grouped.entries()].flatMap(([id, entries]) =>
      entries.length === 1 ? [[id, entries[0] as PushedVariantMapping]] : [],
    ),
  );
}

function optionDefinitions(
  variants: readonly StorefrontProductVariant[],
): { name: string; values: string[] }[] {
  const values = new Map<string, string[]>();
  for (const variant of variants) {
    for (const option of variant.selectedOptions) {
      const existing = values.get(option.name) ?? [];
      if (!existing.some((entry) => entry.toLowerCase() === option.value.toLowerCase())) {
        existing.push(option.value);
      }
      values.set(option.name, existing);
    }
  }
  return [...values.entries()].map(([name, optionValues]) => ({ name, values: optionValues }));
}

function approvedCompareAt(raw: string | null, price: string): string | null {
  const compareAt = normalizeInrAmount(raw);
  if (compareAt === null) return null;
  const comparePaise = inrAmountToPaise(compareAt);
  const pricePaise = inrAmountToPaise(price);
  return comparePaise !== null && pricePaise !== null && comparePaise > pricePaise
    ? compareAt
    : null;
}

/**
 * Build a StorefrontPriceRange from decimal amount strings.
 */
function moneyRange(values: readonly string[]): StorefrontPriceRange | null {
  const normalized = values.flatMap((value) => {
    const amount = normalizeInrAmount(value);
    const paise = amount === null ? null : inrAmountToPaise(amount);
    return amount === null || paise === null ? [] : [{ amount, paise }];
  });
  if (normalized.length === 0) return null;
  normalized.sort((left, right) => (left.paise < right.paise ? -1 : left.paise > right.paise ? 1 : 0));
  return {
    min: { amount: (normalized[0] as { amount: string }).amount, currencyCode: 'INR' },
    max: { amount: (normalized[normalized.length - 1] as { amount: string }).amount, currencyCode: 'INR' },
  };
}

function uniqueImages(images: readonly StorefrontImage[]): StorefrontImage[] {
  const seen = new Set<string>();
  return images.flatMap((image) => {
    const safe = safeImage(image.url, image.alt);
    if (safe === undefined || seen.has(safe.url)) return [];
    seen.add(safe.url);
    return [safe];
  });
}

function safeImage(url: string, alt: string): StorefrontImage | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.hostname.length === 0) return undefined;
    return { url: parsed.toString(), alt: alt.trim() };
  } catch {
    return undefined;
  }
}

function publicId(kind: 'product' | 'collection', shopifyGid: string): string {
  const digest = createHash('sha256')
    .update(`kanay-${kind}-v1\0${shopifyGid}`)
    .digest('base64url')
    .slice(0, 24);
  return `${kind === 'product' ? 'kp' : 'kc'}_${digest}`;
}

function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Derive product-level availability from the commercially valid variants.
 * Fail-closed: if any variant is SELLABLE, product is SELLABLE.
 * If none are SELLABLE but at least one is OUT_OF_STOCK, product is OUT_OF_STOCK.
 * Otherwise UNAVAILABLE.
 */
function deriveProductAvailability(
  variants: readonly StorefrontProductVariant[],
): StorefrontAvailability {
  if (variants.some((v) => v.availability === 'SELLABLE')) return 'SELLABLE';
  if (variants.some((v) => v.availability === 'OUT_OF_STOCK')) return 'OUT_OF_STOCK';
  return 'UNAVAILABLE';
}

/**
 * Strip HTML tags and produce a plain-text excerpt, truncated at word boundary.
 */
function plainTextExcerpt(description: string): string {
  // Strip HTML tags
  const plainText = description.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  if (plainText.length <= EXCERPT_MAX_LENGTH) return plainText;
  // Truncate at word boundary
  const truncated = plainText.slice(0, EXCERPT_MAX_LENGTH);
  const lastSpace = truncated.lastIndexOf(' ');
  const cutoff = lastSpace > EXCERPT_MAX_LENGTH * 0.5 ? lastSpace : EXCERPT_MAX_LENGTH;
  return truncated.slice(0, cutoff) + '…';
}
