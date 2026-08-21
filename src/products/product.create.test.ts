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
  it('defaults status to DRAFT - never auto-visible', () => {
    // The central safety rule for new products.
    assert.equal(validateProductCreate(minimal).status, 'DRAFT');
  });

  it('never creates ACTIVE directly; status:ACTIVE requests publish instead', () => {
    // A product is always CREATED as DRAFT. Legacy status:'active' is mapped to
    // publish:true, so the service publishes + verifies before activating.
    const req = validateProductCreate({ ...minimal, status: 'active' });
    assert.equal(req.status, 'DRAFT');
    assert.equal(req.publish, true);
  });

  it('defaults publish to false and honours an explicit publish flag', () => {
    assert.equal(validateProductCreate(minimal).publish, false);
    assert.equal(validateProductCreate({ ...minimal, publish: true }).publish, true);
    assert.equal(validateProductCreate({ ...minimal, publish: true }).status, 'DRAFT');
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

  it('drops tags containing commas', () => {
    const req = validateProductCreate({ ...minimal, tags: ['good', 'a,b'] });
    assert.deepEqual(req.tags, ['good']);
  });
});

describe('buildProductCreateInput', () => {
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


/**
 * Pre-flight uniqueness and limit checks.
 *
 * WHY THESE ARE WORTH TESTING RATHER THAN LEAVING TO SHOPIFY
 * --------------------------------------------------------
 * Shopify rejects duplicate SKUs, duplicate option combinations and over-limit
 * variant counts itself - but only at the VARIANT step, which runs AFTER the product
 * has been created. A rejection there leaves an orphaned DRAFT product behind and
 * returns a partial success, so a fixable request error becomes cleanup work plus a
 * confusing response.
 *
 * Every check that runs before the first write cannot produce that outcome. These
 * tests are what stop one being quietly removed later.
 */
describe('pre-flight checks run BEFORE the product is created', () => {
  const twoOptions = [
    { name: 'Size', values: ['S', 'M'] },
    { name: 'Colour', values: ['Red', 'Blue'] },
  ];

  function variantFor(size: string, colour: string, extra: Record<string, unknown> = {}) {
    return {
      price: '9.99',
      optionValues: [
        { optionName: 'Size', name: size },
        { optionName: 'Colour', name: colour },
      ],
      ...extra,
    };
  }

  it('rejects two variants sharing a SKU', () => {
    assert.throws(
      () =>
        validateProductCreate({
          title: 'T',
          options: twoOptions,
          variants: [
            variantFor('S', 'Red', { sku: 'DUP-1' }),
            variantFor('M', 'Blue', { sku: 'DUP-1' }),
          ],
        }),
      (error: unknown) =>
        error instanceof AppError && /share the SKU "DUP-1"/.test(error.message),
    );
  });

  it('catches a SKU collision that differs only by case', () => {
    // The frontend maps created variants back to submitted ones by SKU, so a
    // case-only difference makes that mapping ambiguous.
    assert.throws(
      () =>
        validateProductCreate({
          title: 'T',
          options: twoOptions,
          variants: [
            variantFor('S', 'Red', { sku: 'abc-1' }),
            variantFor('M', 'Blue', { sku: 'ABC-1' }),
          ],
        }),
      AppError,
    );
  });

  it('names BOTH offending variant positions, so the caller can fix it', () => {
    try {
      validateProductCreate({
        title: 'T',
        options: twoOptions,
        variants: [
          variantFor('S', 'Red', { sku: 'A' }),
          variantFor('M', 'Blue', { sku: 'B' }),
          variantFor('S', 'Blue', { sku: 'A' }),
        ],
      });
      assert.fail('expected a duplicate-SKU rejection');
    } catch (caught) {
      const error = caught instanceof AppError ? caught : null;
      // "Variants 1 and 3", not just "duplicate SKU".
      assert.match(error?.message ?? '', /Variants 1 and 3/);
    }
  });

  it('allows distinct SKUs', () => {
    const request = validateProductCreate({
      title: 'T',
      options: twoOptions,
      variants: [
        variantFor('S', 'Red', { sku: 'A-1' }),
        variantFor('M', 'Blue', { sku: 'A-2' }),
      ],
    });
    assert.equal(request.variants.length, 2);
  });

  it('rejects two variants sharing a barcode', () => {
    // A barcode identifies a physical item; two variants cannot have the same one.
    assert.throws(
      () =>
        validateProductCreate({
          title: 'T',
          options: twoOptions,
          variants: [
            variantFor('S', 'Red', { barcode: '5012345678900' }),
            variantFor('M', 'Blue', { barcode: '5012345678900' }),
          ],
        }),
      (error: unknown) => error instanceof AppError && /share the barcode/.test(error.message),
    );
  });

  it('rejects two variants with the same option combination', () => {
    assert.throws(
      () =>
        validateProductCreate({
          title: 'T',
          options: twoOptions,
          variants: [variantFor('S', 'Red'), variantFor('S', 'Red')],
        }),
      (error: unknown) =>
        error instanceof AppError && /same option combination/.test(error.message),
    );
  });

  it('detects a duplicate combination even when the values are listed in a different order', () => {
    // The key is sorted by option name, so Size/Colour and Colour/Size are the same
    // point in the grid - which is what Shopify cares about.
    assert.throws(
      () =>
        validateProductCreate({
          title: 'T',
          options: twoOptions,
          variants: [
            variantFor('S', 'Red'),
            {
              price: '9.99',
              optionValues: [
                { optionName: 'Colour', name: 'Red' },
                { optionName: 'Size', name: 'S' },
              ],
            },
          ],
        }),
      AppError,
    );
  });

  it('allows every distinct point in the option grid', () => {
    const request = validateProductCreate({
      title: 'T',
      options: twoOptions,
      variants: [
        variantFor('S', 'Red'),
        variantFor('S', 'Blue'),
        variantFor('M', 'Red'),
        variantFor('M', 'Blue'),
      ],
    });
    assert.equal(request.variants.length, 4);
  });

  it('rejects more variants than Shopify allows, before writing anything', () => {
    const variants = Array.from({ length: 101 }, (_, index) => ({
      price: '1.00',
      sku: `SKU-${index}`,
    }));
    assert.throws(
      () => validateProductCreate({ title: 'T', variants }),
      (error: unknown) => error instanceof AppError && /at most 100 variants/.test(error.message),
    );
  });

  it('rejects declared options with no variants, which would silently ignore them', () => {
    assert.throws(
      () => validateProductCreate({ title: 'T', options: twoOptions, variants: [] }),
      (error: unknown) => error instanceof AppError && /would be ignored/.test(error.message),
    );
  });
});

describe('media URL validation', () => {
  it('rejects a URL with no host, which the regex alone let through', () => {
    // "https://" matches /^https:\/\/.+/ only with something after it, but
    // "https://?x" has an empty hostname and would fail asynchronously in Shopify's
    // EPS fetch - AFTER the product exists, producing an image-less product with no
    // obvious cause.
    assert.throws(
      () => validateProductCreate({ ...minimal, mediaUrls: ['https://?x'] }),
      AppError,
    );
  });

  it('rejects localhost, which Shopify cannot reach', () => {
    assert.throws(
      () => validateProductCreate({ ...minimal, mediaUrls: ['https://localhost/a.jpg'] }),
      (error: unknown) => error instanceof AppError && /cannot reach/.test(error.message),
    );
  });

  it('rejects http', () => {
    assert.throws(
      () => validateProductCreate({ ...minimal, mediaUrls: ['http://example.com/a.jpg'] }),
      AppError,
    );
  });

  it('rejects the same URL twice, which would upload the image twice', () => {
    assert.throws(
      () =>
        validateProductCreate({
          ...minimal,
          mediaUrls: ['https://example.com/a.jpg', 'https://example.com/a.jpg'],
        }),
      (error: unknown) => error instanceof AppError && /the same/.test(error.message),
    );
  });

  it('accepts distinct public https URLs', () => {
    const request = validateProductCreate({
      ...minimal,
      mediaUrls: ['https://example.com/a.jpg', 'https://cdn.example.com/b.png'],
    });
    assert.equal(request.mediaUrls.length, 2);
  });
});
