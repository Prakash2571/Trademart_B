/**
 * Unit tests for product-creation validation and input building.
 *
 * The properties that matter: a new product defaults to DRAFT (never
 * auto-visible), prices are positive, and variants must match the declared
 * options - so a malformed catalogue import is rejected before it reaches
 * Shopify rather than creating a broken product.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AppError } from '../common/errors';
import {
  buildMediaInput,
  buildProductCreateInput,
  buildVariantsCreateInput,
  validateProductCreate,
} from './product.create';

const minimal = {
  title: 'Test Product',
  variants: [{ price: '9.99' }],
};

describe('validateProductCreate', () => {
  it('defaults desiredStatus to DRAFT and does not publish - never auto-visible', () => {
    // The central safety rule for new products.
    const req = validateProductCreate(minimal);
    assert.equal(req.desiredStatus, 'DRAFT');
    assert.equal(req.publishToOnlineStore, false);
  });

  it('allows an explicit ACTIVE as the DESIRED end status', () => {
    assert.equal(
      validateProductCreate({ ...minimal, status: 'active' }).desiredStatus,
      'ACTIVE',
    );
  });

  it('treats status ACTIVE as an intent to publish, absent an explicit flag', () => {
    // Preserves what a caller sending status:ACTIVE has always meant, but as a
    // named field rather than an assumption hidden inside `status`.
    assert.equal(
      validateProductCreate({ ...minimal, status: 'ACTIVE' }).publishToOnlineStore,
      true,
    );
  });

  it('lets publish:false override an ACTIVE status', () => {
    // "Set it live but keep it off the storefront" is a legitimate request, and
    // the two concepts have to be independently expressible for it to work.
    const req = validateProductCreate({ ...minimal, status: 'ACTIVE', publish: false });
    assert.equal(req.desiredStatus, 'ACTIVE');
    assert.equal(req.publishToOnlineStore, false);
  });

  it('lets publish:true be requested for a DRAFT', () => {
    const req = validateProductCreate({ ...minimal, status: 'DRAFT', publish: true });
    assert.equal(req.desiredStatus, 'DRAFT');
    assert.equal(req.publishToOnlineStore, true);
  });

  it('rejects a non-boolean publish', () => {
    assert.throws(
      () => validateProductCreate({ ...minimal, publish: 'yes' }),
      (e: unknown) => e instanceof AppError && e.code === 'VALIDATION_ERROR',
    );
  });

  it('refuses to publish an ARCHIVED product', () => {
    assert.throws(
      () => validateProductCreate({ ...minimal, status: 'ARCHIVED', publish: true }),
      (e: unknown) => e instanceof AppError && e.code === 'VALIDATION_ERROR',
    );
  });

  it('requires a title', () => {
    assert.throws(
      () => validateProductCreate({ variants: [{ price: '1' }] }),
      (e: unknown) => e instanceof AppError && e.code === 'VALIDATION_ERROR',
    );
  });

  it('requires at least one priced variant', () => {
    assert.throws(() => validateProductCreate({ title: 'x' }));
    assert.throws(() => validateProductCreate({ title: 'x', variants: [] }));
  });

  it('rejects a non-positive variant price', () => {
    assert.throws(() => validateProductCreate({ title: 'x', variants: [{ price: 0 }] }));
    assert.throws(() => validateProductCreate({ title: 'x', variants: [{ price: '-3' }] }));
  });

  it('normalises prices to 2dp', () => {
    const req = validateProductCreate({ title: 'x', variants: [{ price: 9.5 }] });
    assert.equal(req.variants[0]?.price, '9.50');
  });

  it('rejects compareAtPrice below price', () => {
    assert.throws(() =>
      validateProductCreate({ title: 'x', variants: [{ price: '20', compareAtPrice: '10' }] }),
    );
  });

  it('accepts options and matching variants', () => {
    const req = validateProductCreate({
      title: 'Tee',
      options: [{ name: 'Size', values: ['S', 'M'] }],
      variants: [
        { price: '10', optionValues: [{ optionName: 'Size', name: 'S' }] },
        { price: '10', optionValues: [{ optionName: 'Size', name: 'M' }] },
      ],
    });
    assert.equal(req.options.length, 1);
    assert.equal(req.variants.length, 2);
  });

  it('rejects a variant value not declared in options', () => {
    assert.throws(() =>
      validateProductCreate({
        title: 'Tee',
        options: [{ name: 'Size', values: ['S', 'M'] }],
        variants: [{ price: '10', optionValues: [{ optionName: 'Size', name: 'XL' }] }],
      }),
    );
  });

  it('rejects a variant missing a value for a declared option', () => {
    assert.throws(() =>
      validateProductCreate({
        title: 'Tee',
        options: [{ name: 'Size', values: ['S'] }],
        variants: [{ price: '10', optionValues: [] }],
      }),
    );
  });

  it('rejects more than 3 options', () => {
    assert.throws(() =>
      validateProductCreate({
        title: 'x',
        options: [
          { name: 'A', values: ['1'] },
          { name: 'B', values: ['1'] },
          { name: 'C', values: ['1'] },
          { name: 'D', values: ['1'] },
        ],
        variants: [{ price: '1' }],
      }),
    );
  });

  it('rejects a non-https media URL', () => {
    assert.throws(() =>
      validateProductCreate({ ...minimal, mediaUrls: ['http://insecure.example/x.jpg'] }),
    );
  });

  it('accepts https media URLs', () => {
    const req = validateProductCreate({
      ...minimal,
      mediaUrls: ['https://cdn.example/x.jpg'],
    });
    assert.equal(req.mediaUrls.length, 1);
  });

  it('rejects a tag containing a comma', () => {
    // Shopify splits tags on commas, so accepting one silently creates two tags
    // the operator never asked for.
    assert.throws(
      () => validateProductCreate({ ...minimal, tags: ['good', 'a,b'] }),
      (e: unknown) => e instanceof AppError && e.code === 'VALIDATION_ERROR',
    );
  });

  it('keeps valid tags and de-duplicates case-insensitively', () => {
    const req = validateProductCreate({ ...minimal, tags: ['Sale', 'sale', ' new '] });
    assert.deepEqual(req.tags, ['Sale', 'new']);
  });

  it('rejects duplicate SKUs across variants', () => {
    // Two variants sharing a SKU misattributes cost and supplier lookups, and
    // the symptom appears later as mispriced stock rather than as an error.
    assert.throws(
      () =>
        validateProductCreate({
          title: 'Tee',
          options: [{ name: 'Size', values: ['S', 'M'] }],
          variants: [
            { price: '10', sku: 'DUP', optionValues: [{ optionName: 'Size', name: 'S' }] },
            { price: '12', sku: 'dup', optionValues: [{ optionName: 'Size', name: 'M' }] },
          ],
        }),
      (e: unknown) => e instanceof AppError && e.code === 'VALIDATION_ERROR',
    );
  });

  it('rejects duplicate option combinations', () => {
    assert.throws(
      () =>
        validateProductCreate({
          title: 'Tee',
          options: [{ name: 'Size', values: ['S'] }],
          variants: [
            { price: '10', optionValues: [{ optionName: 'Size', name: 'S' }] },
            { price: '12', optionValues: [{ optionName: 'Size', name: 'S' }] },
          ],
        }),
      (e: unknown) => e instanceof AppError && e.code === 'VALIDATION_ERROR',
    );
  });

  it('rejects several variants when no options are declared', () => {
    // Shopify collapses these to one variant, silently discarding entered prices.
    assert.throws(
      () =>
        validateProductCreate({
          title: 'x',
          variants: [{ price: '10' }, { price: '12' }],
        }),
      (e: unknown) => e instanceof AppError && e.code === 'VALIDATION_ERROR',
    );
  });

  it('rejects an implausible barcode', () => {
    assert.throws(
      () => validateProductCreate({ title: 'x', variants: [{ price: '1', barcode: 'a b' }] }),
      (e: unknown) => e instanceof AppError && e.code === 'VALIDATION_ERROR',
    );
  });

  it('accepts a plausible barcode', () => {
    const req = validateProductCreate({
      title: 'x',
      variants: [{ price: '1', barcode: '5012345678900' }],
    });
    assert.equal(req.variants[0]?.barcode, '5012345678900');
  });

  it('rejects a duplicate media URL', () => {
    assert.throws(
      () =>
        validateProductCreate({
          ...minimal,
          mediaUrls: ['https://cdn.example/x.jpg', 'https://cdn.example/x.jpg'],
        }),
      (e: unknown) => e instanceof AppError && e.code === 'VALIDATION_ERROR',
    );
  });

  it('rejects a media URL with no public hostname', () => {
    assert.throws(() => validateProductCreate({ ...minimal, mediaUrls: ['https://localhost/x.jpg'] }));
  });
});

describe('buildProductCreateInput', () => {
  it('ALWAYS creates as DRAFT, even when ACTIVE was requested', () => {
    // The single most important property of the create flow: a product is born
    // invisible and is only activated after publication has been verified.
    const req = validateProductCreate({ ...minimal, status: 'ACTIVE', publish: true });
    assert.equal(req.desiredStatus, 'ACTIVE');
    assert.equal(buildProductCreateInput(req)['status'], 'DRAFT');
  });

  it('includes title and status and maps options to productOptions', () => {
    const req = validateProductCreate({
      title: 'Tee',
      options: [{ name: 'Size', values: ['S', 'M'] }],
      variants: [
        { price: '10', optionValues: [{ optionName: 'Size', name: 'S' }] },
        { price: '10', optionValues: [{ optionName: 'Size', name: 'M' }] },
      ],
    });
    const input = buildProductCreateInput(req);
    assert.equal(input['title'], 'Tee');
    assert.equal(input['status'], 'DRAFT');
    assert.deepEqual(input['productOptions'], [
      { name: 'Size', values: [{ name: 'S' }, { name: 'M' }] },
    ]);
  });

  it('omits optional fields that were not supplied', () => {
    const input = buildProductCreateInput(validateProductCreate(minimal));
    assert.ok(!('vendor' in input));
    assert.ok(!('productOptions' in input));
  });
});

describe('buildVariantsCreateInput', () => {
  it('maps price, compareAtPrice, sku (as inventoryItem) and optionValues', () => {
    const req = validateProductCreate({
      title: 'Tee',
      options: [{ name: 'Size', values: ['S'] }],
      variants: [
        {
          price: '10',
          compareAtPrice: '15',
          sku: 'TEE-S',
          optionValues: [{ optionName: 'Size', name: 'S' }],
        },
      ],
    });
    const input = buildVariantsCreateInput(req);
    assert.equal(input[0]?.['price'], '10.00');
    assert.equal(input[0]?.['compareAtPrice'], '15.00');
    assert.deepEqual(input[0]?.['inventoryItem'], { sku: 'TEE-S' });
    assert.deepEqual(input[0]?.['optionValues'], [{ optionName: 'Size', name: 'S' }]);
  });
});

describe('buildMediaInput', () => {
  it('maps each URL to an IMAGE media input', () => {
    const req = validateProductCreate({ ...minimal, mediaUrls: ['https://cdn.example/x.jpg'] });
    assert.deepEqual(buildMediaInput(req), [
      { originalSource: 'https://cdn.example/x.jpg', mediaContentType: 'IMAGE' },
    ]);
  });

  it('is empty when no media', () => {
    assert.deepEqual(buildMediaInput(validateProductCreate(minimal)), []);
  });
});
