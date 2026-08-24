/**
 * Validating an operator's supplier verification.
 *
 * The rules that decide what supplier evidence may be stored: an amount never without its
 * currency, a URL that is evidence (never fetched), no duplicate variants, valid dates.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  validateSupplierVerification,
  type SupplierVerificationInput,
} from './supplier.validation';

function input(overrides: Partial<SupplierVerificationInput> = {}): SupplierVerificationInput {
  return {
    provider: 'TRADELLE',
    availability: 'AVAILABLE',
    sourceUrl: 'https://tradelle.example/p/1',
    supplierProductId: 'TRD-1',
    ...overrides,
  };
}

describe('validateSupplierVerification', () => {
  it('accepts a minimal valid verification', () => {
    assert.deepEqual(validateSupplierVerification(input()), []);
  });

  it('rejects an unknown provider or availability', () => {
    assert.ok(
      validateSupplierVerification(input({ provider: 'ALIEXPRESS' as never })).some((p) =>
        p.includes('provider'),
      ),
    );
    assert.ok(
      validateSupplierVerification(input({ availability: 'MAYBE' as never })).some((p) =>
        p.includes('availability'),
      ),
    );
  });

  it('rejects a non-http source URL, and never implies it will be fetched', () => {
    assert.ok(
      validateSupplierVerification(input({ sourceUrl: 'javascript:alert(1)' })).some((p) =>
        p.includes('http'),
      ),
    );
    // A blank URL is fine - it is optional evidence.
    assert.deepEqual(validateSupplierVerification(input({ sourceUrl: '' })), []);
  });

  it('rejects a cost with no currency - an unlabelled amount is a landmine', () => {
    const problems = validateSupplierVerification(
      input({ productCost: 8, productCurrency: null }),
    );
    assert.ok(problems.some((p) => p.includes('productCurrency is required')));
  });

  it('rejects a negative cost', () => {
    assert.ok(
      validateSupplierVerification(input({ productCost: -1, productCurrency: 'USD' })).some((p) =>
        p.includes('at least 0'),
      ),
    );
  });

  it('accepts independent supplier and shipping currencies', () => {
    assert.deepEqual(
      validateSupplierVerification(
        input({
          productCost: 8,
          productCurrency: 'USD',
          shippingCost: 3,
          shippingCurrency: 'EUR',
        }),
      ),
      [],
    );
  });

  it('rejects an invalid observedAt date', () => {
    assert.ok(
      validateSupplierVerification(input({ observedAt: 'not-a-date' })).some((p) =>
        p.includes('observedAt'),
      ),
    );
  });

  it('requires a title on every variant', () => {
    assert.ok(
      validateSupplierVerification(
        input({ variants: [{ title: '', availability: 'AVAILABLE' }] }),
      ).some((p) => p.includes('title is required')),
    );
  });

  it('rejects a variant cost with no currency', () => {
    assert.ok(
      validateSupplierVerification(
        input({ variants: [{ title: 'Black / M', cost: 5, currencyCode: null }] }),
      ).some((p) => p.includes('currencyCode is required')),
    );
  });

  it('rejects duplicate variants', () => {
    const problems = validateSupplierVerification(
      input({
        variants: [
          { title: 'Black / M', supplierVariantId: 'v1' },
          { title: 'Different', supplierVariantId: 'v1' },
        ],
      }),
    );
    assert.ok(problems.some((p) => p.includes('duplicate variant')));
  });

  it('accepts a set of distinct, valid variants', () => {
    assert.deepEqual(
      validateSupplierVerification(
        input({
          variants: [
            { title: 'Black / M', supplierVariantId: 'v1', availability: 'AVAILABLE' },
            { title: 'Black / L', supplierVariantId: 'v2', availability: 'UNAVAILABLE' },
            { title: 'White / M', supplierVariantId: 'v3', availability: 'UNKNOWN' },
          ],
        }),
      ),
      [],
    );
  });
});
