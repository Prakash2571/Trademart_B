import { StorefrontError } from './storefront.error';
import type {
  CheckoutCustomer,
  CreateCheckoutRequest,
  RequestedCheckoutLine,
  ShippingAddress,
} from './checkout.types';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INDIA_PHONE = /^[6-9]\d{9}$/;
const INDIA_PIN = /^\d{6}$/;
const SAFE_ID = /^[A-Za-z0-9_:/.-]{1,255}$/;

/**
 * Largest quantity accepted for one variant in one checkout.
 *
 * THIS WAS 10, AND THAT WAS A BUG FOR THIS BUSINESS.
 * A wholesale marketplace whose checkout refuses an eleventh unit is not a wholesale
 * marketplace: it made every bulk order impossible, and it would have rejected any product
 * carrying an MOQ above 10 outright - the storefront would advertise "MOQ 12" and the
 * checkout would answer "maximum 10". The cap was a sensible retail guard inherited from a
 * single-item storefront, and it quietly contradicted the whole point of the product.
 *
 * A cap is still needed. It bounds the arithmetic (quantity x price must stay a safe
 * integer in paise), it bounds what one request can ask Shopify to reserve, and it stops a
 * fat-fingered 100000 from becoming an order. 10,000 units of one variant is far beyond any
 * plausible order here and far below anything that could overflow; MAX_MINIMUM_ORDER_QUANTITY
 * in catalog/moq.ts is pinned to the same number so an MOQ can never exceed what the
 * checkout will accept.
 */
export const MAX_LINE_QUANTITY = 10_000;

function object(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new StorefrontError('VALIDATION_ERROR', `${field} must be an object.`, 400);
  }
  return value as Record<string, unknown>;
}

function text(
  value: unknown,
  field: string,
  options: { min?: number; max: number; optional?: boolean },
): string | null {
  if ((value === undefined || value === null || value === '') && options.optional) return null;
  if (typeof value !== 'string') {
    throw new StorefrontError('VALIDATION_ERROR', `${field} is required.`, 400);
  }
  const normalised = value.trim().replace(/\s+/g, ' ');
  const min = options.min ?? 1;
  if (normalised.length < min || normalised.length > options.max || /[\u0000-\u001f\u007f]/.test(normalised)) {
    throw new StorefrontError(
      'VALIDATION_ERROR',
      `${field} must be between ${min} and ${options.max} characters.`,
      400,
    );
  }
  return normalised;
}

function identifier(value: unknown, field: string): string {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    throw new StorefrontError('VALIDATION_ERROR', `${field} is invalid.`, 400);
  }
  return value;
}

function parseCustomer(value: unknown): CheckoutCustomer {
  const raw = object(value, 'customer');
  const fullName = text(raw['fullName'], 'Full name', { min: 2, max: 100 })!;
  const email = text(raw['email'], 'Email', { max: 254 })!.toLowerCase();
  if (!EMAIL.test(email)) {
    throw new StorefrontError('VALIDATION_ERROR', 'Enter a valid email address.', 400);
  }

  const phoneDigits = String(raw['phone'] ?? '').replace(/[^\d]/g, '');
  const nationalPhone = phoneDigits.startsWith('91') && phoneDigits.length === 12
    ? phoneDigits.slice(2)
    : phoneDigits;
  if (!INDIA_PHONE.test(nationalPhone)) {
    throw new StorefrontError('VALIDATION_ERROR', 'Enter a valid 10-digit Indian mobile number.', 400);
  }

  return { fullName, email, phone: `+91${nationalPhone}` };
}

function parseAddress(value: unknown): ShippingAddress {
  const raw = object(value, 'shippingAddress');
  const country = String(raw['countryCode'] ?? raw['country'] ?? 'IN').trim().toUpperCase();
  if (country !== 'IN' && country !== 'INDIA') {
    throw new StorefrontError('VALIDATION_ERROR', 'Kanay Store currently ships only within India.', 400);
  }
  const pinCode = String(raw['pinCode'] ?? raw['postalCode'] ?? '').trim();
  if (!INDIA_PIN.test(pinCode)) {
    throw new StorefrontError('VALIDATION_ERROR', 'Enter a valid 6-digit PIN code.', 400);
  }
  return {
    addressLine1: text(raw['addressLine1'] ?? raw['line1'], 'Address line 1', { min: 3, max: 150 })!,
    addressLine2: text(raw['addressLine2'] ?? raw['line2'], 'Address line 2', { max: 150, optional: true }),
    city: text(raw['city'], 'City', { min: 2, max: 80 })!,
    state: text(raw['state'], 'State', { min: 2, max: 80 })!,
    pinCode,
    countryCode: 'IN',
  };
}

function parseLines(value: unknown): RequestedCheckoutLine[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 50) {
    throw new StorefrontError('VALIDATION_ERROR', 'Cart must contain between 1 and 50 items.', 400);
  }

  const combined = new Map<string, RequestedCheckoutLine>();
  for (const [index, entry] of value.entries()) {
    const raw = object(entry, `lines[${index}]`);

    // Accept both opaque ids (productId/variantId) and Shopify GIDs (shopifyProductId/shopifyVariantId).
    // The opaque ids are the primary identity; Shopify ids are cross-checked in the adapter.
    const productId = identifier(
      raw['productId'] ?? raw['shopifyProductId'],
      `lines[${index}].productId`,
    );
    const variantId = identifier(
      raw['variantId'] ?? raw['shopifyVariantId'],
      `lines[${index}].variantId`,
    );

    // Preserve browser-supplied Shopify GIDs for cross-checking
    const browserShopifyVariantId =
      typeof raw['shopifyVariantId'] === 'string' && SAFE_ID.test(raw['shopifyVariantId'])
        ? raw['shopifyVariantId']
        : undefined;
    const browserShopifyProductId =
      typeof raw['shopifyProductId'] === 'string' && SAFE_ID.test(raw['shopifyProductId'])
        ? raw['shopifyProductId']
        : undefined;

    const quantity = raw['quantity'];
    if (
      !Number.isSafeInteger(quantity) ||
      (quantity as number) < 1 ||
      (quantity as number) > MAX_LINE_QUANTITY
    ) {
      throw new StorefrontError(
        'VALIDATION_ERROR',
        `Quantity for item ${index + 1} must be a whole number from 1 to ${MAX_LINE_QUANTITY}.`,
        400,
      );
    }
    const expected = raw['expectedUnitPricePaise'];
    if (expected !== undefined && (!Number.isSafeInteger(expected) || (expected as number) < 0)) {
      throw new StorefrontError('VALIDATION_ERROR', 'Displayed item price is invalid.', 400);
    }

    const key = `${productId}\u0000${variantId}`;
    const existing = combined.get(key);
    if (existing) {
      const total = existing.quantity + (quantity as number);
      if (total > MAX_LINE_QUANTITY) {
        throw new StorefrontError(
          'VALIDATION_ERROR',
          `Quantity per variant cannot exceed ${MAX_LINE_QUANTITY}.`,
          400,
        );
      }
      existing.quantity = total;
      continue;
    }
    const line: RequestedCheckoutLine = { productId, variantId, quantity: quantity as number };
    if (expected !== undefined) line.expectedUnitPricePaise = expected as number;
    if (browserShopifyVariantId !== undefined) line.shopifyVariantId = browserShopifyVariantId;
    if (browserShopifyProductId !== undefined) line.shopifyProductId = browserShopifyProductId;
    combined.set(key, line);
  }
  return [...combined.values()];
}

export function validateCreateCheckoutRequest(body: unknown): CreateCheckoutRequest {
  const raw = object(body, 'request');
  return {
    lines: parseLines(raw['lines'] ?? raw['cartLines']),
    customer: parseCustomer(raw['customer']),
    shippingAddress: parseAddress(raw['shippingAddress']),
  };
}

export function validateIdempotencyKey(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{16,128}$/.test(value)) {
    throw new StorefrontError(
      'VALIDATION_ERROR',
      'A stable Idempotency-Key of 16 to 128 characters is required.',
      400,
    );
  }
  return value;
}
