/**
 * Cost-source resolution.
 *
 * A product's true cost can come from several places, and which one was used
 * MATTERS - a price computed from a stale manual guess is not the same as one
 * computed from a live supplier API, and the UI/audit must be able to tell them
 * apart. So cost is never a bare number here; it always carries its provenance.
 *
 * Hierarchy, most to least authoritative:
 *
 *   1. SUPPLIER_API      - a documented supplier API returned it (most current)
 *   2. SHOPIFY_UNIT_COST - Shopify's "cost per item", written by the dropshipping
 *                          app on import (Tradelle, DSers, Zendrop, CJ, AutoDS)
 *   3. MANUAL            - a human typed it into Trademart (fallback)
 *   4. UNKNOWN           - none available; the product is NOT priced
 *
 * The central rule of this codebase applies without exception: a missing cost is
 * UNKNOWN, never 0. Shopify returns 0 both for "genuinely free" and "never
 * filled in", so a non-positive amount is treated as absent at every level. A
 * product with an UNKNOWN cost is never automatically repriced.
 *
 * Pure - no Shopify, no database, no clock injected value beyond what callers
 * pass - so the hierarchy is exhaustively unit testable.
 */

import { sumMoney } from '../common/money';
import type { Money } from '../shopify/shopify.types';

export type CostSource = 'SUPPLIER_API' | 'SHOPIFY_UNIT_COST' | 'MANUAL' | 'UNKNOWN';

/**
 * The hierarchy, most to least authoritative, as a value.
 *
 * Exported so API responses can report the order instead of restating it in
 * prose. /api/automation/status used to describe Shopify's unitCost as if it
 * were the only cost source, which was true of the original MVP and badly
 * misleading afterwards. A single exported constant means the documented order
 * and the implemented order cannot drift apart - and the test suite asserts
 * resolveCostSource actually honours this sequence.
 *
 * UNKNOWN is last and is a real member: "no cost" is a decision the pricing
 * path must handle, not an absence to paper over with 0.
 */
export const COST_SOURCE_ORDER: readonly CostSource[] = Object.freeze([
  'SUPPLIER_API',
  'SHOPIFY_UNIT_COST',
  'MANUAL',
  'UNKNOWN',
] as const);

/**
 * What happens to a product whose cost is UNKNOWN.
 *
 * Stated as a constant because it is a safety guarantee the UI repeats to the
 * operator: an unknown cost means the product is skipped, never priced from a
 * zero cost (which would compute an enormous margin and a nonsense price).
 */
export const UNKNOWN_COST_POLICY = 'SKIP_AUTOMATIC_PRICING' as const;

/** A cost that always states where it came from. */
export interface ResolvedCost {
  /**
   * The PRODUCT cost only, excluding shipping. Null only when source is UNKNOWN.
   * Never 0-as-unknown.
   */
  amount: number | null;
  currencyCode: string | null;
  source: CostSource;
  /** ISO timestamp the value was obtained, when known. */
  fetchedAt: string | null;

  /**
   * Supplier shipping, as a SEPARATE figure. Null means UNKNOWN - never 0.
   *
   * This exists because it was previously missing entirely, and its absence was a
   * silent margin bug: an operator could record a 100 shipping cost against a
   * variant and automation would price the product as though shipping were free,
   * because loadManualCostMap dropped the field on the way to the pricing engine.
   *
   * Shopify's `unitCost` ("Cost per item") is a product cost with NO shipping
   * component, so a SHOPIFY_UNIT_COST resolution leaves this null. That is the
   * honest answer: shipping is genuinely unknown, not free.
   */
  shippingCost: number | null;
  /** Where the shipping figure came from. UNKNOWN when there is none. */
  shippingSource: CostSource;

  /**
   * product + shipping - the cost of getting one unit to the customer.
   *
   * Named "landed" deliberately, to keep it distinct from the COMMERCIAL cost
   * (landed + payment fees + platform fees + advertising allowance). Conflating
   * the two is how a margin ends up looking healthy while the order loses money.
   *
   * Null when the product cost is unknown. Equal to `amount` when shipping is
   * unknown - and in that case `shippingKnown` is false, which callers MUST
   * surface, because a margin computed from it is an upper bound rather than an
   * estimate.
   */
  landedCost: number | null;
  /** False when landedCost excludes shipping because shipping is unknown. */
  shippingKnown: boolean;
}

/** A cost a human entered and Trademart persisted. */
export interface ManualCost {
  amount: number;
  currencyCode: string;
  /**
   * Supplier shipping per unit, when the operator recorded one. Undefined/null
   * means they did not - which is UNKNOWN, not free.
   */
  shippingCost?: number | null;
  /** ISO timestamp of last edit, for staleness display. */
  updatedAt?: string | null;
  /**
   * When true, this manual value is treated as an explicit correction and wins
   * over Shopify's cost per item. Off by default: the brief's hierarchy places
   * MANUAL below SHOPIFY_UNIT_COST, because the dropshipping app's value is
   * normally more current than a hand-typed one - but a merchant fixing a wrong
   * Shopify cost needs a way to say "no, use mine".
   */
  override?: boolean;
}

export interface CostInputs {
  /** From a supplier provider's getSupplierCost (null for Tradelle today). */
  supplierApiCost?: Money | null;
  /**
   * Supplier-quoted shipping, when a provider returns one. No provider does today
   * (Tradelle has no documented API), but the slot is reserved so shipping follows
   * the same provenance hierarchy as the product cost rather than being bolted on.
   */
  supplierApiShippingCost?: Money | null;
  /** From variant.unitCost. Product cost only - Shopify has no shipping field. */
  shopifyUnitCost?: Money | null;
  /** From a stored SupplierProduct/CostRecord. May carry shippingCost. */
  manualCost?: ManualCost | null;
}

/** True when a Money value is present and strictly positive. */
function isUsable(money: Money | null | undefined): money is Money {
  return (
    money !== null &&
    money !== undefined &&
    Number.isFinite(money.amount) &&
    money.amount > 0 &&
    typeof money.currencyCode === 'string' &&
    money.currencyCode.length > 0
  );
}

function usableManual(manual: ManualCost | null | undefined): manual is ManualCost {
  return (
    manual !== null &&
    manual !== undefined &&
    Number.isFinite(manual.amount) &&
    manual.amount > 0 &&
    typeof manual.currencyCode === 'string' &&
    manual.currencyCode.length > 0
  );
}

const UNKNOWN: ResolvedCost = {
  amount: null,
  currencyCode: null,
  source: 'UNKNOWN',
  fetchedAt: null,
  shippingCost: null,
  shippingSource: 'UNKNOWN',
  landedCost: null,
  shippingKnown: false,
};

/** True when a shipping figure is present and non-negative. Zero IS valid here. */
function usableShipping(value: number | null | undefined): value is number {
  // Unlike a product cost, 0 is a legitimate shipping value: free shipping is a
  // real commercial arrangement. Only null/undefined mean unknown, which is why
  // this does not reuse the `> 0` test used for product costs.
  return value !== null && value !== undefined && Number.isFinite(value) && value >= 0;
}

/**
 * Attaches shipping to a resolved product cost.
 *
 * Shipping is only ever taken from a source denominated in the SAME currency as the
 * product cost. Adding 100 INR of shipping to a 5.00 GBP product cost would produce
 * a number that is not a price in any currency, and no exchange rate is available.
 */
function withShipping(
  base: Omit<ResolvedCost, 'shippingCost' | 'shippingSource' | 'landedCost' | 'shippingKnown'>,
  shipping: { amount: number | null | undefined; currencyCode: string | null; source: CostSource },
): ResolvedCost {
  const currencyMatches =
    shipping.currencyCode !== null && shipping.currencyCode === base.currencyCode;
  const known = usableShipping(shipping.amount) && currencyMatches;
  const shippingCost: number | null =
    known && shipping.amount !== null && shipping.amount !== undefined
      ? shipping.amount
      : null;

  return {
    ...base,
    shippingCost,
    shippingSource: known ? shipping.source : 'UNKNOWN',
    landedCost:
      base.amount === null
        ? null
        : shippingCost === null
          ? base.amount
          : sumMoney(base.amount, shippingCost),
    shippingKnown: known,
  };
}

/**
 * Resolves the cost to use, following the hierarchy.
 *
 * A `manualCost.override` short-circuits to MANUAL, because an explicit human
 * correction should not be silently ignored in favour of the value it was
 * entered to correct.
 */
export function resolveCostSource(inputs: CostInputs): ResolvedCost {
  const manual = inputs.manualCost;

  // A live supplier API is the most authoritative source and outranks even a
  // manual override - the override exists to correct a stale SHOPIFY value, not
  // to beat a fresh API fetch.
  if (isUsable(inputs.supplierApiCost)) {
    return withShipping(
      {
        amount: inputs.supplierApiCost.amount,
        currencyCode: inputs.supplierApiCost.currencyCode,
        source: 'SUPPLIER_API',
        // A live API value is "now" from the caller's perspective; callers that
        // cache should pass their own timestamp via a wrapper if needed.
        fetchedAt: null,
      },
      // A supplier API that quotes a product cost may also quote shipping. When it
      // does not, a manual shipping figure is still better than pretending shipping
      // is free - the operator typed it for exactly this reason.
      resolveShippingInput(inputs),
    );
  }

  // An explicit human override beats Shopify's cost per item - it exists
  // precisely to correct a wrong automatic value from the dropshipping app.
  if (usableManual(manual) && manual.override === true) {
    return withShipping(
      {
        amount: manual.amount,
        currencyCode: manual.currencyCode,
        source: 'MANUAL',
        fetchedAt: manual.updatedAt ?? null,
      },
      resolveShippingInput(inputs),
    );
  }

  if (isUsable(inputs.shopifyUnitCost)) {
    return withShipping(
      {
        amount: inputs.shopifyUnitCost.amount,
        currencyCode: inputs.shopifyUnitCost.currencyCode,
        source: 'SHOPIFY_UNIT_COST',
        fetchedAt: null,
      },
      // Shopify's "Cost per item" is a PRODUCT cost with no shipping component, so
      // there is nothing to take from it. A manual shipping figure fills the gap;
      // otherwise shipping stays UNKNOWN, which is the truth.
      resolveShippingInput(inputs),
    );
  }

  if (usableManual(manual)) {
    return withShipping(
      {
        amount: manual.amount,
        currencyCode: manual.currencyCode,
        source: 'MANUAL',
        fetchedAt: manual.updatedAt ?? null,
      },
      resolveShippingInput(inputs),
    );
  }

  return UNKNOWN;
}

/**
 * Picks the shipping figure to use, and says where it came from.
 *
 * Supplier-quoted shipping outranks a hand-typed one for the same reason a
 * supplier-quoted product cost does: it is more current.
 */
function resolveShippingInput(inputs: CostInputs): {
  amount: number | null | undefined;
  currencyCode: string | null;
  source: CostSource;
} {
  if (usableShipping(inputs.supplierApiShippingCost?.amount)) {
    return {
      amount: inputs.supplierApiShippingCost.amount,
      currencyCode: inputs.supplierApiShippingCost.currencyCode,
      source: 'SUPPLIER_API',
    };
  }
  const manual = inputs.manualCost;
  if (manual !== null && manual !== undefined && usableShipping(manual.shippingCost)) {
    return {
      amount: manual.shippingCost,
      currencyCode: manual.currencyCode,
      source: 'MANUAL',
    };
  }
  return { amount: null, currencyCode: null, source: 'UNKNOWN' };
}

/** True when a resolved cost is usable for pricing (has a positive amount). */
export function hasUsableCost(cost: ResolvedCost): boolean {
  return cost.amount !== null && cost.amount > 0;
}

/** A short, human-readable label for the source, for UI and audit reasons. */
export function describeCostSource(source: CostSource): string {
  switch (source) {
    case 'SUPPLIER_API':
      return 'supplier API';
    case 'SHOPIFY_UNIT_COST':
      return 'Shopify cost per item';
    case 'MANUAL':
      return 'manually entered';
    case 'UNKNOWN':
    default:
      return 'unknown';
  }
}
