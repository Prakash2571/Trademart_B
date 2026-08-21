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
import {
  assessInventoryChange,
  buildInventorySetInput,
  validateInventorySet,
} from './inventory.write';

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

describe('validateInventorySet - stale-write and large-change fields', () => {
  it('defaults confirmLargeChange to false', () => {
    // The guardrail must be opt-OUT, not opt-in.
    assert.equal(validateInventorySet({ ...base }).confirmLargeChange, false);
  });

  it('accepts expectedQuantity for stale-write detection', () => {
    assert.equal(validateInventorySet({ ...base, expectedQuantity: 7 }).expectedQuantity, 7);
  });

  it('rejects a non-integer or negative expectedQuantity', () => {
    assert.throws(
      () => validateInventorySet({ ...base, expectedQuantity: 1.5 }),
      (e: unknown) => e instanceof AppError && e.code === 'VALIDATION_ERROR',
    );
    assert.throws(() => validateInventorySet({ ...base, expectedQuantity: -1 }));
  });

  it('rejects a non-boolean confirmLargeChange rather than treating it as truthy', () => {
    // 'yes' being read as true would silently disable the cap.
    assert.throws(
      () => validateInventorySet({ ...base, confirmLargeChange: 'yes' }),
      (e: unknown) => e instanceof AppError && e.code === 'VALIDATION_ERROR',
    );
  });
});

describe('assessInventoryChange', () => {
  const request = (overrides: Record<string, unknown> = {}) =>
    validateInventorySet({ ...base, ...overrides });

  it('allows a change within the limit', () => {
    const result = assessInventoryChange(100, request({ quantity: 150 }), 500);
    assert.equal(result.delta, 50);
    assert.equal(result.requiresConfirmation, false);
    assert.equal(result.allowed, true);
  });

  it('measures the delta absolutely, so a big DECREASE is caught too', () => {
    // Writing stock down to zero is at least as consequential as writing it up.
    const result = assessInventoryChange(900, request({ quantity: 0 }), 500);
    assert.equal(result.delta, 900);
    assert.equal(result.allowed, false);
  });

  it('refuses an oversized change without confirmation', () => {
    const result = assessInventoryChange(0, request({ quantity: 5000 }), 500);
    assert.equal(result.allowed, false);
    assert.match(result.reason ?? '', /exceeds the 500-unit limit/);
  });

  it('allows an oversized change once explicitly confirmed', () => {
    const result = assessInventoryChange(
      0,
      request({ quantity: 5000, confirmLargeChange: true }),
      500,
    );
    assert.equal(result.requiresConfirmation, true);
    assert.equal(result.allowed, true);
    assert.equal(result.reason, null);
  });

  it('requires confirmation when the current quantity is unknown', () => {
    // An unknown starting point means the delta cannot be computed, so the cap
    // cannot be enforced. Conservative is the only safe default.
    const unknown = assessInventoryChange(null, request({ quantity: 10 }), 500);
    assert.equal(unknown.delta, null);
    assert.equal(unknown.allowed, false);

    const confirmed = assessInventoryChange(
      null,
      request({ quantity: 10, confirmLargeChange: true }),
      500,
    );
    assert.equal(confirmed.allowed, true);
  });

  it('honours a lowered limit', () => {
    assert.equal(assessInventoryChange(0, request({ quantity: 11 }), 10).allowed, false);
    assert.equal(assessInventoryChange(0, request({ quantity: 10 }), 10).allowed, true);
  });
});
