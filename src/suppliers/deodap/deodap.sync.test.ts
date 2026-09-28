/**
 * Matching a newer DeoDap price list to what was imported.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AppError } from '../../common/errors';
import { readCatalog } from './deodap.catalog';
import {
  MAX_SYNC_UPDATES,
  planCostSync,
  validateSyncRequest,
  type LedgerProductRef,
  type StoredCost,
} from './deodap.sync';

const PRICE_LIST = [
  'SKU,Product Name,Dropship Price,Shipping,Stock',
  'DD-100,Mini Fan,110,,5',
  'DD-101,Lamp,80,10,0',
  'DD-999,Something new,50,,',
].join('\n');

function ledgerEntry(ref: string, variantId: string, sku: string | null): LedgerProductRef {
  return {
    supplierRef: ref,
    title: `Imported ${ref}`,
    shopifyProductId: `gid://shopify/Product/${variantId}`,
    variants: [{ shopifyVariantId: `gid://shopify/ProductVariant/${variantId}`, sku, optionValues: [] }],
  };
}

const STORED = new Map<string, StoredCost>([
  ['gid://shopify/ProductVariant/11', { amount: 100, shippingCost: 20, currencyCode: 'INR' }],
  ['gid://shopify/ProductVariant/21', { amount: 80, shippingCost: 10, currencyCode: 'INR' }],
]);

describe('planCostSync', () => {
  const plan = planCostSync(
    readCatalog(PRICE_LIST).products,
    [ledgerEntry('DD-100', '11', 'DD-100'), ledgerEntry('DD-101', '21', 'DD-101'), ledgerEntry('DD-555', '31', 'DD-555')],
    STORED,
    'INR',
  );

  it('reports a changed cost with its percentage, keeping shipping the file does not give', () => {
    const fan = plan.changes.find((change) => change.supplierRef === 'DD-100');
    assert.equal(fan?.kind, 'COST_CHANGED');
    assert.equal(fan?.currentCost, 100);
    assert.equal(fan?.newCost, 110);
    assert.equal(fan?.changePercent, 10);
    assert.equal(fan?.newShipping, 20, 'an empty shipping cell means unknown, not free');
  });

  it('reports an unchanged cost as unchanged, and carries stock through', () => {
    const lamp = plan.changes.find((change) => change.supplierRef === 'DD-101');
    assert.equal(lamp?.kind, 'UNCHANGED');
    assert.equal(lamp?.inStock, false);
    assert.equal(plan.summary.outOfStock, 1);
  });

  it('lists rows that match nothing imported, and imported products the file omits', () => {
    assert.deepEqual(
      plan.unmatched.map((row) => row.ref),
      ['DD-999'],
    );
    assert.deepEqual(
      plan.missing.map((row) => row.supplierRef),
      ['DD-555'],
    );
    assert.equal(plan.summary.changed, 1);
    assert.equal(plan.summary.unchanged, 1);
  });

  it('finds a variant by SKU when its product reference changed', () => {
    const moved = planCostSync(
      readCatalog(PRICE_LIST).products,
      [ledgerEntry('an-old-handle', '11', 'dd-100')],
      STORED,
      'INR',
    );
    assert.equal(moved.changes[0]?.newCost, 110);
    assert.equal(moved.missing.length, 0);
  });

  it('never compares costs across currencies', () => {
    const inUsd = new Map<string, StoredCost>([
      ['gid://shopify/ProductVariant/11', { amount: 110, shippingCost: null, currencyCode: 'USD' }],
    ]);
    const result = planCostSync(readCatalog(PRICE_LIST).products, [ledgerEntry('DD-100', '11', 'DD-100')], inUsd, 'INR');
    assert.equal(result.changes[0]?.kind, 'COST_CHANGED');
    assert.equal(result.changes[0]?.changePercent, null);
  });

  it('reports a row with no readable cost instead of zeroing the cost', () => {
    const result = planCostSync(
      readCatalog('SKU,Dropship Price\nDD-100,n/a').products,
      [ledgerEntry('DD-100', '11', 'DD-100')],
      STORED,
      'INR',
    );
    assert.equal(result.changes[0]?.kind, 'NO_COST_IN_FILE');
    assert.equal(result.changes[0]?.newCost, null);
  });
});

describe('validateSyncRequest', () => {
  function isValidationError(error: unknown): boolean {
    return error instanceof AppError && error.code === 'VALIDATION_ERROR';
  }

  it('accepts updates and normalises ids', () => {
    const request = validateSyncRequest({
      currencyCode: 'inr',
      updates: [{ shopifyVariantId: '11', cost: 110, shippingCost: 0 }],
    });
    assert.deepEqual(request, {
      currencyCode: 'INR',
      updates: [{ shopifyVariantId: 'gid://shopify/ProductVariant/11', cost: 110, shippingCost: null }],
    });
  });

  it('refuses a zero cost, a repeated variant and an oversized batch', () => {
    assert.throws(
      () => validateSyncRequest({ currencyCode: 'INR', updates: [{ shopifyVariantId: '1', cost: 0 }] }),
      isValidationError,
    );
    assert.throws(
      () =>
        validateSyncRequest({
          currencyCode: 'INR',
          updates: [
            { shopifyVariantId: '1', cost: 5 },
            { shopifyVariantId: 'gid://shopify/ProductVariant/1', cost: 6 },
          ],
        }),
      isValidationError,
    );
    assert.throws(
      () =>
        validateSyncRequest({
          currencyCode: 'INR',
          updates: Array.from({ length: MAX_SYNC_UPDATES + 1 }, (_value, index) => ({
            shopifyVariantId: String(index + 1),
            cost: 5,
          })),
        }),
      isValidationError,
    );
  });

  it('refuses an id that is not a variant', () => {
    assert.throws(() =>
      validateSyncRequest({
        currencyCode: 'INR',
        updates: [{ shopifyVariantId: 'gid://shopify/Order/1', cost: 5 }],
      }),
    );
  });
});
