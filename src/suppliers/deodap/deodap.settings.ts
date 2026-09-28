/**
 * DeoDap settings and credential input - pure.
 *
 * Two different kinds of data live on the DeoDap connection record, and they are
 * handled very differently:
 *
 *   settings      Not secret. SKU prefixes, the currency DeoDap charges in, and the
 *                 defaults the CSV importer prices with. Returned by the API.
 *   credentials   Secret. An API key or a DeoDap account login. Encrypted with
 *                 TOKEN_ENCRYPTION_KEY before storage (common/crypto.ts), NEVER
 *                 returned by any route, and not used by anything yet, because there
 *                 is no DeoDap API to send them to (deodap.api.ts). They are kept so
 *                 the API client can use them the day it exists.
 *
 * Validation lives here so every rule is unit testable without a database.
 */

import { AppError } from '../../common/errors';
import { isExplicitCurrencyCode, roundMoney } from '../../common/money';
import type { PriceRounding } from '../../pricing/rounding';
import type { DeodapCredentials } from './deodap.api';
import {
  DEODAP_VENDOR,
  MAX_SKU_PREFIXES,
  MAX_SKU_PREFIX_LENGTH,
  SKU_PREFIX_PATTERN,
} from './deodap.identify';

/**
 * How the importer sets a selling price.
 *
 *   MARKUP  cost (plus shipping, when included) plus a percentage
 *   RETAIL  the MRP / retail price column from the file, when a row has one
 */
export type DeodapPricingMode = 'MARKUP' | 'RETAIL';

export interface DeodapSettings {
  /** SKU prefixes that identify a DeoDap product. Empty means "do not match on SKU". */
  skuPrefixes: string[];
  /** The currency DeoDap charges in. DeoDap is an Indian supplier, so INR by default. */
  currencyCode: string;
  /**
   * The vendor written on imported products. Defaults to "DeoDap", which is also how
   * they are recognised. Many themes show the vendor to customers, so a store that
   * does not want to name its supplier can use its own brand here. Imported products
   * always carry the DeoDap tag as well, so they are still recognised.
   */
  vendorName: string;
  pricingMode: DeodapPricingMode;
  /** Percentage added to the DeoDap cost when pricingMode is MARKUP. */
  markupPercent: number;
  priceRounding: PriceRounding;
  /** Whether a DeoDap shipping charge is added to the cost before the markup. */
  includeShippingInPrice: boolean;
  /** Whether the MRP column becomes the "compare at" price when it is higher. */
  compareAtFromRetail: boolean;
}

export const DEFAULT_DEODAP_SETTINGS: Readonly<DeodapSettings> = Object.freeze({
  skuPrefixes: [],
  currencyCode: 'INR',
  vendorName: DEODAP_VENDOR,
  pricingMode: 'MARKUP',
  markupPercent: 50,
  priceRounding: 'integer',
  includeShippingInPrice: true,
  compareAtFromRetail: true,
});

export const MAX_MARKUP_PERCENT = 1000;
const MAX_VENDOR_LENGTH = 100;
export const PRICE_ROUNDINGS: readonly PriceRounding[] = ['none', 'charm99', 'integer'];
export const PRICING_MODES: readonly DeodapPricingMode[] = ['MARKUP', 'RETAIL'];

/** A fresh copy of the defaults, so callers can never mutate the frozen object's array. */
export function defaultDeodapSettings(): DeodapSettings {
  return { ...DEFAULT_DEODAP_SETTINGS, skuPrefixes: [] };
}

function fail(message: string): never {
  throw new AppError('VALIDATION_ERROR', message);
}

function readBoolean(raw: unknown, field: string): boolean {
  if (typeof raw !== 'boolean') fail(`${field} must be true or false.`);
  return raw;
}

/** Validates the SKU prefix list exactly as the operator typed it. */
export function validateSkuPrefixes(raw: unknown): string[] {
  if (!Array.isArray(raw)) fail('skuPrefixes must be a list of prefixes.');
  const seen = new Set<string>();
  const prefixes: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') fail('Each SKU prefix must be text.');
    const prefix = entry.trim();
    if (prefix.length === 0) continue;
    if (prefix.length > MAX_SKU_PREFIX_LENGTH) {
      fail(`SKU prefix "${prefix}" is longer than ${MAX_SKU_PREFIX_LENGTH} characters.`);
    }
    if (!SKU_PREFIX_PATTERN.test(prefix)) {
      fail(
        `SKU prefix "${prefix}" must start with a letter or digit and use only letters, digits, dot, dash, underscore or slash.`,
      );
    }
    const key = prefix.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    prefixes.push(prefix);
  }
  if (prefixes.length > MAX_SKU_PREFIXES) {
    fail(`At most ${MAX_SKU_PREFIXES} SKU prefixes can be set.`);
  }
  return prefixes;
}

export function validateMarkupPercent(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    fail('markupPercent must be a number, for example 50 for a 50% markup.');
  }
  if (raw < 0 || raw > MAX_MARKUP_PERCENT) {
    fail(`markupPercent must be between 0 and ${MAX_MARKUP_PERCENT}.`);
  }
  return roundMoney(raw, 'markupPercent');
}

export function validatePriceRounding(raw: unknown): PriceRounding {
  if (typeof raw !== 'string' || !(PRICE_ROUNDINGS as readonly string[]).includes(raw)) {
    fail(`priceRounding must be one of ${PRICE_ROUNDINGS.join(', ')}.`);
  }
  return raw as PriceRounding;
}

export function validatePricingMode(raw: unknown): DeodapPricingMode {
  const value = typeof raw === 'string' ? raw.toUpperCase() : raw;
  if (typeof value !== 'string' || !(PRICING_MODES as readonly string[]).includes(value)) {
    fail(`pricingMode must be one of ${PRICING_MODES.join(', ')}.`);
  }
  return value as DeodapPricingMode;
}

export function validateCurrencyCode(raw: unknown): string {
  if (!isExplicitCurrencyCode(raw)) {
    fail('currencyCode must be a 3-letter currency code, for example INR.');
  }
  return raw.trim().toUpperCase();
}

function validateVendorName(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim().length === 0) fail('vendorName is required.');
  const vendor = raw.trim();
  if (vendor.length > MAX_VENDOR_LENGTH) {
    fail(`vendorName must be at most ${MAX_VENDOR_LENGTH} characters.`);
  }
  return vendor;
}

/**
 * Applies a settings update on top of the current settings.
 *
 * Every field is optional, so the settings form can send only what changed. A field
 * that is present but invalid is an error, never silently ignored: a markup that did
 * not save would price the next import differently from what the operator expects.
 */
export function validateDeodapSettings(
  body: Record<string, unknown>,
  current: DeodapSettings,
): DeodapSettings {
  const next: DeodapSettings = { ...current, skuPrefixes: [...current.skuPrefixes] };
  if (body['skuPrefixes'] !== undefined) next.skuPrefixes = validateSkuPrefixes(body['skuPrefixes']);
  if (body['currencyCode'] !== undefined) next.currencyCode = validateCurrencyCode(body['currencyCode']);
  if (body['vendorName'] !== undefined) next.vendorName = validateVendorName(body['vendorName']);
  if (body['pricingMode'] !== undefined) next.pricingMode = validatePricingMode(body['pricingMode']);
  if (body['markupPercent'] !== undefined) {
    next.markupPercent = validateMarkupPercent(body['markupPercent']);
  }
  if (body['priceRounding'] !== undefined) {
    next.priceRounding = validatePriceRounding(body['priceRounding']);
  }
  if (body['includeShippingInPrice'] !== undefined) {
    next.includeShippingInPrice = readBoolean(body['includeShippingInPrice'], 'includeShippingInPrice');
  }
  if (body['compareAtFromRetail'] !== undefined) {
    next.compareAtFromRetail = readBoolean(body['compareAtFromRetail'], 'compareAtFromRetail');
  }
  return next;
}

/**
 * Reads settings back from storage, tolerating anything malformed.
 *
 * A stored field that no longer validates falls back to its default instead of
 * failing every DeoDap page. What was written was validated, so this only matters
 * after a hand edit in the database or a change to the rules.
 */
export function readStoredSettings(raw: unknown): DeodapSettings {
  const settings = defaultDeodapSettings();
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return settings;
  const stored = raw as Record<string, unknown>;
  for (const key of Object.keys(settings) as (keyof DeodapSettings)[]) {
    if (stored[key] === undefined) continue;
    try {
      const merged = validateDeodapSettings({ [key]: stored[key] }, settings);
      (settings as unknown as Record<string, unknown>)[key] = merged[key];
    } catch {
      // Keep the default for this field only.
    }
  }
  return settings;
}

/* ===========================================================================
 * Credentials
 * ======================================================================== */

export type DeodapCredentialKind = DeodapCredentials['kind'];

export interface DeodapCredentialsInput {
  credentials: DeodapCredentials;
  /** A non-secret label to recognise the account by, e.g. a reseller ID. */
  accountLabel: string | null;
}

function readString(raw: unknown, field: string): string {
  if (typeof raw !== 'string') fail(`${field} is required.`);
  return raw;
}

/**
 * Validates a credentials submission.
 *
 * Error messages never echo the value, so a mistyped API key does not end up in a log
 * line or an error body.
 */
export function validateDeodapCredentials(body: Record<string, unknown>): DeodapCredentialsInput {
  const kind = body['kind'];
  let accountLabel: string | null = null;
  const rawLabel = body['accountLabel'];
  if (rawLabel !== undefined && rawLabel !== null) {
    if (typeof rawLabel !== 'string') fail('accountLabel must be text.');
    const label = rawLabel.trim();
    if (label.length > 100) fail('accountLabel must be at most 100 characters.');
    accountLabel = label.length > 0 ? label : null;
  }

  if (kind === 'API_KEY') {
    const apiKey = readString(body['apiKey'], 'apiKey').trim();
    if (apiKey.length < 8 || apiKey.length > 500) {
      fail('The API key must be between 8 and 500 characters.');
    }
    if (/\s/.test(apiKey)) fail('The API key must not contain spaces or line breaks.');
    return { credentials: { kind: 'API_KEY', apiKey }, accountLabel };
  }

  if (kind === 'ACCOUNT_LOGIN') {
    const username = readString(body['username'], 'username').trim();
    if (username.length < 3 || username.length > 200) {
      fail('The DeoDap login (email or mobile number) must be between 3 and 200 characters.');
    }
    // Not trimmed: a password may legitimately start or end with a space.
    const password = readString(body['password'], 'password');
    if (password.length < 6 || password.length > 200) {
      fail('The DeoDap password must be between 6 and 200 characters.');
    }
    return { credentials: { kind: 'ACCOUNT_LOGIN', username, password }, accountLabel };
  }

  return fail('kind must be API_KEY or ACCOUNT_LOGIN.');
}

const MASK = '\u2022\u2022\u2022\u2022';

/**
 * A recognisable but useless form of the credential, for the UI and the audit trail.
 *
 * API key: only the last four characters. Login: the first two characters and, for
 * an email, the domain. Enough to tell two accounts apart, not enough to use either.
 */
export function maskDeodapIdentifier(credentials: DeodapCredentials): string {
  if (credentials.kind === 'API_KEY') {
    const key = credentials.apiKey;
    return key.length >= 12 ? `${MASK}${key.slice(-4)}` : MASK;
  }
  const username = credentials.username;
  const at = username.indexOf('@');
  if (at > 0) {
    return `${username.slice(0, Math.min(2, at))}${MASK}${username.slice(at)}`;
  }
  return username.length > 6 ? `${username.slice(0, 2)}${MASK}${username.slice(-2)}` : MASK;
}
