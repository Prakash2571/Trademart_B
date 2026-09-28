/** Store-scoped read of only the internal evidence needed to decide public sellability. */

import { config } from '../../config';
import { ProductCandidateModel } from '../../database/models/ProductCandidate';
import type { SupplierInfo } from '../../intelligence/sourceability';
import type { PushedVariantMapping } from '../../intelligence/variant.mapping';

export interface CatalogCandidateEvidence {
  candidateId: string;
  shopifyProductId: string;
  supplier: SupplierInfo | null;
  variantMappings: PushedVariantMapping[];
}

interface LeanEvidenceRow {
  candidateId?: unknown;
  pushedShopifyProductId?: unknown;
  pushState?: unknown;
  supplier?: unknown;
  pushedVariantMappings?: unknown;
}

/**
 * Loads evidence in one Mongo query. A duplicate candidate/product join is omitted rather
 * than guessed, making every affected Shopify product fail closed.
 */
export async function loadCatalogEvidenceByProductIds(
  shopifyProductIds: readonly string[],
): Promise<Map<string, CatalogCandidateEvidence>> {
  const uniqueIds = [...new Set(shopifyProductIds)];
  if (uniqueIds.length === 0) return new Map();

  const rows = (await ProductCandidateModel.find(
    {
      shopDomain: config.shopify.storeDomain,
      pushedShopifyProductId: { $in: uniqueIds },
      pushState: 'SUCCEEDED',
    },
    {
      candidateId: 1,
      pushedShopifyProductId: 1,
      pushState: 1,
      supplier: 1,
      pushedVariantMappings: 1,
    },
  ).lean()) as unknown as LeanEvidenceRow[];

  const grouped = new Map<string, LeanEvidenceRow[]>();
  for (const row of rows) {
    if (typeof row.pushedShopifyProductId !== 'string') continue;
    const existing = grouped.get(row.pushedShopifyProductId) ?? [];
    existing.push(row);
    grouped.set(row.pushedShopifyProductId, existing);
  }

  const result = new Map<string, CatalogCandidateEvidence>();
  for (const [shopifyProductId, matches] of grouped) {
    if (matches.length !== 1) continue;
    const row = matches[0] as LeanEvidenceRow;
    if (typeof row.candidateId !== 'string') continue;
    result.set(shopifyProductId, {
      candidateId: row.candidateId,
      shopifyProductId,
      supplier: toSupplierInfo(row.supplier),
      variantMappings: toVariantMappings(row.pushedVariantMappings),
    });
  }
  return result;
}

function toSupplierInfo(raw: unknown): SupplierInfo | null {
  if (!isObject(raw)) return null;
  return {
    provider: enumValue(raw['provider'], ['TRADELLE', 'DEODAP', 'OTHER', 'UNKNOWN'], 'UNKNOWN'),
    supplierProductId: nullableString(raw['supplierProductId']),
    sourceUrl: nullableString(raw['sourceUrl']),
    availability: enumValue(
      raw['availability'],
      ['AVAILABLE', 'UNAVAILABLE', 'UNKNOWN'],
      'UNKNOWN',
    ),
    availabilitySource: enumValue(
      raw['availabilitySource'],
      ['SHOPIFY_BRIDGE', 'MANUAL', 'DIRECT_API'],
      'MANUAL',
    ),
    checkedAt: nullableString(raw['checkedAt']),
    observedAt: nullableString(raw['observedAt']),
    note: nullableString(raw['note']),
    stockKnown: raw['stockKnown'] === true,
    productAvailable:
      typeof raw['productAvailable'] === 'boolean' ? raw['productAvailable'] : null,
    productCost: nullableNumber(raw['productCost']),
    productCurrency: nullableString(raw['productCurrency']),
    shippingCost: nullableNumber(raw['shippingCost']),
    shippingCurrency: nullableString(raw['shippingCurrency']),
    shippingDays: nullableNumber(raw['shippingDays']),
    variants: Array.isArray(raw['variants'])
      ? raw['variants'].flatMap((entry) => {
          if (!isObject(entry) || typeof entry['title'] !== 'string') return [];
          return [
            {
              supplierVariantId: nullableString(entry['supplierVariantId']),
              sku: nullableString(entry['sku']),
              title: entry['title'],
              optionValues: stringMap(entry['optionValues']),
              availability: enumValue(
                entry['availability'],
                ['AVAILABLE', 'UNAVAILABLE', 'UNKNOWN'],
                'UNKNOWN',
              ),
              stockKnown: entry['stockKnown'] === true,
              cost: nullableNumber(entry['cost']),
              currencyCode: nullableString(entry['currencyCode']),
              checkedAt: nullableString(entry['checkedAt']),
            },
          ];
        })
      : [],
    evidence: Array.isArray(raw['evidence'])
      ? raw['evidence'].flatMap((entry) =>
          isObject(entry) && typeof entry['source'] === 'string' && typeof entry['value'] === 'string'
            ? [{ source: entry['source'], value: entry['value'] }]
            : [],
        )
      : [],
  };
}

function toVariantMappings(raw: unknown): PushedVariantMapping[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (
      !isObject(entry) ||
      typeof entry['publicVariantId'] !== 'string' ||
      typeof entry['shopifyVariantId'] !== 'string' ||
      typeof entry['supplierTitle'] !== 'string' ||
      typeof entry['mappedAt'] !== 'string'
    ) {
      return [];
    }
    return [
      {
        publicVariantId: entry['publicVariantId'],
        shopifyVariantId: entry['shopifyVariantId'],
        supplierVariantId: nullableString(entry['supplierVariantId']),
        supplierSku: nullableString(entry['supplierSku']),
        supplierTitle: entry['supplierTitle'],
        optionValues: stringMap(entry['optionValues']),
        mappedAt: entry['mappedAt'],
      },
    ];
  });
}

function stringMap(raw: unknown): Record<string, string> {
  if (!isObject(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

function nullableString(raw: unknown): string | null {
  return typeof raw === 'string' && raw.trim().length > 0 ? raw : null;
}

function nullableNumber(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}

function enumValue<const T extends string>(
  raw: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  return typeof raw === 'string' && allowed.includes(raw as T) ? (raw as T) : fallback;
}

function isObject(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === 'object' && raw !== null;
}
