/**
 * Product-creation validation and input building — pure.
 *
 * Shopify's current (post-2024-10) model creates a product in two steps:
 *   1. productCreate(product: ProductCreateInput!) - creates the product plus
 *      ONE default standalone variant from the declared options.
 *   2. productVariantsBulkCreate(..., strategy: REMOVE_STANDALONE_VARIANT) -
 *      replaces that default with the real variants (price, SKU, compare-at).
 *   https://shopify.dev/docs/api/admin-graphql/latest/mutations/productCreate
 *
 * This module validates the request and builds the inputs for both steps. It is
 * pure so the rules - required title, positive prices, variants matching the
 * declared options, DRAFT-by-default - are unit testable with no network.
 *
 * Safety stance from the brief: a newly created product must NOT be visible
 * unless explicitly requested. So `status` defaults to DRAFT and the caller has
 * to opt into ACTIVE.
 */

import { AppError } from '../common/errors';
import type { ProductStatus } from './product.write';

const STATUSES: readonly ProductStatus[] = ['ACTIVE', 'ARCHIVED', 'DRAFT'];
const MAX_OPTIONS = 3; // Shopify allows at most 3 options per product.
const MAX_VALUES_PER_OPTION = 100;
/**
 * Shopify's default per-product variant ceiling. Checked here so a bad import is
 * rejected before any product is created, rather than after step 1 has already
 * left a half-built product behind.
 */
const MAX_VARIANTS = 100;
/** Shopify's media-per-product ceiling. */
const MAX_MEDIA = 250;
const MAX_TAGS = 250;
const MAX_TAG_LENGTH = 255;
/**
 * Barcodes are free-form at Shopify, but a value with whitespace or control
 * characters is a copy/paste accident every time. Charset and length only - this
 * does not try to validate an EAN/UPC check digit.
 */
const BARCODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{5,49}$/;

export interface ProductOptionInput {
  name: string;
  values: string[];
}

export interface NewVariantInput {
  price: string;
  compareAtPrice?: string;
  sku?: string;
  barcode?: string;
  /** One value per declared option, e.g. [{ optionName: 'Size', name: 'M' }]. */
  optionValues: { optionName: string; name: string }[];
}

export interface ProductCreateRequest {
  title: string;
  descriptionHtml?: string;
  vendor?: string;
  productType?: string;
  /**
   * The status the product should END UP in once creation and publication have
   * both been confirmed.
   *
   * Deliberately NOT the status sent to `productCreate` - that is always DRAFT.
   * The name is `desiredStatus` rather than `status` so that every call site has
   * to acknowledge the difference: a request for ACTIVE is an *intent*, granted
   * only after publication has been verified.
   */
  desiredStatus: ProductStatus;
  /**
   * Whether to publish to the Online Store sales channel.
   *
   * Separate from `desiredStatus` because they are genuinely different things: a
   * product can be ACTIVE and unpublished (invisible) or DRAFT and published
   * (also invisible). Only both together make it visible to a customer.
   */
  publishToOnlineStore: boolean;
  tags: string[];
  options: ProductOptionInput[];
  variants: NewVariantInput[];
  /** Image URLs; each becomes a media entry of type IMAGE. */
  mediaUrls: string[];
}

const MAX_TITLE = 255;
const MAX_DESCRIPTION = 100_000;

function requiredString(raw: unknown, field: string, max: number): string {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new AppError('VALIDATION_ERROR', `${field} is required.`);
  }
  if (raw.length > max) {
    throw new AppError('VALIDATION_ERROR', `${field} must be at most ${max} characters.`);
  }
  return raw;
}

function optionalString(raw: unknown, field: string, max: number): string | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string') {
    throw new AppError('VALIDATION_ERROR', `${field} must be a string.`);
  }
  if (raw.length > max) {
    throw new AppError('VALIDATION_ERROR', `${field} must be at most ${max} characters.`);
  }
  return raw;
}

/** Positive decimal, at most 2 fractional digits, returned normalised. */
function priceString(raw: unknown, field: string): string {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw <= 0) {
      throw new AppError('VALIDATION_ERROR', `${field} must be greater than 0.`);
    }
    return raw.toFixed(2);
  }
  if (typeof raw === 'string' && /^\d+(\.\d{1,2})?$/.test(raw.trim()) && Number(raw) > 0) {
    return Number(raw).toFixed(2);
  }
  throw new AppError('VALIDATION_ERROR', `${field} must be a positive amount like "24.99".`);
}

function validateOptions(raw: unknown): ProductOptionInput[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new AppError('VALIDATION_ERROR', 'options must be an array.');
  }
  if (raw.length > MAX_OPTIONS) {
    throw new AppError('VALIDATION_ERROR', `A product may have at most ${MAX_OPTIONS} options.`);
  }
  const seenNames = new Set<string>();
  return raw.map((entry) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new AppError('VALIDATION_ERROR', 'Each option must be an object.');
    }
    const o = entry as Record<string, unknown>;
    const name = requiredString(o['name'], 'option name', 255).trim();
    if (seenNames.has(name.toLowerCase())) {
      throw new AppError('VALIDATION_ERROR', `Duplicate option name "${name}".`);
    }
    seenNames.add(name.toLowerCase());

    const rawValues = o['values'];
    if (!Array.isArray(rawValues) || rawValues.length === 0) {
      throw new AppError('VALIDATION_ERROR', `Option "${name}" needs at least one value.`);
    }
    if (rawValues.length > MAX_VALUES_PER_OPTION) {
      throw new AppError('VALIDATION_ERROR', `Option "${name}" has too many values.`);
    }
    const values: string[] = [];
    const seenValues = new Set<string>();
    for (const value of rawValues) {
      if (typeof value !== 'string' || value.trim().length === 0) {
        throw new AppError('VALIDATION_ERROR', `Option "${name}" has an empty value.`);
      }
      const trimmed = value.trim();
      if (!seenValues.has(trimmed.toLowerCase())) {
        seenValues.add(trimmed.toLowerCase());
        values.push(trimmed);
      }
    }
    return { name, values };
  });
}

function validateNewVariants(
  raw: unknown,
  options: ProductOptionInput[],
): NewVariantInput[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new AppError('VALIDATION_ERROR', 'variants must be an array.');
  }

  return raw.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new AppError('VALIDATION_ERROR', `Variant ${index + 1} must be an object.`);
    }
    const v = entry as Record<string, unknown>;
    const variant: NewVariantInput = {
      price: priceString(v['price'], `variant ${index + 1} price`),
      optionValues: [],
    };
    if (v['compareAtPrice'] !== undefined && v['compareAtPrice'] !== null) {
      variant.compareAtPrice = priceString(
        v['compareAtPrice'],
        `variant ${index + 1} compareAtPrice`,
      );
      if (Number(variant.compareAtPrice) < Number(variant.price)) {
        throw new AppError(
          'VALIDATION_ERROR',
          `Variant ${index + 1}: compareAtPrice must be at least the price.`,
        );
      }
    }
    const sku = optionalString(v['sku'], `variant ${index + 1} sku`, 255);
    if (sku !== undefined) {
      const trimmedSku = sku.trim();
      if (trimmedSku.length === 0) {
        throw new AppError(
          'VALIDATION_ERROR',
          `Variant ${index + 1}: sku must not be blank. Omit it instead.`,
        );
      }
      variant.sku = trimmedSku;
    }
    const barcode = optionalString(v['barcode'], `variant ${index + 1} barcode`, 255);
    if (barcode !== undefined) {
      const trimmedBarcode = barcode.trim();
      if (!BARCODE_PATTERN.test(trimmedBarcode)) {
        throw new AppError(
          'VALIDATION_ERROR',
          `Variant ${index + 1}: barcode "${trimmedBarcode}" is not a plausible barcode (6-50 characters, letters/digits/dot/dash/underscore, no spaces).`,
        );
      }
      variant.barcode = trimmedBarcode;
    }

    // Cross-check option values: when options are declared, each variant must
    // supply exactly one value per option, and each must be a declared value.
    if (options.length > 0) {
      const rawOptionValues = v['optionValues'];
      if (!Array.isArray(rawOptionValues) || rawOptionValues.length !== options.length) {
        throw new AppError(
          'VALIDATION_ERROR',
          `Variant ${index + 1} must provide one value for each of the ${options.length} option(s).`,
        );
      }
      for (const ov of rawOptionValues) {
        if (typeof ov !== 'object' || ov === null) {
          throw new AppError('VALIDATION_ERROR', `Variant ${index + 1} has a malformed optionValue.`);
        }
        const pair = ov as Record<string, unknown>;
        const optionName = String(pair['optionName'] ?? '').trim();
        const name = String(pair['name'] ?? '').trim();
        const option = options.find((o) => o.name.toLowerCase() === optionName.toLowerCase());
        if (option === undefined) {
          throw new AppError(
            'VALIDATION_ERROR',
            `Variant ${index + 1} references unknown option "${optionName}".`,
          );
        }
        if (!option.values.some((value) => value.toLowerCase() === name.toLowerCase())) {
          throw new AppError(
            'VALIDATION_ERROR',
            `Variant ${index + 1}: "${name}" is not a declared value of option "${option.name}".`,
          );
        }
        variant.optionValues.push({ optionName: option.name, name });
      }
    }
    return variant;
  });
}

/**
 * Cross-variant checks, run after each variant is individually valid.
 *
 * These have to be a separate pass because they are about relationships between
 * variants, and every one of them is a mistake Shopify would either reject
 * mid-creation (leaving a partial product) or silently accept to the merchant's
 * cost. Catching them here means nothing is created at all.
 */
function validateVariantSet(
  variants: readonly NewVariantInput[],
  options: readonly ProductOptionInput[],
): void {
  if (variants.length > MAX_VARIANTS) {
    throw new AppError(
      'VALIDATION_ERROR',
      `A product may have at most ${MAX_VARIANTS} variants (received ${variants.length}).`,
    );
  }

  // A product with no options has exactly one variant in Shopify's model. More
  // than one would be silently collapsed, losing prices the operator entered.
  if (options.length === 0 && variants.length > 1) {
    throw new AppError(
      'VALIDATION_ERROR',
      `${variants.length} variants were supplied but no options were declared. Declare an option (e.g. "Size") so each variant is distinguishable, or supply a single variant.`,
    );
  }

  // Duplicate option-value combinations. Two variants for "Size: M" is
  // ambiguous - Shopify would reject it, and which price wins is undefined.
  const seenCombinations = new Map<string, number>();
  variants.forEach((variant, index) => {
    if (variant.optionValues.length === 0) return;
    const key = variant.optionValues
      .map((pair) => `${pair.optionName.toLowerCase()}=${pair.name.toLowerCase()}`)
      .sort()
      .join('|');
    const previous = seenCombinations.get(key);
    if (previous !== undefined) {
      const description = variant.optionValues
        .map((pair) => `${pair.optionName}: ${pair.name}`)
        .join(', ');
      throw new AppError(
        'VALIDATION_ERROR',
        `Variants ${previous + 1} and ${index + 1} have the same option combination (${description}). Each variant must be a distinct combination.`,
      );
    }
    seenCombinations.set(key, index);
  });

  // Duplicate SKUs. Shopify permits them, which is exactly why this is checked:
  // two variants sharing a SKU breaks cost attribution and supplier matching,
  // and the damage shows up later as mispriced stock rather than as an error.
  const seenSkus = new Map<string, number>();
  variants.forEach((variant, index) => {
    if (variant.sku === undefined) return;
    const key = variant.sku.toLowerCase();
    const previous = seenSkus.get(key);
    if (previous !== undefined) {
      throw new AppError(
        'VALIDATION_ERROR',
        `Variants ${previous + 1} and ${index + 1} both use SKU "${variant.sku}". A SKU must identify exactly one variant, or cost and supplier lookups will attribute to the wrong one.`,
      );
    }
    seenSkus.set(key, index);
  });

  // Duplicate barcodes, for the same reason.
  const seenBarcodes = new Map<string, number>();
  variants.forEach((variant, index) => {
    if (variant.barcode === undefined) return;
    const key = variant.barcode.toLowerCase();
    const previous = seenBarcodes.get(key);
    if (previous !== undefined) {
      throw new AppError(
        'VALIDATION_ERROR',
        `Variants ${previous + 1} and ${index + 1} both use barcode "${variant.barcode}".`,
      );
    }
    seenBarcodes.set(key, index);
  });
}

/** Tags: bounded count, bounded length, no commas (Shopify's separator). */
function validateTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.includes(',')) {
      throw new AppError(
        'VALIDATION_ERROR',
        `A tag must not contain a comma ("${entry}") - Shopify uses commas to separate tags.`,
      );
    }
    if (trimmed.length > MAX_TAG_LENGTH) {
      throw new AppError(
        'VALIDATION_ERROR',
        `A tag must be at most ${MAX_TAG_LENGTH} characters (received ${trimmed.length}).`,
      );
    }
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(trimmed);
  }
  if (tags.length > MAX_TAGS) {
    throw new AppError(
      'VALIDATION_ERROR',
      `A product may have at most ${MAX_TAGS} tags (received ${tags.length}).`,
    );
  }
  return tags;
}

function validateMediaUrls(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new AppError('VALIDATION_ERROR', 'mediaUrls must be an array of URLs.');
  }
  if (raw.length > MAX_MEDIA) {
    throw new AppError(
      'VALIDATION_ERROR',
      `A product may have at most ${MAX_MEDIA} media items (received ${raw.length}).`,
    );
  }

  const seen = new Set<string>();
  return raw.map((entry) => {
    if (typeof entry !== 'string') {
      throw new AppError('VALIDATION_ERROR', 'Each media URL must be a string.');
    }
    const url = entry.trim();
    // Must be an absolute https URL: Shopify fetches it from EPS, and an http
    // source is both interceptable and frequently blocked.
    if (!/^https:\/\/.+/i.test(url)) {
      throw new AppError('VALIDATION_ERROR', `Media URL must be an https URL ("${entry}").`);
    }
    // Parsed as well as pattern-matched, so "https://" alone or a URL with
    // whitespace is rejected here rather than by Shopify after the product exists.
    let parsed: { hostname: string };
    try {
      parsed = new URL(url) as { hostname: string };
    } catch {
      throw new AppError('VALIDATION_ERROR', `Media URL is not a valid URL ("${entry}").`);
    }
    if (parsed.hostname.length === 0 || !parsed.hostname.includes('.')) {
      throw new AppError(
        'VALIDATION_ERROR',
        `Media URL must have a public hostname ("${entry}"). Shopify has to be able to fetch it.`,
      );
    }
    if (seen.has(url)) {
      throw new AppError('VALIDATION_ERROR', `Duplicate media URL ("${url}").`);
    }
    seen.add(url);
    return url;
  });
}

/**
 * Validates a product-creation request. `status` defaults to DRAFT: a new
 * product must not appear on the storefront unless ACTIVE is explicitly asked
 * for.
 */
export function validateProductCreate(body: Record<string, unknown>): ProductCreateRequest {
  const title = requiredString(body['title'], 'title', MAX_TITLE);

  let desiredStatus: ProductStatus = 'DRAFT';
  if (body['status'] !== undefined && body['status'] !== null) {
    const raw = String(body['status']).toUpperCase();
    if (!(STATUSES as readonly string[]).includes(raw)) {
      throw new AppError('VALIDATION_ERROR', `status must be one of ${STATUSES.join(', ')}.`);
    }
    desiredStatus = raw as ProductStatus;
  }

  // Publication intent.
  //
  // An explicit `publish` boolean always wins. When it is absent, ACTIVE is
  // interpreted as "make this visible", which is what the older API contract
  // meant and what a caller sending status:ACTIVE actually wants. The important
  // part is that this is now an explicit, named field rather than an assumption
  // buried in the meaning of `status`.
  let publishToOnlineStore: boolean;
  if (body['publish'] !== undefined && body['publish'] !== null) {
    if (typeof body['publish'] !== 'boolean') {
      throw new AppError('VALIDATION_ERROR', 'publish must be true or false.');
    }
    publishToOnlineStore = body['publish'];
  } else {
    publishToOnlineStore = desiredStatus === 'ACTIVE';
  }

  // An archived product cannot meaningfully be on sale, so this combination is a
  // mistake rather than something to silently reconcile later.
  if (publishToOnlineStore && desiredStatus === 'ARCHIVED') {
    throw new AppError(
      'VALIDATION_ERROR',
      'An ARCHIVED product cannot be published to the Online Store. Use DRAFT or ACTIVE.',
    );
  }

  const options = validateOptions(body['options']);
  const variants = validateNewVariants(body['variants'], options);
  validateVariantSet(variants, options);

  // A variant per unique option-value combination is not enforced (Shopify
  // allows a subset), but at least one priced variant is required so the product
  // is purchasable and priceable.
  if (variants.length === 0) {
    throw new AppError(
      'VALIDATION_ERROR',
      'At least one variant with a price is required so the product has a cost basis and is purchasable.',
    );
  }

  const request: ProductCreateRequest = {
    title,
    desiredStatus,
    publishToOnlineStore,
    tags: validateTags(body['tags']),
    options,
    variants,
    mediaUrls: validateMediaUrls(body['mediaUrls']),
  };
  const descriptionHtml = optionalString(body['descriptionHtml'], 'descriptionHtml', MAX_DESCRIPTION);
  if (descriptionHtml !== undefined) request.descriptionHtml = descriptionHtml;
  const vendor = optionalString(body['vendor'], 'vendor', 255);
  if (vendor !== undefined) request.vendor = vendor;
  const productType = optionalString(body['productType'], 'productType', 255);
  if (productType !== undefined) request.productType = productType;

  return request;
}

/**
 * Builds the ProductCreateInput `product` variable (step 1).
 *
 * `status` is HARD-CODED to DRAFT, regardless of `request.desiredStatus`.
 *
 * This is the single most important line in the create flow. A product is born
 * invisible and only becomes ACTIVE after its variants, costs and media are in
 * place AND publication has been verified. Creating it ACTIVE up front would put
 * a half-built product in front of customers for the duration of the remaining
 * steps - and permanently if any of them failed.
 */
export function buildProductCreateInput(
  request: ProductCreateRequest,
): Record<string, unknown> {
  const input: Record<string, unknown> = {
    title: request.title,
    status: 'DRAFT',
  };
  if (request.descriptionHtml !== undefined) input['descriptionHtml'] = request.descriptionHtml;
  if (request.vendor !== undefined) input['vendor'] = request.vendor;
  if (request.productType !== undefined) input['productType'] = request.productType;
  if (request.tags.length > 0) input['tags'] = request.tags;
  if (request.options.length > 0) {
    input['productOptions'] = request.options.map((option) => ({
      name: option.name,
      values: option.values.map((value) => ({ name: value })),
    }));
  }
  return input;
}

/** Builds the media argument for productCreate. Empty array when none. */
export function buildMediaInput(request: ProductCreateRequest): Record<string, unknown>[] {
  return request.mediaUrls.map((url) => ({
    originalSource: url,
    mediaContentType: 'IMAGE',
  }));
}

/**
 * Builds the productVariantsBulkCreate `variants` array (step 2). Empty when the
 * default variant from step 1 is acceptable as-is (no explicit variants).
 */
export function buildVariantsCreateInput(
  request: ProductCreateRequest,
): Record<string, unknown>[] {
  return request.variants.map((variant) => {
    const input: Record<string, unknown> = { price: variant.price };
    if (variant.compareAtPrice !== undefined) input['compareAtPrice'] = variant.compareAtPrice;
    if (variant.optionValues.length > 0) input['optionValues'] = variant.optionValues;
    const inventoryItem: Record<string, unknown> = {};
    if (variant.sku !== undefined) inventoryItem['sku'] = variant.sku;
    if (Object.keys(inventoryItem).length > 0) input['inventoryItem'] = inventoryItem;
    if (variant.barcode !== undefined) input['barcode'] = variant.barcode;
    return input;
  });
}
