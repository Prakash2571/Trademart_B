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
 * Shopify's per-product variant ceiling on a standard plan.
 *
 * Checked here rather than left to Shopify because of WHEN the failure would
 * otherwise happen. The create flow makes the product first and adds variants
 * second, so a rejection at the variant step leaves an orphaned DRAFT product
 * behind and returns a partial success. Every check that can run BEFORE the first
 * write is one that cannot produce that outcome.
 */
const MAX_VARIANTS = 100;

/**
 * Media items per create. Shopify accepts more, but each one is an EPS fetch that
 * can fail independently, and a request carrying hundreds of URLs is far more
 * likely to be a mistake than an intent.
 */
const MAX_MEDIA = 20;

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
   * Status the product is CREATED with. Always DRAFT: a product is never
   * created ACTIVE, because ACTIVE without a sales-channel publication is
   * invisible-but-looks-live. Activation happens only after a verified publish.
   */
  status: ProductStatus;
  /**
   * Whether to publish + activate after creation. Set by `publish: true`, or by
   * the legacy `status: 'ACTIVE'`. When true the service publishes to the Online
   * Store, verifies it, and only then sets ACTIVE; on failure the product is
   * left DRAFT.
   */
  publish: boolean;
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
    throw new AppError(
      'VALIDATION_ERROR',
      `A product may have at most ${MAX_OPTIONS} options, and this request has ${raw.length}.`,
    );
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
  if (raw.length > MAX_VARIANTS) {
    throw new AppError(
      'VALIDATION_ERROR',
      `A product may have at most ${MAX_VARIANTS} variants, and this request has ${raw.length}. Rejected before the product is created, so there is no half-built product to clean up.`,
    );
  }

  // Cross-variant uniqueness. Shopify would reject these itself, but only at the
  // variant step - AFTER the product exists - which turns a fixable request error
  // into an orphaned DRAFT product and a partial success. Caught here instead.
  const seenSkus = new Map<string, number>();
  const seenBarcodes = new Map<string, number>();
  const seenCombinations = new Map<string, number>();

  const variants = raw.map((entry, index) => {
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
      variant.sku = sku;
      // Compared case-insensitively: Shopify treats SKUs as distinct strings, but
      // "ABC-1" and "abc-1" in one product is a data-entry mistake every time, and
      // it makes the created-variant mapping ambiguous for the frontend, which
      // matches returned variants back by SKU.
      const key = sku.trim().toLowerCase();
      const first = seenSkus.get(key);
      if (first !== undefined) {
        throw new AppError(
          'VALIDATION_ERROR',
          `Variants ${first} and ${index + 1} share the SKU "${sku}". SKUs must be unique within a product, otherwise the created variants cannot be told apart.`,
        );
      }
      seenSkus.set(key, index + 1);
    }

    const barcode = optionalString(v['barcode'], `variant ${index + 1} barcode`, 255);
    if (barcode !== undefined) {
      variant.barcode = barcode;
      const key = barcode.trim().toLowerCase();
      const first = seenBarcodes.get(key);
      if (first !== undefined) {
        throw new AppError(
          'VALIDATION_ERROR',
          `Variants ${first} and ${index + 1} share the barcode "${barcode}". A barcode identifies a physical item, so two variants cannot have the same one.`,
        );
      }
      seenBarcodes.set(key, index + 1);
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

      // Two variants cannot occupy the same point in the option grid - there would
      // be no way for a customer to choose between them, and Shopify rejects it.
      // Sorted by option name so the key does not depend on the order the caller
      // happened to list the values in.
      const combination = [...variant.optionValues]
        .sort((a, b) => a.optionName.localeCompare(b.optionName))
        .map((pair) => `${pair.optionName.toLowerCase()}=${pair.name.toLowerCase()}`)
        .join(' / ');
      const first = seenCombinations.get(combination);
      if (first !== undefined) {
        throw new AppError(
          'VALIDATION_ERROR',
          `Variants ${first} and ${index + 1} have the same option combination (${combination}). Each combination must be unique, otherwise a customer could not choose between them.`,
        );
      }
      seenCombinations.set(combination, index + 1);
    }
    return variant;
  });

  // A product with declared options and no variants would be created with only
  // Shopify's implicit default variant, silently ignoring the options - so the
  // request did not mean what it said.
  if (options.length > 0 && variants.length === 0) {
    throw new AppError(
      'VALIDATION_ERROR',
      `${options.length} option(s) were declared but no variants were supplied, so the options would be ignored. Supply one variant per option combination.`,
    );
  }

  return variants;
}

function validateMediaUrls(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new AppError('VALIDATION_ERROR', 'mediaUrls must be an array of URLs.');
  }
  if (raw.length > MAX_MEDIA) {
    throw new AppError(
      'VALIDATION_ERROR',
      `At most ${MAX_MEDIA} media URLs may be supplied, and this request has ${raw.length}.`,
    );
  }

  const seen = new Map<string, number>();
  return raw.map((entry, index) => {
    if (typeof entry !== 'string') {
      throw new AppError('VALIDATION_ERROR', 'Each media URL must be a string.');
    }
    const url = entry.trim();

    // Must be an absolute https URL: Shopify fetches it from EPS.
    if (!/^https:\/\/.+/i.test(url)) {
      throw new AppError('VALIDATION_ERROR', `Media URL must be an https URL ("${entry}").`);
    }

    // Parsed, not just pattern-matched. "https://" passes the regex above with an
    // empty host, and Shopify's EPS fetch would fail asynchronously AFTER the
    // product exists - producing an image-less product with no obvious cause.
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new AppError('VALIDATION_ERROR', `Media URL is not a valid URL ("${entry}").`);
    }
    if (parsed.hostname.length === 0) {
      throw new AppError('VALIDATION_ERROR', `Media URL has no host ("${entry}").`);
    }
    // Shopify's image fetcher has to be able to reach it from the internet.
    if (parsed.hostname === 'localhost' || parsed.hostname.startsWith('127.')) {
      throw new AppError(
        'VALIDATION_ERROR',
        `Media URL "${entry}" points at localhost, which Shopify cannot reach. Use a publicly accessible https URL.`,
      );
    }

    const first = seen.get(url.toLowerCase());
    if (first !== undefined) {
      throw new AppError(
        'VALIDATION_ERROR',
        `Media URL ${first} and ${index + 1} are the same ("${entry}"), which would upload the image twice.`,
      );
    }
    seen.set(url.toLowerCase(), index + 1);

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

  // The product is ALWAYS created DRAFT. `publish: true` (or the legacy
  // status: 'ACTIVE') requests the create+publish+activate flow, which the
  // service performs only after verifying publication.
  let publish = body['publish'] === true;
  if (body['status'] !== undefined && body['status'] !== null) {
    const raw = String(body['status']).toUpperCase();
    if (!(STATUSES as readonly string[]).includes(raw)) {
      throw new AppError('VALIDATION_ERROR', `status must be one of ${STATUSES.join(', ')}.`);
    }
    if (raw === 'ACTIVE') publish = true;
  }
  const status: ProductStatus = 'DRAFT';

  const options = validateOptions(body['options']);
  const variants = validateNewVariants(body['variants'], options);

  // The FULL option grid is not required - Shopify allows a subset of
  // combinations - but validateNewVariants does reject DUPLICATE combinations,
  // and at least one priced variant is required here so the product is
  // purchasable and priceable.
  if (variants.length === 0) {
    throw new AppError(
      'VALIDATION_ERROR',
      'At least one variant with a price is required so the product has a cost basis and is purchasable.',
    );
  }

  const tags = Array.isArray(body['tags'])
    ? (body['tags'] as unknown[]).filter((t): t is string => typeof t === 'string').map((t) => t.trim()).filter((t) => t.length > 0 && !t.includes(','))
    : [];

  const request: ProductCreateRequest = {
    title,
    status,
    publish,
    tags,
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

/** Builds the ProductCreateInput `product` variable (step 1). */
export function buildProductCreateInput(
  request: ProductCreateRequest,
): Record<string, unknown> {
  const input: Record<string, unknown> = {
    title: request.title,
    status: request.status,
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
