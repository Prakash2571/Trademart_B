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
  /** Null only when source is UNKNOWN. Never 0-as-unknown. */
  amount: number | null;
  currencyCode: string | null;
  source: CostSource;
  /** ISO timestamp the value was obtained, when known. */
  fetchedAt: string | null;
}

/** A cost a human entered and Trademart persisted. */
export interface ManualCost {
  amount: number;
  currencyCode: string;
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
  /** From variant.unitCost. */
  shopifyUnitCost?: Money | null;
  /** From a stored SupplierProduct/CostRecord. */
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
};

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
    return {
      amount: inputs.supplierApiCost.amount,
      currencyCode: inputs.supplierApiCost.currencyCode,
      source: 'SUPPLIER_API',
      // A live API value is "now" from the caller's perspective; callers that
      // cache should pass their own timestamp via a wrapper if needed.
      fetchedAt: null,
    };
  }

  // An explicit human override beats Shopify's cost per item - it exists
  // precisely to correct a wrong automatic value from the dropshipping app.
  if (usableManual(manual) && manual.override === true) {
    return {
      amount: manual.amount,
      currencyCode: manual.currencyCode,
      source: 'MANUAL',
      fetchedAt: manual.updatedAt ?? null,
    };
  }

  if (isUsable(inputs.shopifyUnitCost)) {
    return {
      amount: inputs.shopifyUnitCost.amount,
      currencyCode: inputs.shopifyUnitCost.currencyCode,
      source: 'SHOPIFY_UNIT_COST',
      fetchedAt: null,
    };
  }

  if (usableManual(manual)) {
    return {
      amount: manual.amount,
      currencyCode: manual.currencyCode,
      source: 'MANUAL',
      fetchedAt: manual.updatedAt ?? null,
    };
  }

  return UNKNOWN;
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
