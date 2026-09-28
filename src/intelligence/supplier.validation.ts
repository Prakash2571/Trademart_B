/**
 * Validating an operator's supplier (Tradelle or DeoDap) verification.
 *
 * PURE, and separate from intelligence.service.ts for the usual reason: that module imports
 * the config singleton, which calls process.exit(1) at import, so nothing in it can be unit
 * tested. These rules decide what supplier evidence may be stored, which makes them exactly
 * the rules that need tests.
 *
 * WHAT THIS IS NOT
 * ----------------
 * It never fetches the supplier URL. The URL is evidence and navigation only - server-side
 * fetching of arbitrary operator-supplied URLs is an SSRF footgun and would also imply a
 * live availability check that does not exist. Availability here is asserted by a human who
 * looked, and `checkedAt` records when.
 */

import { isExplicitCurrencyCode } from '../common/money';
import type { CandidateSource } from './candidate.types';
import type {
  SupplierAvailability,
  SupplierProvider,
} from './sourceability';

/**
 * The supplier a verification is for when the operator did not say.
 *
 * Where the candidate was researched, when that is DeoDap; otherwise Tradelle, which was
 * the only supplier before DeoDap and so is what an existing caller means.
 */
export function defaultVerificationProvider(source: CandidateSource): SupplierProvider {
  return source === 'DEODAP' ? 'DEODAP' : 'TRADELLE';
}

/** How the verification evidence names where the operator looked. */
export function verificationEvidence(provider: SupplierProvider): string {
  switch (provider) {
    case 'TRADELLE':
      return 'Operator verified availability in Tradelle';
    case 'DEODAP':
      return 'Operator verified availability in DeoDap';
    case 'OTHER':
    case 'UNKNOWN':
    default:
      return 'Operator verified availability with the supplier';
  }
}

/** One variant's availability, as submitted by the operator. */
export interface SupplierVariantInput {
  supplierVariantId?: string | null;
  sku?: string | null;
  title: string;
  optionValues?: Record<string, string> | null;
  availability?: SupplierAvailability;
  stockKnown?: boolean;
  cost?: number | null;
  currencyCode?: string | null;
}

export interface SupplierVerificationInput {
  provider?: SupplierProvider;
  supplierProductId?: string | null;
  sourceUrl?: string | null;
  availability?: SupplierAvailability;
  observedAt?: string | null;
  productCost?: number | null;
  productCurrency?: string | null;
  shippingCost?: number | null;
  shippingCurrency?: string | null;
  shippingDays?: number | null;
  stockKnown?: boolean;
  variants?: SupplierVariantInput[];
  note?: string | null;
}

const PROVIDERS: readonly SupplierProvider[] = ['TRADELLE', 'DEODAP', 'OTHER', 'UNKNOWN'];
const AVAILABILITIES: readonly SupplierAvailability[] = ['AVAILABLE', 'UNAVAILABLE', 'UNKNOWN'];

const MAX_URL = 2048;
const MAX_ID = 200;
const MAX_TITLE = 300;
const MAX_NOTE = 2000;
const MAX_VARIANTS = 250;

/** Every money field on the verification, paired with its currency, for the loop below. */
const MONEY_FIELDS: readonly {
  amount: keyof SupplierVerificationInput;
  currency: keyof SupplierVerificationInput;
  label: string;
}[] = [
  { amount: 'productCost', currency: 'productCurrency', label: 'productCost' },
  { amount: 'shippingCost', currency: 'shippingCurrency', label: 'shippingCost' },
];

/**
 * Validates a supplier verification, reporting every problem at once.
 *
 * Mirrors candidate.validation: a form should show all its errors, not the first one and
 * then another after each retry.
 */
export function validateSupplierVerification(input: SupplierVerificationInput): string[] {
  const problems: string[] = [];

  if (input.provider !== undefined && !PROVIDERS.includes(input.provider)) {
    problems.push(`provider must be one of ${PROVIDERS.join(', ')}.`);
  }
  if (input.availability !== undefined && !AVAILABILITIES.includes(input.availability)) {
    problems.push(`availability must be one of ${AVAILABILITIES.join(', ')}.`);
  }

  if (typeof input.sourceUrl === 'string' && input.sourceUrl.trim() !== '') {
    const url = input.sourceUrl.trim();
    if (url.length > MAX_URL) problems.push('sourceUrl is too long.');
    if (!/^https?:\/\/\S+$/i.test(url)) {
      problems.push('sourceUrl must be an http(s) URL. It is stored as evidence only and never fetched.');
    }
  }

  if (isPresentString(input.supplierProductId) && input.supplierProductId!.trim().length > MAX_ID) {
    problems.push('supplierProductId is too long.');
  }
  if (isPresentString(input.note) && input.note!.length > MAX_NOTE) {
    problems.push('note is too long.');
  }

  // Money: an amount present without an explicit currency is refused, exactly as the
  // candidate commercials are - an unlabelled amount is a landmine.
  for (const field of MONEY_FIELDS) {
    const amount = input[field.amount] as number | null | undefined;
    if (amount === undefined || amount === null) continue;
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
      problems.push(`${field.label} must be a number of at least 0, or omitted when unknown.`);
      continue;
    }
    const currency = input[field.currency] as string | null | undefined;
    if (!isExplicitCurrencyCode(currency ?? null)) {
      problems.push(
        `${String(field.currency)} is required when ${field.label} is set, and must be a 3-letter currency code. Trademart will not infer it.`,
      );
    }
  }

  if (input.shippingDays !== undefined && input.shippingDays !== null) {
    if (
      typeof input.shippingDays !== 'number' ||
      !Number.isFinite(input.shippingDays) ||
      input.shippingDays < 0
    ) {
      problems.push('shippingDays must be a number of at least 0, or omitted.');
    }
  }

  if (isPresentString(input.observedAt) && Number.isNaN(new Date(input.observedAt!).getTime())) {
    problems.push('observedAt must be a valid ISO date.');
  }

  problems.push(...validateVariants(input.variants ?? []));

  return problems;
}

function validateVariants(variants: SupplierVariantInput[]): string[] {
  const problems: string[] = [];
  if (variants.length > MAX_VARIANTS) {
    problems.push(`Too many variants (max ${MAX_VARIANTS}).`);
    return problems;
  }

  const seen = new Set<string>();
  variants.forEach((variant, index) => {
    const where = `variant ${index + 1}`;
    if (typeof variant.title !== 'string' || variant.title.trim() === '') {
      problems.push(`${where}: a title is required.`);
    } else if (variant.title.length > MAX_TITLE) {
      problems.push(`${where}: title is too long.`);
    }
    if (variant.availability !== undefined && !AVAILABILITIES.includes(variant.availability)) {
      problems.push(`${where}: availability must be one of ${AVAILABILITIES.join(', ')}.`);
    }
    if (variant.cost !== undefined && variant.cost !== null) {
      if (typeof variant.cost !== 'number' || !Number.isFinite(variant.cost) || variant.cost < 0) {
        problems.push(`${where}: cost must be a number of at least 0.`);
      } else if (!isExplicitCurrencyCode(variant.currencyCode ?? null)) {
        problems.push(`${where}: currencyCode is required when a cost is set.`);
      }
    }

    // Duplicate identity check: prefer supplierVariantId, then sku, then the title.
    const key = (variant.supplierVariantId ?? variant.sku ?? variant.title ?? '').trim().toLowerCase();
    if (key !== '') {
      if (seen.has(key)) problems.push(`${where}: duplicate variant "${key}".`);
      seen.add(key);
    }
  });

  return problems;
}

function isPresentString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}
