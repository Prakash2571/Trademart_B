/**
 * Pricing engine tests.
 * Uses node:test (built into Node) so no test framework install is required.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AppError } from '../common/errors';
import {
  calculatePricing,
  calculateSuggestedPrice,
  pricingGuardBreaches,
  round2,
} from './pricing.service';

describe('calculatePricing', () => {
  it('reproduces the worked example from the brief', () => {
    // Selling 2999, supplier 1000, shipping 300, payment fee 90, ads 500
    // => cost 1890, profit 1109
    const result = calculatePricing({
      sellingPrice: 2999,
      supplierProductCost: 1000,
      supplierShippingCost: 300,
      paymentFee: 90,
      advertisingCost: 500,
    });

    assert.equal(result.totalCost, 1890);
    assert.equal(result.grossProfit, 1109);
    assert.equal(result.profitMarginPercentage, round2((1109 / 2999) * 100));
  });

  it('flags results as estimates and lists the missing inputs', () => {
    const result = calculatePricing({ sellingPrice: 100, supplierProductCost: 40 });

    assert.equal(result.isEstimate, true);
    assert.ok(result.missingInputs.includes('supplierShippingCost'));
    assert.ok(result.missingInputs.includes('advertisingCost'));
    assert.ok(result.notes.some((note) => note.includes('estimate')));
  });

  it('is not an estimate when every cost is supplied', () => {
    const result = calculatePricing({
      sellingPrice: 100,
      supplierProductCost: 10,
      supplierShippingCost: 5,
      paymentFee: 2,
      shopifyFee: 1,
      advertisingCost: 20,
      taxes: 3,
      otherCosts: 4,
    });

    assert.equal(result.isEstimate, false);
    assert.deepEqual(result.missingInputs, []);
    assert.equal(result.totalCost, 45);
    assert.equal(result.grossProfit, 55);
    assert.equal(result.profitMarginPercentage, 55);
  });

  it('reports negative profit rather than clamping to zero', () => {
    const result = calculatePricing({ sellingPrice: 50, supplierProductCost: 80 });

    assert.equal(result.grossProfit, -30);
    assert.equal(result.profitMarginPercentage, -60);
    assert.ok(result.notes.some((note) => note.includes('loses money')));
  });

  it('returns null margin for a zero selling price instead of dividing by zero', () => {
    const result = calculatePricing({ sellingPrice: 0 });

    assert.equal(result.profitMarginPercentage, null);
    assert.equal(result.returnOnCostPercentage, null);
  });

  it('rejects negative and non-finite inputs', () => {
    assert.throws(
      () => calculatePricing({ sellingPrice: -1 }),
      (error: unknown) =>
        error instanceof AppError && error.code === 'VALIDATION_ERROR',
    );
    assert.throws(
      () => calculatePricing({ sellingPrice: 100, supplierProductCost: -5 }),
      (error: unknown) =>
        error instanceof AppError && error.code === 'VALIDATION_ERROR',
    );
    assert.throws(
      () => calculatePricing({ sellingPrice: Number.NaN }),
      (error: unknown) =>
        error instanceof AppError && error.code === 'VALIDATION_ERROR',
    );
  });

  it('avoids floating point drift', () => {
    const result = calculatePricing({
      sellingPrice: 0.3,
      supplierProductCost: 0.1,
      supplierShippingCost: 0.2,
    });

    assert.equal(result.totalCost, 0.3);
    assert.equal(result.grossProfit, 0);
  });
});

describe('calculateSuggestedPrice', () => {
  it('solves for a price that achieves the desired margin', () => {
    const result = calculateSuggestedPrice({
      desiredMarginPercentage: 30,
      supplierProductCost: 700,
    });

    // 700 / (1 - 0.30) = 1000
    assert.equal(result.suggestedPrice, 1000);
    assert.equal(result.projection.profitMarginPercentage, 30);
  });

  it('accounts for percentage fees when solving', () => {
    const result = calculateSuggestedPrice({
      desiredMarginPercentage: 20,
      supplierProductCost: 600,
      paymentFeePercentage: 3,
      shopifyFeePercentage: 2,
    });

    // 600 / (1 - (5 + 20)/100) = 800
    assert.equal(result.suggestedPrice, 800);
    // Fees are 5% of 800 = 40, so profit = 800 - 600 - 40 = 160 = 20%.
    assert.equal(result.projection.profitMarginPercentage, 20);
  });

  it('always marks the suggestion as an estimate', () => {
    const result = calculateSuggestedPrice({
      desiredMarginPercentage: 25,
      supplierProductCost: 100,
    });

    assert.equal(result.isEstimate, true);
    assert.ok(result.notes.some((note) => note.includes('estimate')));
  });

  it('refuses impossible margin/fee combinations', () => {
    assert.throws(
      () =>
        calculateSuggestedPrice({
          desiredMarginPercentage: 90,
          supplierProductCost: 100,
          paymentFeePercentage: 15,
        }),
      (error: unknown) =>
        error instanceof AppError && error.code === 'VALIDATION_ERROR',
    );
    assert.throws(
      () => calculateSuggestedPrice({ desiredMarginPercentage: 100 }),
      (error: unknown) =>
        error instanceof AppError && error.code === 'VALIDATION_ERROR',
    );
  });

  it('refuses to suggest a price with no absolute costs', () => {
    assert.throws(
      () => calculateSuggestedPrice({ desiredMarginPercentage: 30 }),
      (error: unknown) =>
        error instanceof AppError && error.code === 'VALIDATION_ERROR',
    );
  });
});


describe('calculateSuggestedPrice with a percentage advertising allowance', () => {
  it('solves for the allowance alongside the margin rather than applying it after', () => {
    const result = calculateSuggestedPrice({
      desiredMarginPercentage: 45,
      supplierProductCost: 10,
      supplierShippingCost: 2,
      otherCosts: 0,
      paymentFeePercentage: 2.9,
      advertisingPercentage: 15,
    });

    // 12 / (1 - (2.9 + 15 + 45)/100) = 12 / 0.371 = 32.35
    assert.equal(result.suggestedPrice, 32.35);
    assert.equal(result.percentageCosts, 17.9);
    // The projection must actually achieve the margin that was asked for, which is
    // the whole point of solving rather than post-applying.
    assert.ok((result.projection.profitMarginPercentage as number) >= 44.9);
  });

  it('folds the allowance into the projected advertising cost', () => {
    const result = calculateSuggestedPrice({
      desiredMarginPercentage: 40,
      supplierProductCost: 10,
      advertisingPercentage: 20,
    });
    const advertising = result.projection.breakdown.find(
      (entry) => entry.key === 'advertisingCost',
    );
    // 20% of the suggested price, reported as PROVIDED - it is a configured cost, not
    // a missing input.
    assert.equal(advertising?.provided, true);
    assert.equal(advertising?.amount, round2(result.suggestedPrice * 0.2));
  });

  it('leaves an omitted advertising cost reported as missing when no allowance is set', () => {
    const result = calculateSuggestedPrice({
      desiredMarginPercentage: 40,
      supplierProductCost: 10,
    });
    // Without this, adding the percentage feature would have turned every absent
    // advertising cost into a silent zero.
    assert.ok(result.missingInputs.includes('advertisingCost'));
  });

  it('rejects a negative allowance', () => {
    assert.throws(
      () =>
        calculateSuggestedPrice({
          desiredMarginPercentage: 40,
          supplierProductCost: 10,
          advertisingPercentage: -5,
        }),
      (error: unknown) => error instanceof AppError && error.code === 'VALIDATION_ERROR',
    );
  });
});

describe('pricingGuardBreaches', () => {
  /** A priced result at `sellingPrice` with a single supplier cost. */
  function at(sellingPrice: number, cost: number) {
    return calculatePricing({
      sellingPrice,
      supplierProductCost: cost,
      supplierShippingCost: 0,
      paymentFee: 0,
      shopifyFee: 0,
      advertisingCost: 0,
      taxes: 0,
      otherCosts: 0,
    });
  }

  it('returns nothing when both floors are cleared', () => {
    assert.deepEqual(pricingGuardBreaches(at(100, 50), 15, 5), []);
  });

  it('reports a margin below the percentage floor', () => {
    const breaches = pricingGuardBreaches(at(100, 90), 15, 0);
    assert.equal(breaches.length, 1);
    assert.ok(breaches[0]?.includes('10.00% margin'));
    assert.ok(breaches[0]?.includes('below the 15% floor'));
  });

  it('reports a thin absolute contribution the percentage floor would miss', () => {
    // 3.00 item at 20% margin: clears a 15% floor, yields 60p.
    const breaches = pricingGuardBreaches(at(3, 2.4), 15, 1);
    assert.equal(breaches.length, 1);
    assert.ok(breaches[0]?.includes('0.60 contribution per unit'));
  });

  it('reports both breaches together when both bind', () => {
    assert.equal(pricingGuardBreaches(at(100, 95), 15, 10).length, 2);
  });

  it('ignores the absolute floor when it is set to zero', () => {
    // Every price clears a floor of 0, so checking it would only add noise.
    assert.deepEqual(pricingGuardBreaches(at(100, 50), 15, 0), []);
  });

  it('treats an incomputable margin as clearing, not as a loss', () => {
    // A zero selling price gives a null margin. Refusing on it would block pricing
    // for a reason nobody could act on.
    const result = at(0, 0);
    assert.equal(result.profitMarginPercentage, null);
    assert.deepEqual(pricingGuardBreaches(result, 15, 0), []);
  });
});
