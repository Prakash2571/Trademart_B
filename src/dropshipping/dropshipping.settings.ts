/**
 * Validating and merging dropshipping settings.
 *
 * Pure, so the rules can be tested without a database - and they need testing, because
 * these numbers decide which orders get flagged, what a margin means, and what price
 * Research recommends. A settings screen that silently accepts nonsense produces figures
 * nobody can reconcile.
 *
 * WHY A PATCH RATHER THAN A WHOLE OBJECT
 * -------------------------------------
 * An operator editing the payment fee should not have to resend the SLA. A partial patch
 * also means an absent field is distinguishable from a field set to 0, which matters
 * here: minimumProfitAmount 0 DISABLES the absolute floor, and if absence and zero were
 * the same thing an operator could never turn it off.
 */

import type { PricingPolicy } from '../pricing/recommendation';
import { validatePricingPolicy } from '../pricing/recommendation';
import { pricingPolicyFrom } from './dropshipping.pricing';
import {
  DEFAULT_DROPSHIP_COST_CONFIG,
  DEFAULT_SHIPPING_SLA,
  type DropshipCostConfig,
  type ShippingSla,
} from './dropshipping.types';

/**
 * Everything an operator can configure, plus the pricing overrides Research uses.
 *
 * `pricing` is a PARTIAL policy, not a whole one, because most of a pricing policy is
 * already implied by `cost` - the fees and the floors come from there. Storing a full
 * copy would create a second place for the minimum margin to live, and the two would
 * disagree within a week.
 */
export interface DropshipSettingsRecord {
  cost: DropshipCostConfig;
  sla: ShippingSla;
  /** Overrides on top of what `cost` implies. Empty by default. */
  pricing: Partial<PricingPolicy>;
}

export interface DropshipSettingsPatch {
  cost?: Partial<DropshipCostConfig>;
  sla?: Partial<ShippingSla>;
  pricing?: Partial<PricingPolicy> | null;
}

export const DEFAULT_DROPSHIP_SETTINGS: Readonly<DropshipSettingsRecord> = Object.freeze({
  cost: DEFAULT_DROPSHIP_COST_CONFIG,
  sla: DEFAULT_SHIPPING_SLA,
  pricing: Object.freeze({}),
});

/* ===========================================================================
 * Merging
 * ======================================================================== */

/** Strips null and undefined so a partial body cannot erase a default with nothing. */
function supplied<T extends object>(patch: Partial<T> | null | undefined): Partial<T> {
  if (patch === undefined || patch === null) return {};
  return Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined && value !== null),
  ) as Partial<T>;
}

/**
 * Applies a patch to a settings record.
 *
 * `pricing: null` is the one place an explicit null MEANS something - it clears every
 * override and returns to what `cost` implies. Distinguished from an absent `pricing`,
 * which leaves the existing overrides alone.
 */
export function mergeDropshipSettings(
  base: DropshipSettingsRecord,
  patch: DropshipSettingsPatch,
): DropshipSettingsRecord {
  return {
    cost: { ...base.cost, ...supplied(patch.cost) },
    sla: { ...base.sla, ...supplied(patch.sla) },
    pricing:
      patch.pricing === null
        ? {}
        : patch.pricing === undefined
          ? { ...base.pricing }
          : { ...base.pricing, ...supplied(patch.pricing) },
  };
}

/* ===========================================================================
 * Validation
 * ======================================================================== */

const PERCENTAGE_FIELDS: readonly (keyof DropshipCostConfig)[] = Object.freeze([
  'paymentFeePercentage',
  'shopifyFeePercentage',
  'advertisingAllowancePercentage',
  'minimumMarginPercentage',
]);

const BOOLEAN_FIELDS: readonly (keyof DropshipCostConfig)[] = Object.freeze([
  'includeSupplierShipping',
  'includePaymentFees',
  'includeShopifyFees',
  'includeAdvertisingAllowance',
]);

/**
 * Checks a merged settings record, returning every problem at once.
 *
 * Reports all of them rather than throwing on the first, matching how automation rules
 * and pricing policies are validated: a form should show its errors together, not one
 * per submit.
 */
export function validateDropshipSettings(record: DropshipSettingsRecord): string[] {
  const problems: string[] = [];

  for (const field of BOOLEAN_FIELDS) {
    if (typeof record.cost[field] !== 'boolean') {
      problems.push(`${field} must be true or false.`);
    }
  }

  for (const field of PERCENTAGE_FIELDS) {
    const value = record.cost[field];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      problems.push(`${field} must be a number.`);
      continue;
    }
    if (value < 0) problems.push(`${field} cannot be negative.`);
    // 100% of revenue as a single fee is not a fee, it is the whole order.
    if (value >= 100) problems.push(`${field} must be below 100.`);
  }

  for (const field of ['otherCommercialCostPerOrder', 'minimumProfitAmount'] as const) {
    const value = record.cost[field];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      problems.push(`${field} must be a number of at least 0.`);
    }
  }

  // The three percentage costs together, because each can be individually reasonable and
  // the combination still leave nothing to sell for.
  const percentageCosts =
    numberOr(record.cost.paymentFeePercentage) +
    numberOr(record.cost.shopifyFeePercentage) +
    (record.cost.includeAdvertisingAllowance
      ? numberOr(record.cost.advertisingAllowancePercentage)
      : 0);
  if (percentageCosts >= 100) {
    problems.push(
      `Payment, platform and advertising percentages total ${percentageCosts}% of revenue, which leaves nothing for the product itself. No price can satisfy that.`,
    );
  }

  for (const field of ['processingWarningHours', 'trackingWarningHours'] as const) {
    const value = record.sla[field];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      problems.push(`${field} must be a number of hours, at least 0.`);
    }
  }
  if (
    typeof record.sla.deliveryDelayDays !== 'number' ||
    !Number.isFinite(record.sla.deliveryDelayDays) ||
    record.sla.deliveryDelayDays < 0
  ) {
    problems.push('deliveryDelayDays must be a number of days, at least 0.');
  }

  // The pricing overrides are validated through the SAME function the pricing engine
  // uses, against the policy these settings actually produce. Validating the partial
  // alone would miss the interesting failures, which are all about combinations - a
  // target below a floor, or fees plus target reaching 100%.
  if (problems.length === 0) {
    problems.push(...validatePricingPolicy(pricingPolicyFrom(record.cost, record.pricing)));
  }

  return problems;
}

function numberOr(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Warnings that are not errors.
 *
 * A settings screen should say when a valid configuration is likely to mislead. These do
 * not block the save - the operator may know something the software does not - but
 * staying silent about them is how a dashboard ends up reporting margins nobody can
 * explain.
 */
export function describeDropshipSettingsRisks(record: DropshipSettingsRecord): string[] {
  const risks: string[] = [];

  if (!record.cost.includeSupplierShipping) {
    risks.push(
      'Supplier shipping is excluded from cost, so every margin shown is an upper bound. Real contribution is lower by whatever the supplier charges to ship.',
    );
  }
  if (!record.cost.includeAdvertisingAllowance) {
    risks.push(
      'No advertising allowance is deducted, so reported margins assume customers arrive at no acquisition cost. Recommended prices will also not cover paid traffic.',
    );
  }
  if (record.cost.minimumProfitAmount === 0) {
    risks.push(
      'The absolute contribution floor is disabled. A percentage floor alone lets a cheap item pass at a contribution too small to cover one support email - 15% of 3.00 is 45p.',
    );
  }
  if (record.cost.minimumMarginPercentage === 0) {
    risks.push(
      'The minimum margin floor is disabled, so nothing will be flagged as too thin and no recommended price will be refused.',
    );
  }
  if (record.sla.deliveryDelayDays > 0) {
    risks.push(
      `Orders are only called late ${record.sla.deliveryDelayDays} day(s) after the carrier's own estimate. That is Trademart overriding the promise made to the customer at checkout.`,
    );
  }

  return risks;
}
