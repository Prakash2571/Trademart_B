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
 *   2. Compute the target per `pricingMode`: solve for a margin, or apply a
 *      markup (cost x N / cost + N).
 *   3. Rounding                -> charm/integer/none.
 *   4. Minimum-margin floor    -> raise the price if rounding or a thin markup
 *                                 breached it.
 *   5. Max change clamp        -> bound movement per run.
 *   6. Minimum change filter   -> ignore trivial drift.
 *
 * Note that the floor applies to the markup modes too. A "2.5x" rule sounds like
 * a 60% margin but is not one once payment fees and ad costs are counted, so the
 * floor still has real work to do — it is not redundant with the target.
 */

import { AppError } from '../common/errors';
import { percentageOf } from '../common/money';
import {
  calculatePricing,
  calculateSuggestedPrice,
  round2,
} from '../pricing/pricing.service';
import type { ProductVariantDto } from '../shopify/shopify.types';
import {
  describeCostSource,
  resolveCostSource,
  type CostSource,
  type ManualCost,
} from '../suppliers/cost';
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
      /** Where the cost that drove this decision came from. */
      costSource: CostSource;
      clamped: boolean;
      reasons: string[];
    }
  | {
      kind: 'noop';
      variantId: string;
      currentMarginPercentage: number | null;
      costSource: CostSource;
      reasons: string[];
    }
  | { kind: 'skip'; variantId: string; costSource: CostSource; reasons: string[] };

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
      paymentFee: percentageOf(sellingPrice, rules.paymentFeePercentage),
      shopifyFee: percentageOf(sellingPrice, rules.shopifyFeePercentage),
      advertisingCost: rules.advertisingCost,
      otherCosts: rules.otherCosts,
    });
    return result.profitMarginPercentage;
  } catch {
    return null;
  }
}

/**
 * Absolute contribution per unit at `sellingPrice`, or null when it cannot be
 * computed.
 *
 * Exists because a percentage floor alone is not a sufficient guard. 15% of a 3.00
 * item is 45p - which does not cover one support email, one return, or the payment
 * processor's fixed component. A margin floor and a cash floor answer different
 * questions and both are needed.
 */
export function profitAtPrice(
  sellingPrice: number,
  cost: number,
  rules: PriceRules,
): number | null {
  if (!Number.isFinite(sellingPrice) || sellingPrice <= 0) return null;
  try {
    const result = calculatePricing({
      sellingPrice,
      supplierProductCost: cost,
      paymentFee: percentageOf(sellingPrice, rules.paymentFeePercentage),
      shopifyFee: percentageOf(sellingPrice, rules.shopifyFeePercentage),
      advertisingCost: rules.advertisingCost,
      otherCosts: rules.otherCosts,
    });
    return result.grossProfit;
  } catch {
    return null;
  }
}

/**
 * True when `price` clears BOTH floors: the margin percentage and the absolute
 * contribution.
 *
 * A null figure (cost or price not computable) is treated as clearing the floor,
 * matching the existing behaviour: an incomputable margin is not evidence of a
 * loss, and refusing on it would stop pricing for a reason nobody could act on.
 */
function clearsFloors(
  price: number,
  cost: number,
  rules: PriceRules,
): { ok: true } | { ok: false; reason: string } {
  const margin = marginAtPrice(price, cost, rules);
  if (margin !== null && margin < rules.minMarginPercentage) {
    return {
      ok: false,
      reason: `yields ${margin.toFixed(2)}% margin, below the ${rules.minMarginPercentage}% floor`,
    };
  }

  if (rules.minimumProfitAmount > 0) {
    const profit = profitAtPrice(price, cost, rules);
    if (profit !== null && profit < rules.minimumProfitAmount) {
      return {
        ok: false,
        reason: `yields only ${profit.toFixed(2)} contribution per unit, below the ${rules.minimumProfitAmount.toFixed(2)} minimum`,
      };
    }
  }

  return { ok: true };
}

/**
 * The variant's resolved cost, following the source hierarchy
 * (supplier API > Shopify cost per item > manual > unknown).
 *
 * A zero or negative amount at any level is treated as UNKNOWN, not as free:
 * Shopify returns 0 both for "genuinely free" and "never filled in", and pricing
 * a product as if it cost nothing is exactly the invented-data failure the
 * codebase forbids.
 */
export function resolveVariantCost(
  variant: ProductVariantDto,
  manualCost?: ManualCost | null,
) {
  return resolveCostSource({
    // No supplier provider returns a real cost today (Tradelle has no API), so
    // supplierApiCost is intentionally not supplied here; the hierarchy still
    // reserves the top slot for when one does.
    shopifyUnitCost: variant.unitCost,
    manualCost: manualCost ?? null,
  });
}

/**
 * Backward-compatible numeric accessor. Returns just the amount (or null), for
 * callers that do not need the source. Prefer resolveVariantCost when the source
 * matters (audit, UI).
 */
export function resolveCost(
  variant: ProductVariantDto,
  manualCost?: ManualCost | null,
): number | null {
  return resolveVariantCost(variant, manualCost).amount;
}

/** Decides the price for a single variant. */
export function decideVariantPrice(
  variant: ProductVariantDto,
  rules: PriceRules,
  manualCost?: ManualCost | null,
): PriceDecision {
  const variantId = variant.shopifyVariantId;

  if (!rules.enabled) {
    return {
      kind: 'skip',
      variantId,
      costSource: 'UNKNOWN',
      reasons: ['Price automation is disabled.'],
    };
  }

  const resolved = resolveVariantCost(variant, manualCost);
  // Prices are derived from the LANDED cost - product + supplier shipping - not
  // from the product cost alone. Pricing on the product cost meant every margin
  // was overstated by the shipping the supplier charges, including the
  // minMarginPercentage floor that exists specifically to prevent a loss.
  //
  // landedCost equals the product cost when shipping is UNKNOWN. That case is
  // reported below rather than hidden, because the resulting margin is then an
  // upper bound, not an estimate.
  const cost = resolved.landedCost;
  const costSource = resolved.source;
  if (cost === null && rules.requireKnownCost) {
    return {
      kind: 'skip',
      variantId,
      costSource,
      reasons: [
        'No cost available from any source (supplier API, Shopify cost per item, or a manual entry). Set "Cost per item" in Shopify, or add a manual cost in Trademart - nothing is priced from a guess.',
      ],
    };
  }
  if (cost === null) {
    return { kind: 'skip', variantId, costSource, reasons: ['Cost unknown.'] };
  }

  if (variant.price === null) {
    return {
      kind: 'skip',
      variantId,
      costSource,
      reasons: ['Variant has no current price to compare against.'],
    };
  }
  const currentPrice = variant.price.amount;
  const currencyCode = variant.price.currencyCode;

  // A cost denominated differently from the price would make the maths
  // meaningless, and no conversion rate is available. Refuse rather than guess.
  // Uses the RESOLVED cost's currency, so a manual cost is checked too, not just
  // Shopify's unit cost.
  if (resolved.currencyCode !== null && resolved.currencyCode !== currencyCode) {
    return {
      kind: 'skip',
      variantId,
      costSource,
      reasons: [
        `Cost is in ${resolved.currencyCode} but the price is in ${currencyCode}; no exchange rate is available.`,
      ],
    };
  }

  const currentMarginPercentage = marginAtPrice(currentPrice, cost, rules);
  const reasons: string[] = [`Cost source: ${describeCostSource(costSource)}.`];

  // Shipping is stated explicitly either way, so a margin is never quoted without
  // the reader knowing whether shipping was in it.
  if (resolved.shippingKnown && resolved.shippingCost !== null) {
    reasons.push(
      `Landed cost ${cost.toFixed(2)} ${currencyCode} = product ${(resolved.amount ?? 0).toFixed(2)} + supplier shipping ${resolved.shippingCost.toFixed(2)} (${describeCostSource(resolved.shippingSource)}).`,
    );
  } else if (rules.requireKnownShippingCost) {
    return {
      kind: 'skip',
      variantId,
      costSource,
      reasons: [
        ...reasons,
        'Supplier shipping cost is unknown, and requireKnownShippingCost is on. Record a shipping cost for this variant, or turn the requirement off to price from the product cost alone and accept that the margin will be an upper bound.',
      ],
    };
  } else {
    reasons.push(
      `Supplier shipping is UNKNOWN, so it is NOT included: the margin below is an upper bound, not an estimate, and the real margin is lower by whatever the supplier charges to ship. Record a shipping cost to price this accurately.`,
    );
  }

  let target: number;
  if (rules.pricingMode === 'multiplier') {
    // The classic dropshipping markup: cost x N.
    target = round2(cost * rules.multiplier);
    reasons.push(
      `Cost ${cost.toFixed(2)} ${currencyCode} x ${rules.multiplier} -> ${target.toFixed(2)}.`,
    );
  } else if (rules.pricingMode === 'fixed_uplift') {
    target = round2(cost + rules.fixedUplift);
    reasons.push(
      `Cost ${cost.toFixed(2)} ${currencyCode} + ${rules.fixedUplift.toFixed(2)} -> ${target.toFixed(2)}.`,
    );
  } else {
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
        costSource,
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
  }

  let candidate = applyRounding(target, rules.rounding);
  if (candidate !== round2(target)) {
    reasons.push(`Rounded to ${candidate.toFixed(2)} (${rules.rounding}).`);
  }

  // Rounding down can push the price under a floor; step up until it clears BOTH
  // the margin floor and the absolute contribution floor.
  const floorMargin = rules.minMarginPercentage;
  let floorAdjusted = false;
  let lastFloorReason = '';
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const check = clearsFloors(candidate, cost, rules);
    if (check.ok) break;
    lastFloorReason = check.reason;
    candidate = round2(candidate + (rules.rounding === 'integer' ? 1 : 0.5));
    floorAdjusted = true;
  }
  if (floorAdjusted) {
    reasons.push(
      `Raised to ${candidate.toFixed(2)}: the rounded price ${lastFloorReason}.`,
    );
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

  // A clamp must never drag the price below either floor.
  if (clamped) {
    const check = clearsFloors(candidate, cost, rules);
    if (!check.ok) {
      return {
        kind: 'skip',
        variantId,
        costSource,
        reasons: [
          ...reasons,
          `Clamped price ${check.reason}. Skipped rather than sold at a loss - raise maxIncreasePercentage or lower the target.`,
        ],
      };
    }
  }

  if (Math.abs(candidate - currentPrice) < rules.minChangeAmount) {
    return {
      kind: 'noop',
      variantId,
      currentMarginPercentage,
      costSource,
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
    costSource,
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
  manualCosts?: ReadonlyMap<string, ManualCost>,
): number | null {
  let lowest: number | null = null;
  for (const variant of variants) {
    const cost = resolveCost(variant, manualCosts?.get(variant.shopifyVariantId) ?? null);
    if (cost === null || variant.price === null) continue;
    const margin = marginAtPrice(variant.price.amount, cost, rules);
    if (margin === null) continue;
    if (lowest === null || margin < lowest) lowest = margin;
  }
  return lowest;
}
