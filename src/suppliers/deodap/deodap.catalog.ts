/**
 * Supplier rows to products - pure.
 *
 * Reads a DeoDap product file (CSV) into CatalogProducts: one per product, each with
 * one or more priced variants, plus the problems that would stop it being imported.
 * Nothing here talks to Shopify or the database, so every rule is unit tested.
 *
 * TWO FILE SHAPES
 * ---------------
 *   Flat          one row per product: title, SKU, cost, MRP, stock, images...
 *   Shopify-style rows grouped by Handle. The first row carries the title and
 *                 description, further rows add variants (Option1 Value, Variant SKU,
 *                 Variant Price) or just extra images. This is what any Shopify
 *                 product export looks like, and DeoDap's own store runs on Shopify.
 *
 * COLUMNS ARE DETECTED, AND THE OPERATOR HAS THE LAST WORD
 * -------------------------------------------------------
 * Headers are matched against known names ("Dropship Price", "Variant SKU", "MRP"...).
 * The one that matters most is the COST: a column called just "Price" is used as the
 * cost only as a last resort and is flagged, because it could equally be a selling
 * price. The preview shows every choice and the operator can change any of them.
 *
 * A missing or unreadable cost is a blocking problem, never a zero: a product priced
 * from a zero cost would be sold at a loss.
 */

import { AppError } from '../../common/errors';
import { roundMoney } from '../../common/money';
import { parseCsv, type CsvDelimiter, type CsvRecord } from './deodap.csv';
import { sanitiseDescription } from './deodap.description';

export type CatalogField =
  | 'title'
  | 'handle'
  | 'sku'
  | 'productId'
  | 'cost'
  | 'retailPrice'
  | 'shippingCost'
  | 'stock'
  | 'description'
  | 'productType'
  | 'tags'
  | 'option1Name'
  | 'option1Value'
  | 'option2Name'
  | 'option2Value'
  | 'option3Name'
  | 'option3Value';

export interface CatalogFieldInfo {
  field: CatalogField;
  label: string;
  required: boolean;
  hint: string;
}

/** Every field, in the order the mapping is shown and detected. */
export const CATALOG_FIELDS: readonly CatalogFieldInfo[] = Object.freeze([
  {
    field: 'title',
    label: 'Product title',
    required: true,
    hint: 'The product name customers see.',
  },
  {
    field: 'handle',
    label: 'Handle',
    required: false,
    hint: 'Groups several rows into one product with variants, as in a Shopify export.',
  },
  {
    field: 'sku',
    label: 'SKU',
    required: false,
    hint: "DeoDap's product code. Used to recognise the product in later price lists and orders.",
  },
  {
    field: 'productId',
    label: 'DeoDap product ID',
    required: false,
    hint: 'A DeoDap product number or code, when the file has one.',
  },
  {
    field: 'cost',
    label: 'DeoDap cost',
    required: true,
    hint: 'What DeoDap charges you for one unit. Selling prices are worked out from it.',
  },
  {
    field: 'retailPrice',
    label: 'MRP / retail price',
    required: false,
    hint: 'Used as the compare-at price, or as the selling price when pricing from MRP.',
  },
  {
    field: 'shippingCost',
    label: 'DeoDap shipping',
    required: false,
    hint: "DeoDap's shipping charge per unit, when the file has one.",
  },
  {
    field: 'stock',
    label: 'Stock',
    required: false,
    hint: 'Shown for information only. Shopify stock is not changed.',
  },
  {
    field: 'description',
    label: 'Description',
    required: false,
    hint: 'Plain text or HTML. Scripts, links and other unsafe markup are removed.',
  },
  {
    field: 'productType',
    label: 'Product type / category',
    required: false,
    hint: 'Becomes the Shopify product type.',
  },
  {
    field: 'tags',
    label: 'Tags',
    required: false,
    hint: 'Comma-separated. The DeoDap tag is always added.',
  },
  { field: 'option1Name', label: 'Option 1 name', required: false, hint: 'For example Color.' },
  { field: 'option1Value', label: 'Option 1 value', required: false, hint: 'For example Red.' },
  { field: 'option2Name', label: 'Option 2 name', required: false, hint: '' },
  { field: 'option2Value', label: 'Option 2 value', required: false, hint: '' },
  { field: 'option3Name', label: 'Option 3 name', required: false, hint: '' },
  { field: 'option3Value', label: 'Option 3 value', required: false, hint: '' },
] as CatalogFieldInfo[]);

const FIELD_NAMES: readonly string[] = CATALOG_FIELDS.map((info) => info.field);

/**
 * Known header names, normalised (lowercase, letters and digits only), most specific
 * first.
 */
const STRONG_ALIASES: Readonly<Record<CatalogField, readonly string[]>> = {
  title: ['title', 'producttitle', 'productname', 'name', 'itemname', 'product'],
  handle: ['handle', 'producthandle', 'urlhandle', 'slug'],
  sku: ['sku', 'variantsku', 'skucode', 'skuid', 'skuno', 'itemsku', 'productsku'],
  productId: [
    'deodapid',
    'deodapproductid',
    'deodapcode',
    'productid',
    'productcode',
    'itemid',
    'itemcode',
    'productno',
    'productnumber',
    'id',
  ],
  cost: [
    'dropshipprice',
    'dropshippingprice',
    'dropshipperprice',
    'resellerprice',
    'wholesaleprice',
    'b2bprice',
    'dealerprice',
    'costprice',
    'cost',
    'costperitem',
    'purchaseprice',
    'buyprice',
    'buyingprice',
    'yourprice',
    'netprice',
  ],
  retailPrice: [
    'mrp',
    'maximumretailprice',
    'retailprice',
    'suggestedretailprice',
    'srp',
    'rrp',
    'listprice',
    'compareatprice',
    'variantcompareatprice',
    'marketprice',
    'originalprice',
  ],
  shippingCost: [
    'shippingcost',
    'shippingcharge',
    'shippingcharges',
    'shipping',
    'shippingprice',
    'deliverycharge',
    'deliverycharges',
    'couriercharge',
    'couriercharges',
    'freight',
  ],
  stock: [
    'stock',
    'stockqty',
    'stockquantity',
    'inventory',
    'inventoryqty',
    'variantinventoryqty',
    'qty',
    'quantity',
    'availablequantity',
    'available',
    'instock',
    'stockstatus',
    'availability',
  ],
  description: [
    'bodyhtml',
    'descriptionhtml',
    'description',
    'productdescription',
    'longdescription',
    'details',
    'body',
  ],
  productType: ['type', 'producttype', 'category', 'productcategory'],
  tags: ['tags', 'tag', 'keywords'],
  option1Name: ['option1name'],
  option1Value: ['option1value'],
  option2Name: ['option2name'],
  option2Value: ['option2value'],
  option3Name: ['option3name'],
  option3Value: ['option3value'],
};

/**
 * Names that only weakly suggest the field. Used when nothing stronger matched, and
 * reported as a guess. "Price" is the important one: in a DeoDap export it is usually
 * what DeoDap charges, but it could be a selling price.
 */
const WEAK_ALIASES: Readonly<Partial<Record<CatalogField, readonly string[]>>> = {
  cost: ['price', 'variantprice', 'unitprice', 'rate'],
  retailPrice: ['sellingprice', 'saleprice', 'resaleprice', 'resellingprice'],
};

/** Image columns: "Image", "Image Src", "Image 2", "Image URL 3", "Variant Image"... */
const IMAGE_HEADER =
  /^(main|product|variant|additional|extra)?(image|images|img|photo|photos|picture|pictures|pic)(\d+)?(src|url|urls|link|links)?(\d+)?$/;

export interface ColumnMapping {
  /** The header each field is read from. An absent field is not read. */
  fields: Partial<Record<CatalogField, string>>;
  /** Every column that holds image addresses. */
  imageColumns: string[];
  /** Fields matched only by a weak name, which the preview flags. */
  guessed: CatalogField[];
}

/** An operator's changes to the detected mapping. Null un-maps a field. */
export interface MappingOverride {
  fields: Partial<Record<CatalogField, string | null>>;
  /** Replaces the detected image columns when present. */
  imageColumns: string[] | null;
}

export interface CatalogVariant {
  line: number;
  sku: string | null;
  /** One value per product option, in CatalogProduct.optionNames order. */
  optionValues: string[];
  /** What DeoDap charges for one unit. Null when missing or unreadable. */
  cost: number | null;
  shippingCost: number | null;
  retailPrice: number | null;
  /** Null when the file does not say. Zero means out of stock. */
  stock: number | null;
  inStock: boolean | null;
}

export interface CatalogProduct {
  /** The supplier reference used to recognise this product later. */
  ref: string | null;
  handle: string | null;
  lines: number[];
  title: string | null;
  descriptionHtml: string | null;
  productType: string | null;
  tags: string[];
  imageUrls: string[];
  optionNames: string[];
  variants: CatalogVariant[];
  /** Problems that stop the product being imported. */
  issues: string[];
  /** Worth knowing; nothing is blocked. */
  warnings: string[];
}

export interface Catalog {
  delimiter: CsvDelimiter;
  headers: string[];
  mapping: ColumnMapping;
  recordCount: number;
  products: CatalogProduct[];
  /** Problems with the file as a whole, such as no cost column. */
  warnings: string[];
}

export const MAX_IMAGES_PER_PRODUCT = 10;
export const MAX_TAGS_PER_PRODUCT = 20;
export const MAX_VARIANTS_PER_PRODUCT = 100;
const MAX_TITLE_LENGTH = 255;
const MAX_REF_LENGTH = 200;
/** A single product costing more than this is almost certainly a mis-mapped column. */
const MAX_PLAUSIBLE_AMOUNT = 10_000_000;

function fail(message: string): never {
  throw new AppError('VALIDATION_ERROR', message);
}

/** The key two supplier references are compared by. */
export function refKeyOf(ref: string): string {
  return ref.trim().toLowerCase();
}

export function normaliseHeader(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/* ===========================================================================
 * Values
 * ======================================================================== */

export interface ParsedValue<T> {
  value: T | null;
  /** Set when the cell had content that could not be read. */
  error: string | null;
}

/**
 * Reads a money amount as written in an Indian price list: "₹1,299.00", "Rs. 199",
 * "1,29,999", "INR 450". A comma followed by one or two digits is a decimal comma.
 * An empty cell is null with no error; anything unreadable is an error, never 0.
 */
export function parseAmount(raw: string): ParsedValue<number> {
  const original = raw.trim();
  if (original.length === 0) return { value: null, error: null };

  let text = original.replace(/₹|\brs\.?|\binr\b|\busd\b|\$|€|£/gi, '').replace(/\s+/g, '');
  if (text.startsWith('-')) return { value: null, error: `"${original}" is negative.` };
  if (text.includes(',') && text.includes('.')) {
    text = text.replace(/,/g, '');
  } else if (text.includes(',')) {
    if (/^\d{1,3}(,\d{2,3})*,\d{3}$/.test(text)) text = text.replace(/,/g, '');
    else if (/^\d+,\d{1,2}$/.test(text)) text = text.replace(',', '.');
    else return { value: null, error: `"${original}" is not an amount.` };
  }
  if (!/^\d+(\.\d+)?$/.test(text)) return { value: null, error: `"${original}" is not an amount.` };

  const value = Number(text);
  if (!Number.isFinite(value)) return { value: null, error: `"${original}" is not an amount.` };
  if (value > MAX_PLAUSIBLE_AMOUNT) {
    return {
      value: null,
      error: `"${original}" is too large to be a product price. Check the column mapping.`,
    };
  }
  return { value: roundMoney(value), error: null };
}

export interface ParsedStock {
  quantity: number | null;
  inStock: boolean | null;
  error: string | null;
}

/** Reads a stock cell: a number, or words such as "In stock" and "Out of stock". */
export function parseStock(raw: string): ParsedStock {
  const original = raw.trim();
  const text = original.toLowerCase().replace(/\s+/g, ' ');
  if (text.length === 0) return { quantity: null, inStock: null, error: null };
  if (/^(out of stock|outofstock|sold out|soldout|unavailable|not available|no|n|false)$/.test(text)) {
    return { quantity: null, inStock: false, error: null };
  }
  if (/^(in stock|instock|available|yes|y|true)$/.test(text)) {
    return { quantity: null, inStock: true, error: null };
  }
  const numeric = text.replace(/,/g, '');
  if (/^-?\d+(\.0+)?$/.test(numeric)) {
    // A negative supplier stock level means none available.
    const quantity = Math.max(0, Math.trunc(Number(numeric)));
    return { quantity, inStock: quantity > 0, error: null };
  }
  return {
    quantity: null,
    inStock: null,
    error: `Stock "${original}" is not a number or "in stock" / "out of stock".`,
  };
}

/** Splits a cell that may hold several image addresses. */
function splitUrls(cell: string): string[] {
  return cell
    .split(/[\s|]+|,(?=\s*https?:)|;(?=\s*https?:)/i)
    .map((piece) => piece.trim())
    .filter((piece) => piece.length > 0);
}

/** True for an address Shopify can fetch an image from. Mirrors product.create.ts. */
export function isUsableImageUrl(url: string): boolean {
  if (!/^https:\/\//i.test(url)) return false;
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' &&
      parsed.hostname.length > 0 &&
      parsed.hostname !== 'localhost' &&
      !parsed.hostname.startsWith('127.')
    );
  } catch {
    return false;
  }
}

/* ===========================================================================
 * Mapping
 * ======================================================================== */

/** Detects which column holds which field. Empty columns are skipped. */
export function detectMapping(
  headers: readonly string[],
  records: readonly CsvRecord[] = [],
): ColumnMapping {
  const normalised = headers.map(normaliseHeader);
  const hasValues = headers.map(
    (_header, index) =>
      records.length === 0 || records.some((record) => (record.cells[index] ?? '').trim() !== ''),
  );
  const used = new Set<number>();
  const fields: Partial<Record<CatalogField, string>> = {};
  const guessed: CatalogField[] = [];

  const claim = (field: CatalogField, aliases: readonly string[]): boolean => {
    for (const alias of aliases) {
      const index = normalised.findIndex(
        (name, position) => name === alias && !used.has(position) && hasValues[position] === true,
      );
      if (index !== -1) {
        used.add(index);
        fields[field] = headers[index] as string;
        return true;
      }
    }
    return false;
  };

  for (const info of CATALOG_FIELDS) {
    if (claim(info.field, STRONG_ALIASES[info.field])) continue;
    const weak = WEAK_ALIASES[info.field];
    if (weak !== undefined && claim(info.field, weak)) guessed.push(info.field);
  }

  const imageColumns = headers.filter(
    (_header, index) =>
      !used.has(index) && hasValues[index] === true && IMAGE_HEADER.test(normalised[index] ?? ''),
  );

  return { fields, imageColumns, guessed };
}

/** Validates the `mapping` part of a request body. */
export function validateMappingOverride(raw: unknown): MappingOverride | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) fail('mapping must be an object.');
  const body = raw as Record<string, unknown>;

  const fields: Partial<Record<CatalogField, string | null>> = {};
  const rawFields = body['fields'];
  if (rawFields !== undefined && rawFields !== null) {
    if (typeof rawFields !== 'object' || Array.isArray(rawFields)) {
      fail('mapping.fields must be an object of field name to column name.');
    }
    for (const [key, value] of Object.entries(rawFields as Record<string, unknown>)) {
      if (!FIELD_NAMES.includes(key)) fail(`"${key}" is not a field the importer knows.`);
      if (value === null || value === '') {
        fields[key as CatalogField] = null;
        continue;
      }
      if (typeof value !== 'string' || value.length > 200) {
        fail(`The column for "${key}" must be a column name from the file.`);
      }
      fields[key as CatalogField] = value;
    }
  }

  let imageColumns: string[] | null = null;
  const rawImages = body['imageColumns'];
  if (rawImages !== undefined && rawImages !== null) {
    if (
      !Array.isArray(rawImages) ||
      rawImages.length > 50 ||
      rawImages.some((entry) => typeof entry !== 'string' || entry.length > 200)
    ) {
      fail('mapping.imageColumns must be a list of column names.');
    }
    imageColumns = rawImages as string[];
  }

  return { fields, imageColumns };
}

function findHeader(headers: readonly string[], wanted: string): string | null {
  const exact = headers.find((header) => header === wanted);
  if (exact !== undefined) return exact;
  const target = wanted.trim().toLowerCase();
  return headers.find((header) => header.trim().toLowerCase() === target) ?? null;
}

/**
 * Applies an operator's mapping changes.
 *
 * A column the operator assigns explicitly is taken away from any field that was only
 * auto-detected onto it, so choosing "Price" as the MRP does not leave it also being
 * read as the cost.
 */
export function applyMappingOverride(
  detected: ColumnMapping,
  override: MappingOverride | undefined,
  headers: readonly string[],
): ColumnMapping {
  if (override === undefined) {
    return {
      fields: { ...detected.fields },
      imageColumns: [...detected.imageColumns],
      guessed: [...detected.guessed],
    };
  }

  const fields: Partial<Record<CatalogField, string>> = { ...detected.fields };
  const guessed = new Set(detected.guessed);
  const explicit = new Set<CatalogField>();
  const claimed = new Set<string>();

  for (const [key, header] of Object.entries(override.fields)) {
    const field = key as CatalogField;
    explicit.add(field);
    guessed.delete(field);
    if (header === null || header === undefined) {
      delete fields[field];
      continue;
    }
    const actual = findHeader(headers, header);
    if (actual === null) fail(`Column "${header}" is not in the file.`);
    fields[field] = actual;
    claimed.add(actual);
  }

  for (const info of CATALOG_FIELDS) {
    const header = fields[info.field];
    if (!explicit.has(info.field) && header !== undefined && claimed.has(header)) {
      delete fields[info.field];
      guessed.delete(info.field);
    }
  }

  let imageColumns = detected.imageColumns.filter((header) => !claimed.has(header));
  if (override.imageColumns !== null) {
    imageColumns = override.imageColumns.map((header) => {
      const actual = findHeader(headers, header);
      if (actual === null) fail(`Image column "${header}" is not in the file.`);
      return actual;
    });
  }

  return { fields, imageColumns: [...new Set(imageColumns)], guessed: [...guessed] };
}

/* ===========================================================================
 * Products
 * ======================================================================== */

interface Row {
  line: number;
  value(field: CatalogField): string;
  imageCells(): string[];
}

function rowReader(headers: readonly string[], mapping: ColumnMapping): (record: CsvRecord) => Row {
  const columns = new Map<CatalogField, number>();
  for (const [field, header] of Object.entries(mapping.fields)) {
    if (header === undefined) continue;
    const index = headers.indexOf(header);
    if (index !== -1) columns.set(field as CatalogField, index);
  }
  const imageIndexes = mapping.imageColumns
    .map((header) => headers.indexOf(header))
    .filter((index) => index !== -1);

  return (record) => ({
    line: record.line,
    value: (field) => {
      const index = columns.get(field);
      return index === undefined ? '' : (record.cells[index] ?? '').trim();
    },
    imageCells: () =>
      imageIndexes
        .map((index) => (record.cells[index] ?? '').trim())
        .filter((cell) => cell.length > 0),
  });
}

function firstValue(group: readonly Row[], field: CatalogField): string {
  for (const row of group) {
    const value = row.value(field);
    if (value.length > 0) return value;
  }
  return '';
}

const OPTION_NAME_FIELDS = ['option1Name', 'option2Name', 'option3Name'] as const;
const OPTION_VALUE_FIELDS = ['option1Value', 'option2Value', 'option3Value'] as const;

/** Fields whose presence makes a row a variant rather than an extra-image row. */
const VARIANT_FIELDS: readonly CatalogField[] = [
  'sku',
  'cost',
  'retailPrice',
  'shippingCost',
  'stock',
  'option1Value',
  'option2Value',
  'option3Value',
];

function splitTags(raw: string, warnings: string[]): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const piece of raw.split(',')) {
    const tag = piece.trim();
    if (tag.length === 0 || tag.length > 255) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
  }
  if (tags.length > MAX_TAGS_PER_PRODUCT) {
    warnings.push(`Only the first ${MAX_TAGS_PER_PRODUCT} of ${tags.length} tags are kept.`);
    return tags.slice(0, MAX_TAGS_PER_PRODUCT);
  }
  return tags;
}

function collectImages(group: readonly Row[], warnings: string[]): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];
  let rejected = 0;
  for (const row of group) {
    for (const cell of row.imageCells()) {
      for (const piece of splitUrls(cell)) {
        if (!isUsableImageUrl(piece)) {
          rejected += 1;
          continue;
        }
        const key = piece.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        urls.push(piece);
      }
    }
  }
  if (rejected > 0) {
    warnings.push(
      `${rejected} image address(es) skipped: Shopify can only fetch public https:// images.`,
    );
  }
  if (urls.length > MAX_IMAGES_PER_PRODUCT) {
    warnings.push(`Only the first ${MAX_IMAGES_PER_PRODUCT} of ${urls.length} images are kept.`);
    return urls.slice(0, MAX_IMAGES_PER_PRODUCT);
  }
  return urls;
}

function readOptionNames(group: readonly Row[], mapping: ColumnMapping): string[] {
  const names: string[] = [];
  for (let index = 0; index < 3; index += 1) {
    const nameField = OPTION_NAME_FIELDS[index] as CatalogField;
    const valueField = OPTION_VALUE_FIELDS[index] as CatalogField;
    // A flat file may have a "Color" column mapped as option 1 value and no name
    // column at all. The column's own header is then the option name.
    const name = firstValue(group, nameField) || (firstValue(group, valueField) ? (mapping.fields[valueField] ?? '') : '');
    if (name.trim().length === 0) break;
    names.push(name.trim());
  }
  return names;
}

function buildProduct(group: readonly Row[], mapping: ColumnMapping): CatalogProduct {
  const issues: string[] = [];
  const warnings: string[] = [];
  const lines = group.map((row) => row.line);

  const title = firstValue(group, 'title');
  const handle = firstValue(group, 'handle');
  const productId = firstValue(group, 'productId');

  const description = sanitiseDescription(firstValue(group, 'description'));
  if (description.removed.length > 0) {
    warnings.push(`Removed from the description: ${description.removed.join(', ')}.`);
  }
  if (description.truncated) warnings.push('The description was shortened to fit.');

  let optionNames = readOptionNames(group, mapping);

  const variantRows = group.length === 1 ? [...group] : group.filter((row) =>
    VARIANT_FIELDS.some((field) => row.value(field).length > 0),
  );

  // Shopify writes a single-variant product as option "Title" = "Default Title".
  if (
    optionNames.length === 1 &&
    optionNames[0]?.toLowerCase() === 'title' &&
    variantRows.every((row) => {
      const value = row.value('option1Value').toLowerCase();
      return value === '' || value === 'default title';
    })
  ) {
    optionNames = [];
  }

  const variants: CatalogVariant[] = variantRows.map((row) => {
    const cost = parseAmount(row.value('cost'));
    if (cost.error !== null) issues.push(`Line ${row.line}: DeoDap cost ${cost.error}`);
    else if (cost.value === null) issues.push(`Line ${row.line}: no DeoDap cost.`);
    else if (cost.value <= 0) issues.push(`Line ${row.line}: the DeoDap cost must be more than 0.`);

    const shipping = parseAmount(row.value('shippingCost'));
    if (shipping.error !== null) {
      warnings.push(`Line ${row.line}: shipping ${shipping.error} It was ignored.`);
    }
    const retail = parseAmount(row.value('retailPrice'));
    if (retail.error !== null) {
      warnings.push(`Line ${row.line}: MRP ${retail.error} It was ignored.`);
    }
    const stock = parseStock(row.value('stock'));
    if (stock.error !== null) warnings.push(`Line ${row.line}: ${stock.error}`);

    const sku = row.value('sku');
    if (sku.length > 255) issues.push(`Line ${row.line}: the SKU is longer than 255 characters.`);

    const optionValues = optionNames.map((name, index) => {
      const value = row.value(OPTION_VALUE_FIELDS[index] as CatalogField);
      if (value.length === 0) issues.push(`Line ${row.line}: no value for option "${name}".`);
      return value;
    });

    return {
      line: row.line,
      sku: sku.length > 0 ? sku : null,
      optionValues,
      cost: cost.error === null && cost.value !== null && cost.value > 0 ? cost.value : null,
      shippingCost: shipping.error === null ? shipping.value : null,
      retailPrice:
        retail.error === null && retail.value !== null && retail.value > 0 ? retail.value : null,
      stock: stock.quantity,
      inStock: stock.inStock,
    };
  });

  if (title.length === 0) issues.push('No product title.');
  else if (title.length > MAX_TITLE_LENGTH) {
    issues.push(`The title is longer than ${MAX_TITLE_LENGTH} characters.`);
  }

  if (variants.length === 0) issues.push('No row with a price for this product.');
  if (variants.length > MAX_VARIANTS_PER_PRODUCT) {
    issues.push(
      `${variants.length} variants; a Shopify product can have at most ${MAX_VARIANTS_PER_PRODUCT}.`,
    );
  }
  if (variants.length > 1 && optionNames.length === 0) {
    issues.push(
      `${variants.length} rows share the handle "${handle}" but have no option values (such as Size or Color), so the variants cannot be told apart.`,
    );
  }

  if (optionNames.length > 0) {
    const seenCombinations = new Map<string, number>();
    for (const variant of variants) {
      const combination = variant.optionValues.map((value) => value.toLowerCase()).join(' / ');
      const first = seenCombinations.get(combination);
      if (first !== undefined) {
        issues.push(`Lines ${first} and ${variant.line} have the same options (${combination}).`);
      } else {
        seenCombinations.set(combination, variant.line);
      }
    }
  }

  const seenSkus = new Map<string, number>();
  for (const variant of variants) {
    if (variant.sku === null) continue;
    const key = variant.sku.toLowerCase();
    const first = seenSkus.get(key);
    if (first !== undefined) {
      issues.push(`Lines ${first} and ${variant.line} have the same SKU "${variant.sku}".`);
    } else {
      seenSkus.set(key, variant.line);
    }
  }

  const ref =
    productId || handle || (variants.length === 1 ? (variants[0]?.sku ?? '') : '') || null;
  if (ref === null) {
    issues.push(
      'No SKU, handle or product ID, so Trademart could not recognise this product again in a later price list or order.',
    );
  } else if (ref.length > MAX_REF_LENGTH) {
    issues.push(`The product reference is longer than ${MAX_REF_LENGTH} characters.`);
  }

  if (variants.length > 0 && variants.every((variant) => variant.inStock === false)) {
    warnings.push('DeoDap lists this product as out of stock.');
  }

  return {
    ref,
    handle: handle.length > 0 ? handle : null,
    lines,
    title: title.length > 0 ? title : null,
    descriptionHtml: description.html,
    productType: firstValue(group, 'productType') || null,
    tags: splitTags(firstValue(group, 'tags'), warnings),
    imageUrls: collectImages(group, warnings),
    optionNames,
    variants,
    issues,
    warnings,
  };
}

/**
 * Reads a DeoDap product file.
 *
 * Throws VALIDATION_ERROR only for a file that cannot be read at all (see
 * deodap.csv.ts) or a mapping naming a column that does not exist. Everything else is
 * reported per product, so one bad row never hides the other five hundred.
 */
export function readCatalog(text: string, override?: MappingOverride): Catalog {
  const table = parseCsv(text);
  const mapping = applyMappingOverride(
    detectMapping(table.headers, table.records),
    override,
    table.headers,
  );

  const warnings: string[] = [];
  if (mapping.fields.title === undefined) {
    warnings.push('No column looks like the product title. Choose it in the column mapping.');
  }
  if (mapping.fields.cost === undefined) {
    warnings.push(
      'No column looks like the DeoDap cost. Choose it in the column mapping; nothing can be priced without it.',
    );
  } else if (mapping.guessed.includes('cost')) {
    warnings.push(
      `The DeoDap cost is being read from the "${mapping.fields.cost}" column. Check that this is what DeoDap charges you and not a selling price.`,
    );
  }
  if (
    mapping.fields.sku === undefined &&
    mapping.fields.productId === undefined &&
    mapping.fields.handle === undefined
  ) {
    warnings.push(
      'There is no SKU, product ID or handle column, so products cannot be recognised in later price lists or orders.',
    );
  }

  const read = rowReader(table.headers, mapping);
  const rows = table.records.map(read);

  const groups: Row[][] = [];
  if (mapping.fields.handle === undefined) {
    for (const row of rows) groups.push([row]);
  } else {
    const byHandle = new Map<string, Row[]>();
    for (const row of rows) {
      const handle = row.value('handle').toLowerCase();
      if (handle.length === 0) {
        groups.push([row]);
        continue;
      }
      const existing = byHandle.get(handle);
      if (existing !== undefined) {
        existing.push(row);
      } else {
        const group = [row];
        byHandle.set(handle, group);
        groups.push(group);
      }
    }
  }

  const products = groups.map((group) => buildProduct(group, mapping));

  // The same supplier reference twice would be imported twice.
  const firstLineByRef = new Map<string, number>();
  for (const product of products) {
    if (product.ref === null) continue;
    const key = refKeyOf(product.ref);
    const first = firstLineByRef.get(key);
    if (first !== undefined) {
      product.issues.push(`Same product reference as line ${first}; only the first is imported.`);
    } else {
      firstLineByRef.set(key, product.lines[0] ?? 0);
    }
  }

  return {
    delimiter: table.delimiter,
    headers: table.headers,
    mapping,
    recordCount: table.records.length,
    products,
    warnings,
  };
}
