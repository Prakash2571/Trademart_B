/**
 * Import pricing: markup, MRP, rounding, and never below cost.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AppError } from '../../common/errors';
import { priceVariant, pricingRuleFromSettings, resolvePricingRule, type PricingRule } from './deodap.pricing';
import { defaultDeodapSettings } from './deodap.settings';

const MARKUP_50: PricingRule = {
  mode: 'MARKUP',
  markupPercent: 50,
  rounding: 'none',
  includeShipping: true,
  compareAtFromRetail: true,
};

describe('priceVariant', () => {
  it('adds the markup to cost plus shipping', () => {
    const result = priceVariant({ cost: 100, shippingCost: 20, retailPrice: null }, MARKUP_50);
    assert.equal(result.landedCost, 120);
    assert.equal(result.price, 180);
    assert.equal(result.marginPercent, 33.3);
    assert.deepEqual(result.issues, []);
  });

  it('leaves shipping out when told to', () => {
    const result = priceVariant(
      { cost: 100, shippingCost: 20, retailPrice: null },
      { ...MARKUP_50, includeShipping: false },
    );
    assert.equal(result.price, 150);
  });

  it('rounds to whole units, or to .99 without dropping under cost', () => {
    assert.equal(
      priceVariant({ cost: 99.4, shippingCost: null, retailPrice: null }, { ...MARKUP_50, rounding: 'integer' }).price,
      149,
    );
    // 0% markup with .99 rounding would round 100.00 DOWN to 99.99 - under cost.
    const charm = priceVariant(
      { cost: 100, shippingCost: null, retailPrice: null },
      { ...MARKUP_50, markupPercent: 0, rounding: 'charm99' },
    );
    assert.ok((charm.price ?? 0) >= 100, `got ${charm.price}`);
  });

  it('uses the MRP as the compare-at price only when it is higher', () => {
    assert.equal(priceVariant({ cost: 100, shippingCost: null, retailPrice: 250 }, MARKUP_50).compareAtPrice, 250);
    assert.equal(priceVariant({ cost: 100, shippingCost: null, retailPrice: 120 }, MARKUP_50).compareAtPrice, null);
  });

  it('prices from the MRP in RETAIL mode, falling back to the markup with a warning', () => {
    const retail: PricingRule = { ...MARKUP_50, mode: 'RETAIL' };
    const fromMrp = priceVariant({ cost: 100, shippingCost: null, retailPrice: 199 }, retail);
    assert.equal(fromMrp.price, 199);
    assert.equal(fromMrp.compareAtPrice, null);

    const fallback = priceVariant({ cost: 100, shippingCost: null, retailPrice: null }, retail);
    assert.equal(fallback.price, 150);
    assert.ok(fallback.warnings.length > 0);
  });

  it('refuses a selling price below the DeoDap cost', () => {
    const result = priceVariant(
      { cost: 100, shippingCost: null, retailPrice: 80 },
      { ...MARKUP_50, mode: 'RETAIL' },
    );
    assert.equal(result.issues.length, 1);
  });

  it('prices nothing without a cost', () => {
    const result = priceVariant({ cost: null, shippingCost: null, retailPrice: 500 }, MARKUP_50);
    assert.equal(result.price, null);
    assert.equal(result.issues.length, 1);
  });
});

describe('resolvePricingRule', () => {
  const defaults = pricingRuleFromSettings(defaultDeodapSettings());

  it('defaults to the settings', () => {
    assert.deepEqual(resolvePricingRule(undefined, defaults), defaults);
    assert.equal(defaults.markupPercent, 50);
    assert.equal(defaults.rounding, 'integer');
  });

  it('applies overrides and validates them', () => {
    assert.equal(resolvePricingRule({ markupPercent: 80 }, defaults).markupPercent, 80);
    assert.equal(resolvePricingRule({ mode: 'retail' }, defaults).mode, 'RETAIL');
    for (const bad of [{ markupPercent: -1 }, { markupPercent: 5000 }, { rounding: 'up' }, { includeShipping: 'yes' }]) {
      assert.throws(
        () => resolvePricingRule(bad, defaults),
        (error: unknown) => error instanceof AppError && error.code === 'VALIDATION_ERROR',
      );
    }
  });
});
