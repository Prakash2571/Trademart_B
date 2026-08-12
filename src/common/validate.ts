/**
 * Small, dependency-free input validation for query params and bodies.
 * Throws VALIDATION_ERROR so the error middleware produces a 400.
 */

import { AppError } from './errors';

export function parseIntParam(
  raw: unknown,
  field: string,
  options: { min: number; max: number; fallback: number },
): number {
  if (raw === undefined || raw === null || raw === '') return options.fallback;
  if (typeof raw !== 'string' || !/^-?\d+$/.test(raw)) {
    throw new AppError('VALIDATION_ERROR', `${field} must be an integer.`);
  }
  const value = Number(raw);
  if (value < options.min || value > options.max) {
    throw new AppError(
      'VALIDATION_ERROR',
      `${field} must be between ${options.min} and ${options.max}.`,
    );
  }
  return value;
}

export function parseStringParam(
  raw: unknown,
  field: string,
  options: { maxLength?: number } = {},
): string | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string') {
    throw new AppError('VALIDATION_ERROR', `${field} must be a string.`);
  }
  const max = options.maxLength ?? 255;
  if (raw.length > max) {
    throw new AppError('VALIDATION_ERROR', `${field} must be at most ${max} characters.`);
  }
  return raw;
}

export function parseNumberField(
  raw: unknown,
  field: string,
  options: { min?: number; max?: number; required?: boolean } = {},
): number | undefined {
  if (raw === undefined || raw === null || raw === '') {
    if (options.required) {
      throw new AppError('VALIDATION_ERROR', `${field} is required.`);
    }
    return undefined;
  }
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(value)) {
    throw new AppError('VALIDATION_ERROR', `${field} must be a finite number.`);
  }
  const min = options.min ?? Number.NEGATIVE_INFINITY;
  const max = options.max ?? Number.MAX_SAFE_INTEGER;
  if (value < min) {
    throw new AppError('VALIDATION_ERROR', `${field} must be at least ${min}.`);
  }
  if (value > max) {
    throw new AppError('VALIDATION_ERROR', `${field} must be at most ${max}.`);
  }
  return value;
}

/**
 * Accepts either a raw Shopify numeric id or a full GID and returns a GID.
 * Shopify ids must be treated as opaque strings, never coerced to numbers.
 */
export function toShopifyGid(raw: string, resource: 'Product' | 'Order' | 'Customer'): string {
  const value = raw.trim();
  if (value.startsWith('gid://shopify/')) {
    const expectedPrefix = `gid://shopify/${resource}/`;
    if (!value.startsWith(expectedPrefix)) {
      throw new AppError(
        'VALIDATION_ERROR',
        `Expected a ${resource} id but received "${value}".`,
      );
    }
    return value;
  }
  if (!/^\d+$/.test(value)) {
    throw new AppError(
      'VALIDATION_ERROR',
      `id must be a Shopify numeric id or a gid://shopify/${resource}/... value.`,
    );
  }
  return `gid://shopify/${resource}/${value}`;
}
