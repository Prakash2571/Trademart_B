/**
 * The single authority for monetary arithmetic.
 *
 * THE BUG THIS REPLACES
 * ---------------------
 * Rounding was `Math.round((value + Number.EPSILON) * 100) / 100`.
 *
 * Number.EPSILON is the gap between 1.0 and the next double - about 2.2e-16. It is
 * the WRONG correction for any value that is not near 1.0, because floating-point
 * spacing scales with magnitude: at 100 the gap is ~1.4e-14, so adding EPSILON
 * changes nothing at all. The nudge silently stopped working exactly where prices
 * live.
 *
 * The consequence was real and invisible:
 *
 *     round2(8.165)  -> 8.16   (should be 8.17)
 *     round2(10.075) -> 10.07  (should be 10.08)
 *     round2(2.675)  -> 2.68   correct, by luck
 *
 * A penny lost, non-deterministically, depending on whether the binary
 * representation of that particular decimal happened to fall above or below the
 * .5 boundary. Worse than a consistent bias, because it is not reproducible by
 * inspection.
 *
 * HOW THIS IS FIXED
 * -----------------
 * Scaling is done in DECIMAL, not binary. `String(value)` produces the shortest
 * decimal string that round-trips to the same double, so appending an exponent
 * shifts the decimal point exactly:
 *
 *     8.165  ->  "8.165"  ->  "8.165e+2"  ->  816.5  (exactly representable)
 *                                          ->  817
 *                                          ->  "817e-2"  ->  8.17
 *
 * `816.5 * 100` in binary would have given 816.4999999999999, which is where the
 * penny went. Multiplying by 100 is precisely the step that must be avoided.
 *
 * Rounding is HALF AWAY FROM ZERO, the normal commercial convention, rather than
 * JavaScript's `Math.round` which rounds half toward +Infinity and would therefore
 * treat -0.005 and +0.005 asymmetrically.
 *
 * WHY MINOR UNITS ARE EXPOSED
 * ---------------------------
 * Rounding correctly at each step is not the same as being safe to accumulate.
 * Summing ten rounded doubles still drifts. Anything that adds several amounts
 * (a cost breakdown, an order's economics) should sum in integer minor units and
 * convert back once, which is what sumMoney does.
 *
 * NOT A CURRENCY LIBRARY, DELIBERATELY. Every currency Trademart handles is
 * 2-decimal, and a full arbitrary-precision decimal type is not justified for that.
 * If a zero-decimal currency (JPY) or a 3-decimal one (KWD) ever has to be
 * supported, MINOR_UNIT_SCALE is the one place that changes.
 */

import { AppError } from './errors';

/** Decimal places for every currency Trademart currently handles. */
export const MONEY_DECIMALS = 2;
const MINOR_UNIT_SCALE = 10 ** MONEY_DECIMALS;

/**
 * Above this, a value is not a plausible monetary amount and is far more likely to
 * be a units mix-up (minor units passed as major, an id passed as a price) than a
 * real number. Rejecting it turns a silent absurdity into an error.
 */
const MAX_AMOUNT = 1e12;

function reject(value: unknown, field: string, why: string): never {
  throw new AppError(
    'VALIDATION_ERROR',
    `${field} is not a usable monetary amount (${String(value)}): ${why}`,
  );
}

/** Throws unless `value` is a finite number within a plausible money range. */
export function assertMoney(value: unknown, field = 'amount'): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return reject(value, field, 'it must be a finite number.');
  }
  if (Math.abs(value) > MAX_AMOUNT) {
    return reject(value, field, `it exceeds ${MAX_AMOUNT}, so it is probably not a price.`);
  }
  return value;
}

/**
 * Shifts a number's decimal point by `places` without a binary multiply.
 *
 * Returns null when the value's string form is already exponential, which
 * `String()` does below 1e-6 and at/above 1e21 - appending another exponent there
 * would produce "1e-7e+2" and parse as NaN. Callers decide what that means.
 */
function shiftDecimal(value: number, places: number): number | null {
  const text = String(value);
  if (text.includes('e') || text.includes('E')) return null;
  const shifted = Number(`${text}e${places >= 0 ? '+' : ''}${places}`);
  return Number.isFinite(shifted) ? shifted : null;
}

/** Rounds half away from zero. Math.round alone rounds half toward +Infinity. */
function roundHalfAwayFromZero(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

/**
 * Converts a major-unit amount to integer minor units (pence, cents, paise).
 *
 * This is the form to do arithmetic in, and the form to persist if exact
 * reproducibility matters more than readability in the database.
 */
export function toMinorUnits(value: number, field = 'amount'): number {
  const amount = assertMoney(value, field);
  if (amount === 0) return 0;

  const shifted = shiftDecimal(amount, MONEY_DECIMALS);
  if (shifted === null) {
    // Only reachable for |amount| < 1e-6 given the MAX_AMOUNT guard above. That is
    // less than a hundredth of the smallest minor unit, so it IS zero here - and
    // saying so is honest rather than a silent truncation of something meaningful.
    return 0;
  }
  return roundHalfAwayFromZero(shifted);
}

/** Converts integer minor units back to a major-unit amount. */
export function fromMinorUnits(minor: number): number {
  if (!Number.isFinite(minor)) {
    return reject(minor, 'minorUnits', 'it must be a finite number.');
  }
  const whole = roundHalfAwayFromZero(minor);
  if (whole === 0) return 0;
  const shifted = shiftDecimal(whole, -MONEY_DECIMALS);
  // An integer's string form is never exponential within MAX_AMOUNT * 100, so the
  // fallback is unreachable in practice; kept so the function is total.
  return shifted ?? whole / MINOR_UNIT_SCALE;
}

/**
 * Rounds a monetary amount to 2 decimal places, correctly.
 *
 * Use this at the point a number becomes a price. Do NOT use it as a substitute
 * for summing in minor units - see sumMoney.
 */
export function roundMoney(value: number, field = 'amount'): number {
  return fromMinorUnits(toMinorUnits(value, field));
}

/**
 * Adds amounts exactly, by summing in integer minor units.
 *
 * Rounding each term and then adding doubles still drifts; this cannot. Use it for
 * every cost breakdown and order total, which is where several amounts meet.
 */
export function sumMoney(...values: (number | null | undefined)[]): number {
  let minor = 0;
  for (const value of values) {
    // null/undefined are SKIPPED, not coerced to 0. An unknown shipping cost is not
    // free shipping, and a caller that wants it counted as zero has to say so.
    if (value === null || value === undefined) continue;
    minor += toMinorUnits(value);
  }
  return fromMinorUnits(minor);
}

/** `a - b`, exactly. */
export function subtractMoney(a: number, b: number): number {
  return fromMinorUnits(toMinorUnits(a, 'a') - toMinorUnits(b, 'b'));
}

/**
 * Multiplies an amount by a plain (non-money) factor - a quantity, a multiplier.
 *
 * Scales in minor units so the result is a whole number of minor units rather than
 * a double that merely looks like a price.
 */
export function multiplyMoney(value: number, factor: number): number {
  if (!Number.isFinite(factor)) {
    return reject(factor, 'factor', 'it must be a finite number.');
  }
  return fromMinorUnits(roundHalfAwayFromZero(toMinorUnits(value) * factor));
}

/** `percentage`% of `value`, e.g. percentageOf(1399, 2.9) for a payment fee. */
export function percentageOf(value: number, percentage: number): number {
  if (!Number.isFinite(percentage)) {
    return reject(percentage, 'percentage', 'it must be a finite number.');
  }
  return fromMinorUnits(roundHalfAwayFromZero((toMinorUnits(value) * percentage) / 100));
}

/**
 * `value / divisor`. Used by the target-margin formula, which divides by
 * (1 - margin).
 *
 * Division by zero throws rather than returning Infinity: a margin of 100% is a
 * configuration error, and an Infinity silently propagating into a price is the
 * worst possible outcome.
 */
export function divideMoney(value: number, divisor: number): number {
  if (!Number.isFinite(divisor)) {
    return reject(divisor, 'divisor', 'it must be a finite number.');
  }
  if (divisor === 0) {
    throw new AppError(
      'VALIDATION_ERROR',
      'Cannot divide a monetary amount by zero. A 100% target margin is unachievable - a selling price would have to be infinite.',
    );
  }
  return fromMinorUnits(roundHalfAwayFromZero(toMinorUnits(value) / divisor));
}

/** Formats for display/logging. Never used for arithmetic. */
export function formatMoney(value: number, currencyCode: string | null): string {
  const amount = roundMoney(value).toFixed(MONEY_DECIMALS);
  return currencyCode === null ? amount : `${amount} ${currencyCode}`;
}

/**
 * True when two amounts are equal to the minor unit.
 *
 * `a === b` on doubles is the wrong comparison for money: two computations that
 * should agree can differ in the last bit.
 */
export function moneyEquals(a: number, b: number): boolean {
  return toMinorUnits(a) === toMinorUnits(b);
}
