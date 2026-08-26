import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AppError } from '../common/errors';
import type { SupplierVariantAvailability } from './sourceability';
import {
  buildVariantPlanFromSupplierVariants,
  mapCreatedVariants,
} from './variant.mapping';

const NOW = new Date('2026-08-26T12:00:00.000Z');

function variant(
  overrides: Partial<SupplierVariantAvailability> = {},
): SupplierVariantAvailability {
  return {
    supplierVariantId: 'sv-black-m',
    sku: 'KAN-BLK-M',
    title: 'Black / M',
    optionValues: { Color: 'Black', Size: 'M' },
    availability: 'AVAILABLE',
    stockKnown: true,
    cost: 500,
    currencyCode: 'INR',
    checkedAt: NOW.toISOString(),
    ...overrides,
  };
}

describe('truthful supplier variant planning', () => {
  it('creates exactly the available verified combinations and no Cartesian product', () => {
    const plan = buildVariantPlanFromSupplierVariants(
      [
        variant(),
        variant({
          supplierVariantId: 'sv-black-l',
          sku: 'KAN-BLK-L',
          title: 'Black / L',
          optionValues: { Color: 'Black', Size: 'L' },
        }),
        variant({
          supplierVariantId: 'sv-white-m',
          sku: 'KAN-WHT-M',
          title: 'White / M',
          optionValues: { Color: 'White', Size: 'M' },
          availability: 'UNAVAILABLE',
        }),
      ],
      1499,
    );

    assert.deepEqual(plan.options, [
      { name: 'Color', values: ['Black'] },
      { name: 'Size', values: ['M', 'L'] },
    ]);
    assert.equal(plan.variants.length, 2);
    assert.deepEqual(
      plan.variants.map((entry) => entry.optionValues),
      [
        [
          { optionName: 'Color', name: 'Black' },
          { optionName: 'Size', name: 'M' },
        ],
        [
          { optionName: 'Color', name: 'Black' },
          { optionName: 'Size', name: 'L' },
        ],
      ],
    );
  });

  it('allows one default Shopify variant only when no supplier variant structure exists', () => {
    const plan = buildVariantPlanFromSupplierVariants([], 1499);
    assert.deepEqual(plan.options, []);
    assert.deepEqual(plan.variants, [{ price: '1499.00', optionValues: [] }]);
    assert.equal(plan.sources.length, 1);
  });

  it('refuses multiple supplier variants with no truthful option identity', () => {
    assert.throws(
      () =>
        buildVariantPlanFromSupplierVariants(
          [
            variant({ optionValues: {} }),
            variant({
              supplierVariantId: 'sv-2',
              sku: 'KAN-2',
              title: 'Second',
              optionValues: {},
            }),
          ],
          1499,
        ),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'VALIDATION_ERROR' &&
        error.message.includes('cannot be collapsed'),
    );
  });

  it('refuses inconsistent option maps instead of filling missing values', () => {
    assert.throws(
      () =>
        buildVariantPlanFromSupplierVariants(
          [
            variant(),
            variant({
              supplierVariantId: 'sv-2',
              sku: 'KAN-2',
              title: 'Black',
              optionValues: { Color: 'Black' },
            }),
          ],
          1499,
        ),
      AppError,
    );
  });
});

describe('durable Shopify variant mapping', () => {
  it('matches by exact SKU/options even when Shopify returns the reverse order', () => {
    const plan = buildVariantPlanFromSupplierVariants(
      [
        variant(),
        variant({
          supplierVariantId: 'sv-black-l',
          sku: null,
          title: 'Black / L',
          optionValues: { Color: 'Black', Size: 'L' },
        }),
      ],
      1499,
    );
    const mapped = mapCreatedVariants(
      'cand-1',
      plan.sources,
      [
        {
          shopifyVariantId: 'gid://shopify/ProductVariant/L',
          sku: null,
          optionValues: [
            { name: 'Size', value: 'L' },
            { name: 'Color', value: 'Black' },
          ],
        },
        {
          shopifyVariantId: 'gid://shopify/ProductVariant/M',
          sku: 'KAN-BLK-M',
          optionValues: [
            { name: 'Color', value: 'Black' },
            { name: 'Size', value: 'M' },
          ],
        },
      ],
      NOW,
    );

    assert.equal(mapped.complete, true);
    assert.deepEqual(
      mapped.mappings.map((entry) => [entry.supplierVariantId, entry.shopifyVariantId]),
      [
        ['sv-black-m', 'gid://shopify/ProductVariant/M'],
        ['sv-black-l', 'gid://shopify/ProductVariant/L'],
      ],
    );
    assert.ok(mapped.mappings.every((entry) => entry.publicVariantId.startsWith('kv_')));
    assert.ok(mapped.mappings.every((entry) => !entry.publicVariantId.includes('sv-')));
  });

  it('fails an unmatched row closed rather than assigning by array position', () => {
    const plan = buildVariantPlanFromSupplierVariants([variant()], 1499);
    const mapped = mapCreatedVariants(
      'cand-1',
      plan.sources,
      [{ shopifyVariantId: 'gid://shopify/ProductVariant/other', sku: 'OTHER' }],
      NOW,
    );
    assert.equal(mapped.complete, false);
    assert.deepEqual(mapped.mappings, []);
    assert.ok(mapped.warnings.some((warning) => warning.includes('not exposed for sale')));
  });

  it('generates the same public id during crash recovery', () => {
    const plan = buildVariantPlanFromSupplierVariants([variant()], 1499);
    const created = [
      { shopifyVariantId: 'gid://shopify/ProductVariant/M', sku: 'KAN-BLK-M' },
    ];
    const first = mapCreatedVariants('cand-1', plan.sources, created, NOW);
    const recovered = mapCreatedVariants(
      'cand-1',
      plan.sources,
      created,
      new Date('2026-08-27T12:00:00.000Z'),
    );
    assert.equal(first.mappings[0]?.publicVariantId, recovered.mappings[0]?.publicVariantId);
  });
});
