/** Central fail-closed storefront sellability policy. Checkout must reuse this evaluator. */

import { resolveFreshness } from '../../common/dataQuality';
import type {
  SourceabilityResult,
  SupplierVariantAvailability,
} from '../../intelligence/sourceability';
import { DEFAULT_SOURCEABILITY_CONFIG } from '../../intelligence/sourceability';
import type { PushedVariantMapping } from '../../intelligence/variant.mapping';
import type { ChannelPublicationStatus } from '../../shopify/publications/publications.types';
import type { StorefrontAvailability } from './types';

export type SellabilityBlockReason =
  | 'SHOPIFY_NOT_ACTIVE'
  | 'SHOPIFY_NOT_PUBLISHED'
  | 'SHOPIFY_PUBLICATION_UNKNOWN'
  | 'SOURCEABILITY_BLOCKED'
  | 'VARIANT_MAPPING_MISSING'
  | 'SUPPLIER_VARIANT_MISSING'
  | 'SUPPLIER_VARIANT_UNAVAILABLE'
  | 'SUPPLIER_VARIANT_STALE'
  | 'PRICE_INVALID'
  | 'PRICE_NOT_INR'
  | 'SHOPIFY_VARIANT_AVAILABILITY_UNKNOWN'
  | 'SHOPIFY_VARIANT_OUT_OF_STOCK';

export interface StorefrontSellabilityInput {
  productStatus: string | null;
  /**
   * Publication on the channel THIS storefront sells through - three-valued.
   *
   * Was a `publishedToOnlineStore: boolean`, which could not distinguish "Shopify
   * says unpublished" from "the app could not see the channel", and hardcoded the
   * assumption that the themed Online Store is the selling channel. A headless
   * storefront is a different publication, so the caller now names the channel it
   * means and passes the resolved status.
   *
   * UNKNOWN blocks the sale exactly as UNPUBLISHED does; they are distinguished
   * only so the operator is told which problem they actually have.
   */
  channelPublication: ChannelPublicationStatus;
  sourceability: SourceabilityResult;
  mapping: PushedVariantMapping | null;
  shopifyVariantAvailableForSale: boolean | null;
  priceAmount: string | null;
  priceCurrencyCode: string | null;
  now: Date;
}

export interface StorefrontSellabilityResult {
  availability: StorefrontAvailability;
  availableForSale: boolean;
  approvedPrice: string | null;
  blockReason: SellabilityBlockReason | null;
}

/**
 * The single commercial gate for catalog and checkout.
 *
 * OUT_OF_STOCK means every non-inventory gate passed and Shopify alone reports no stock.
 * Unknown, stale, mismatched, or unmapped facts are UNAVAILABLE; absence never grants sale.
 */
export function evaluateStorefrontSellability(
  input: StorefrontSellabilityInput,
): StorefrontSellabilityResult {
  // Both halves are required and neither implies the other: a DRAFT product
  // published to the channel is not sellable, and an ACTIVE product absent from the
  // channel is not sellable either.
  if (input.productStatus !== 'ACTIVE') return unavailable('SHOPIFY_NOT_ACTIVE');
  if (input.channelPublication === 'UNKNOWN') {
    return unavailable('SHOPIFY_PUBLICATION_UNKNOWN');
  }
  if (input.channelPublication !== 'PUBLISHED') return unavailable('SHOPIFY_NOT_PUBLISHED');
  if (
    input.sourceability.current !== 'SOURCEABLE' &&
    input.sourceability.current !== 'PARTIALLY_SOURCEABLE'
  ) {
    return unavailable('SOURCEABILITY_BLOCKED');
  }
  if (input.mapping === null) return unavailable('VARIANT_MAPPING_MISSING');

  const supplierVariant = currentSupplierVariant(input.sourceability, input.mapping);
  if (input.sourceability.variants.length > 0) {
    if (supplierVariant === null) return unavailable('SUPPLIER_VARIANT_MISSING');
    if (supplierVariant.availability !== 'AVAILABLE') {
      return unavailable('SUPPLIER_VARIANT_UNAVAILABLE');
    }
    const checkedAt = supplierVariant.checkedAt ?? input.sourceability.checkedAt;
    const { freshness } = resolveFreshness(checkedAt, input.now, {
      freshWithinHours: DEFAULT_SOURCEABILITY_CONFIG.manualAvailabilityFreshHours,
      agingWithinHours: DEFAULT_SOURCEABILITY_CONFIG.manualAvailabilityFreshHours * 2,
    });
    if (freshness === 'STALE' || freshness === 'UNKNOWN') {
      return unavailable('SUPPLIER_VARIANT_STALE');
    }
  }

  if (input.priceCurrencyCode?.trim().toUpperCase() !== 'INR') {
    return unavailable('PRICE_NOT_INR');
  }
  const approvedPrice = normalizeInrAmount(input.priceAmount);
  if (approvedPrice === null) return unavailable('PRICE_INVALID');

  if (input.shopifyVariantAvailableForSale === null) {
    return unavailable('SHOPIFY_VARIANT_AVAILABILITY_UNKNOWN');
  }
  if (!input.shopifyVariantAvailableForSale) {
    return {
      availability: 'OUT_OF_STOCK',
      availableForSale: false,
      approvedPrice,
      blockReason: 'SHOPIFY_VARIANT_OUT_OF_STOCK',
    };
  }

  return {
    availability: 'SELLABLE',
    availableForSale: true,
    approvedPrice,
    blockReason: null,
  };
}

/** Strict INR decimal normalization without floating-point arithmetic. */
export function normalizeInrAmount(raw: string | null): string | null {
  if (raw === null) return null;
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(raw.trim());
  if (match === null) return null;
  const majorRaw = match[1] as string;
  const fraction = (match[2] ?? '').padEnd(2, '0');
  const major = majorRaw.replace(/^0+(?=\d)/, '');
  const paise = BigInt(major) * 100n + BigInt(fraction);
  if (paise <= 0n) return null;
  return `${major}.${fraction}`;
}

export function inrAmountToPaise(raw: string): bigint | null {
  const normalized = normalizeInrAmount(raw);
  if (normalized === null) return null;
  const [major, fraction] = normalized.split('.');
  return BigInt(major as string) * 100n + BigInt(fraction as string);
}

function unavailable(blockReason: SellabilityBlockReason): StorefrontSellabilityResult {
  return {
    availability: 'UNAVAILABLE',
    availableForSale: false,
    approvedPrice: null,
    blockReason,
  };
}

function currentSupplierVariant(
  sourceability: SourceabilityResult,
  mapping: PushedVariantMapping,
): SupplierVariantAvailability | null {
  const variants = sourceability.variants;
  const mappedId = clean(mapping.supplierVariantId);
  if (mappedId !== null) {
    const matches = variants.filter(
      (variant) => normalize(variant.supplierVariantId) === normalize(mappedId),
    );
    return matches.length === 1 ? (matches[0] as SupplierVariantAvailability) : null;
  }

  const mappedSku = clean(mapping.supplierSku);
  if (mappedSku !== null) {
    const matches = variants.filter((variant) => normalize(variant.sku) === normalize(mappedSku));
    return matches.length === 1 ? (matches[0] as SupplierVariantAvailability) : null;
  }

  const mappedOptions = optionKey(mapping.optionValues);
  const matches = variants.filter((variant) => optionKey(variant.optionValues) === mappedOptions);
  return matches.length === 1 ? (matches[0] as SupplierVariantAvailability) : null;
}

function optionKey(options: Record<string, string>): string {
  return Object.entries(options)
    .map(([name, value]) => `${name.trim().toLowerCase()}=${value.trim().toLowerCase()}`)
    .sort()
    .join('\u0000');
}

function clean(value: string | null): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
}

function normalize(value: string | null): string | null {
  return clean(value)?.toLowerCase() ?? null;
}
