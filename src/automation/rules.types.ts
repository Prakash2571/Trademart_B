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
 * Defined in pricing/rounding.ts, which is where the implementation now lives -
 * price recommendation rounds prices too, and charm pricing must mean the same thing
 * in both places. Re-exported so importers of this module are unaffected.
 */
export type { PriceRounding } from '../pricing/rounding';

// Imported as well as re-exported: `export ... from` does not bring the name into
// this module's own scope, and PriceRules below uses it.
import type { PriceRounding } from '../pricing/rounding';

/**
 * How a target price is derived from the supplier cost.
 *
 *   margin       - solve for a price achieving `targetMarginPercentage`, fees
 *                  included. Most accurate, least intuitive.
 *   multiplier   - cost x `multiplier` (the classic dropshipping "2.5x rule").
 *   fixed_uplift - cost + `fixedUplift` (a flat amount on every item).
 *
 * All three are then subject to the SAME guardrails: rounding, the
 * minimum-margin floor and the per-run change clamps. A multiplier that fees
 * would eat into gets raised to clear the floor rather than quietly shipping a
 * thinner margin than the merchant thinks they set.
 */
export type PricingMode = 'margin' | 'multiplier' | 'fixed_uplift';

/**
 * Which products automation is allowed to act on — "my desired products".
 *
 *   all    - the whole catalogue.
 *   tagged - only products carrying one of `includeTags`.
 *   vendor - only products from one of `includeVendors` (e.g. "Tradelle").
 *
 * Products OUTSIDE the selection are left completely untouched — never hidden,
 * never repriced. Narrowing the selection can therefore never damage the rest of
 * the catalogue, which is what makes it safe to experiment with.
 */
export type SelectionMode = 'all' | 'tagged' | 'vendor';

/**
 * What to do with a product Trademart has never seen before (a fresh import
 * from a dropshipping app).
 *
 *   leave    - do nothing; whatever status the importing app set stands.
 *   draft    - force it to DRAFT and tag it for review, so nothing reaches the
 *              storefront until a human approves it.
 *   activate - publish it immediately once it has a price and stock.
 */
export type NewProductPolicy = 'leave' | 'draft' | 'activate';

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
  /** How the target price is derived from cost. */
  pricingMode: PricingMode;
  /** Used when pricingMode is 'multiplier'. Price = cost x this. */
  multiplier: number;
  /** Used when pricingMode is 'fixed_uplift'. Price = cost + this. */
  fixedUplift: number;
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
   * Refuse to price a variant whose supplier SHIPPING cost is unknown.
   *
   * Default false, which preserves the existing behaviour: price from the product
   * cost alone and state clearly that the margin is an upper bound. Most stores
   * have no per-variant shipping recorded, so defaulting this on would stop
   * automation pricing anything.
   *
   * Turn it on when margins are thin enough that shipping decides whether an order
   * is profitable - which is most dropshipping. Distinct from requireKnownCost,
   * which is about the PRODUCT cost.
   */
  requireKnownShippingCost: boolean;
  /**
   * Absolute minimum contribution per unit, in the store's currency.
   *
   * A percentage floor alone is not enough: 15% of a 3.00 item is 45p, which does
   * not cover a single support email or one return. This is the "do not bother"
   * threshold, and it is checked in ADDITION to minMarginPercentage - whichever
   * binds harder wins.
   *
   * 0 disables it.
   */
  minimumProfitAmount: number;
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

export interface SelectionRules {
  mode: SelectionMode;
  /** Used when mode is 'tagged'. Matched case-insensitively. */
  includeTags: string[];
  /** Used when mode is 'vendor'. Matched case-insensitively. */
  includeVendors: string[];
  /**
   * How to treat a newly imported product.
   *
   * Defaults to 'draft': a dropshipping app can import hundreds of products at
   * once, and having them appear in the shop unreviewed and unpriced is exactly
   * the surprise this feature exists to prevent.
   */
  newProductPolicy: NewProductPolicy;
}

export interface AutomationRules {
  visibility: VisibilityRules;
  price: PriceRules;
  selection: SelectionRules;
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
 * The tag vocabulary automation reads and writes.
 *
 * Declared above DEFAULT_AUTOMATION_RULES so the defaults can reference them
 * instead of repeating the literals. Two copies of 'trademart:no-automation' is
 * exactly the sort of thing that gets typo'd into a silently-ineffective opt-out.
 */

/** Tag automation applies when it hides a product, so it knows what it owns. */
export const AUTOMATION_HIDDEN_TAG = 'trademart:auto-hidden';

/**
 * Tag applied to a newly imported product that is being held back for review.
 * Distinct from AUTOMATION_HIDDEN_TAG so "never shown yet" is not confused with
 * "was live, then went out of stock".
 */
export const AUTOMATION_REVIEW_TAG = 'trademart:needs-review';

/** The permanent opt-out: automation never touches a product carrying this. */
export const NO_AUTOMATION_TAG = 'trademart:no-automation';

/** A product whose price a human manages by hand. */
export const MANUAL_PRICING_TAG = 'trademart:manual';

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
    pricingMode: 'margin',
    multiplier: 2.5,
    fixedUplift: 10,
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
    // False so this does not change how existing stores behave. Most have no
    // per-variant shipping recorded, and defaulting it on would stop automation
    // pricing anything at all. When shipping is unknown the plan says so, loudly,
    // and states that the margin is an upper bound.
    requireKnownShippingCost: false,
    // 0 = disabled, so behaviour is unchanged until an operator sets a figure.
    // Turning it on by default would need a number, and any number picked here
    // would be wrong for some store's currency and price points.
    minimumProfitAmount: 0,
  },
  selection: {
    mode: 'all',
    includeTags: [],
    includeVendors: [],
    newProductPolicy: 'draft',
  },
  exemptTags: [MANUAL_PRICING_TAG, NO_AUTOMATION_TAG],
  maxItemsPerRun: 50,
};

const PRICING_MODES: readonly PricingMode[] = ['margin', 'multiplier', 'fixed_uplift'];
const SELECTION_MODES: readonly SelectionMode[] = ['all', 'tagged', 'vendor'];

/**
 * Validates a rule set, returning human-readable problems.
 *
 * Pure and returns a list rather than throwing on the first issue, so a bad
 * config can be reported all at once — the same approach as env validation.
 */
export function validateAutomationRules(rules: AutomationRules): string[] {
  const problems: string[] = [];
  const { price, selection } = rules;

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

  if (!PRICING_MODES.includes(price.pricingMode)) {
    problems.push(`pricingMode must be one of ${PRICING_MODES.join(', ')}.`);
  }
  if (price.pricingMode === 'multiplier') {
    if (!Number.isFinite(price.multiplier) || price.multiplier <= 0) {
      problems.push('multiplier must be greater than 0.');
    } else if (price.multiplier < 1) {
      // Below 1x is selling under cost. The margin floor would reject it later,
      // but saying so here is far clearer than a run that skips everything.
      problems.push(
        'multiplier below 1 would price every product under its cost. Use a value of at least 1.',
      );
    }
  }
  if (price.pricingMode === 'fixed_uplift') {
    if (!Number.isFinite(price.fixedUplift) || price.fixedUplift <= 0) {
      problems.push('fixedUplift must be greater than 0.');
    }
  }
  if (price.targetMarginPercentage >= 100) {
    problems.push('targetMarginPercentage must be below 100.');
  }
  if (price.minMarginPercentage >= 100) {
    problems.push('minMarginPercentage must be below 100.');
  }
  // Only meaningful in margin mode; in markup modes the target is derived from
  // cost and the floor is a separate, independent guardrail.
  if (price.pricingMode === 'margin') {
    if (price.minMarginPercentage > price.targetMarginPercentage) {
      problems.push(
        'minMarginPercentage must not exceed targetMarginPercentage - the floor would always beat the target.',
      );
    }
    // The pricing engine cannot solve for a price when margin + percentage fees
    // reach 100%; catching it here is clearer than the engine's throw.
    if (
      price.targetMarginPercentage + price.paymentFeePercentage + price.shopifyFeePercentage >=
      100
    ) {
      problems.push(
        'targetMarginPercentage plus paymentFeePercentage and shopifyFeePercentage must be below 100 - no price can satisfy these inputs.',
      );
    }
  }
  if (price.maxDecreasePercentage > 100) {
    problems.push('maxDecreasePercentage must not exceed 100.');
  }
  if (price.minChangeAmount < 0) {
    problems.push('minChangeAmount must not be negative.');
  }
  if (!Number.isFinite(price.minimumProfitAmount) || price.minimumProfitAmount < 0) {
    problems.push('minimumProfitAmount must be zero or a positive amount (0 disables it).');
  }
  // NOTE: there is deliberately no target-vs-floor check here. It already exists
  // above, correctly scoped to `pricingMode === 'margin'` - in multiplier and
  // fixed_uplift modes targetMarginPercentage is not read at all, so validating it
  // there would reject a configuration that works perfectly well.
  if (!Number.isInteger(rules.maxItemsPerRun) || rules.maxItemsPerRun < 1) {
    problems.push('maxItemsPerRun must be a positive integer.');
  }

  // ---- selection --------------------------------------------------------
  if (!SELECTION_MODES.includes(selection.mode)) {
    problems.push(`selection.mode must be one of ${SELECTION_MODES.join(', ')}.`);
  }
  // An empty include list in a filtering mode would select NOTHING, so every run
  // would silently do nothing. Reject it rather than look broken.
  if (selection.mode === 'tagged' && selection.includeTags.length === 0) {
    problems.push(
      'selection.mode is "tagged" but selection.includeTags is empty, so no product would ever be selected.',
    );
  }
  if (selection.mode === 'vendor' && selection.includeVendors.length === 0) {
    problems.push(
      'selection.mode is "vendor" but selection.includeVendors is empty, so no product would ever be selected.',
    );
  }

  return problems;
}
