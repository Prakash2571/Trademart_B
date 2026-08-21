/**
 * Price recommendation: what should we sell this for?
 *
 * Answers a different question from automation/price.rules.ts. That module decides
 * whether to CHANGE the price of a variant Shopify already has, and is therefore
 * concerned with movement limits, drift filters and not repricing a catalogue wildly.
 * This module prices something that does not exist yet - a research candidate, or a
 * product about to be pushed as a draft - where there is no current price to move
 * from and the operator wants options rather than a single verdict.
 *
 * Both derive the price itself from the same engine (calculateSuggestedPrice) and
 * apply the same floors (pricingGuardBreaches) and the same rounding
 * (pricing/rounding.ts), so a price Research recommends is never one automation would
 * refuse.
 *
 * THREE SCENARIOS, NOT ONE NUMBER
 * -------------------------------
 * Conservative, Balanced and Premium are the same arithmetic at three positions on
 * the operator's own lever - the margin target, or the markup, depending on the
 * configured strategy. They exist because the right price is a commercial judgement
 * that depends on how the product will be sold, and a single recommended figure
 * hides the trade-off being made. All three are shown with their margin and their
 * per-unit contribution so the choice is informed.
 *
 * FLOORS WARN, THEY DO NOT SILENTLY REWRITE
 * -----------------------------------------
 * When a scenario breaches the minimum margin or the minimum contribution it is
 * reported as computed, marked NOT viable, and accompanied by the price that WOULD
 * clear both floors. Quietly substituting the higher price would hide the fact that
 * the operator's conservative position is not available on this product, which is
 * the single most useful thing the calculation found out.
 *
 * Pure: no config singleton, no database, no clock.
 */

import { AppError } from '../common/errors';
import {
  ceilMoney,
  divideMoney,
  multiplyMoney,
  percentageOf,
  resolveSharedCurrency,
  roundMoney,
  sumMoney,
  type CurrencyAmount,
} from '../common/money';
import {
  calculatePricing,
  calculateSuggestedPrice,
  pricingGuardBreaches,
  type PricingBreakdownEntry,
  type PricingResult,
} from './pricing.service';
import { applyRounding, roundingStep, type PriceRounding } from './rounding';

/* ===========================================================================
 * Policy
 * ======================================================================== */

/**
 * How the target price is derived from cost.
 *
 *   TARGET_MARGIN      solve for the price that yields a margin, fees included.
 *                      The correct default: it is the only mode that accounts for
 *                      percentage costs.
 *   MARKUP_MULTIPLIER  the classic dropshipping "cost x N". Popular, and blind to
 *                      fees - a 2.5x markup is not a 60% margin once payment
 *                      processing and acquisition are paid for.
 *   FIXED_UPLIFT       cost + a flat amount. Suits a catalogue with a consistent
 *                      handling cost and little price variation.
 */
export type PricingStrategy = 'TARGET_MARGIN' | 'MARKUP_MULTIPLIER' | 'FIXED_UPLIFT';

export type PricingScenarioName = 'CONSERVATIVE' | 'BALANCED' | 'PREMIUM';

/**
 * The pricing settings an operator configures once and overrides per product.
 *
 * Percentages are of the SELLING PRICE throughout, matching the order view - so a
 * recommended price and a reported margin describe the same thing. Mixing "percentage
 * of cost" and "percentage of price" in one settings screen is a reliable way to
 * produce a number nobody can reconcile.
 */
export interface PricingPolicy {
  strategy: PricingStrategy;
  /** Used when strategy is TARGET_MARGIN. Percentage of the selling price. */
  targetMarginPercentage: number;
  /** Used when strategy is MARKUP_MULTIPLIER. Price = landed cost x this. */
  markupMultiplier: number;
  /** Used when strategy is FIXED_UPLIFT. Price = landed cost + this. */
  fixedUplift: number;
  /** Payment-processor fee, as a percentage of the selling price. */
  paymentFeePercentage: number;
  /** Platform fee, as a percentage of the selling price. */
  shopifyFeePercentage: number;
  /**
   * Acquisition allowance, as a percentage of the selling price.
   *
   * 0 means no acquisition cost is priced in, which the recommendation warns about
   * rather than assuming a number. Defaults to 0 to match the order view, where the
   * advertising allowance is off by default - the two must agree, or Research and the
   * dashboard will report different margins for the same product.
   */
  advertisingAllowancePercentage: number;
  /** Flat per-order cost (packaging, support, subscriptions). */
  otherCostPerOrder: number;
  /** Hard floor: margin as a percentage of the selling price. */
  minimumMarginPercentage: number;
  /** Hard floor: absolute contribution per unit. 0 disables it. */
  minimumProfitAmount: number;
  rounding: PriceRounding;
}

/**
 * Defaults chosen to agree with DEFAULT_DROPSHIP_COST_CONFIG in the order view.
 *
 * The floors are the same numbers deliberately: a price that Research recommends
 * must not immediately appear under "Needs attention" on the dashboard because the
 * two modules disagreed about what a thin margin is.
 */
export const DEFAULT_PRICING_POLICY: Readonly<PricingPolicy> = Object.freeze({
  strategy: 'TARGET_MARGIN',
  // A common dropshipping target: high enough to fund acquisition and absorb a
  // return, low enough to be reachable on most supplier costs.
  targetMarginPercentage: 45,
  markupMultiplier: 2.5,
  fixedUplift: 10,
  paymentFeePercentage: 2.9,
  shopifyFeePercentage: 0,
  advertisingAllowancePercentage: 0,
  otherCostPerOrder: 0,
  minimumMarginPercentage: 15,
  minimumProfitAmount: 0,
  rounding: 'charm99',
});

/**
 * Validates a policy, returning every problem rather than throwing on the first.
 *
 * Matches how automation rules and scoring weights are validated: a settings form
 * should report all of its errors at once.
 */
export function validatePricingPolicy(policy: PricingPolicy): string[] {
  const problems: string[] = [];

  const finiteNonNegative: [keyof PricingPolicy, string][] = [
    ['paymentFeePercentage', 'Payment fee percentage'],
    ['shopifyFeePercentage', 'Platform fee percentage'],
    ['advertisingAllowancePercentage', 'Advertising allowance percentage'],
    ['otherCostPerOrder', 'Other cost per order'],
    ['minimumMarginPercentage', 'Minimum margin percentage'],
    ['minimumProfitAmount', 'Minimum profit amount'],
    ['fixedUplift', 'Fixed uplift'],
  ];
  for (const [key, label] of finiteNonNegative) {
    const value = policy[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      problems.push(`${label} must be a number of at least 0.`);
    }
  }

  if (
    !Number.isFinite(policy.targetMarginPercentage) ||
    policy.targetMarginPercentage < 0 ||
    policy.targetMarginPercentage >= 100
  ) {
    problems.push('Target margin percentage must be at least 0 and below 100.');
  }

  if (
    !Number.isFinite(policy.minimumMarginPercentage) ||
    policy.minimumMarginPercentage >= 100
  ) {
    problems.push('Minimum margin percentage must be below 100.');
  }

  if (!Number.isFinite(policy.markupMultiplier) || policy.markupMultiplier <= 1) {
    // At or below 1x the price does not cover the goods, never mind the fees.
    problems.push('Markup multiplier must be greater than 1.');
  }

  if (
    Number.isFinite(policy.targetMarginPercentage) &&
    Number.isFinite(policy.minimumMarginPercentage) &&
    policy.targetMarginPercentage < policy.minimumMarginPercentage
  ) {
    problems.push(
      `Target margin (${policy.targetMarginPercentage}%) is below the minimum margin floor (${policy.minimumMarginPercentage}%), so every recommendation would breach the floor. Raise the target or lower the floor.`,
    );
  }

  const percentageCosts =
    (policy.paymentFeePercentage || 0) +
    (policy.shopifyFeePercentage || 0) +
    (policy.advertisingAllowancePercentage || 0);
  if (percentageCosts + policy.targetMarginPercentage >= 100) {
    problems.push(
      `Percentage costs (${percentageCosts}%) plus the target margin (${policy.targetMarginPercentage}%) reach or exceed 100%. No selling price can satisfy that.`,
    );
  }

  return problems;
}

/**
 * Applies a per-product override on top of the store's settings.
 *
 * Overrides are a partial: an absent field means "use the store default", which is
 * different from a field set to 0. That distinction matters for the floors, where 0
 * legitimately means "disabled" and would otherwise be indistinguishable from "not
 * overridden".
 */
export function resolvePricingPolicy(
  base: PricingPolicy = DEFAULT_PRICING_POLICY,
  override?: Partial<PricingPolicy> | null,
): PricingPolicy {
  if (override === undefined || override === null) return { ...base };

  // Null and undefined are stripped BEFORE the spread. Spreading the override
  // directly would let an explicit null overwrite a real default with nothing, which
  // is how a JSON body containing `"rounding": null` would silently disable rounding.
  const supplied = Object.fromEntries(
    Object.entries(override).filter(([, value]) => value !== undefined && value !== null),
  ) as Partial<PricingPolicy>;

  return { ...base, ...supplied };
}

/* ===========================================================================
 * Scenarios
 * ======================================================================== */

interface ScenarioPlan {
  label: string;
  /** Why an operator would choose this position. */
  intent: string;
  /** Percentage points added to the target margin. */
  marginPoints: number;
  /** Added to the markup multiplier. */
  multiplierDelta: number;
  /** Multiplies the fixed uplift. */
  upliftFactor: number;
}

/**
 * The three positions, in presentation order.
 *
 * The offsets are deliberately blunt round numbers rather than a tuned curve: their
 * job is to bracket the configured target with something an operator can reason
 * about, and "ten points either side of your target" is arguable in a way that a
 * fitted coefficient is not.
 *
 * Premium moves further up (+12) than Conservative moves down (-10) because the
 * downside is bounded by the margin floor anyway, whereas the upside is bounded only
 * by what customers will pay - which is the thing worth testing.
 */
const SCENARIO_PLANS: Readonly<Record<PricingScenarioName, ScenarioPlan>> = Object.freeze({
  CONSERVATIVE: Object.freeze({
    label: 'Conservative',
    intent:
      'Priced to compete on price and convert at a higher rate, accepting a thinner margin per order. Choose this when the market is crowded or the product is a commodity.',
    marginPoints: -10,
    multiplierDelta: -0.4,
    upliftFactor: 0.75,
  }),
  BALANCED: Object.freeze({
    label: 'Balanced',
    intent:
      'The configured target. Choose this unless there is a specific reason about this product or this market to move off it.',
    marginPoints: 0,
    multiplierDelta: 0,
    upliftFactor: 1,
  }),
  PREMIUM: Object.freeze({
    label: 'Premium',
    intent:
      'Priced for margin over volume, on the assumption the product can be differentiated. Choose this when the product is unusual, bundled, or sold on a story rather than a price comparison.',
    marginPoints: 12,
    multiplierDelta: 0.6,
    upliftFactor: 1.35,
  }),
});

export const SCENARIO_ORDER: readonly PricingScenarioName[] = Object.freeze([
  'CONSERVATIVE',
  'BALANCED',
  'PREMIUM',
]);

export interface PricingScenario {
  name: PricingScenarioName;
  label: string;
  intent: string;
  /** The recommended price, after rounding. */
  price: number;
  /** Margin as a percentage of the price. Null only when the price is zero. */
  marginPercentage: number | null;
  /** Absolute contribution per unit at this price. */
  contribution: number;
  /** Contribution as a percentage of cost - the markup equivalent. */
  returnOnCostPercentage: number | null;
  /** False when a floor is breached. The scenario is still reported. */
  viable: boolean;
  /** Readable descriptions of each floor breach. Empty when viable. */
  guardBreaches: string[];
  /**
   * The lowest price that clears BOTH floors, after rounding.
   *
   * Present even for viable scenarios, so the operator can see how much headroom
   * there is before a discount becomes unprofitable.
   */
  minimumViablePrice: number | null;
  reasons: string[];
  breakdown: PricingBreakdownEntry[];
}

/* ===========================================================================
 * Input and output
 * ======================================================================== */

export interface PriceRecommendationInput {
  /** Supplier product cost per unit. Null means unknown - nothing is priced. */
  supplierCost: number | null;
  supplierCurrency: string | null;
  /** Supplier shipping per unit. Null means unrecorded, NOT free. */
  shippingCost: number | null;
  shippingCurrency: string | null;
  /** The currency the product will be sold in. */
  sellingCurrency: string | null;
  policy?: PricingPolicy;
  /** Per-product override of the policy. */
  policyOverride?: Partial<PricingPolicy> | null;
}

export interface PriceRecommendation {
  currencyCode: string | null;
  /**
   * Supplier product cost + supplier shipping. The money owed to the supplier, and
   * the basis every scenario is priced from. Null when nothing can be priced.
   *
   * Named landed cost to match the order view. It is NOT the commercial cost - fees
   * and the acquisition allowance are percentages of the price and so are resolved
   * per scenario, not folded in here.
   */
  landedCost: number | null;
  /** False when supplier shipping was not recorded and is therefore excluded. */
  shippingIncluded: boolean;
  /** The policy actually used, after overrides. Echoed so a price is reproducible. */
  policy: PricingPolicy;
  scenarios: PricingScenario[];
  /** The scenario to lead with, or null when none is viable. */
  recommended: PricingScenarioName | null;
  /** Set when no price could be computed at all. Scenarios is then empty. */
  blockedReason: string | null;
  warnings: string[];
  notes: string[];
}

/* ===========================================================================
 * Entry point
 * ======================================================================== */

export function recommendPrice(input: PriceRecommendationInput): PriceRecommendation {
  const policy = resolvePricingPolicy(input.policy ?? DEFAULT_PRICING_POLICY, input.policyOverride);

  const blocked = (reason: string): PriceRecommendation => ({
    currencyCode: input.sellingCurrency,
    landedCost: null,
    shippingIncluded: false,
    policy,
    scenarios: [],
    recommended: null,
    blockedReason: reason,
    warnings: [reason],
    notes: [],
  });

  const problems = validatePricingPolicy(policy);
  if (problems.length > 0) {
    // Refused rather than corrected. A price computed from settings the operator
    // cannot see in the form would not be reproducible, and an unreproducible price
    // is not a recommendation - it is a guess with a decimal point.
    return blocked(`These pricing settings cannot produce a price: ${problems.join(' ')}`);
  }

  // ---- currency ------------------------------------------------------------
  //
  // Checked before any arithmetic. Adding a USD supplier cost to a GBP shipping cost
  // produces a number with no meaning, and a meaningless cost produces a confident
  // wrong price.
  const entries: CurrencyAmount[] = [
    { amount: input.supplierCost, currencyCode: input.supplierCurrency, label: 'supplier cost' },
    { amount: input.shippingCost, currencyCode: input.shippingCurrency, label: 'supplier shipping' },
  ];
  const shared = resolveSharedCurrency(entries);
  if (shared.conflicts.length > 0) {
    return blocked(
      `CURRENCY_MISMATCH: ${shared.conflicts.join('; ')}. No exchange rate is configured, so no price has been calculated - a converted guess would be worse than no answer.`,
    );
  }

  const costCurrency = shared.currencyCode;
  const sellingCurrency = input.sellingCurrency?.trim().toUpperCase() ?? null;
  if (costCurrency !== null && sellingCurrency !== null && costCurrency !== sellingCurrency) {
    return blocked(
      `CURRENCY_MISMATCH: costs are in ${costCurrency} but the product would sell in ${sellingCurrency}, and no exchange rate is configured. Record the cost in the selling currency to price this product.`,
    );
  }

  // ---- cost ----------------------------------------------------------------
  if (input.supplierCost === null) {
    return blocked(
      'No supplier cost is recorded, so no price can be recommended. An unknown cost is not a zero cost - pricing from one would produce a flattering margin and a loss-making product.',
    );
  }
  if (!Number.isFinite(input.supplierCost) || input.supplierCost < 0) {
    return blocked(`The recorded supplier cost (${String(input.supplierCost)}) is not a usable amount.`);
  }

  const shippingIncluded = input.shippingCost !== null && Number.isFinite(input.shippingCost);
  // sumMoney SKIPS null rather than coercing it, so an unrecorded shipping cost does
  // not silently become free shipping - it is excluded, and said so below.
  const landedCost = shippingIncluded
    ? sumMoney(input.supplierCost, input.shippingCost)
    : roundMoney(input.supplierCost);

  const currencyCode = sellingCurrency ?? costCurrency;

  const warnings: string[] = [];
  const notes: string[] = [
    shippingIncluded
      ? `Priced from a landed cost of ${landedCost.toFixed(2)}${currencyCode === null ? '' : ` ${currencyCode}`} (supplier product cost + supplier shipping).`
      : `Priced from the supplier product cost of ${landedCost.toFixed(2)}${currencyCode === null ? '' : ` ${currencyCode}`} alone.`,
  ];

  if (!shippingIncluded) {
    warnings.push(
      'Supplier shipping is not recorded, so it is EXCLUDED - not zero. Every margin below is therefore an upper bound, and the real margin is lower by whatever the supplier charges to ship.',
    );
  }
  if (policy.advertisingAllowancePercentage === 0) {
    warnings.push(
      'No advertising allowance is configured, so these prices assume customers arrive at no acquisition cost. If any of this product\u2019s traffic is paid for, the real contribution is lower than shown - set an allowance in the pricing settings.',
    );
  }

  notes.push(
    policy.strategy === 'TARGET_MARGIN'
      ? `Each scenario solves for the price that achieves its margin AFTER percentage costs (${describePercentageCosts(policy)}).`
      : `Each scenario applies a ${policy.strategy === 'MARKUP_MULTIPLIER' ? 'markup to' : 'flat uplift on'} the cost, then the resulting margin is reported after percentage costs (${describePercentageCosts(policy)}). A markup is not a margin - the reported figure is what actually remains.`,
  );
  notes.push('Returns, refunds, chargebacks and currency conversion are not included.');

  // ---- scenarios -----------------------------------------------------------
  const minimumViablePrice = computeMinimumViablePrice(landedCost, input.shippingCost, input.supplierCost, policy);

  const scenarios: PricingScenario[] = [];
  for (const name of SCENARIO_ORDER) {
    const scenario = buildScenario(
      name,
      landedCost,
      input.supplierCost,
      input.shippingCost,
      policy,
      minimumViablePrice,
    );
    if (scenario !== null) scenarios.push(scenario);
  }

  if (scenarios.length === 0) {
    return blocked(
      'None of the pricing scenarios could be computed from these costs and settings.',
    );
  }

  const breaching = scenarios.filter((scenario) => !scenario.viable);
  if (breaching.length > 0) {
    warnings.push(
      `${breaching.map((scenario) => scenario.label).join(' and ')} ${breaching.length === 1 ? 'breaches' : 'breach'} your floors and ${breaching.length === 1 ? 'is' : 'are'} shown for comparison only. ${minimumViablePrice === null ? '' : `The lowest price that clears both floors is ${minimumViablePrice.toFixed(2)}.`}`.trim(),
    );
  }

  return {
    currencyCode,
    landedCost,
    shippingIncluded,
    policy,
    scenarios,
    recommended: chooseRecommended(scenarios),
    blockedReason: null,
    warnings,
    notes,
  };
}

/* ===========================================================================
 * Scenario construction
 * ======================================================================== */

function buildScenario(
  name: PricingScenarioName,
  landedCost: number,
  supplierCost: number,
  shippingCost: number | null,
  policy: PricingPolicy,
  minimumViablePrice: number | null,
): PricingScenario | null {
  const plan = SCENARIO_PLANS[name];
  const reasons: string[] = [];

  let target: number;
  if (policy.strategy === 'MARKUP_MULTIPLIER') {
    const multiplier = Math.max(1.01, roundTo2(policy.markupMultiplier + plan.multiplierDelta));
    target = multiplyMoney(landedCost, multiplier);
    reasons.push(
      `Cost ${landedCost.toFixed(2)} x ${multiplier} = ${target.toFixed(2)}. A markup is not a margin: the margin below is what remains after fees.`,
    );
  } else if (policy.strategy === 'FIXED_UPLIFT') {
    const uplift = roundMoney(policy.fixedUplift * plan.upliftFactor);
    target = sumMoney(landedCost, uplift);
    reasons.push(`Cost ${landedCost.toFixed(2)} + ${uplift.toFixed(2)} uplift = ${target.toFixed(2)}.`);
  } else {
    // Clamped to the floor at the bottom and below 100 at the top. A Conservative
    // scenario 10 points under a 12% target would otherwise ask for 2%, which is not
    // a conservative price - it is a broken one.
    const requested = policy.targetMarginPercentage + plan.marginPoints;
    const margin = clampMargin(requested, policy);
    if (margin !== requested) {
      reasons.push(
        `Requested margin ${requested.toFixed(1)}% adjusted to ${margin.toFixed(1)}%: ${requested < margin ? `it was below your ${policy.minimumMarginPercentage}% floor` : 'it left no room for percentage costs'}.`,
      );
    }

    let suggested;
    try {
      suggested = calculateSuggestedPrice({
        desiredMarginPercentage: margin,
        supplierProductCost: supplierCost,
        supplierShippingCost: shippingCost ?? undefined,
        // A configured 0 is passed as 0, not omitted: a flat cost the operator has
        // set to nothing is a KNOWN zero, not a missing input.
        otherCosts: policy.otherCostPerOrder,
        paymentFeePercentage: policy.paymentFeePercentage,
        shopifyFeePercentage: policy.shopifyFeePercentage,
        advertisingPercentage: policy.advertisingAllowancePercentage,
      });
    } catch (error) {
      // The engine refuses impossible inputs. Its message is more specific than
      // anything invented here, so it is surfaced rather than replaced.
      if (error instanceof AppError) return null;
      throw error;
    }
    target = suggested.suggestedPrice;
    reasons.push(
      `Solved for a ${margin.toFixed(1)}% margin on a ${landedCost.toFixed(2)} cost, after ${describePercentageCosts(policy)}: ${target.toFixed(2)}.`,
    );
  }

  const price = applyRounding(target, policy.rounding);
  if (price !== roundMoney(target)) {
    reasons.push(`Rounded to ${price.toFixed(2)} (${policy.rounding}).`);
  }

  const result = evaluateAt(price, supplierCost, shippingCost, policy);
  const guardBreaches = pricingGuardBreaches(
    result,
    policy.minimumMarginPercentage,
    policy.minimumProfitAmount,
  );

  if (guardBreaches.length > 0) {
    reasons.push(
      `NOT viable at this price: it ${guardBreaches.join(' and it ')}. Shown as computed rather than quietly raised, because a floor your target cannot clear is something to know.`,
    );
  }

  return {
    name,
    label: plan.label,
    intent: plan.intent,
    price,
    marginPercentage: result.profitMarginPercentage,
    contribution: result.grossProfit,
    returnOnCostPercentage: result.returnOnCostPercentage,
    viable: guardBreaches.length === 0,
    guardBreaches,
    minimumViablePrice,
    reasons,
    breakdown: result.breakdown,
  };
}

/** Prices a candidate at a specific price, with every percentage cost resolved. */
function evaluateAt(
  price: number,
  supplierCost: number,
  shippingCost: number | null,
  policy: PricingPolicy,
): PricingResult {
  return calculatePricing({
    sellingPrice: price,
    supplierProductCost: supplierCost,
    // undefined, not 0, when unrecorded: calculatePricing then reports it in
    // missingInputs and flags the result an estimate, instead of asserting free
    // shipping.
    supplierShippingCost: shippingCost ?? undefined,
    paymentFee: percentageOf(price, policy.paymentFeePercentage),
    shopifyFee: percentageOf(price, policy.shopifyFeePercentage),
    advertisingCost: percentageOf(price, policy.advertisingAllowancePercentage),
    otherCosts: policy.otherCostPerOrder,
  });
}

/**
 * The lowest price that clears BOTH floors, with rounding applied.
 *
 * Solved rather than searched from zero: the margin floor has a closed form (the same
 * one calculateSuggestedPrice uses), and so does the contribution floor -
 *
 *   price x (1 - percentageCosts/100) - absoluteCosts = minimumProfit
 *
 * The higher of the two binds. Rounding is applied afterwards and can push the price
 * back under, so the result is stepped up until it clears; charm pricing rounds DOWN
 * by design, which is exactly the case that needs it.
 */
function computeMinimumViablePrice(
  landedCost: number,
  shippingCost: number | null,
  supplierCost: number,
  policy: PricingPolicy,
): number | null {
  const percentageCosts =
    policy.paymentFeePercentage +
    policy.shopifyFeePercentage +
    policy.advertisingAllowancePercentage;
  const divisor = 1 - percentageCosts / 100;
  if (divisor <= 0) return null;

  const absoluteCosts = sumMoney(landedCost, policy.otherCostPerOrder);

  const candidates: number[] = [];

  if (policy.minimumMarginPercentage > 0) {
    try {
      candidates.push(
        calculateSuggestedPrice({
          desiredMarginPercentage: policy.minimumMarginPercentage,
          supplierProductCost: supplierCost,
          supplierShippingCost: shippingCost ?? undefined,
          otherCosts: policy.otherCostPerOrder,
          paymentFeePercentage: policy.paymentFeePercentage,
          shopifyFeePercentage: policy.shopifyFeePercentage,
          advertisingPercentage: policy.advertisingAllowancePercentage,
        }).suggestedPrice,
      );
    } catch {
      // An unsatisfiable floor leaves the other candidate to answer.
    }
  }

  if (policy.minimumProfitAmount > 0) {
    candidates.push(divideMoney(sumMoney(absoluteCosts, policy.minimumProfitAmount), divisor));
  }

  if (candidates.length === 0) {
    // Both floors disabled. Any price above cost clears them, so there is no
    // meaningful minimum to report - null rather than a made-up figure.
    return null;
  }

  // ceilMoney, not roundMoney: this is a floor to clear, and 16.404 rounded to 16.40
  // is a penny short of the margin it was derived from.
  let price = applyRounding(ceilMoney(Math.max(...candidates)), policy.rounding);

  const step = roundingStep(policy.rounding);
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const breaches = pricingGuardBreaches(
      evaluateAt(price, supplierCost, shippingCost, policy),
      policy.minimumMarginPercentage,
      policy.minimumProfitAmount,
    );
    if (breaches.length === 0) return price;
    price = roundMoney(price + step);
  }
  // Unreachable for any sane policy; returning null beats returning a price that
  // does not actually clear the floor it claims to.
  return null;
}

/**
 * Which scenario to lead with.
 *
 * Balanced when it is viable, because it is the operator's own configured target and
 * this function's job is not to second-guess it. Otherwise the CHEAPEST viable
 * scenario - the floors are breached by prices being too low, so the viable options
 * are the dearer ones, and the cheapest of those is the smallest departure from the
 * intent the operator expressed. Null when none is viable, which is a real answer:
 * this product cannot be priced acceptably on these costs.
 */
function chooseRecommended(scenarios: PricingScenario[]): PricingScenarioName | null {
  const viable = scenarios.filter((scenario) => scenario.viable);
  if (viable.length === 0) return null;

  const balanced = viable.find((scenario) => scenario.name === 'BALANCED');
  if (balanced !== undefined) return balanced.name;

  return viable.reduce((cheapest, scenario) =>
    scenario.price < cheapest.price ? scenario : cheapest,
  ).name;
}

/* ===========================================================================
 * Small helpers
 * ======================================================================== */

function describePercentageCosts(policy: PricingPolicy): string {
  const parts = [
    policy.paymentFeePercentage > 0 ? `${policy.paymentFeePercentage}% payment fees` : null,
    policy.shopifyFeePercentage > 0 ? `${policy.shopifyFeePercentage}% platform fees` : null,
    policy.advertisingAllowancePercentage > 0
      ? `${policy.advertisingAllowancePercentage}% advertising allowance`
      : null,
  ].filter((part): part is string => part !== null);

  return parts.length === 0 ? 'no percentage costs' : parts.join(' + ');
}

/** Keeps a scenario's margin inside what the policy and arithmetic allow. */
function clampMargin(requested: number, policy: PricingPolicy): number {
  const percentageCosts =
    policy.paymentFeePercentage +
    policy.shopifyFeePercentage +
    policy.advertisingAllowancePercentage;
  // Leave a point of headroom below 100 so the solver's divisor stays positive.
  const ceiling = Math.max(0, 99 - percentageCosts);
  return roundTo2(Math.min(ceiling, Math.max(policy.minimumMarginPercentage, requested)));
}

/**
 * 2dp rounding for a PERCENTAGE or a multiplier.
 *
 * Not roundMoney: these are ratios, not amounts, and pushing them through minor units
 * would imply they take part in money arithmetic.
 */
function roundTo2(value: number): number {
  return Math.round(value * 100) / 100;
}
