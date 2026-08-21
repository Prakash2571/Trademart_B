/**
 * Currency safety.
 *
 * Trademart configures no FX source. The rule under test: mixed-currency arithmetic
 * FAILS rather than guessing a rate. A missing profit figure prompts a question; a
 * wrong one prompts a purchase.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AppError } from './errors';
import { assertSharedCurrency, resolveSharedCurrency, sumSameCurrency } from './money';

describe('resolveSharedCurrency', () => {
  it('finds the single shared currency', () => {
    const result = resolveSharedCurrency([
      { amount: 420, currencyCode: 'INR', label: 'supplier cost' },
      { amount: 100, currencyCode: 'INR', label: 'supplier shipping' },
    ]);
    assert.equal(result.currencyCode, 'INR');
    assert.deepEqual(result.conflicts, []);
  });

  it('IGNORES absent amounts - an unknown value has no currency to conflict with', () => {
    // Firing the guard because an unrecorded shipping cost carries no currency code
    // would make it complain about the wrong problem.
    const result = resolveSharedCurrency([
      { amount: 420, currencyCode: 'INR', label: 'supplier cost' },
      { amount: null, currencyCode: null, label: 'supplier shipping' },
    ]);
    assert.equal(result.currencyCode, 'INR');
    assert.deepEqual(result.conflicts, []);
  });

  it('detects a genuine conflict and names both sides', () => {
    const result = resolveSharedCurrency([
      { amount: 5, currencyCode: 'USD', label: 'supplier cost' },
      { amount: 100, currencyCode: 'INR', label: 'supplier shipping' },
    ]);
    assert.equal(result.currencyCode, null);
    assert.equal(result.conflicts.length, 2);
    assert.ok(result.conflicts.some((c) => c.includes('USD') && c.includes('supplier cost')));
    assert.ok(result.conflicts.some((c) => c.includes('INR') && c.includes('supplier shipping')));
  });

  it('treats case differences as the same currency, not a conflict', () => {
    // Sloppy input should not trigger a false alarm.
    const result = resolveSharedCurrency([
      { amount: 1, currencyCode: 'inr' },
      { amount: 2, currencyCode: 'INR' },
    ]);
    assert.equal(result.currencyCode, 'INR');
    assert.deepEqual(result.conflicts, []);
  });

  it('reports an amount with no currency code without calling it a conflict', () => {
    const result = resolveSharedCurrency([
      { amount: 420, currencyCode: 'INR', label: 'cost' },
      { amount: 100, currencyCode: null, label: 'shipping' },
    ]);
    assert.deepEqual(result.conflicts, []);
    assert.deepEqual(result.missingCurrency, ['shipping']);
  });

  it('is null with nothing present', () => {
    assert.equal(resolveSharedCurrency([]).currencyCode, null);
    assert.equal(
      resolveSharedCurrency([{ amount: null, currencyCode: 'INR' }]).currencyCode,
      null,
    );
  });
});

describe('assertSharedCurrency', () => {
  it('returns the currency when they agree', () => {
    assert.equal(
      assertSharedCurrency(
        [
          { amount: 1, currencyCode: 'GBP' },
          { amount: 2, currencyCode: 'GBP' },
        ],
        'compute landed cost',
      ),
      'GBP',
    );
  });

  it('throws CURRENCY_MISMATCH rather than guessing a rate', () => {
    let caught: AppError | null = null;
    try {
      assertSharedCurrency(
        [
          { amount: 5, currencyCode: 'USD', label: 'supplier cost' },
          { amount: 100, currencyCode: 'INR', label: 'supplier shipping' },
        ],
        'compute landed cost',
      );
    } catch (error) {
      caught = error instanceof AppError ? error : null;
    }

    assert.notEqual(caught, null, 'expected an AppError');
    assert.equal(caught?.code, 'CURRENCY_MISMATCH');
    // The message must name the operation and both currencies, or it is not actionable.
    assert.match(caught?.message ?? '', /compute landed cost/);
    assert.match(caught?.message ?? '', /USD/);
    assert.match(caught?.message ?? '', /INR/);
    // And must say WHY it refused rather than converted.
    assert.match(caught?.message ?? '', /No exchange rate is configured/);
  });
});

describe('sumSameCurrency', () => {
  it('sums exactly, in one currency', () => {
    // 0.1 + 0.2 === 0.30000000000000004 in plain doubles.
    const result = sumSameCurrency(
      [
        { amount: 0.1, currencyCode: 'INR' },
        { amount: 0.2, currencyCode: 'INR' },
      ],
      'add costs',
    );
    assert.equal(result.amount, 0.3);
    assert.equal(result.currencyCode, 'INR');
  });

  it('SKIPS absent amounts rather than treating them as zero', () => {
    // Same rule as sumMoney: deciding what unknown MEANS stays with the caller.
    const result = sumSameCurrency(
      [
        { amount: 420, currencyCode: 'INR' },
        { amount: null, currencyCode: null },
      ],
      'add costs',
    );
    assert.equal(result.amount, 420);
  });

  it('refuses to add across currencies', () => {
    assert.throws(
      () =>
        sumSameCurrency(
          [
            { amount: 5, currencyCode: 'USD' },
            { amount: 100, currencyCode: 'INR' },
          ],
          'add costs',
        ),
      (error: unknown) => error instanceof AppError && error.code === 'CURRENCY_MISMATCH',
    );
  });
});
