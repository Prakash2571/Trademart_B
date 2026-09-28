/**
 * Importing DeoDap products as Shopify drafts: the pure half.
 *
 * THE FLOW
 * --------
 *   1. preview   The operator uploads a file. deodap.catalog.ts reads it, this module
 *                prices every variant and builds an ImportDraft for each product that
 *                can be imported. Nothing is written anywhere.
 *   2. import    The operator sends back the drafts they chose, in batches of at most
 *                MAX_IMPORT_BATCH. Every draft is validated again from scratch here -
 *                the browser is not trusted to return what the preview produced - and
 *                the whole batch is checked BEFORE the first Shopify write, so a bad
 *                draft cannot leave half a batch imported.
 *
 * Every product is created as a DRAFT. validateProductCreate forces that anyway;
 * publishing stays a separate, deliberate step in the review queue.
 *
 * The preview runs the same validateProductCreate the import uses, so it never offers
 * a product that Shopify-side validation would then refuse.
 */

import { AppError } from '../../common/errors';
import { assertMoney, roundMoney } from '../../common/money';
import { validateProductCreate, type ProductCreateRequest } from '../../products/product.create';
import {
  CATALOG_FIELDS,
  MAX_IMAGES_PER_PRODUCT,
  MAX_TAGS_PER_PRODUCT,
  MAX_VARIANTS_PER_PRODUCT,
  isUsableImageUrl,
  refKeyOf,
  validateMappingOverride,
  type Catalog,
  type CatalogFieldInfo,
  type ColumnMapping,
  type MappingOverride,
} from './deodap.catalog';
import { CSV_LIMITS } from './deodap.csv';
import { MAX_DESCRIPTION_CHARS, sanitiseDescription } from './deodap.description';
import { DEODAP_TAG } from './deodap.identify';
import {
  priceVariant,
  pricingRuleFromSettings,
  resolvePricingRule,
  type PricingRule,
} from './deodap.pricing';
import { validateCurrencyCode, type DeodapSettings } from './deodap.settings';

/** Products per import request. Each costs two or three Shopify calls. */
export const MAX_IMPORT_BATCH = 10;
const MAX_REF_LENGTH = 200;

/** The delimiter as a word, so the preview can say "semicolon" rather than ";". */
export type CsvDelimiterName = 'comma' | 'semicolon' | 'tab';

function fail(message: string): never {
  throw new AppError('VALIDATION_ERROR', message);
}

/* ===========================================================================
 * Requests that carry a CSV file
 * ======================================================================== */

export interface CsvRequest {
  csv: string;
  sourceFile: string | null;
  mapping: MappingOverride | undefined;
  /** The currency the file's DeoDap costs are in. */
  currencyCode: string;
}

export interface ImportPreviewRequest extends CsvRequest {
  pricing: PricingRule;
}

/** The file name only, never a path, and never more than 200 characters. */
export function readSourceFile(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = (raw.split(/[\\/]/).pop() ?? '').trim();
  if (name.length === 0) return null;
  return name.slice(0, 200);
}

/** Validates a request carrying a CSV file (import preview and cost sync preview). */
export function validateCsvRequest(
  body: Record<string, unknown>,
  settings: DeodapSettings,
): CsvRequest {
  const csv = body['csv'];
  if (typeof csv !== 'string' || csv.trim().length === 0) {
    fail('csv is required: the text of the DeoDap file.');
  }
  if (csv.length > CSV_LIMITS.maxChars) {
    fail(
      `The file is too large to upload in one go (limit ${CSV_LIMITS.maxChars.toLocaleString('en-US')} characters). Split it into smaller files.`,
    );
  }
  return {
    csv,
    sourceFile: readSourceFile(body['sourceFile']),
    mapping: validateMappingOverride(body['mapping']),
    currencyCode:
      body['currencyCode'] === undefined || body['currencyCode'] === null
        ? settings.currencyCode
        : validateCurrencyCode(body['currencyCode']),
  };
}

export function validateImportPreviewRequest(
  body: Record<string, unknown>,
  settings: DeodapSettings,
): ImportPreviewRequest {
  return {
    ...validateCsvRequest(body, settings),
    pricing: resolvePricingRule(body['pricing'], pricingRuleFromSettings(settings)),
  };
}

/* ===========================================================================
 * Drafts
 * ======================================================================== */

export interface ImportVariantDraft {
  sku: string | null;
  optionValues: { optionName: string; name: string }[];
  price: number;
  compareAtPrice: number | null;
  /** What DeoDap charges for one unit. Recorded as the product's supplier cost. */
  cost: number;
  shippingCost: number | null;
}

/** One product exactly as it will be created in Shopify. */
export interface ImportDraft {
  ref: string;
  title: string;
  descriptionHtml: string | null;
  productType: string | null;
  tags: string[];
  imageUrls: string[];
  options: { name: string; values: string[] }[];
  variants: ImportVariantDraft[];
  sourceLine: number | null;
}

/** Tags with the DeoDap tag first, duplicates removed ignoring case. */
export function mergeTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tag of [DEODAP_TAG, ...tags]) {
    const trimmed = tag.trim();
    const key = trimmed.toLowerCase();
    if (trimmed.length === 0 || trimmed.includes(',') || seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

/** The body products/product.create.ts validates, for one draft. Always a DRAFT. */
export function toProductCreateBody(draft: ImportDraft, vendor: string): Record<string, unknown> {
  return {
    title: draft.title,
    ...(draft.descriptionHtml !== null ? { descriptionHtml: draft.descriptionHtml } : {}),
    vendor,
    ...(draft.productType !== null ? { productType: draft.productType } : {}),
    status: 'DRAFT',
    publish: false,
    tags: mergeTags(draft.tags),
    options: draft.options,
    variants: draft.variants.map((variant) => ({
      price: variant.price.toFixed(2),
      ...(variant.compareAtPrice !== null
        ? { compareAtPrice: variant.compareAtPrice.toFixed(2) }
        : {}),
      ...(variant.sku !== null ? { sku: variant.sku } : {}),
      optionValues: variant.optionValues,
    })),
    mediaUrls: draft.imageUrls,
  };
}

/** Runs Shopify-side validation on a draft, naming the product in any error. */
function createRequestFor(draft: ImportDraft, vendor: string, label: string): ProductCreateRequest {
  try {
    return validateProductCreate(toProductCreateBody(draft, vendor));
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    return fail(`${label}: ${error.message}`);
  }
}

/* ===========================================================================
 * Preview
 * ======================================================================== */

/** What the import ledger already knows about a product reference. */
export interface ExistingImport {
  status: 'CLAIMED' | 'CREATED' | 'PARTIAL' | 'FAILED';
  shopifyProductId: string | null;
  error: string | null;
  updatedAt: string | null;
}

export type PreviewStatus = 'READY' | 'NEEDS_ATTENTION' | 'ALREADY_IMPORTED' | 'IN_PROGRESS';

export interface PreviewProduct {
  ref: string | null;
  lines: number[];
  title: string | null;
  sku: string | null;
  variantCount: number;
  optionNames: string[];
  imageUrls: string[];
  costMin: number | null;
  costMax: number | null;
  priceMin: number | null;
  priceMax: number | null;
  compareAtMax: number | null;
  /** Lowest margin across the variants, as a percentage. */
  marginMin: number | null;
  /** Total stock when every variant reports a number. */
  stock: number | null;
  /** True when any variant is in stock, false when none is, null when unknown. */
  inStock: boolean | null;
  status: PreviewStatus;
  existing: ExistingImport | null;
  issues: string[];
  warnings: string[];
  /** Present only when status is READY: send it back to import the product. */
  draft: ImportDraft | null;
}

export interface ImportPreview {
  file: {
    sourceFile: string | null;
    delimiter: CsvDelimiterName;
    headers: string[];
    recordCount: number;
  };
  fields: readonly CatalogFieldInfo[];
  mapping: ColumnMapping;
  pricing: PricingRule;
  currencyCode: string;
  vendor: string;
  shopCurrency: string | null;
  /** When set, nothing may be imported: prices would be in the wrong currency. */
  currencyProblem: string | null;
  /** False when the database was unavailable to say what was already imported. */
  ledgerChecked: boolean;
  warnings: string[];
  products: PreviewProduct[];
  summary: {
    products: number;
    ready: number;
    needsAttention: number;
    alreadyImported: number;
    inProgress: number;
  };
}

function range(values: readonly (number | null)[]): { min: number | null; max: number | null } {
  const known = values.filter((value): value is number => value !== null);
  if (known.length === 0) return { min: null, max: null };
  return { min: Math.min(...known), max: Math.max(...known) };
}

function uniqueValues(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (value.length === 0 || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

export function currencyProblemFor(shopCurrency: string | null, costCurrency: string): string | null {
  if (shopCurrency === null || shopCurrency.toUpperCase() === costCurrency.toUpperCase()) {
    return null;
  }
  return `Your Shopify store sells in ${shopCurrency}, but the DeoDap costs are in ${costCurrency}. Selling prices are worked out from the costs, so they would be in the wrong currency. Change the DeoDap currency if the file is in ${shopCurrency}; Trademart does not convert currencies.`;
}

export function buildImportPreview(input: {
  catalog: Catalog;
  request: ImportPreviewRequest;
  vendor: string;
  existing: ReadonlyMap<string, ExistingImport>;
  ledgerChecked: boolean;
  shopCurrency: string | null;
  shopCurrencyError: string | null;
}): ImportPreview {
  const { catalog, request, vendor } = input;
  const pricing = request.pricing;

  const products: PreviewProduct[] = catalog.products.map((product) => {
    const issues = [...product.issues];
    const warnings = [...product.warnings];

    const priced = product.variants.map((variant) => priceVariant(variant, pricing));
    priced.forEach((result, index) => {
      const variant = product.variants[index];
      // A missing cost is already reported by the catalog reader.
      if (variant === undefined || variant.cost === null) return;
      for (const issue of result.issues) issues.push(`Line ${variant.line}: ${issue}`);
      for (const warning of result.warnings) {
        if (!warnings.includes(warning)) warnings.push(warning);
      }
    });

    let draft: ImportDraft | null = null;
    if (issues.length === 0 && product.ref !== null && product.title !== null) {
      draft = {
        ref: product.ref,
        title: product.title,
        descriptionHtml: product.descriptionHtml,
        productType: product.productType,
        tags: product.tags,
        imageUrls: product.imageUrls,
        options: product.optionNames.map((name, index) => ({
          name,
          values: uniqueValues(product.variants.map((variant) => variant.optionValues[index] ?? '')),
        })),
        variants: product.variants.map((variant, index) => ({
          sku: variant.sku,
          optionValues: product.optionNames.map((name, optionIndex) => ({
            optionName: name,
            name: variant.optionValues[optionIndex] ?? '',
          })),
          price: priced[index]?.price ?? 0,
          compareAtPrice: priced[index]?.compareAtPrice ?? null,
          cost: variant.cost ?? 0,
          shippingCost: variant.shippingCost,
        })),
        sourceLine: product.lines[0] ?? null,
      };
      try {
        validateProductCreate(toProductCreateBody(draft, vendor));
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        issues.push(error.message);
        draft = null;
      }
    }

    const existing =
      product.ref === null ? null : (input.existing.get(refKeyOf(product.ref)) ?? null);
    if (existing?.status === 'FAILED') {
      warnings.push(
        `An earlier import of this product failed${existing.error ? ` (${existing.error})` : ''}. Importing again retries it.`,
      );
    }

    let status: PreviewStatus;
    if (existing?.status === 'CREATED' || existing?.status === 'PARTIAL') status = 'ALREADY_IMPORTED';
    else if (existing?.status === 'CLAIMED') status = 'IN_PROGRESS';
    else if (issues.length > 0 || draft === null) status = 'NEEDS_ATTENTION';
    else status = 'READY';

    const costs = range(product.variants.map((variant) => variant.cost));
    const prices = range(priced.map((result) => result.price));
    const stockKnown = product.variants.every((variant) => variant.stock !== null);

    return {
      ref: product.ref,
      lines: product.lines,
      title: product.title,
      sku: product.variants[0]?.sku ?? null,
      variantCount: product.variants.length,
      optionNames: product.optionNames,
      imageUrls: product.imageUrls,
      costMin: costs.min,
      costMax: costs.max,
      priceMin: prices.min,
      priceMax: prices.max,
      compareAtMax: range(priced.map((result) => result.compareAtPrice)).max,
      marginMin: range(priced.map((result) => result.marginPercent)).min,
      stock:
        stockKnown && product.variants.length > 0
          ? product.variants.reduce((total, variant) => total + (variant.stock ?? 0), 0)
          : null,
      inStock: product.variants.some((variant) => variant.inStock === true)
        ? true
        : product.variants.length > 0 && product.variants.every((variant) => variant.inStock === false)
          ? false
          : null,
      status,
      existing,
      issues,
      warnings,
      draft: status === 'READY' ? draft : null,
    };
  });

  const warnings = [...catalog.warnings];
  if (!input.ledgerChecked) {
    warnings.push(
      'MongoDB is not connected, so Trademart could not check which products were already imported. Importing needs the database.',
    );
  }
  if (input.shopCurrency === null) {
    warnings.push(
      `The store currency could not be read from Shopify${input.shopCurrencyError ? ` (${input.shopCurrencyError})` : ''}. It is checked again when you import.`,
    );
  }

  return {
    file: {
      sourceFile: request.sourceFile,
      delimiter: delimiterName(catalog.delimiter),
      headers: catalog.headers,
      recordCount: catalog.recordCount,
    },
    fields: CATALOG_FIELDS,
    mapping: catalog.mapping,
    pricing,
    currencyCode: request.currencyCode,
    vendor,
    shopCurrency: input.shopCurrency,
    currencyProblem: currencyProblemFor(input.shopCurrency, request.currencyCode),
    ledgerChecked: input.ledgerChecked,
    warnings,
    products,
    summary: {
      products: products.length,
      ready: products.filter((product) => product.status === 'READY').length,
      needsAttention: products.filter((product) => product.status === 'NEEDS_ATTENTION').length,
      alreadyImported: products.filter((product) => product.status === 'ALREADY_IMPORTED').length,
      inProgress: products.filter((product) => product.status === 'IN_PROGRESS').length,
    },
  };
}

function delimiterName(delimiter: string): CsvDelimiterName {
  if (delimiter === ';') return 'semicolon';
  if (delimiter === '\t') return 'tab';
  return 'comma';
}

/* ===========================================================================
 * Import request
 * ======================================================================== */

export interface ImportItem {
  draft: ImportDraft;
  create: ProductCreateRequest;
}

export interface ImportRequest {
  items: ImportItem[];
  currencyCode: string;
  sourceFile: string | null;
}

function requiredText(raw: unknown, field: string, max: number): string {
  if (typeof raw !== 'string' || raw.trim().length === 0) fail(`${field} is required.`);
  const value = raw.trim();
  if (value.length > max) fail(`${field} must be at most ${max} characters.`);
  return value;
}

function optionalText(raw: unknown, field: string, max: number): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string') fail(`${field} must be text.`);
  const value = raw.trim();
  if (value.length > max) fail(`${field} must be at most ${max} characters.`);
  return value.length > 0 ? value : null;
}

function positiveAmount(raw: unknown, field: string): number {
  if (typeof raw !== 'number') fail(`${field} must be a number.`);
  const value = roundMoney(assertMoney(raw, field));
  if (value <= 0) fail(`${field} must be greater than 0.`);
  return value;
}

function optionalAmount(raw: unknown, field: string, options: { allowZero: boolean }): number | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'number') fail(`${field} must be a number.`);
  const value = roundMoney(assertMoney(raw, field));
  if (value < 0 || (!options.allowZero && value === 0)) {
    fail(`${field} must be greater than ${options.allowZero ? 'or equal to ' : ''}0.`);
  }
  return value;
}

function textList(raw: unknown, field: string, maxItems: number, maxLength: number): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > maxItems) {
    fail(`${field} must be a list of at most ${maxItems} entries.`);
  }
  return raw.map((entry) => requiredText(entry, field, maxLength));
}

function validateVariant(raw: unknown, label: string): ImportVariantDraft {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    fail(`${label} must be an object.`);
  }
  const body = raw as Record<string, unknown>;

  const rawOptions: unknown = body['optionValues'] ?? [];
  if (!Array.isArray(rawOptions)) fail(`${label} optionValues must be a list.`);
  const optionValues = rawOptions.map((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null) fail(`${label} has a malformed option value.`);
    const pair = entry as Record<string, unknown>;
    return {
      optionName: requiredText(pair['optionName'], `${label} option name`, 255),
      name: requiredText(pair['name'], `${label} option value`, 255),
    };
  });

  const cost = positiveAmount(body['cost'], `${label} cost`);
  const price = positiveAmount(body['price'], `${label} price`);
  if (price < cost) {
    fail(`${label}: the price ${price.toFixed(2)} is below the DeoDap cost ${cost.toFixed(2)}.`);
  }

  return {
    sku: optionalText(body['sku'], `${label} sku`, 255),
    optionValues,
    price,
    compareAtPrice: optionalAmount(body['compareAtPrice'], `${label} compareAtPrice`, {
      allowZero: false,
    }),
    cost,
    shippingCost: optionalAmount(body['shippingCost'], `${label} shippingCost`, {
      allowZero: true,
    }),
  };
}

function validateDraft(raw: unknown, index: number): ImportDraft {
  const label = `Product ${index + 1}`;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    fail(`${label} must be an object.`);
  }
  const body = raw as Record<string, unknown>;

  const rawOptions: unknown = body['options'] ?? [];
  if (!Array.isArray(rawOptions)) fail(`${label} options must be a list.`);
  const options = rawOptions.map((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null) fail(`${label} has a malformed option.`);
    const option = entry as Record<string, unknown>;
    return {
      name: requiredText(option['name'], `${label} option name`, 255),
      values: textList(option['values'], `${label} option values`, 100, 255),
    };
  });

  const rawVariants = body['variants'];
  if (!Array.isArray(rawVariants) || rawVariants.length === 0) {
    fail(`${label} needs at least one variant.`);
  }
  if (rawVariants.length > MAX_VARIANTS_PER_PRODUCT) {
    fail(`${label} has more than ${MAX_VARIANTS_PER_PRODUCT} variants.`);
  }

  const imageUrls = textList(body['imageUrls'], `${label} imageUrls`, MAX_IMAGES_PER_PRODUCT, 2000);
  for (const url of imageUrls) {
    if (!isUsableImageUrl(url)) fail(`${label} has an image that is not a public https address.`);
  }

  const rawLine = body['sourceLine'];
  const sourceLine =
    typeof rawLine === 'number' && Number.isInteger(rawLine) && rawLine > 0 ? rawLine : null;

  // Sanitised again: the browser sent this back, and it goes onto a storefront.
  const description = optionalText(
    body['descriptionHtml'],
    `${label} descriptionHtml`,
    MAX_DESCRIPTION_CHARS * 2,
  );

  return {
    ref: requiredText(body['ref'], `${label} ref`, MAX_REF_LENGTH),
    title: requiredText(body['title'], `${label} title`, 255),
    descriptionHtml: description === null ? null : sanitiseDescription(description).html,
    productType: optionalText(body['productType'], `${label} productType`, 255),
    tags: textList(body['tags'], `${label} tags`, MAX_TAGS_PER_PRODUCT, 255),
    imageUrls,
    options,
    variants: rawVariants.map((variant, variantIndex) =>
      validateVariant(variant, `${label} variant ${variantIndex + 1}`),
    ),
    sourceLine,
  };
}

/**
 * Validates an import batch completely, before anything is written.
 *
 * `vendor` is the configured DeoDap vendor name, applied to every product.
 */
export function validateImportRequest(body: Record<string, unknown>, vendor: string): ImportRequest {
  const rawProducts = body['products'];
  if (!Array.isArray(rawProducts) || rawProducts.length === 0) {
    fail('products must be a non-empty list of drafts from the preview.');
  }
  if (rawProducts.length > MAX_IMPORT_BATCH) {
    fail(`At most ${MAX_IMPORT_BATCH} products can be imported per request. Send them in batches.`);
  }
  const currencyCode = validateCurrencyCode(body['currencyCode']);

  const seen = new Set<string>();
  const items = rawProducts.map((raw, index) => {
    const draft = validateDraft(raw, index);
    const key = refKeyOf(draft.ref);
    if (seen.has(key)) fail(`"${draft.ref}" appears twice in this request.`);
    seen.add(key);
    return { draft, create: createRequestFor(draft, vendor, `Product ${index + 1} ("${draft.title}")`) };
  });

  return { items, currencyCode, sourceFile: readSourceFile(body['sourceFile']) };
}

/* ===========================================================================
 * After Shopify has created the product
 * ======================================================================== */

export interface CreatedVariantRef {
  shopifyVariantId: string;
  sku: string | null;
  optionValues: { name: string; value: string }[];
}

/**
 * Pairs each draft variant with the Shopify variant created for it: by SKU first, then
 * by option values, and for a single-variant product, the only one there is. Never by
 * position alone, because Shopify does not promise to return variants in input order.
 */
export function matchCreatedVariants(
  drafts: readonly ImportVariantDraft[],
  created: readonly CreatedVariantRef[],
): (string | null)[] {
  const used = new Set<string>();
  const take = (variant: CreatedVariantRef | undefined): string | null => {
    if (variant === undefined) return null;
    used.add(variant.shopifyVariantId);
    return variant.shopifyVariantId;
  };

  const matched = drafts.map((draft) => {
    if (draft.sku !== null) {
      const sku = draft.sku.trim().toLowerCase();
      const hit = created.find(
        (variant) =>
          !used.has(variant.shopifyVariantId) &&
          variant.sku !== null &&
          variant.sku.trim().toLowerCase() === sku,
      );
      if (hit !== undefined) return take(hit);
    }
    if (draft.optionValues.length > 0) {
      const hit = created.find(
        (variant) =>
          !used.has(variant.shopifyVariantId) &&
          draft.optionValues.every((option) =>
            variant.optionValues.some(
              (selected) =>
                selected.name.toLowerCase() === option.optionName.toLowerCase() &&
                selected.value.toLowerCase() === option.name.toLowerCase(),
            ),
          ),
      );
      if (hit !== undefined) return take(hit);
    }
    return null;
  });

  if (drafts.length === 1 && created.length === 1 && matched[0] === null) {
    matched[0] = created[0]?.shopifyVariantId ?? null;
  }
  return matched;
}

export type ImportOutcome = 'CREATED' | 'PARTIAL' | 'SKIPPED' | 'FAILED' | 'NOT_ATTEMPTED';

export interface ImportItemResult {
  ref: string;
  title: string;
  outcome: ImportOutcome;
  shopifyProductId: string | null;
  /** Why it was skipped, failed or not attempted. */
  reason: string | null;
  errorCode: string | null;
  warnings: string[];
  /** Variants whose DeoDap cost was recorded in Trademart. */
  costsRecorded: number;
}

export interface ImportBatchResult {
  results: ImportItemResult[];
  summary: Record<ImportOutcome, number>;
  /** True when anything did not end CREATED or SKIPPED. */
  partial: boolean;
}

export function summariseImport(results: ImportItemResult[]): ImportBatchResult {
  const summary: Record<ImportOutcome, number> = {
    CREATED: 0,
    PARTIAL: 0,
    SKIPPED: 0,
    FAILED: 0,
    NOT_ATTEMPTED: 0,
  };
  for (const result of results) summary[result.outcome] += 1;
  return {
    results,
    summary,
    partial: results.some((result) => result.outcome !== 'CREATED' && result.outcome !== 'SKIPPED'),
  };
}
