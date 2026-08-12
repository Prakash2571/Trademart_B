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

/** Rounds to 2 dp without accumulating float noise. */
export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

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
  let totalCost = 0;

  for (const field of COST_FIELDS) {
    const raw = input[field.key];
    const provided = raw !== undefined && raw !== null;
    if (provided) {
      assertNonNegative(raw as number, field.key);
    }
    const amount = provided ? (raw as number) : 0;
    totalCost += amount;
    breakdown.push({
      key: field.key,
      label: field.label,
      amount: round2(amount),
      provided,
    });
    if (!provided) missingInputs.push(field.key);
  }

  totalCost = round2(totalCost);
  const sellingPrice = round2(input.sellingPrice);
  const grossProfit = round2(sellingPrice - totalCost);

  const profitMarginPercentage =
    sellingPrice > 0 ? round2((grossProfit / sellingPrice) * 100) : null;
  const returnOnCostPercentage =
    totalCost > 0 ? round2((grossProfit / totalCost) * 100) : null;

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
  let absoluteCosts = 0;
  for (const field of absoluteFields) {
    const raw = input[field.key] as number | undefined;
    if (raw === undefined || raw === null) {
      missingInputs.push(field.key as string);
      continue;
    }
    assertNonNegative(raw, field.key as string);
    absoluteCosts += raw;
  }

  const paymentFeePercentage = input.paymentFeePercentage ?? 0;
  const shopifyFeePercentage = input.shopifyFeePercentage ?? 0;
  assertNonNegative(paymentFeePercentage, 'paymentFeePercentage');
  assertNonNegative(shopifyFeePercentage, 'shopifyFeePercentage');
  const percentageCosts = paymentFeePercentage + shopifyFeePercentage;

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

  const suggestedPrice = round2(absoluteCosts / divisor);

  const projection = calculatePricing({
    sellingPrice: suggestedPrice,
    supplierProductCost: input.supplierProductCost,
    supplierShippingCost: input.supplierShippingCost,
    advertisingCost: input.advertisingCost,
    taxes: input.taxes,
    otherCosts: input.otherCosts,
    paymentFee: round2((suggestedPrice * paymentFeePercentage) / 100),
    shopifyFee: round2((suggestedPrice * shopifyFeePercentage) / 100),
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
    absoluteCosts: round2(absoluteCosts),
    percentageCosts: round2(percentageCosts),
    desiredMarginPercentage: input.desiredMarginPercentage,
    projection,
    isEstimate: true,
    missingInputs,
    notes,
  };
}
