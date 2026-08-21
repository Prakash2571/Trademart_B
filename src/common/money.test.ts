/**
 * Money arithmetic.
 *
 * The cases that matter are the ones the previous EPSILON-based rounding got
 * WRONG, because those were losing a penny silently and non-reproducibly.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AppError } from './errors';
import {
  divideMoney,
  formatMoney,
  fromMinorUnits,
  moneyEquals,
  multiplyMoney,
  percentageOf,
  roundMoney,
  subtractMoney,
  sumMoney,
  toMinorUnits,
} from './money';

/** The old implementation, kept here to pin what was actually broken. */
function legacyRound2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

describe('roundMoney fixes the cases EPSILON rounding got wrong', () => {
  // Each of these lost a penny. They are not exotic: 8.165 is what a 30% margin on
  // a 6.28 cost produces.
  const regressions: [number, number][] = [
    [8.165, 8.17],
    [10.075, 10.08],
    [1.005, 1.01],
    [2.675, 2.68],
    [262.475, 262.48],
    [1.015, 1.02],
    [0.615, 0.62],
    [1.335, 1.34],
  ];

  for (const [input, expected] of regressions) {
    it(`rounds ${input} to ${expected}`, () => {
      assert.equal(roundMoney(input), expected);
    });
  }

  it('and at least one of those was genuinely wrong before, not just theoretically', () => {
    // Proof the fix is load-bearing rather than a no-op refactor.
    assert.equal(legacyRound2(8.165), 8.16);
    assert.equal(roundMoney(8.165), 8.17);
    assert.notEqual(legacyRound2(8.165), roundMoney(8.165));
  });
});

describe('roundMoney basics', () => {
  it('leaves already-2dp values alone', () => {
    for (const value of [0, 1, 9.99, 1399, 420.5, 0.01]) {
      assert.equal(roundMoney(value), value);
    }
  });

  it('rounds down below the half', () => {
    assert.equal(roundMoney(8.164), 8.16);
    assert.equal(roundMoney(0.004), 0);
  });

  it('rounds half AWAY FROM ZERO, symmetrically', () => {
    // Math.round rounds half toward +Infinity, which would make -0.005 round to
    // -0.00 while +0.005 rounds to 0.01 - an asymmetry that becomes a rounding bias
    // on refunds and negative adjustments.
    assert.equal(roundMoney(0.005), 0.01);
    assert.equal(roundMoney(-0.005), -0.01);
    assert.equal(roundMoney(-8.165), -8.17);
  });

  it('handles negatives generally', () => {
    assert.equal(roundMoney(-1.234), -1.23);
    assert.equal(roundMoney(-1.235), -1.24);
  });

  it('collapses amounts below a hundredth of a minor unit to zero', () => {
    // 1e-7 stringifies as "1e-7"; the decimal shift has to cope rather than NaN.
    assert.equal(roundMoney(1e-7), 0);
    assert.equal(roundMoney(-1e-7), 0);
  });

  it('rejects values that are not finite numbers', () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      assert.throws(() => roundMoney(bad), AppError);
    }
  });

  it('rejects implausibly large values, which are almost always a units mix-up', () => {
    assert.throws(() => roundMoney(1e13), AppError);
  });

  it('names the field in the error, so a caller can find it', () => {
    let caught: AppError | null = null;
    try {
      roundMoney(NaN, 'supplierShippingCost');
    } catch (error) {
      caught = error instanceof AppError ? error : null;
    }
    assert.notEqual(caught, null, 'expected an AppError');
    assert.match(caught?.message ?? '', /supplierShippingCost/);
  });
});

describe('minor units round-trip', () => {
  it('converts major to minor exactly', () => {
    assert.equal(toMinorUnits(8.165), 817);
    assert.equal(toMinorUnits(1399), 139900);
    assert.equal(toMinorUnits(0.01), 1);
    assert.equal(toMinorUnits(0), 0);
    assert.equal(toMinorUnits(-4.2), -420);
  });

  it('round-trips', () => {
    for (const value of [0, 0.01, 9.99, 420, 1399.45, -55.5]) {
      assert.equal(fromMinorUnits(toMinorUnits(value)), value);
    }
  });
});

describe('sumMoney accumulates without drift', () => {
  it('adds the classic 0.1 + 0.2 case exactly', () => {
    // 0.1 + 0.2 === 0.30000000000000004 in plain doubles.
    assert.equal(sumMoney(0.1, 0.2), 0.3);
  });

  it('does not drift over many terms', () => {
    // Ten 0.1s is 0.9999999999999999 added naively.
    const tenth = Array.from({ length: 10 }, () => 0.1);
    assert.equal(sumMoney(...tenth), 1);
  });

  it('sums a realistic cost breakdown', () => {
    // supplier 420 + shipping 100 + payment fee 60.45 + ads 220.30
    assert.equal(sumMoney(420, 100, 60.45, 220.3), 800.75);
  });

  it('SKIPS null and undefined rather than treating them as zero', () => {
    // The whole point: an unknown shipping cost is not free shipping. Skipping keeps
    // the arithmetic honest; deciding what unknown MEANS is the caller's job.
    assert.equal(sumMoney(420, null, 100), 520);
    assert.equal(sumMoney(420, undefined), 420);
    assert.equal(sumMoney(null, undefined), 0);
  });
});

describe('subtractMoney', () => {
  it('subtracts exactly', () => {
    // 1399 - 800.75 in doubles is 598.2500000000001 in some orderings.
    assert.equal(subtractMoney(1399, 800.75), 598.25);
    assert.equal(subtractMoney(0.3, 0.1), 0.2);
  });

  it('can go negative, because a loss is a real answer', () => {
    assert.equal(subtractMoney(100, 250.5), -150.5);
  });
});

describe('multiplyMoney', () => {
  it('multiplies by a quantity', () => {
    assert.equal(multiplyMoney(19.99, 3), 59.97);
  });

  it('multiplies by a fractional multiplier and rounds once', () => {
    assert.equal(multiplyMoney(420, 2.5), 1050);
    assert.equal(multiplyMoney(6.28, 1.3), 8.16);
  });

  it('rejects a non-finite factor', () => {
    assert.throws(() => multiplyMoney(10, NaN), AppError);
  });
});

describe('percentageOf', () => {
  it('computes a payment fee', () => {
    assert.equal(percentageOf(1399, 2.9), 40.57);
  });

  it('computes an advertising allowance', () => {
    assert.equal(percentageOf(1399, 15), 209.85);
  });

  it('0% is zero, 100% is the value', () => {
    assert.equal(percentageOf(1399, 0), 0);
    assert.equal(percentageOf(1399, 100), 1399);
  });
});

describe('divideMoney', () => {
  it('implements the target-margin formula', () => {
    // sellingPrice = commercialCost / (1 - margin)
    assert.equal(divideMoney(800, 1 - 0.4), 1333.33);
  });

  it('REFUSES to divide by zero instead of returning Infinity', () => {
    // A 100% target margin is a configuration error. An Infinity propagating into a
    // price is the worst possible outcome, so this is the one place it is stopped.
    assert.throws(() => divideMoney(800, 0), AppError);

    let caught: AppError | null = null;
    try {
      divideMoney(800, 0);
    } catch (error) {
      caught = error instanceof AppError ? error : null;
    }
    assert.match(caught?.message ?? '', /100% target margin/);
  });
});

describe('moneyEquals compares at the minor unit', () => {
  it('treats values equal to the penny as equal', () => {
    assert.equal(moneyEquals(0.1 + 0.2, 0.3), true);
    assert.equal(moneyEquals(8.165, 8.17), true);
  });

  it('still distinguishes a real one-penny difference', () => {
    assert.equal(moneyEquals(8.16, 8.17), false);
  });
});

describe('formatMoney', () => {
  it('always shows two decimals', () => {
    assert.equal(formatMoney(1399, 'INR'), '1399.00 INR');
    assert.equal(formatMoney(8.165, 'GBP'), '8.17 GBP');
  });

  it('omits the currency when it is unknown rather than inventing one', () => {
    assert.equal(formatMoney(420, null), '420.00');
  });
});
