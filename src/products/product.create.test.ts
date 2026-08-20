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
