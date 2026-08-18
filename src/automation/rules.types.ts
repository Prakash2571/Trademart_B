/**
 * Automation rule configuration — "the platform rules".
 *
 * These are the knobs that decide what Trademart shows in the Shopify storefront
 * and what it charges. Everything here is data, not behaviour, so a rule set can
 * be stored, diffed and reviewed before it is ever applied.
 *
 * Design rules that the whole automation layer obeys:
 *
 *  1. NOTHING IS INVENTED. A product whose cost is unknown is never repriced.
 *     The existing pricing engine already refuses to guess (`missingInputs`,
 *     `isEstimate`); automation must not launder a guess into a live price.
 *  2. EVERY DECISION CARRIES ITS REASONS, so a run is auditable after the fact
 *     rather than being a silent mutation of someone's storefront.
 *  3. CHANGES ARE BOUNDED. A bad cost feed must not be able to move a whole
 *     catalogue by an arbitrary amount — see `maxIncreasePercentage` /
 *     `maxDecreasePercentage` and `maxItemsPerRun`.
 *  4. THERE IS ALWAYS AN ESCAPE HATCH. `exemptTags` lets a merchant pin a
 *     product by hand and have automation leave it alone forever.
 */

/**
 * How a computed price is rounded before being written.
 *
 *   none    - exact 2dp value
 *   charm99 - round to the nearest .99 (never below the minimum-margin floor)
 *   integer - whole currency units
 */
export type PriceRounding = 'none' | 'charm99' | 'integer';

/** Where a variant's cost came from. Mirrors SupplierProduct.costSource. */
export type CostSource = 'SHOPIFY_UNIT_COST' | 'MANUAL' | 'SUPPLIER_API' | 'UNKNOWN';

export interface VisibilityRules {
  enabled: boolean;
  /** Out of stock (tracked, quantity <= 0) -> hide from the storefront. */
  hideOutOfStock: boolean;
  /** Back in stock -> show again, but only if automation hid it. */
  restoreWhenBackInStock: boolean;
  /**
   * Hide a product whose margin at its CURRENT price is below
   * `minMarginPercentage`. This is the rule that stops a bad supplier cost from
   * quietly leaving loss-making listings on sale.
   */
  hideBelowMinMargin: boolean;
  /**
   * Hide products with no known cost. Defaults to FALSE on purpose: on a store
   * that has never populated "cost per item" this would hide the entire
   * catalogue on the first run.
   */
  hideUnknownCost: boolean;
}

export interface PriceRules {
  enabled: boolean;
  /** Margin automation aims for, as a percentage of the selling price. */
  targetMarginPercentage: number;
  /** Hard floor. A computed price that breaches this is clamped or skipped. */
  minMarginPercentage: number;
  /** Payment-processor fee as a percentage of the selling price. */
  paymentFeePercentage: number;
  /** Platform fee as a percentage of the selling price. */
  shopifyFeePercentage: number;
  /** Flat per-order costs folded into every price calculation. */
  advertisingCost: number;
  otherCosts: number;
  rounding: PriceRounding;
  /** Maximum single-run price increase, as a percentage of the current price. */
  maxIncreasePercentage: number;
  /** Maximum single-run price decrease, as a percentage of the current price. */
  maxDecreasePercentage: number;
  /**
   * Ignore price differences smaller than this, in currency units. Prevents a
   * pointless write (and a pointless audit row) for a half-penny drift.
   */
  minChangeAmount: number;
  /**
   * Refuse to price a variant whose cost is unknown. Effectively always true;
   * exposed so the refusal is visible in the config rather than implicit.
   */
  requireKnownCost: boolean;
}

export interface AutomationRules {
  visibility: VisibilityRules;
  price: PriceRules;
  /**
   * Products carrying any of these tags are never touched. The merchant's
   * manual override, and the first thing to reach for if a run goes wrong.
   */
  exemptTags: string[];
  /**
   * Hard cap on actions per run. A safety valve: if a rule change would rewrite
   * the whole catalogue, the run stops and says so instead of doing it.
   */
  maxItemsPerRun: number;
}

/**
 * Deliberately cautious defaults.
 *
 * Visibility is on (low risk, reversible) while price writing is OFF, so
 * installing this cannot change a single price until someone opts in.
 */
export const DEFAULT_AUTOMATION_RULES: AutomationRules = {
  visibility: {
    enabled: true,
    hideOutOfStock: true,
    restoreWhenBackInStock: true,
    hideBelowMinMargin: false,
    hideUnknownCost: false,
  },
  price: {
    enabled: false,
    targetMarginPercentage: 30,
    minMarginPercentage: 10,
    paymentFeePercentage: 2.9,
    shopifyFeePercentage: 0,
    advertisingCost: 0,
    otherCosts: 0,
    rounding: 'charm99',
    maxIncreasePercentage: 20,
    maxDecreasePercentage: 20,
    minChangeAmount: 0.05,
    requireKnownCost: true,
  },
  exemptTags: ['trademart:manual', 'trademart:no-automation'],
  maxItemsPerRun: 50,
};

/** Tag automation applies when it hides a product, so it knows what it owns. */
export const AUTOMATION_HIDDEN_TAG = 'trademart:auto-hidden';

/**
 * Validates a rule set, returning human-readable problems.
 *
 * Pure and returns a list rather than throwing on the first issue, so a bad
 * config can be reported all at once — the same approach as env validation.
 */
export function validateAutomationRules(rules: AutomationRules): string[] {
  const problems: string[] = [];
  const { price } = rules;

  const percentages: { value: number; label: string }[] = [
    { value: price.targetMarginPercentage, label: 'targetMarginPercentage' },
    { value: price.minMarginPercentage, label: 'minMarginPercentage' },
    { value: price.paymentFeePercentage, label: 'paymentFeePercentage' },
    { value: price.shopifyFeePercentage, label: 'shopifyFeePercentage' },
    { value: price.maxIncreasePercentage, label: 'maxIncreasePercentage' },
    { value: price.maxDecreasePercentage, label: 'maxDecreasePercentage' },
  ];

  for (const entry of percentages) {
    if (!Number.isFinite(entry.value)) {
      problems.push(`${entry.label} must be a finite number.`);
    } else if (entry.value < 0) {
      problems.push(`${entry.label} must not be negative.`);
    }
  }

  if (price.targetMarginPercentage >= 100) {
    problems.push('targetMarginPercentage must be below 100.');
  }
  if (price.minMarginPercentage >= 100) {
    problems.push('minMarginPercentage must be below 100.');
  }
  if (price.minMarginPercentage > price.targetMarginPercentage) {
    problems.push(
      'minMarginPercentage must not exceed targetMarginPercentage - the floor would always beat the target.',
    );
  }
  // The pricing engine cannot solve for a price when margin + percentage fees
  // reach 100%; catching it here gives a clearer message than the engine's throw.
  if (
    price.targetMarginPercentage + price.paymentFeePercentage + price.shopifyFeePercentage >=
    100
  ) {
    problems.push(
      'targetMarginPercentage plus paymentFeePercentage and shopifyFeePercentage must be below 100 - no price can satisfy these inputs.',
    );
  }
  if (price.maxDecreasePercentage > 100) {
    problems.push('maxDecreasePercentage must not exceed 100.');
  }
  if (price.minChangeAmount < 0) {
    problems.push('minChangeAmount must not be negative.');
  }
  if (!Number.isInteger(rules.maxItemsPerRun) || rules.maxItemsPerRun < 1) {
    problems.push('maxItemsPerRun must be a positive integer.');
  }

  return problems;
}
