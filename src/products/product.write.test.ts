/**
 * Unit tests for product-edit validation and input building.
 *
 * The security-relevant property: only allow-listed fields survive, an empty
 * edit is rejected (never a silent no-op write), prices must be positive, and a
 * compare-at price below the price is refused.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AppError } from '../common/errors';
import {
  buildProductUpdateInput,
  buildVariantBulkInput,
  validateProductEdit,
} from './product.write';

const PRODUCT = 'gid://shopify/Product/1';
const VARIANT = 'gid://shopify/ProductVariant/9';

describe('validateProductEdit', () => {
  it('accepts scalar fields', () => {
    const req = validateProductEdit({
      title: 'New title',
      descriptionHtml: '<p>desc</p>',
      vendor: 'Acme',
      productType: 'Widget',
      status: 'draft',
    });
    assert.equal(req.fields.title, 'New title');
    assert.equal(req.fields.status, 'DRAFT'); // upper-cased
    assert.equal(req.fields.vendor, 'Acme');
  });

  it('rejects an unknown status', () => {
    assert.throws(
      () => validateProductEdit({ status: 'hidden' }),
      (e: unknown) => e instanceof AppError && e.code === 'VALIDATION_ERROR',
    );
  });

  it('rejects an empty edit rather than doing a no-op write', () => {
    assert.throws(() => validateProductEdit({}));
    assert.throws(() => validateProductEdit({ addTags: [], removeTags: [] }));
  });

  it('rejects a blank title', () => {
    assert.throws(() => validateProductEdit({ title: '   ' }));
  });

  it('ignores unknown fields entirely', () => {
    // A stray/malicious key must not reach Shopify.
    const req = validateProductEdit({ title: 'ok', handle: 'x', published: true, id: 'evil' });
    assert.deepEqual(Object.keys(req.fields), ['title']);
  });

  it('normalises and de-duplicates tags case-insensitively', () => {
    const req = validateProductEdit({ addTags: ['Sale', 'sale', ' new '] });
    assert.deepEqual(req.addTags, ['Sale', 'new']);
  });

  it('rejects a tag containing a comma', () => {
    assert.throws(() => validateProductEdit({ addTags: ['a,b'] }));
  });

  it('accepts a variant price and normalises to 2dp', () => {
    const req = validateProductEdit({ variants: [{ id: VARIANT, price: 24.9 }] });
    assert.equal(req.variants[0]?.price, '24.90');
  });

  it('rejects a non-positive price', () => {
    assert.throws(() => validateProductEdit({ variants: [{ id: VARIANT, price: 0 }] }));
    assert.throws(() => validateProductEdit({ variants: [{ id: VARIANT, price: -1 }] }));
  });

  it('rejects a price with too many decimals', () => {
    assert.throws(() => validateProductEdit({ variants: [{ id: VARIANT, price: '9.999' }] }));
  });

  it('allows clearing compareAtPrice with null', () => {
    const req = validateProductEdit({
      variants: [{ id: VARIANT, price: '10.00', compareAtPrice: null }],
    });
    assert.equal(req.variants[0]?.compareAtPrice, null);
  });

  it('rejects compareAtPrice below price', () => {
    assert.throws(() =>
      validateProductEdit({ variants: [{ id: VARIANT, price: '20', compareAtPrice: '15' }] }),
    );
  });

  it('rejects a variant with no id', () => {
    assert.throws(() => validateProductEdit({ variants: [{ price: '10' }] }));
  });

  it('rejects a variant id that is not a variant GID', () => {
    assert.throws(() =>
      validateProductEdit({ variants: [{ id: 'gid://shopify/Product/1', price: '10' }] }),
    );
  });

  it('rejects a variant that changes nothing', () => {
    assert.throws(() => validateProductEdit({ variants: [{ id: VARIANT }] }));
  });
});

describe('buildProductUpdateInput', () => {
  it('includes the id and only the supplied fields', () => {
    const input = buildProductUpdateInput(PRODUCT, { title: 'T', status: 'ACTIVE' });
    assert.deepEqual(input, { id: PRODUCT, title: 'T', status: 'ACTIVE' });
  });

  it('returns null when there are no scalar fields (tags/variants handled elsewhere)', () => {
    assert.equal(buildProductUpdateInput(PRODUCT, {}), null);
  });
});

describe('buildVariantBulkInput', () => {
  it('maps price and forwards a null compareAtPrice to clear it', () => {
    const input = buildVariantBulkInput([
      { id: VARIANT, price: '10.00', compareAtPrice: null },
    ]);
    assert.deepEqual(input[0], { id: VARIANT, price: '10.00', compareAtPrice: null });
  });

  it('omits compareAtPrice when undefined', () => {
    const input = buildVariantBulkInput([{ id: VARIANT, price: '10.00' }]);
    assert.deepEqual(input[0], { id: VARIANT, price: '10.00' });
    assert.ok(!('compareAtPrice' in (input[0] as object)));
  });
});
