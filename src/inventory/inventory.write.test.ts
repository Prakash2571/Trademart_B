/**
 * Unit tests for inventory-quantity write validation and input building.
 *
 * Key property: a negative quantity is refused (never coerced to 0), ids must be
 * the right GID type, and the built input targets exactly one item at one
 * location with the operator-set absolute value.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AppError } from '../common/errors';
import { buildInventorySetInput, validateInventorySet } from './inventory.write';

const base = {
  inventoryItemId: 'gid://shopify/InventoryItem/1',
  locationId: 'gid://shopify/Location/2',
  quantity: 10,
};

describe('validateInventorySet', () => {
  it('accepts a valid request and defaults name to available', () => {
    const req = validateInventorySet({ ...base });
    assert.equal(req.name, 'available');
    assert.equal(req.quantity, 10);
  });

  it('accepts on_hand', () => {
    assert.equal(validateInventorySet({ ...base, name: 'on_hand' }).name, 'on_hand');
  });

  it('rejects an unknown state', () => {
    assert.throws(
      () => validateInventorySet({ ...base, name: 'committed' }),
      (e: unknown) => e instanceof AppError && e.code === 'VALIDATION_ERROR',
    );
  });

  it('normalises numeric ids to GIDs', () => {
    const req = validateInventorySet({ inventoryItemId: '1', locationId: '2', quantity: 0 });
    assert.equal(req.inventoryItemId, 'gid://shopify/InventoryItem/1');
    assert.equal(req.locationId, 'gid://shopify/Location/2');
  });

  it('allows zero', () => {
    assert.equal(validateInventorySet({ ...base, quantity: 0 }).quantity, 0);
  });

  it('refuses a negative quantity - never coerces to 0', () => {
    assert.throws(() => validateInventorySet({ ...base, quantity: -1 }));
  });

  it('refuses a non-integer quantity', () => {
    assert.throws(() => validateInventorySet({ ...base, quantity: 1.5 }));
  });

  it('rejects a wrong GID type for the location', () => {
    assert.throws(() =>
      validateInventorySet({ ...base, locationId: 'gid://shopify/Product/2' }),
    );
  });

  it('requires the ids', () => {
    assert.throws(() => validateInventorySet({ quantity: 1 }));
  });
});

describe('buildInventorySetInput', () => {
  it('builds a single-item absolute set with ignoreCompareQuantity', () => {
    const input = buildInventorySetInput(validateInventorySet({ ...base }));
    assert.equal(input['name'], 'available');
    assert.equal(input['ignoreCompareQuantity'], true);
    assert.deepEqual(input['quantities'], [
      {
        inventoryItemId: 'gid://shopify/InventoryItem/1',
        locationId: 'gid://shopify/Location/2',
        quantity: 10,
      },
    ]);
  });
});
