/**
 * Price decisions — what should this variant cost?
 *
 * Pure. Reuses the existing pricing engine (`calculateSuggestedPrice`) rather
 * than re-deriving the margin maths, so automation and the manual
 * /api/pricing/suggest-price endpoint can never disagree.
 *
 * The cost input is Shopify's own "cost per item" (`inventoryItem.unitCost`).
 * That is what makes this supplier-agnostic: Tradelle, DSers, Zendrop, CJ,
 * AutoDS and manual imports all write into that one field, so Trademart reads
 * one place and works with any of them — no supplier API required (which
 * matters, because Tradelle does not publish one).
 *
 * Guardrails, in the order they are applied:
 *   1. Unknown cost            -> skip. Never invent a price.
 *   2. Compute target price at targetMarginPercentage.
 *   3. Rounding                -> charm/integer/none.
 *   4. Minimum-margin floor    -> raise the price if rounding breached it.
 *   5. Max change clamp        -> bound movement per run.
 *   6. Minimum change filter   -> ignore trivial drift.
 */

import { AppError } from '../common/errors';
import {
  calculatePricing,
  calculateSuggestedPrice,
  round2,
} from '../pricing/pricing.service';
import type { ProductVariantDto } from '../shopify/shopify.types';
import type { PriceRounding, PriceRules } from './rules.types';

export type PriceDecision =
  | {
      kind: 'change';
      variantId: string;
      from: number;
      to: number;
      currencyCode: string;
      /** Margin achieved at the new price. */
      projectedMarginPercentage: number | null;
      /** Margin at the price it had before. Null when it could not be computed. */
      currentMarginPercentage: number | null;
      clamped: boolean;
      reasons: string[];
    }
  | { kind: 'noop'; variantId: string; currentMarginPercentage: number | null; reasons: string[] }
  | { kind: 'skip'; variantId: string; reasons: string[] };

/**
 * Rounds to the nearest .99 at or below the target, then steps up a unit if
 * that would land at a negative or zero price.
 *
 * Rounding DOWN is deliberate: .99 pricing that rounds up would silently push
 * every price above the computed target.
 */
function toCharm99(value: number): number {
  if (value <= 0.99) return 0.99;
  const floor = Math.floor(value);
  // 12.40 -> 11.99, 12.99 -> 12.99, 13.00 -> 12.99
  const candidate = value >= floor + 0.99 ? floor + 0.99 : floor - 1 + 0.99;
  return round2(candidate <= 0 ? 0.99 : candidate);
}

/** Applies the configured rounding strategy. */
export function applyRounding(value: number, rounding: PriceRounding): number {
  switch (rounding) {
    case 'charm99':
      return toCharm99(value);
    case 'integer':
      return round2(Math.max(1, Math.round(value)));
    case 'none':
    default:
      return round2(value);
  }
}

/**
 * Margin percentage achieved at `sellingPrice`, or null when it cannot be
 * computed. Wrapped because the pricing engine throws on invalid inputs and a
 * single odd variant must not abort a whole run.
 */
export function marginAtPrice(
  sellingPrice: number,
  cost: number,
  rules: PriceRules,
): number | null {
  if (!Number.isFinite(sellingPrice) || sellingPrice <= 0) return null;
  try {
    const result = calculatePricing({
      sellingPrice,
      supplierProductCost: cost,
      // Percentage fees are absolute amounts here, derived from the price.
      paymentFee: round2((sellingPrice * rules.paymentFeePercentage) / 100),
      shopifyFee: round2((sellingPrice * rules.shopifyFeePercentage) / 100),
      advertisingCost: rules.advertisingCost,
      otherCosts: rules.otherCosts,
    });
    return result.profitMarginPercentage;
  } catch {
    return null;
  }
}

/**
 * The variant's cost, or null when unknown.
 *
 * A zero or negative unitCost is treated as UNKNOWN, not as free: Shopify
 * returns 0 both for "genuinely free" and for "never filled in", and pricing a
 * product as if it cost nothing is exactly the invented-data failure the
 * codebase forbids.
 */
export function resolveCost(variant: ProductVariantDto): number | null {
  if (variant.unitCost === null) return null;
  const amount = variant.unitCost.amount;
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return amount;
}

/** Decides the price for a single variant. */
export function decideVariantPrice(
  variant: ProductVariantDto,
  rules: PriceRules,
): PriceDecision {
  const variantId = variant.shopifyVariantId;

  if (!rules.enabled) {
    return { kind: 'skip', variantId, reasons: ['Price automation is disabled.'] };
  }

  const cost = resolveCost(variant);
  if (cost === null && rules.requireKnownCost) {
    return {
      kind: 'skip',
      variantId,
      reasons: [
        'No cost per item on this variant. Set "Cost per item" in Shopify (dropshipping apps such as Tradelle usually populate it) - nothing is priced from a guess.',
      ],
    };
  }
  if (cost === null) {
    return { kind: 'skip', variantId, reasons: ['Cost unknown.'] };
  }

  if (variant.price === null) {
    return {
      kind: 'skip',
      variantId,
      reasons: ['Variant has no current price to compare against.'],
    };
  }
  const currentPrice = variant.price.amount;
  const currencyCode = variant.price.currencyCode;

  // A cost denominated differently from the price would make the maths
  // meaningless, and no conversion rate is available. Refuse rather than guess.
  if (
    variant.unitCost !== null &&
    variant.unitCost.currencyCode !== currencyCode
  ) {
    return {
      kind: 'skip',
      variantId,
      reasons: [
        `Cost is in ${variant.unitCost.currencyCode} but the price is in ${currencyCode}; no exchange rate is available.`,
      ],
    };
  }

  const currentMarginPercentage = marginAtPrice(currentPrice, cost, rules);
  const reasons: string[] = [];

  let target: number;
  try {
    const suggestion = calculateSuggestedPrice({
      desiredMarginPercentage: rules.targetMarginPercentage,
      supplierProductCost: cost,
      advertisingCost: rules.advertisingCost,
      otherCosts: rules.otherCosts,
      paymentFeePercentage: rules.paymentFeePercentage,
      shopifyFeePercentage: rules.shopifyFeePercentage,
    });
    target = suggestion.suggestedPrice;
  } catch (error) {
    // The engine refuses impossible inputs (margin + fees >= 100, zero costs).
    // Surface its message instead of substituting a number of our own.
    return {
      kind: 'skip',
      variantId,
      reasons: [
        error instanceof AppError
          ? `Pricing engine rejected these inputs: ${error.message}`
          : 'Pricing engine could not compute a price.',
      ],
    };
  }

  reasons.push(
    `Target ${rules.targetMarginPercentage}% margin on cost ${cost.toFixed(2)} ${currencyCode} -> ${target.toFixed(2)}.`,
  );

  let candidate = applyRounding(target, rules.rounding);
  if (candidate !== round2(target)) {
    reasons.push(`Rounded to ${candidate.toFixed(2)} (${rules.rounding}).`);
  }

  // Rounding down can push the price under the floor; step up until it clears.
  const floorMargin = rules.minMarginPercentage;
  let floorAdjusted = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const margin = marginAtPrice(candidate, cost, rules);
    if (margin === null || margin >= floorMargin) break;
    candidate = round2(candidate + (rules.rounding === 'integer' ? 1 : 0.5));
    floorAdjusted = true;
  }
  if (floorAdjusted) {
    reasons.push(`Raised to ${candidate.toFixed(2)} to respect the ${floorMargin}% margin floor.`);
  }

  // Bound the movement so a bad cost feed cannot reprice a catalogue wildly.
  const maxUp = round2(currentPrice * (1 + rules.maxIncreasePercentage / 100));
  const maxDown = round2(currentPrice * (1 - rules.maxDecreasePercentage / 100));
  let clamped = false;
  if (candidate > maxUp) {
    candidate = maxUp;
    clamped = true;
    reasons.push(
      `Clamped to +${rules.maxIncreasePercentage}% (${maxUp.toFixed(2)}) - the full target would be a larger jump than one run allows.`,
    );
  } else if (candidate < maxDown) {
    candidate = maxDown;
    clamped = true;
    reasons.push(
      `Clamped to -${rules.maxDecreasePercentage}% (${maxDown.toFixed(2)}).`,
    );
  }

  // A clamp must never drag the price below the floor.
  if (clamped) {
    const margin = marginAtPrice(candidate, cost, rules);
    if (margin !== null && margin < floorMargin) {
      return {
        kind: 'skip',
        variantId,
        reasons: [
          ...reasons,
          `Clamped price yields ${margin.toFixed(2)}% margin, below the ${floorMargin}% floor. Skipped rather than sold at a loss - raise maxIncreasePercentage or lower the target.`,
        ],
      };
    }
  }

  if (Math.abs(candidate - currentPrice) < rules.minChangeAmount) {
    return {
      kind: 'noop',
      variantId,
      currentMarginPercentage,
      reasons: [
        `Already within ${rules.minChangeAmount} of the target (${currentPrice.toFixed(2)} vs ${candidate.toFixed(2)}).`,
      ],
    };
  }

  return {
    kind: 'change',
    variantId,
    from: currentPrice,
    to: candidate,
    currencyCode,
    projectedMarginPercentage: marginAtPrice(candidate, cost, rules),
    currentMarginPercentage,
    clamped,
    reasons,
  };
}

/**
 * Lowest margin across a product's variants at their current prices, used by the
 * visibility engine's `hideBelowMinMargin` rule.
 *
 * The minimum is used rather than an average because one loss-making variant is
 * enough to make a listing a problem.
 */
export function lowestCurrentMargin(
  variants: readonly ProductVariantDto[],
  rules: PriceRules,
): number | null {
  let lowest: number | null = null;
  for (const variant of variants) {
    const cost = resolveCost(variant);
    if (cost === null || variant.price === null) continue;
    const margin = marginAtPrice(variant.price.amount, cost, rules);
    if (margin === null) continue;
    if (lowest === null || margin < lowest) lowest = margin;
  }
  return lowest;
}
