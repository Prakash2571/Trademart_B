/**
 * Selling prices for imported DeoDap products - pure.
 *
 * Two ways to price, chosen per import:
 *
 *   MARKUP  (DeoDap cost + DeoDap shipping, when included) + markup%, then rounded
 *   RETAIL  the MRP / retail price from the file; rows without one fall back to MARKUP
 *
 * All arithmetic goes through common/money (minor units), and rounding reuses
 * pricing/rounding, so an imported price rounds exactly like a repriced one.
 *
 * A price below the landed cost is refused rather than imported: it can only happen in
 * RETAIL mode, when a file's MRP is lower than what DeoDap charges.
 */

import { AppError } from '../../common/errors';
import { percentageOf, roundMoney, subtractMoney, sumMoney } from '../../common/money';
import { applyRounding, type PriceRounding } from '../../pricing/rounding';
import {
  validateMarkupPercent,
  validatePriceRounding,
  validatePricingMode,
  type DeodapPricingMode,
  type DeodapSettings,
} from './deodap.settings';

export interface PricingRule {
  mode: DeodapPricingMode;
  markupPercent: number;
  rounding: PriceRounding;
  includeShipping: boolean;
  compareAtFromRetail: boolean;
}

export interface VariantPrice {
  /** DeoDap cost plus shipping when shipping is included and known. */
  landedCost: number | null;
  price: number | null;
  compareAtPrice: number | null;
  /** (price - landed cost) / price, as a percentage to one decimal place. */
  marginPercent: number | null;
  issues: string[];
  warnings: string[];
}

export function pricingRuleFromSettings(settings: DeodapSettings): PricingRule {
  return {
    mode: settings.pricingMode,
    markupPercent: settings.markupPercent,
    rounding: settings.priceRounding,
    includeShipping: settings.includeShippingInPrice,
    compareAtFromRetail: settings.compareAtFromRetail,
  };
}

/** Reads a `pricing` object from a request, each field defaulting to `defaults`. */
export function resolvePricingRule(raw: unknown, defaults: PricingRule): PricingRule {
  if (raw === undefined || raw === null) return { ...defaults };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AppError('VALIDATION_ERROR', 'pricing must be an object.');
  }
  const body = raw as Record<string, unknown>;
  const rule = { ...defaults };
  if (body['mode'] !== undefined) rule.mode = validatePricingMode(body['mode']);
  if (body['markupPercent'] !== undefined) {
    rule.markupPercent = validateMarkupPercent(body['markupPercent']);
  }
  if (body['rounding'] !== undefined) rule.rounding = validatePriceRounding(body['rounding']);
  for (const key of ['includeShipping', 'compareAtFromRetail'] as const) {
    const value = body[key];
    if (value === undefined) continue;
    if (typeof value !== 'boolean') {
      throw new AppError('VALIDATION_ERROR', `pricing.${key} must be true or false.`);
    }
    rule[key] = value;
  }
  return rule;
}

function marginOf(price: number, landedCost: number): number | null {
  if (price <= 0) return null;
  return Math.round((subtractMoney(price, landedCost) / price) * 1000) / 10;
}

/** Works out the selling and compare-at price for one variant. */
export function priceVariant(
  input: { cost: number | null; shippingCost: number | null; retailPrice: number | null },
  rule: PricingRule,
): VariantPrice {
  if (input.cost === null || input.cost <= 0) {
    return {
      landedCost: null,
      price: null,
      compareAtPrice: null,
      marginPercent: null,
      issues: ['There is no DeoDap cost, so no selling price can be worked out.'],
      warnings: [],
    };
  }

  const shipping =
    rule.includeShipping && input.shippingCost !== null && input.shippingCost > 0
      ? input.shippingCost
      : null;
  const landedCost = sumMoney(input.cost, shipping);
  const issues: string[] = [];
  const warnings: string[] = [];

  let price: number;
  if (rule.mode === 'RETAIL' && input.retailPrice !== null && input.retailPrice > 0) {
    price = roundMoney(input.retailPrice);
  } else {
    if (rule.mode === 'RETAIL') {
      warnings.push('No MRP in this row, so the markup was used instead.');
    }
    price = applyRounding(sumMoney(landedCost, percentageOf(landedCost, rule.markupPercent)), rule.rounding);
    // .99 rounding goes DOWN, which can land a low-markup price just under cost.
    for (let attempt = 0; attempt < 3 && price < landedCost; attempt += 1) {
      price = applyRounding(sumMoney(price, 1), rule.rounding);
    }
  }

  if (price < landedCost) {
    issues.push(
      `The selling price ${price.toFixed(2)} is below the DeoDap cost ${landedCost.toFixed(2)}.`,
    );
  } else if (price === landedCost) {
    warnings.push('The selling price equals the DeoDap cost, so there is no margin.');
  }

  const compareAtPrice =
    rule.compareAtFromRetail && input.retailPrice !== null && input.retailPrice > price
      ? roundMoney(input.retailPrice)
      : null;

  return {
    landedCost,
    price,
    compareAtPrice,
    marginPercent: marginOf(price, landedCost),
    issues,
    warnings,
  };
}
