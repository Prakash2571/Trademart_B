/**
 * Pricing / margin engine.
 *
 * Completely standalone: no Shopify, no database, no framework imports. It is
 * pure arithmetic over explicit inputs, which makes it independently testable
 * and independently useful (the brief requires it to work on its own).
 *
 * Honesty rules baked into the output:
 *  - Every cost input is optional. Omitted costs are treated as 0 for the
 *    arithmetic but recorded in `missingInputs`.
 *  - `isEstimate` is true whenever any cost was missing, so the UI can label
 *    the result an estimate rather than claiming exact profit.
 *  - Nothing is inferred or invented; unknown supplier costs stay unknown.
 */

import { AppError } from '../common/errors';
import {
  divideMoney,
  percentageOf,
  roundMoney,
  subtractMoney,
  sumMoney,
} from '../common/money';

export interface PricingInput {
  sellingPrice: number;
  supplierProductCost?: number;
  supplierShippingCost?: number;
  paymentFee?: number;
  shopifyFee?: number;
  advertisingCost?: number;
  taxes?: number;
  otherCosts?: number;
}

export interface PricingBreakdownEntry {
  key: string;
  label: string;
  amount: number;
  provided: boolean;
}

export interface PricingResult {
  sellingPrice: number;
  totalCost: number;
  grossProfit: number;
  profitMarginPercentage: number | null;
  /** Profit as a percentage of total cost (markup), null when cost is 0. */
  returnOnCostPercentage: number | null;
  breakdown: PricingBreakdownEntry[];
  /** True when at least one cost input was not supplied. */
  isEstimate: boolean;
  missingInputs: string[];
  notes: string[];
}

export interface SuggestedPriceInput {
  desiredMarginPercentage: number;
  supplierProductCost?: number;
  supplierShippingCost?: number;
  advertisingCost?: number;
  taxes?: number;
  otherCosts?: number;
  /** Percentage of the selling price taken as a payment-processing fee. */
  paymentFeePercentage?: number;
  /** Percentage of the selling price taken as a platform fee. */
  shopifyFeePercentage?: number;
  /**
   * Acquisition allowance as a percentage of the selling price.
   *
   * Separate from `advertisingCost`, which is an absolute amount. Both are
   * supported because the two are genuinely different models: a store with a
   * measured cost-per-acquisition knows an amount, whereas a store budgeting
   * "15% of revenue goes to ads" knows a percentage - and a percentage must be
   * solved for alongside the margin rather than applied to a price that has
   * already been computed, or the resulting margin is wrong.
   *
   * The order view models the advertising allowance as a percentage of revenue too,
   * so pricing this way keeps a recommended price and a reported margin consistent.
   */
  advertisingPercentage?: number;
}

export interface SuggestedPriceResult {
  suggestedPrice: number;
  absoluteCosts: number;
  percentageCosts: number;
  desiredMarginPercentage: number;
  projection: PricingResult;
  isEstimate: boolean;
  missingInputs: string[];
  notes: string[];
}

const COST_FIELDS: { key: keyof PricingInput; label: string }[] = [
  { key: 'supplierProductCost', label: 'Supplier product cost' },
  { key: 'supplierShippingCost', label: 'Supplier shipping cost' },
  { key: 'paymentFee', label: 'Payment fee' },
  { key: 'shopifyFee', label: 'Platform / Shopify fee' },
  { key: 'advertisingCost', label: 'Advertising cost (CPA)' },
  { key: 'taxes', label: 'Taxes' },
  { key: 'otherCosts', label: 'Other costs' },
];

/**
 * Rounds to 2 dp.
 *
 * Re-exported from common/money so there is ONE rounding implementation. It used to
 * be `Math.round((value + Number.EPSILON) * 100) / 100` here, which lost a penny on
 * values like 8.165 and 10.075: Number.EPSILON is the gap between 1.0 and the next
 * double, so it is far too small to correct representation error at price
 * magnitudes. See common/money.ts for the full explanation.
 *
 * Kept as a named export because price.rules.ts and the tests import it; new code
 * should use roundMoney, and anything that ADDS several amounts should use sumMoney
 * rather than rounding each term.
 */
export { roundMoney as round2 };

function assertFinite(value: number, field: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new AppError('VALIDATION_ERROR', `${field} must be a finite number.`);
  }
}

function assertNonNegative(value: number, field: string): void {
  assertFinite(value, field);
  if (value < 0) {
    throw new AppError('VALIDATION_ERROR', `${field} cannot be negative.`);
  }
}

export function calculatePricing(input: PricingInput): PricingResult {
  assertNonNegative(input.sellingPrice, 'sellingPrice');

  const breakdown: PricingBreakdownEntry[] = [];
  const missingInputs: string[] = [];
  const providedAmounts: number[] = [];

  for (const field of COST_FIELDS) {
    const raw = input[field.key];
    const provided = raw !== undefined && raw !== null;
    if (provided) {
      assertNonNegative(raw as number, field.key);
      providedAmounts.push(raw as number);
    }
    const amount = provided ? (raw as number) : 0;
    breakdown.push({
      key: field.key,
      label: field.label,
      amount: roundMoney(amount, field.key),
      provided,
    });
    if (!provided) missingInputs.push(field.key);
  }

  // Summed in integer minor units in ONE step. Accumulating `totalCost += amount`
  // over eight doubles and rounding at the end still drifts - each addition can
  // introduce error that the final round cannot distinguish from a real value.
  const totalCost = sumMoney(...providedAmounts);
  const sellingPrice = roundMoney(input.sellingPrice, 'sellingPrice');
  const grossProfit = subtractMoney(sellingPrice, totalCost);

  // Percentages are ratios, not money, so they are rounded with plain 2dp rounding
  // rather than being pushed through minor units - 39.24% is a display figure and
  // nothing downstream adds it to anything.
  const profitMarginPercentage =
    sellingPrice > 0 ? roundMoney((grossProfit / sellingPrice) * 100, 'profitMargin') : null;
  const returnOnCostPercentage =
    totalCost > 0 ? roundMoney((grossProfit / totalCost) * 100, 'returnOnCost') : null;

  const notes: string[] = [];
  if (missingInputs.length > 0) {
    notes.push(
      'Treated missing cost inputs as 0. Profit is an estimate, not an exact figure.',
    );
  }
  if (grossProfit < 0) {
    notes.push('Costs exceed the selling price - this product loses money as configured.');
  }
  notes.push('Returns, refunds, chargebacks and currency conversion are not included.');

  return {
    sellingPrice,
    totalCost,
    grossProfit,
    profitMarginPercentage,
    returnOnCostPercentage,
    breakdown,
    isEstimate: missingInputs.length > 0,
    missingInputs,
    notes,
  };
}

/**
 * Solves for the selling price that achieves a desired margin.
 *
 *   price * (1 - (feePct + marginPct)/100) = absoluteCosts
 *
 * so percentage-based fees are handled correctly rather than being applied to
 * an already-computed price.
 */
export function calculateSuggestedPrice(
  input: SuggestedPriceInput,
): SuggestedPriceResult {
  assertFinite(input.desiredMarginPercentage, 'desiredMarginPercentage');
  if (input.desiredMarginPercentage < 0 || input.desiredMarginPercentage >= 100) {
    throw new AppError(
      'VALIDATION_ERROR',
      'desiredMarginPercentage must be at least 0 and below 100.',
    );
  }

  const absoluteFields: { key: keyof SuggestedPriceInput; label: string }[] = [
    { key: 'supplierProductCost', label: 'Supplier product cost' },
    { key: 'supplierShippingCost', label: 'Supplier shipping cost' },
    { key: 'advertisingCost', label: 'Advertising cost (CPA)' },
    { key: 'taxes', label: 'Taxes' },
    { key: 'otherCosts', label: 'Other costs' },
  ];

  const missingInputs: string[] = [];
  const providedAbsolute: number[] = [];
  for (const field of absoluteFields) {
    const raw = input[field.key] as number | undefined;
    if (raw === undefined || raw === null) {
      missingInputs.push(field.key as string);
      continue;
    }
    assertNonNegative(raw, field.key as string);
    providedAbsolute.push(raw);
  }
  // Summed in minor units in one step rather than accumulated as doubles.
  const absoluteCosts = sumMoney(...providedAbsolute);

  const paymentFeePercentage = input.paymentFeePercentage ?? 0;
  const shopifyFeePercentage = input.shopifyFeePercentage ?? 0;
  const advertisingPercentage = input.advertisingPercentage ?? 0;
  assertNonNegative(paymentFeePercentage, 'paymentFeePercentage');
  assertNonNegative(shopifyFeePercentage, 'shopifyFeePercentage');
  assertNonNegative(advertisingPercentage, 'advertisingPercentage');
  const percentageCosts =
    paymentFeePercentage + shopifyFeePercentage + advertisingPercentage;

  const divisor = 1 - (percentageCosts + input.desiredMarginPercentage) / 100;
  if (divisor <= 0) {
    throw new AppError(
      'VALIDATION_ERROR',
      'Desired margin plus percentage fees must be below 100% - no price can satisfy these inputs.',
    );
  }

  if (absoluteCosts === 0) {
    // With no absolute costs the equation collapses to price 0; that is a
    // meaningless answer, so say so instead of returning 0.
    throw new AppError(
      'VALIDATION_ERROR',
      'Provide at least one absolute cost (supplier cost, shipping, advertising, taxes or other) to suggest a price.',
    );
  }

  // divideMoney rather than a raw `/`: it refuses a zero divisor instead of
  // producing Infinity. The guard above already rejects divisor <= 0, so this is
  // belt-and-braces - but an Infinity reaching a price is the worst outcome
  // available, so it gets two chances to be stopped.
  const suggestedPrice = divideMoney(absoluteCosts, divisor);

  const projection = calculatePricing({
    sellingPrice: suggestedPrice,
    supplierProductCost: input.supplierProductCost,
    supplierShippingCost: input.supplierShippingCost,
    // The percentage allowance is resolved against the price that was just solved
    // for, then added to any absolute advertising cost. When no percentage is
    // configured the absolute value passes through untouched, so an omitted
    // advertising cost is still reported as a missing input rather than becoming a
    // spurious zero.
    advertisingCost:
      advertisingPercentage > 0
        ? sumMoney(input.advertisingCost, percentageOf(suggestedPrice, advertisingPercentage))
        : input.advertisingCost,
    taxes: input.taxes,
    otherCosts: input.otherCosts,
    paymentFee: percentageOf(suggestedPrice, paymentFeePercentage),
    shopifyFee: percentageOf(suggestedPrice, shopifyFeePercentage),
  });

  const notes: string[] = [
    'Suggested price is an estimate derived from the costs supplied.',
  ];
  if (missingInputs.length > 0) {
    notes.push(
      `Not included because no value was supplied: ${missingInputs.join(', ')}.`,
    );
  }

  return {
    suggestedPrice,
    absoluteCosts,
    // A percentage, not money - rounded for display only.
    percentageCosts: roundMoney(percentageCosts, 'percentageCosts'),
    desiredMarginPercentage: input.desiredMarginPercentage,
    projection,
    isEstimate: true,
    missingInputs,
    notes,
  };
}


/**
 * Checks a priced result against the two commercial floors, returning a readable
 * description of each breach. Empty means the price is acceptable.
 *
 * WHY BOTH FLOORS
 * ---------------
 * They catch different failures and neither subsumes the other. A percentage floor
 * misses a thin absolute contribution on a cheap item - 15% of 3.00 is 45p, which
 * does not cover one support email or one return. An absolute floor misses a poor
 * percentage on an expensive one. Whichever binds harder wins.
 *
 * A NULL FIGURE CLEARS THE FLOOR
 * ------------------------------
 * profitMarginPercentage is null when the selling price is zero, and an incomputable
 * margin is not evidence of a loss. Refusing on it would block pricing for a reason
 * nobody could act on, so it passes and the caller's own missing-input reporting is
 * what surfaces the gap.
 *
 * Lives here rather than in either caller because automation (repricing an existing
 * variant) and the recommendation engine (pricing a new candidate) must apply the
 * same floors with the same wording. Two implementations of the same two checks is
 * how a price that automation would refuse gets recommended in Research.
 */
export function pricingGuardBreaches(
  result: PricingResult,
  minimumMarginPercentage: number,
  minimumProfitAmount: number,
): string[] {
  const breaches: string[] = [];

  if (
    result.profitMarginPercentage !== null &&
    result.profitMarginPercentage < minimumMarginPercentage
  ) {
    breaches.push(
      `yields ${result.profitMarginPercentage.toFixed(2)}% margin, below the ${minimumMarginPercentage}% floor`,
    );
  }

  // Gated on > 0 because 0 means the absolute floor is disabled - every price clears
  // a floor of zero, so checking it would only ever add noise.
  if (minimumProfitAmount > 0 && result.grossProfit < minimumProfitAmount) {
    breaches.push(
      `yields only ${result.grossProfit.toFixed(2)} contribution per unit, below the ${minimumProfitAmount.toFixed(2)} minimum`,
    );
  }

  return breaches;
}
