/**
 * The store's dropshipping settings, read as pricing settings.
 *
 * WHY AN ADAPTER RATHER THAN A SECOND SETTINGS SCREEN
 * --------------------------------------------------
 * DropshipCostConfig already holds the fee rates, the advertising allowance and the two
 * commercial floors. Research needs exactly those numbers to recommend a price. Giving
 * Research its own copy would mean an operator could set a 15% minimum margin on one
 * screen and 25% on another, and then watch Research recommend a price the dashboard
 * immediately flags as too thin. So there is one set of settings and this maps it.
 *
 * THE ONE PLACE THE TWO GENUINELY DIFFER
 * -------------------------------------
 * `includeAdvertisingAllowance` is a switch in the order view because there it decides
 * whether to DEDUCT a modelled cost from a real order's reported margin - and deducting
 * a cost nobody incurred would understate every margin. Pricing has the mirror-image
 * problem: a price that does not cover acquisition is the most common way a dropshipping
 * product loses money quietly.
 *
 * The switch is honoured rather than overridden. When it is off, the allowance maps to
 * 0 and recommendPrice() warns that the prices assume customers arrive at no acquisition
 * cost. That keeps the two modules consistent and makes the gap visible, which is better
 * than this adapter quietly deciding it knows the operator's advertising budget.
 *
 * Pure: types and arithmetic only.
 */

import {
  DEFAULT_PRICING_POLICY,
  resolvePricingPolicy,
  type PricingPolicy,
} from '../pricing/recommendation';
import { DEFAULT_DROPSHIP_COST_CONFIG, type DropshipCostConfig } from './dropshipping.types';

/**
 * Builds a pricing policy from the store's dropshipping cost settings.
 *
 * `override` is applied last, so a per-candidate or per-request override beats the store
 * default. Null and undefined fields in the override are ignored rather than erasing a
 * default - see resolvePricingPolicy.
 */
export function pricingPolicyFrom(
  cost: DropshipCostConfig = DEFAULT_DROPSHIP_COST_CONFIG,
  override?: Partial<PricingPolicy> | null,
): PricingPolicy {
  const base: PricingPolicy = {
    ...DEFAULT_PRICING_POLICY,

    // Fees are only charged when the operator says they are. An excluded fee is a
    // KNOWN zero by policy, exactly as it is in the order view - not an unknown.
    paymentFeePercentage: cost.includePaymentFees ? cost.paymentFeePercentage : 0,
    shopifyFeePercentage: cost.includeShopifyFees ? cost.shopifyFeePercentage : 0,
    advertisingAllowancePercentage: cost.includeAdvertisingAllowance
      ? cost.advertisingAllowancePercentage
      : 0,
    otherCostPerOrder: cost.otherCommercialCostPerOrder,

    // The floors are the SAME numbers the dashboard alerts on. This is the whole point
    // of the adapter: a recommended price cannot land under the threshold that will
    // flag the resulting orders.
    minimumMarginPercentage: cost.minimumMarginPercentage,
    minimumProfitAmount: cost.minimumProfitAmount,
  };

  // The target must clear the floor, or every recommendation would breach it. Raising
  // the target is the safe direction: it cannot produce a price below the floor, whereas
  // lowering the floor would silently weaken a guard the operator set deliberately.
  if (base.targetMarginPercentage < base.minimumMarginPercentage) {
    base.targetMarginPercentage = Math.min(
      // Leave headroom below 100 so the solver's divisor stays positive.
      95,
      base.minimumMarginPercentage + TARGET_MARGIN_HEADROOM_POINTS,
    );
  }

  return resolvePricingPolicy(base, override);
}

/**
 * How far above the floor a default target sits when the floor is raised past it.
 *
 * Ten points, so the Conservative scenario (target minus ten) lands exactly ON the floor
 * rather than under it. That makes all three scenarios viable by default instead of
 * shipping a Conservative option that always breaches.
 */
const TARGET_MARGIN_HEADROOM_POINTS = 10;
