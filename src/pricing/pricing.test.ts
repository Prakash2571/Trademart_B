/**
 * Pricing engine tests.
 * Uses node:test (built into Node) so no test framework install is required.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AppError } from '../common/errors';
import { calculatePricing, calculateSuggestedPrice, round2 } from './pricing.service';

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
