/**
 * Product-edit validation and input building — pure.
 *
 * Separated from the Shopify calls so the rules that decide *what* is allowed to
 * change are unit testable with no network. The controller stays a thin shell.
 *
 * Safety stance: only an explicit allow-list of fields can be edited. An unknown
 * field in the request body is ignored, never forwarded to Shopify, so a typo or
 * a malicious extra key cannot reach a field this feature has no business
 * touching. Tags are add/remove (surgical), never a wholesale replace.
 */

import { AppError } from '../common/errors';

export type ProductStatus = 'ACTIVE' | 'ARCHIVED' | 'DRAFT';
const STATUSES: readonly ProductStatus[] = ['ACTIVE', 'ARCHIVED', 'DRAFT'];

/** Scalar product fields this feature may change. Tags/variants are separate. */
export interface ProductUpdateFields {
  title?: string;
  descriptionHtml?: string;
  vendor?: string;
  productType?: string;
  status?: ProductStatus;
}

export interface VariantPriceUpdate {
  id: string;
  /** New price as a decimal string, or undefined to leave unchanged. */
  price?: string;
  /** New compare-at price, null to CLEAR it, or undefined to leave unchanged. */
  compareAtPrice?: string | null;
}

export interface ProductEditRequest {
  fields: ProductUpdateFields;
  addTags: string[];
  removeTags: string[];
  variants: VariantPriceUpdate[];
}

const MAX_TITLE = 255;
const MAX_VENDOR = 255;
const MAX_TYPE = 255;
const MAX_DESCRIPTION = 100_000;
const MAX_TAGS = 250;

function optionalString(
  raw: unknown,
  field: string,
  maxLength: number,
): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') {
    throw new AppError('VALIDATION_ERROR', `${field} must be a string.`);
  }
  if (raw.length > maxLength) {
    throw new AppError('VALIDATION_ERROR', `${field} must be at most ${maxLength} characters.`);
  }
  return raw;
}

/** A price string: positive decimal, at most 2 fractional digits. */
function priceString(raw: unknown, field: string): string {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw <= 0) {
      throw new AppError('VALIDATION_ERROR', `${field} must be greater than 0.`);
    }
    return raw.toFixed(2);
  }
  if (typeof raw === 'string' && /^\d+(\.\d{1,2})?$/.test(raw.trim())) {
    const value = Number(raw);
    if (value <= 0) {
      throw new AppError('VALIDATION_ERROR', `${field} must be greater than 0.`);
    }
    return value.toFixed(2);
  }
  throw new AppError(
    'VALIDATION_ERROR',
    `${field} must be a positive amount like "24.99".`,
  );
}

function validateTags(raw: unknown, field: string): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new AppError('VALIDATION_ERROR', `${field} must be an array of strings.`);
  }
  if (raw.length > MAX_TAGS) {
    throw new AppError('VALIDATION_ERROR', `${field} may contain at most ${MAX_TAGS} tags.`);
  }
  const tags: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') {
      throw new AppError('VALIDATION_ERROR', `${field} must contain only strings.`);
    }
    const trimmed = entry.trim();
    // Shopify tags cannot contain commas - it uses them as the separator.
    if (trimmed.includes(',')) {
      throw new AppError('VALIDATION_ERROR', `A tag must not contain a comma ("${entry}").`);
    }
    if (trimmed.length === 0 || trimmed.length > 255) {
      throw new AppError('VALIDATION_ERROR', `Each tag must be 1-255 characters.`);
    }
    tags.push(trimmed);
  }
  // De-duplicate case-insensitively, keeping first spelling.
  const seen = new Set<string>();
  return tags.filter((tag) => {
    const key = tag.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function validateVariants(raw: unknown): VariantPriceUpdate[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new AppError('VALIDATION_ERROR', 'variants must be an array.');
  }
  const out: VariantPriceUpdate[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) {
      throw new AppError('VALIDATION_ERROR', 'Each variant must be an object.');
    }
    const v = entry as Record<string, unknown>;
    const id = v['id'];
    if (typeof id !== 'string' || !id.startsWith('gid://shopify/ProductVariant/')) {
      throw new AppError(
        'VALIDATION_ERROR',
        'Each variant needs an id like gid://shopify/ProductVariant/123.',
      );
    }

    const update: VariantPriceUpdate = { id };
    if (v['price'] !== undefined) update.price = priceString(v['price'], 'variant price');

    if (v['compareAtPrice'] !== undefined) {
      // null explicitly clears the compare-at price (removes a strikethrough).
      update.compareAtPrice =
        v['compareAtPrice'] === null
          ? null
          : priceString(v['compareAtPrice'], 'variant compareAtPrice');
    }

    if (update.price === undefined && update.compareAtPrice === undefined) {
      throw new AppError(
        'VALIDATION_ERROR',
        `Variant ${id} has nothing to change (set price and/or compareAtPrice).`,
      );
    }

    // A compare-at price below the price is a meaningless "sale" - reject it.
    if (
      typeof update.compareAtPrice === 'string' &&
      update.price !== undefined &&
      Number(update.compareAtPrice) < Number(update.price)
    ) {
      throw new AppError(
        'VALIDATION_ERROR',
        `Variant ${id}: compareAtPrice (${update.compareAtPrice}) must be at least the price (${update.price}).`,
      );
    }
    out.push(update);
  }
  return out;
}

/**
 * Validates and normalises a product-edit request body.
 *
 * Throws VALIDATION_ERROR when nothing valid to change was supplied, so an empty
 * request is a clear error rather than a silent no-op write.
 */
export function validateProductEdit(body: Record<string, unknown>): ProductEditRequest {
  const fields: ProductUpdateFields = {};

  const title = optionalString(body['title'], 'title', MAX_TITLE);
  if (title !== undefined) {
    if (title.trim().length === 0) {
      throw new AppError('VALIDATION_ERROR', 'title must not be blank.');
    }
    fields.title = title;
  }

  const descriptionHtml = optionalString(
    body['descriptionHtml'],
    'descriptionHtml',
    MAX_DESCRIPTION,
  );
  if (descriptionHtml !== undefined) fields.descriptionHtml = descriptionHtml;

  const vendor = optionalString(body['vendor'], 'vendor', MAX_VENDOR);
  if (vendor !== undefined) fields.vendor = vendor;

  const productType = optionalString(body['productType'], 'productType', MAX_TYPE);
  if (productType !== undefined) fields.productType = productType;

  if (body['status'] !== undefined && body['status'] !== null) {
    const raw = String(body['status']).toUpperCase();
    if (!(STATUSES as readonly string[]).includes(raw)) {
      throw new AppError(
        'VALIDATION_ERROR',
        `status must be one of ${STATUSES.join(', ')}.`,
      );
    }
    fields.status = raw as ProductStatus;
  }

  const addTags = validateTags(body['addTags'], 'addTags');
  const removeTags = validateTags(body['removeTags'], 'removeTags');
  const variants = validateVariants(body['variants']);

  const nothingToDo =
    Object.keys(fields).length === 0 &&
    addTags.length === 0 &&
    removeTags.length === 0 &&
    variants.length === 0;
  if (nothingToDo) {
    throw new AppError(
      'VALIDATION_ERROR',
      'No changes supplied. Provide at least one of: title, descriptionHtml, vendor, productType, status, addTags, removeTags, variants.',
    );
  }

  return { fields, addTags, removeTags, variants };
}

/**
 * Builds the `product` variable for the productUpdate mutation from validated
 * fields. Returns null when there are no scalar fields to update (tags/variants
 * go through their own mutations), so the caller can skip the call entirely.
 */
export function buildProductUpdateInput(
  productGid: string,
  fields: ProductUpdateFields,
): Record<string, unknown> | null {
  if (Object.keys(fields).length === 0) return null;
  const input: Record<string, unknown> = { id: productGid };
  if (fields.title !== undefined) input['title'] = fields.title;
  if (fields.descriptionHtml !== undefined) input['descriptionHtml'] = fields.descriptionHtml;
  if (fields.vendor !== undefined) input['vendor'] = fields.vendor;
  if (fields.productType !== undefined) input['productType'] = fields.productType;
  if (fields.status !== undefined) input['status'] = fields.status;
  return input;
}

/** Builds the ProductVariantsBulkInput array. Empty when no variants change. */
export function buildVariantBulkInput(
  variants: readonly VariantPriceUpdate[],
): Record<string, unknown>[] {
  return variants.map((variant) => {
    const input: Record<string, unknown> = { id: variant.id };
    if (variant.price !== undefined) input['price'] = variant.price;
    // null is forwarded to clear the compare-at price; undefined is omitted.
    if (variant.compareAtPrice !== undefined) {
      input['compareAtPrice'] = variant.compareAtPrice;
    }
    return input;
  });
}
