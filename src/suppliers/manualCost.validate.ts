/**
 * Validation for the manual-cost API payload.
 *
 * Pure and separate from the persistence layer so the input rules are unit
 * testable with no database. The core invariant of the whole cost system holds
 * here too: a cost must be a positive number - 0 or negative is rejected, never
 * silently stored as "free".
 */

import { AppError } from '../common/errors';
import { toShopifyGid } from '../common/validate';
import type { SupplierClassification } from './supplier.types';

export interface ManualCostInput {
  shopifyProductId: string;
  /** Null means the cost applies to the product as a whole (all variants). */
  shopifyVariantId: string | null;
  supplierProductCost: number;
  supplierShippingCost: number | null;
  currencyCode: string;
  provider: SupplierClassification;
  /** When true, this value overrides Shopify's cost per item. */
  override: boolean;
  note: string | null;
}

const PROVIDERS: readonly SupplierClassification[] = ['TRADELLE', 'OTHER', 'UNKNOWN'];
/** ISO-4217-ish: three ASCII letters. Not an exhaustive currency list. */
const CURRENCY = /^[A-Za-z]{3}$/;

function requirePositive(raw: unknown, field: string): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw new AppError('VALIDATION_ERROR', `${field} must be a number.`);
  }
  if (raw <= 0) {
    // The central rule: a cost is positive or it is unknown. Storing 0 would let
    // automation price a product as if it were free.
    throw new AppError(
      'VALIDATION_ERROR',
      `${field} must be greater than 0. Omit it entirely if the cost is unknown - it is never stored as zero.`,
    );
  }
  return raw;
}

function optionalPositive(raw: unknown, field: string): number | null {
  if (raw === undefined || raw === null) return null;
  return requirePositive(raw, field);
}

/**
 * Validates and normalises a manual-cost request body.
 *
 * Throws VALIDATION_ERROR on any problem, so the controller stays a thin shell.
 */
export function validateManualCostInput(body: Record<string, unknown>): ManualCostInput {
  const rawProduct = body['shopifyProductId'];
  if (typeof rawProduct !== 'string' || rawProduct.trim().length === 0) {
    throw new AppError('VALIDATION_ERROR', 'shopifyProductId is required.');
  }
  // Accepts a numeric id or a full GID and normalises to a Product GID; this
  // also rejects an Order/Customer GID passed by mistake.
  const shopifyProductId = toShopifyGid(rawProduct, 'Product');

  let shopifyVariantId: string | null = null;
  const rawVariant = body['shopifyVariantId'];
  if (rawVariant !== undefined && rawVariant !== null && rawVariant !== '') {
    if (typeof rawVariant !== 'string') {
      throw new AppError('VALIDATION_ERROR', 'shopifyVariantId must be a string.');
    }
    shopifyVariantId = toShopifyGid(rawVariant, 'ProductVariant');
  }

  const currencyRaw = body['currencyCode'];
  if (typeof currencyRaw !== 'string' || !CURRENCY.test(currencyRaw)) {
    throw new AppError(
      'VALIDATION_ERROR',
      'currencyCode must be a 3-letter code, e.g. GBP or INR.',
    );
  }

  let provider: SupplierClassification = 'UNKNOWN';
  const providerRaw = body['provider'];
  if (providerRaw !== undefined && providerRaw !== null) {
    if (
      typeof providerRaw !== 'string' ||
      !(PROVIDERS as readonly string[]).includes(providerRaw.toUpperCase())
    ) {
      throw new AppError(
        'VALIDATION_ERROR',
        `provider must be one of ${PROVIDERS.join(', ')}.`,
      );
    }
    provider = providerRaw.toUpperCase() as SupplierClassification;
  }

  let note: string | null = null;
  const noteRaw = body['note'];
  if (noteRaw !== undefined && noteRaw !== null) {
    if (typeof noteRaw !== 'string' || noteRaw.length > 500) {
      throw new AppError('VALIDATION_ERROR', 'note must be a string of at most 500 characters.');
    }
    note = noteRaw.length > 0 ? noteRaw : null;
  }

  return {
    shopifyProductId,
    shopifyVariantId,
    supplierProductCost: requirePositive(body['supplierProductCost'], 'supplierProductCost'),
    supplierShippingCost: optionalPositive(body['supplierShippingCost'], 'supplierShippingCost'),
    currencyCode: currencyRaw.toUpperCase(),
    provider,
    override: body['override'] === true,
    note,
  };
}
