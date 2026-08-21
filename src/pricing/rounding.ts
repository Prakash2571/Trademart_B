/**
 * Price rounding strategies.
 *
 * Moved here from automation/price.rules.ts, where it originally lived because
 * automation was the only thing that rounded a price. It is not automation-specific:
 * a price recommendation rounds the same way a repriced variant does, and two
 * implementations of charm pricing would eventually disagree about whether 13.00
 * becomes 12.99. automation re-exports these names so existing importers are
 * unaffected.
 *
 * Pure: money helpers only.
 */

import { roundMoney } from '../common/money';

/**
 * How a computed price is rounded before being used.
 *
 *   none    - exact 2dp value
 *   charm99 - round to the nearest .99 (never below the minimum-margin floor)
 *   integer - whole currency units
 */
export type PriceRounding = 'none' | 'charm99' | 'integer';

/**
 * Rounds to the nearest .99 at or below the target, then steps up a unit if
 * that would land at a negative or zero price.
 *
 * Rounding DOWN is deliberate: .99 pricing that rounded up would silently push
 * every price above the computed target. Callers that must not fall below a floor
 * re-check the floor afterwards and raise - see pricingGuardBreaches.
 */
function toCharm99(value: number): number {
  if (value <= 0.99) return 0.99;
  const floor = Math.floor(value);
  // 12.40 -> 11.99, 12.99 -> 12.99, 13.00 -> 12.99
  const candidate = value >= floor + 0.99 ? floor + 0.99 : floor - 1 + 0.99;
  return roundMoney(candidate <= 0 ? 0.99 : candidate);
}

/** Applies the configured rounding strategy. */
export function applyRounding(value: number, rounding: PriceRounding): number {
  switch (rounding) {
    case 'charm99':
      return toCharm99(value);
    case 'integer':
      return roundMoney(Math.max(1, Math.round(value)));
    case 'none':
    default:
      return roundMoney(value);
  }
}

/** The step to take when raising a rounded price back over a floor. */
export function roundingStep(rounding: PriceRounding): number {
  // A whole unit for integer pricing, so the price stays whole. Half a unit
  // otherwise, which is small enough not to overshoot a floor badly and large
  // enough to terminate quickly.
  return rounding === 'integer' ? 1 : 0.5;
}
