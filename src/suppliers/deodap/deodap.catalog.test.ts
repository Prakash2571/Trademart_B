/**
 * Reading DeoDap files into products.
 *
 * The rule under test above all others: a cost that is missing or unreadable is a
 * blocking problem, never zero, because a product priced from zero is sold at a loss.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AppError } from '../../common/errors';
import {
  applyMappingOverride,
  detectMapping,
  parseAmount,
  parseStock,
  readCatalog,
  validateMappingOverride,
} from './deodap.catalog';
import { parseCsv } from './deodap.csv';

const SHOPIFY_EXPORT = [
  'Handle,Title,Body (HTML),Vendor,Type,Tags,Option1 Name,Option1 Value,Variant SKU,Variant Price,Variant Compare At Price,Variant Inventory Qty,Image Src,Cost per item',
  'steel-bottle,Steel Bottle,<p>Keeps water <b>cold</b></p>,DeoDap,Kitchen,"bottle, steel",Color,Red,1234-R,199,299,50,https://cdn.example.com/red.jpg,',
  'steel-bottle,,,,,,,Blue,1234-B,199,299,0,https://cdn.example.com/blue.jpg,',
  'steel-bottle,,,,,,,,,,,,https://cdn.example.com/extra.jpg,',
  'lunch-box,Lunch Box,Airtight,DeoDap,Kitchen,,Title,Default Title,5678,149,,12,https://cdn.example.com/box.jpg,',
].join('\n');

const FLAT_EXPORT = [
  'Product Name,SKU,Dropship Price,MRP,Shipping,Stock,Image 1,Image 2,Description',
  'Mini Fan,DD-100,"₹1,299.00",1999,50,In stock,https://cdn.example.com/fan.jpg,http://insecure.example.com/fan.jpg,Quiet fan',
  'Desk Lamp,DD-101,abc,799,,Out of stock,,,',
  ',DD-102,120,,,,,,',
  'Mini Fan Copy,DD-100,99,,,,,,',
].join('\n');

function isValidationError(error: unknown): boolean {
  return error instanceof AppError && error.code === 'VALIDATION_ERROR';
}

describe('parseAmount', () => {
  it('reads Indian price formats', () => {
    assert.equal(parseAmount('₹1,299.00').value, 1299);
    assert.equal(parseAmount('Rs. 199').value, 199);
    assert.equal(parseAmount('INR 450').value, 450);
    assert.equal(parseAmount('1,29,999').value, 129999);
    assert.equal(parseAmount('12,50').value, 12.5);
  });

  it('treats an empty cell as unknown, not zero', () => {
    assert.deepEqual(parseAmount('  '), { value: null, error: null });
  });

  it('reports what it cannot read instead of guessing', () => {
    assert.ok(parseAmount('abc').error !== null);
    assert.ok(parseAmount('-5').error !== null);
    assert.ok(parseAmount('1.2.3').error !== null);
    assert.match(parseAmount('99999999').error ?? '', /too large/);
  });
});

describe('parseStock', () => {
  it('reads numbers and words', () => {
    assert.deepEqual(parseStock('12'), { quantity: 12, inStock: true, error: null });
    assert.deepEqual(parseStock('0'), { quantity: 0, inStock: false, error: null });
    assert.deepEqual(parseStock('Out of stock'), { quantity: null, inStock: false, error: null });
    assert.deepEqual(parseStock('In Stock'), { quantity: null, inStock: true, error: null });
    assert.deepEqual(parseStock(''), { quantity: null, inStock: null, error: null });
  });

  it('treats a negative supplier stock as none', () => {
    assert.equal(parseStock('-3').quantity, 0);
  });

  it('reports an unreadable stock value', () => {
    assert.ok(parseStock('lots').error !== null);
  });
});

describe('detectMapping', () => {
  it('maps a Shopify export, falling back from an empty cost column to Variant Price as a guess', () => {
    const table = parseCsv(SHOPIFY_EXPORT);
    const mapping = detectMapping(table.headers, table.records);
    assert.equal(mapping.fields.title, 'Title');
    assert.equal(mapping.fields.handle, 'Handle');
    assert.equal(mapping.fields.sku, 'Variant SKU');
    assert.equal(mapping.fields.cost, 'Variant Price', '"Cost per item" is empty in every row');
    assert.deepEqual(mapping.guessed, ['cost']);
    assert.equal(mapping.fields.retailPrice, 'Variant Compare At Price');
    assert.equal(mapping.fields.stock, 'Variant Inventory Qty');
    assert.equal(mapping.fields.description, 'Body (HTML)');
    assert.deepEqual(mapping.imageColumns, ['Image Src']);
  });

  it('maps a flat DeoDap-style file, with a named cost column that is not a guess', () => {
    const table = parseCsv(FLAT_EXPORT);
    const mapping = detectMapping(table.headers, table.records);
    assert.equal(mapping.fields.title, 'Product Name');
    assert.equal(mapping.fields.cost, 'Dropship Price');
    assert.equal(mapping.fields.retailPrice, 'MRP');
    assert.equal(mapping.fields.shippingCost, 'Shipping');
    assert.deepEqual(mapping.guessed, []);
    assert.deepEqual(mapping.imageColumns, ['Image 1', 'Image 2']);
  });
});

describe('mapping overrides', () => {
  const table = parseCsv(SHOPIFY_EXPORT);
  const detected = detectMapping(table.headers, table.records);

  it('lets the operator choose a column, and frees it from an auto-detected field', () => {
    const override = validateMappingOverride({ fields: { retailPrice: 'Variant Price' } });
    const mapping = applyMappingOverride(detected, override, table.headers);
    assert.equal(mapping.fields.retailPrice, 'Variant Price');
    assert.equal(mapping.fields.cost, undefined, 'the cost must not silently read the same column');
    assert.deepEqual(mapping.guessed, []);
  });

  it('un-maps a field set to null', () => {
    const mapping = applyMappingOverride(
      detected,
      validateMappingOverride({ fields: { stock: null } }),
      table.headers,
    );
    assert.equal(mapping.fields.stock, undefined);
  });

  it('refuses a column that is not in the file, and an unknown field', () => {
    assert.throws(
      () => applyMappingOverride(detected, validateMappingOverride({ fields: { cost: 'Nope' } }), table.headers),
      isValidationError,
    );
    assert.throws(() => validateMappingOverride({ fields: { colour: 'Title' } }), isValidationError);
  });
});

describe('readCatalog - Shopify-style export', () => {
  const catalog = readCatalog(SHOPIFY_EXPORT);

  it('groups rows by handle into products with variants', () => {
    assert.equal(catalog.products.length, 2);
    const bottle = catalog.products[0];
    assert.equal(bottle?.title, 'Steel Bottle');
    assert.equal(bottle?.ref, 'steel-bottle');
    assert.deepEqual(bottle?.optionNames, ['Color']);
    assert.deepEqual(
      bottle?.variants.map((variant) => [variant.sku, variant.optionValues[0], variant.cost]),
      [
        ['1234-R', 'Red', 199],
        ['1234-B', 'Blue', 199],
      ],
    );
    assert.equal(bottle?.imageUrls.length, 3, 'an image-only row adds an image, not a variant');
    assert.deepEqual(bottle?.tags, ['bottle', 'steel']);
    assert.deepEqual(bottle?.issues, []);
  });

  it('treats Shopify\'s "Default Title" option as no options', () => {
    const box = catalog.products[1];
    assert.deepEqual(box?.optionNames, []);
    assert.equal(box?.variants.length, 1);
    assert.equal(box?.variants[0]?.retailPrice, null);
  });

  it('flags the guessed cost column at file level', () => {
    assert.ok(catalog.warnings.some((warning) => warning.includes('Variant Price')));
  });

  it('keeps the description as sanitised HTML', () => {
    assert.equal(catalog.products[0]?.descriptionHtml, '<p>Keeps water <b>cold</b></p>');
  });
});

describe('readCatalog - flat file', () => {
  const catalog = readCatalog(FLAT_EXPORT);
  const [fan, lamp, untitled, copy] = catalog.products;

  it('reads one product per row with the SKU as its reference', () => {
    assert.equal(catalog.products.length, 4);
    assert.equal(fan?.ref, 'DD-100');
    assert.equal(fan?.variants[0]?.cost, 1299);
    assert.equal(fan?.variants[0]?.retailPrice, 1999);
    assert.equal(fan?.variants[0]?.shippingCost, 50);
    assert.equal(fan?.variants[0]?.inStock, true);
    assert.deepEqual(fan?.issues, []);
  });

  it('skips images Shopify cannot fetch, and says so', () => {
    assert.deepEqual(fan?.imageUrls, ['https://cdn.example.com/fan.jpg']);
    assert.ok(fan?.warnings.some((warning) => warning.includes('https')));
  });

  it('blocks a product whose cost cannot be read - it is never priced from zero', () => {
    assert.equal(lamp?.variants[0]?.cost, null);
    assert.ok(lamp?.issues.some((issue) => issue.includes('DeoDap cost')));
    assert.ok(lamp?.warnings.some((warning) => warning.includes('out of stock')));
  });

  it('blocks a product with no title', () => {
    assert.ok(untitled?.issues.includes('No product title.'));
  });

  it('blocks a second product with the same reference', () => {
    assert.ok(copy?.issues.some((issue) => issue.includes('line 2')));
  });
});

describe('readCatalog - problems', () => {
  it('blocks rows sharing a handle with no options to tell them apart', () => {
    const catalog = readCatalog('Handle,Title,SKU,Price\nx,Thing,A,10\nx,,B,12');
    assert.ok(catalog.products[0]?.issues.some((issue) => issue.includes('cannot be told apart')));
  });

  it('blocks duplicate option combinations', () => {
    const catalog = readCatalog(
      'Handle,Title,Option1 Name,Option1 Value,SKU,Cost\nx,Thing,Size,M,A,10\nx,,,M,B,12',
    );
    assert.ok(catalog.products[0]?.issues.some((issue) => issue.includes('same options')));
  });

  it('uses the column header as the option name when there is no name column', () => {
    const catalog = readCatalog(
      validCsv(['Handle,Title,Colour,SKU,Cost', 'x,Thing,Red,A,10', 'x,,Blue,B,12']),
      validateMappingOverride({ fields: { option1Value: 'Colour' } }),
    );
    assert.deepEqual(catalog.products[0]?.optionNames, ['Colour']);
    assert.deepEqual(catalog.products[0]?.issues, []);
  });

  it('warns at file level when there is no cost column at all', () => {
    const catalog = readCatalog('Title,SKU\nThing,A');
    assert.ok(catalog.warnings.some((warning) => warning.includes('DeoDap cost')));
    assert.ok(catalog.products[0]?.issues.some((issue) => issue.includes('no DeoDap cost')));
  });

  it('requires something to recognise the product by later', () => {
    const catalog = readCatalog('Title,Cost\nThing,10');
    assert.ok(catalog.products[0]?.issues.some((issue) => issue.includes('No SKU, handle or product ID')));
  });
});

function validCsv(lines: string[]): string {
  return lines.join('\n');
}
