/**
 * Supplier classification tests.
 *
 * The critical guarantee: a product is never classified as TRADELLE from its
 * title, and Tradelle cost/shipping lookups return null rather than fabricating
 * numbers.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { classifySupplier } from './supplier.registry';
import { tradelleProvider } from './tradelle/tradelle.provider';

describe('classifySupplier', () => {
  it('classifies TRADELLE from the vendor field', () => {
    const result = classifySupplier({ vendor: 'Tradelle' });

    assert.equal(result.supplier, 'TRADELLE');
    assert.ok(result.evidence.some((entry) => entry.includes('vendor')));
  });

  it('classifies TRADELLE from a tag', () => {
    const result = classifySupplier({ vendor: 'Acme', tags: ['imported', 'tradelle'] });

    assert.equal(result.supplier, 'TRADELLE');
    assert.ok(result.evidence.some((entry) => entry.includes('tag')));
  });

  it('classifies TRADELLE from a fulfillment service', () => {
    const result = classifySupplier({ fulfillmentServices: ['tradelle-fulfillment'] });

    assert.equal(result.supplier, 'TRADELLE');
  });

  it('does NOT classify TRADELLE from the product title', () => {
    // Titles are not even part of the signal contract - a product named after
    // Tradelle must still not be attributed to it.
    const result = classifySupplier({ vendor: 'Generic Imports', tags: ['summer'] });

    assert.equal(result.supplier, 'OTHER');
  });

  it('returns OTHER when a non-Tradelle vendor is set', () => {
    const result = classifySupplier({ vendor: 'Acme Supplies' });

    assert.equal(result.supplier, 'OTHER');
    assert.deepEqual(result.evidence, ['vendor="Acme Supplies"']);
  });

  it('returns UNKNOWN when there is nothing to go on', () => {
    assert.equal(classifySupplier({}).supplier, 'UNKNOWN');
    assert.equal(classifySupplier({ vendor: '   ' }).supplier, 'UNKNOWN');
    assert.deepEqual(classifySupplier({}).evidence, []);
  });

  it('is case and whitespace insensitive', () => {
    assert.equal(classifySupplier({ vendor: '  TRADELLE  ' }).supplier, 'TRADELLE');
    assert.equal(classifySupplier({ tags: ['Supplier:Tradelle'] }).supplier, 'TRADELLE');
  });
});

describe('tradelleProvider', () => {
  it('reports a supplier cost of null - no public API is documented', async () => {
    assert.equal(await tradelleProvider.getSupplierCost?.('gid://shopify/Product/1'), null);
  });

  it('reports a shipping cost of null', async () => {
    assert.equal(
      await tradelleProvider.getShippingCost?.('gid://shopify/Product/1', 'GB'),
      null,
    );
  });

  it('identifies products only from reliable signals', () => {
    assert.equal(tradelleProvider.identifyProduct?.({ vendor: 'Tradelle' }), true);
    assert.equal(tradelleProvider.identifyProduct?.({ vendor: 'Acme' }), false);
    assert.equal(tradelleProvider.identifyProduct?.({}), false);
  });
});
