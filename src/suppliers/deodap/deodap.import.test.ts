/**
 * Preview and import-batch contract.
 *
 * What must hold: only a product with no blocking problem gets a draft; the ledger
 * decides what counts as already imported; a batch is validated completely before any
 * Shopify write; and everything is created as a DRAFT with the DeoDap tag.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AppError } from '../../common/errors';
import { readCatalog } from './deodap.catalog';
import {
  APP_FLOW_IMPORT_WARNING,
  MAX_IMPORT_BATCH,
  buildImportPreview,
  matchCreatedVariants,
  mergeTags,
  readSourceFile,
  summariseImport,
  validateCsvRequest,
  validateImportPreviewRequest,
  validateImportRequest,
  type ExistingImport,
  type ImportDraft,
  type ImportItemResult,
} from './deodap.import';
import { defaultDeodapSettings, type DeodapOrderFlow } from './deodap.settings';

const CSV = [
  'Product Name,SKU,Dropship Price,MRP,Image',
  'Mini Fan,DD-100,100,250,https://cdn.example.com/fan.jpg',
  'Lamp,DD-101,,,',
  'Jar,DD-102,40,,',
].join('\n');

function isValidationError(error: unknown): boolean {
  return error instanceof AppError && error.code === 'VALIDATION_ERROR';
}

function preview(
  existing: ReadonlyMap<string, ExistingImport> = new Map(),
  shopCurrency: string | null = 'INR',
  orderFlow: DeodapOrderFlow = 'MANUAL',
) {
  const settings = defaultDeodapSettings();
  const request = validateImportPreviewRequest(
    { csv: CSV, sourceFile: 'C:\\Users\\me\\Downloads\\deodap.csv' },
    settings,
  );
  return buildImportPreview({
    catalog: readCatalog(request.csv, request.mapping),
    request,
    vendor: settings.vendorName,
    orderFlow,
    existing,
    ledgerChecked: true,
    shopCurrency,
    shopCurrencyError: null,
  });
}

function fanDraft(): ImportDraft {
  const draft = preview().products[0]?.draft;
  if (draft === null || draft === undefined) throw new Error('expected a draft for the fan');
  return draft;
}

describe('buildImportPreview', () => {
  it('prices each ready product and builds its draft', () => {
    const result = preview();
    const fan = result.products[0];
    assert.equal(fan?.status, 'READY');
    // Default settings: 50% markup, whole-unit rounding, MRP as compare-at.
    assert.deepEqual(fan?.draft?.variants[0], {
      sku: 'DD-100',
      optionValues: [],
      price: 150,
      compareAtPrice: 250,
      cost: 100,
      shippingCost: null,
    });
    assert.equal(fan?.marginMin, 33.3);
    assert.deepEqual(result.summary, {
      products: 3,
      ready: 2,
      needsAttention: 1,
      alreadyImported: 0,
      inProgress: 0,
    });
  });

  it('gives a product with a blocking problem no draft', () => {
    const lamp = preview().products[1];
    assert.equal(lamp?.status, 'NEEDS_ATTENTION');
    assert.equal(lamp?.draft, null);
    assert.ok((lamp?.issues.length ?? 0) > 0);
  });

  it('marks what the ledger already has, and lets a failed import be retried', () => {
    const existing = new Map<string, ExistingImport>([
      ['dd-100', { status: 'CREATED', shopifyProductId: 'gid://shopify/Product/9', error: null, updatedAt: null }],
      ['dd-102', { status: 'FAILED', shopifyProductId: null, error: 'SHOPIFY_TIMEOUT', updatedAt: null }],
    ]);
    const [fan, , jar] = preview(existing).products;
    assert.equal(fan?.status, 'ALREADY_IMPORTED');
    assert.equal(fan?.draft, null, 'an imported product must not be offered again');
    assert.equal(jar?.status, 'READY');
    assert.ok(jar?.warnings.some((warning) => warning.includes('failed')));
  });

  it('reports a store in another currency as blocking', () => {
    assert.match(preview(new Map(), 'GBP').currencyProblem ?? '', /GBP/);
    assert.equal(preview(new Map(), 'INR').currencyProblem, null);
  });

  it('warns first, while DeoDap\u2019s app places orders, that it will not know these products', () => {
    const appFlow = preview(new Map(), 'INR', 'SHOPIFY_APP');
    assert.equal(appFlow.orderFlow, 'SHOPIFY_APP');
    assert.equal(appFlow.warnings[0], APP_FLOW_IMPORT_WARNING);
    assert.match(APP_FLOW_IMPORT_WARNING, /NOT sent to DeoDap automatically/);
    assert.ok(!preview().warnings.includes(APP_FLOW_IMPORT_WARNING));
  });

  it('keeps only the file name of the upload', () => {
    assert.equal(preview().file.sourceFile, 'deodap.csv');
    assert.equal(readSourceFile('/tmp/a/b.csv'), 'b.csv');
    assert.equal(readSourceFile(42), null);
  });
});

describe('validateImportRequest', () => {
  it('accepts drafts from the preview and creates a DRAFT with the DeoDap tag', () => {
    const request = validateImportRequest(
      { products: [fanDraft()], currencyCode: 'inr', sourceFile: 'deodap.csv' },
      'DeoDap',
    );
    assert.equal(request.currencyCode, 'INR');
    const create = request.items[0]?.create;
    assert.equal(create?.status, 'DRAFT');
    assert.equal(create?.publish, false);
    assert.equal(create?.vendor, 'DeoDap');
    assert.ok(create?.tags.includes('DeoDap'));
    assert.equal(create?.variants[0]?.price, '150.00');
    assert.equal(create?.variants[0]?.compareAtPrice, '250.00');
    assert.deepEqual(create?.mediaUrls, ['https://cdn.example.com/fan.jpg']);
  });

  it('applies the configured vendor, and still tags the product as DeoDap', () => {
    const request = validateImportRequest({ products: [fanDraft()], currencyCode: 'INR' }, 'My Brand');
    assert.equal(request.items[0]?.create.vendor, 'My Brand');
    assert.ok(request.items[0]?.create.tags.includes('DeoDap'));
  });

  it('refuses a batch that is too large, or the same product twice', () => {
    const draft = fanDraft();
    assert.throws(
      () =>
        validateImportRequest(
          { products: Array.from({ length: MAX_IMPORT_BATCH + 1 }, () => draft), currencyCode: 'INR' },
          'DeoDap',
        ),
      isValidationError,
    );
    assert.throws(
      () => validateImportRequest({ products: [draft, draft], currencyCode: 'INR' }, 'DeoDap'),
      isValidationError,
    );
  });

  it('refuses a price below the DeoDap cost', () => {
    const draft = fanDraft();
    const cheap = { ...draft, variants: draft.variants.map((variant) => ({ ...variant, price: 50 })) };
    assert.throws(
      () => validateImportRequest({ products: [cheap], currencyCode: 'INR' }, 'DeoDap'),
      isValidationError,
    );
  });

  it('refuses an image Shopify cannot fetch, and a missing currency', () => {
    const draft = fanDraft();
    assert.throws(
      () =>
        validateImportRequest(
          { products: [{ ...draft, imageUrls: ['http://insecure.example.com/a.jpg'] }], currencyCode: 'INR' },
          'DeoDap',
        ),
      isValidationError,
    );
    assert.throws(() => validateImportRequest({ products: [draft] }, 'DeoDap'), isValidationError);
  });

  it('sanitises a returned description again rather than trusting the browser', () => {
    const draft = { ...fanDraft(), descriptionHtml: '<script>alert(1)</script><p>Quiet</p>' };
    const request = validateImportRequest({ products: [draft], currencyCode: 'INR' }, 'DeoDap');
    assert.equal(request.items[0]?.create.descriptionHtml, '<p>Quiet</p>');
  });

  it('runs Shopify-side validation for every product before anything is written', () => {
    const draft = fanDraft();
    const bad = { ...draft, ref: 'other', options: [{ name: 'Size', values: ['M'] }] };
    assert.throws(
      () => validateImportRequest({ products: [draft, bad], currencyCode: 'INR' }, 'DeoDap'),
      (error: unknown) => isValidationError(error) && /Product 2/.test((error as Error).message),
    );
  });
});

describe('matchCreatedVariants', () => {
  const drafts = [
    { sku: 'A', optionValues: [{ optionName: 'Color', name: 'Red' }], price: 10, compareAtPrice: null, cost: 5, shippingCost: null },
    { sku: null, optionValues: [{ optionName: 'Color', name: 'Blue' }], price: 10, compareAtPrice: null, cost: 5, shippingCost: null },
  ];

  it('matches by SKU and by option values, whatever order Shopify returns', () => {
    const matched = matchCreatedVariants(drafts, [
      { shopifyVariantId: 'v-blue', sku: null, optionValues: [{ name: 'Color', value: 'Blue' }] },
      { shopifyVariantId: 'v-red', sku: 'a', optionValues: [{ name: 'Color', value: 'Red' }] },
    ]);
    assert.deepEqual(matched, ['v-red', 'v-blue']);
  });

  it('pairs a single variant with the only created variant', () => {
    const single = [{ sku: null, optionValues: [], price: 10, compareAtPrice: null, cost: 5, shippingCost: null }];
    assert.deepEqual(matchCreatedVariants(single, [{ shopifyVariantId: 'v1', sku: null, optionValues: [] }]), ['v1']);
  });

  it('reports what it cannot match as null rather than guessing', () => {
    assert.deepEqual(matchCreatedVariants(drafts, []), [null, null]);
  });
});

describe('small helpers', () => {
  it('mergeTags puts the DeoDap tag first and drops duplicates and commas', () => {
    assert.deepEqual(mergeTags(['deodap', 'kitchen', 'bad,tag', 'Kitchen']), ['DeoDap', 'kitchen']);
  });

  it('summariseImport calls a batch partial unless everything was created or skipped', () => {
    const result = (outcome: ImportItemResult['outcome']): ImportItemResult => ({
      ref: 'r',
      title: 't',
      outcome,
      shopifyProductId: null,
      reason: null,
      errorCode: null,
      warnings: [],
      costsRecorded: 0,
    });
    assert.equal(summariseImport([result('CREATED'), result('SKIPPED')]).partial, false);
    const mixed = summariseImport([result('CREATED'), result('FAILED'), result('NOT_ATTEMPTED')]);
    assert.equal(mixed.partial, true);
    assert.equal(mixed.summary.FAILED, 1);
  });

  it('validateCsvRequest requires the file and defaults the currency from settings', () => {
    const settings = defaultDeodapSettings();
    assert.throws(() => validateCsvRequest({}, settings), isValidationError);
    assert.equal(validateCsvRequest({ csv: 'Title\nA' }, settings).currencyCode, 'INR');
    assert.equal(validateCsvRequest({ csv: 'Title\nA', currencyCode: 'usd' }, settings).currencyCode, 'USD');
    assert.throws(() => validateCsvRequest({ csv: 'Title\nA', currencyCode: 'rupees' }, settings), isValidationError);
  });
});
