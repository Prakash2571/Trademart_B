/**
 * Truthful supplier -> Shopify variant planning and mapping.
 *
 * Supplier verification is the only source of option combinations. Unavailable and
 * unknown supplier variants are omitted, incomplete grids are refused, and Shopify's
 * response is matched by identity rather than by response order. The resulting mapping
 * is durable and is the only bridge the public catalog and checkout may use.
 */

import { createHash } from 'node:crypto';

import { AppError } from '../common/errors';
import type { NewVariantInput, ProductOptionInput } from '../products/product.create';
import type { ProductCandidate } from './candidate.types';
import type { SupplierVariantAvailability } from './sourceability';

export interface PlannedVariantSource {
  supplierVariantId: string | null;
  supplierSku: string | null;
  supplierTitle: string;
  optionValues: Record<string, string>;
}

export interface SupplierVariantPlan {
  options: ProductOptionInput[];
  variants: NewVariantInput[];
  sources: PlannedVariantSource[];
}

export interface ShopifyCreatedVariantIdentity {
  shopifyVariantId: string;
  sku?: string | null;
  optionValues?: readonly { name: string; value: string }[];
}

export interface PushedVariantMapping extends PlannedVariantSource {
  publicVariantId: string;
  shopifyVariantId: string;
  mappedAt: string;
}

export interface VariantMappingResult {
  mappings: PushedVariantMapping[];
  complete: boolean;
  warnings: string[];
}

/**
 * Builds Shopify inputs from AVAILABLE supplier variants only.
 *
 * An empty supplier variant list means the supplier presented a product-level item with
 * no variant structure, so one Shopify default variant is truthful. It does not mean a
 * missing or malformed multi-variant grid may be collapsed.
 */
export function buildSupplierVariantPlan(
  candidate: ProductCandidate,
  price: number,
): SupplierVariantPlan {
  return buildVariantPlanFromSupplierVariants(candidate.supplier?.variants ?? [], price);
}

/** Same planner over a frozen push-intent snapshot, used during crash recovery. */
export function buildVariantPlanFromSupplierVariants(
  verified: readonly SupplierVariantAvailability[],
  price: number,
): SupplierVariantPlan {
  const formattedPrice = price.toFixed(2);

  if (verified.length === 0) {
    return {
      options: [],
      variants: [{ price: formattedPrice, optionValues: [] }],
      sources: [
        {
          supplierVariantId: null,
          supplierSku: null,
          supplierTitle: 'Default',
          optionValues: {},
        },
      ],
    };
  }

  const available = verified.filter((variant) => variant.availability === 'AVAILABLE');
  if (available.length === 0) {
    throw new AppError(
      'VALIDATION_ERROR',
      'No verified supplier variant is currently available, so no Shopify variant can be created.',
    );
  }

  validateStableSupplierIdentities(available);

  const normalized = available.map(normalizeSupplierVariant);
  const firstOptionNames = Object.keys(normalized[0]?.optionValues ?? {});

  if (normalized.length > 1 && firstOptionNames.length === 0) {
    throw new AppError(
      'VALIDATION_ERROR',
      'Multiple supplier variants were verified without option values. Record their real options before pushing; they cannot be collapsed into one default variant.',
    );
  }
  if (firstOptionNames.length > 3) {
    throw new AppError(
      'VALIDATION_ERROR',
      `The supplier variants use ${firstOptionNames.length} options, but Shopify supports at most 3.`,
    );
  }

  for (const variant of normalized) {
    const names = Object.keys(variant.optionValues);
    if (!sameNames(firstOptionNames, names)) {
      throw new AppError(
        'VALIDATION_ERROR',
        'Verified supplier variants do not use the same option names. Record a complete, consistent option map before pushing.',
      );
    }
  }

  const seenCombinations = new Set<string>();
  const optionValuesByName = new Map(firstOptionNames.map((name) => [name, new Set<string>()]));
  for (const variant of normalized) {
    const combination = optionCombinationKey(variant.optionValues);
    if (seenCombinations.has(combination)) {
      throw new AppError(
        'VALIDATION_ERROR',
        `Two available supplier variants share the same option combination (${displayOptions(variant.optionValues)}).`,
      );
    }
    seenCombinations.add(combination);
    for (const name of firstOptionNames) {
      optionValuesByName.get(name)?.add(variant.optionValues[name] as string);
    }
  }

  const options = firstOptionNames.map((name) => ({
    name,
    values: [...(optionValuesByName.get(name) ?? [])],
  }));

  return {
    options,
    variants: normalized.map((variant) => ({
      price: formattedPrice,
      ...(variant.supplierSku === null ? {} : { sku: variant.supplierSku }),
      optionValues: firstOptionNames.map((optionName) => ({
        optionName,
        name: variant.optionValues[optionName] as string,
      })),
    })),
    sources: normalized,
  };
}

/** Maps Shopify's response to planned supplier rows without trusting response order. */
export function mapCreatedVariants(
  candidateId: string,
  sources: readonly PlannedVariantSource[],
  created: readonly ShopifyCreatedVariantIdentity[],
  mappedAt: Date,
): VariantMappingResult {
  const unused = new Set(created.map((variant) => variant.shopifyVariantId));
  const mappings: PushedVariantMapping[] = [];
  const warnings: string[] = [];

  for (const source of sources) {
    const matches = created.filter((variant) => {
      if (!unused.has(variant.shopifyVariantId)) return false;
      if (source.supplierSku !== null) {
        return normalizeIdentity(variant.sku ?? null) === normalizeIdentity(source.supplierSku);
      }
      if (Object.keys(source.optionValues).length === 0) {
        return sources.length === 1 && created.length === 1;
      }
      return optionCombinationKey(fromShopifyOptions(variant.optionValues ?? [])) ===
        optionCombinationKey(source.optionValues);
    });

    if (matches.length !== 1) {
      warnings.push(
        matches.length === 0
          ? `Shopify returned no exact variant identity match for supplier variant "${source.supplierTitle}"; it is not exposed for sale.`
          : `Shopify returned an ambiguous variant identity for supplier variant "${source.supplierTitle}"; none of those matches is exposed for sale.`,
      );
      continue;
    }

    const match = matches[0] as ShopifyCreatedVariantIdentity;
    unused.delete(match.shopifyVariantId);
    mappings.push({
      ...source,
      publicVariantId: publicVariantId(candidateId, source),
      shopifyVariantId: match.shopifyVariantId,
      mappedAt: mappedAt.toISOString(),
    });
  }

  if (unused.size > 0) {
    warnings.push(
      `Shopify returned ${unused.size} variant(s) that have no verified supplier mapping; they are not exposed for sale.`,
    );
  }

  const publicIds = new Set(mappings.map((mapping) => mapping.publicVariantId));
  if (publicIds.size !== mappings.length) {
    throw new AppError(
      'INTERNAL_ERROR',
      'Two supplier variants resolved to the same public variant identity. The product remains fail-closed.',
    );
  }

  return {
    mappings,
    complete: mappings.length === sources.length && unused.size === 0,
    warnings,
  };
}

function normalizeSupplierVariant(variant: SupplierVariantAvailability): PlannedVariantSource {
  const optionValues: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(variant.optionValues ?? {})) {
    const name = rawName.trim();
    const value = typeof rawValue === 'string' ? rawValue.trim() : '';
    if (name.length === 0 || value.length === 0) {
      throw new AppError(
        'VALIDATION_ERROR',
        `Supplier variant "${variant.title}" has an empty option name or value.`,
      );
    }
    const existing = Object.keys(optionValues).find(
      (entry) => entry.toLowerCase() === name.toLowerCase(),
    );
    if (existing !== undefined) {
      throw new AppError(
        'VALIDATION_ERROR',
        `Supplier variant "${variant.title}" repeats option "${name}" with different casing.`,
      );
    }
    optionValues[name] = value;
  }
  return {
    supplierVariantId: clean(variant.supplierVariantId),
    supplierSku: clean(variant.sku),
    supplierTitle: variant.title.trim(),
    optionValues,
  };
}

function validateStableSupplierIdentities(variants: readonly SupplierVariantAvailability[]): void {
  const ids = new Set<string>();
  const skus = new Set<string>();
  for (const variant of variants) {
    const id = normalizeIdentity(variant.supplierVariantId);
    if (id !== null) {
      if (ids.has(id)) {
        throw new AppError('VALIDATION_ERROR', `Duplicate supplier variant id "${variant.supplierVariantId}".`);
      }
      ids.add(id);
    }
    const sku = normalizeIdentity(variant.sku);
    if (sku !== null) {
      if (skus.has(sku)) {
        throw new AppError('VALIDATION_ERROR', `Duplicate supplier variant SKU "${variant.sku}".`);
      }
      skus.add(sku);
    }
  }
}

function publicVariantId(candidateId: string, source: PlannedVariantSource): string {
  const stableIdentity =
    clean(source.supplierVariantId) ??
    clean(source.supplierSku) ??
    (optionCombinationKey(source.optionValues) || 'default');
  const digest = createHash('sha256')
    .update(`kanay-variant-v1\0${candidateId}\0${stableIdentity}`)
    .digest('base64url')
    .slice(0, 24);
  return `kv_${digest}`;
}

function fromShopifyOptions(
  options: readonly { name: string; value: string }[],
): Record<string, string> {
  return Object.fromEntries(options.map((option) => [option.name, option.value]));
}

function optionCombinationKey(values: Record<string, string>): string {
  return Object.entries(values)
    .map(([name, value]) => `${name.trim().toLowerCase()}=${value.trim().toLowerCase()}`)
    .sort()
    .join('\u0000');
}

function displayOptions(values: Record<string, string>): string {
  return Object.entries(values)
    .map(([name, value]) => `${name}: ${value}`)
    .join(', ');
}

function sameNames(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const normalizedRight = new Set(right.map((name) => name.toLowerCase()));
  return left.every((name) => normalizedRight.has(name.toLowerCase()));
}

function clean(value: string | null): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed.length === 0 ? null : trimmed;
}

function normalizeIdentity(value: string | null): string | null {
  return clean(value)?.toLowerCase() ?? null;
}
