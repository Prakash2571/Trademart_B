/**
 * Fingerprinting for automation rules and plans.
 *
 * THE PROBLEM THIS SOLVES
 * -----------------------
 * A preview is a promise: "these 17 prices will change from X to Y". Between the
 * preview and the apply, Shopify data can move - a supplier app rewrites a cost,
 * someone edits a price in the admin. Replanning at apply time would then write
 * DIFFERENT numbers than the operator reviewed and approved, silently.
 *
 * So the plan itself is hashed, not just the inputs. At apply time the plan is
 * rebuilt from fresh data and re-hashed; a different hash means the world moved
 * and the apply is refused with PREVIEW_STALE.
 *
 * WHAT IS AND IS NOT HASHED
 * -------------------------
 * Included: everything that determines what will be WRITTEN, plus the values the
 * operator was shown as the starting point - so `from` is part of the hash. A
 * plan that changes £20 -> £25 and one that changes £18 -> £25 are not the same
 * plan even though the destination matches; the second means the cost basis
 * changed under the operator's feet.
 *
 * Also included: costSource and clamped. Those are decision provenance the
 * operator reviewed. If a price is now derived from a manual override rather than
 * Shopify's cost, that is a material change even at an identical amount.
 *
 * Excluded: titles, variant titles, reasons and margin percentages. They are
 * presentational or derived, and a product rename should not invalidate a
 * pricing decision.
 *
 * The bias throughout is deliberate: a FALSE stale costs one extra preview
 * click. A false fresh writes prices nobody approved. So when in doubt, include.
 */

import { createHash } from 'node:crypto';

import type { AutomationPlan } from './plan';
import type { AutomationRules } from './rules.types';

/**
 * Deterministic JSON with sorted object keys.
 *
 * `JSON.stringify` preserves insertion order, so two structurally identical rule
 * objects built by different code paths (defaults-then-overrides vs
 * stored-then-overrides) could serialise differently and produce different
 * hashes. Sorting removes that.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value ?? null) ?? 'null';
  }
  if (Array.isArray(value)) {
    // Array order IS significant and is preserved.
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    // undefined members are dropped so `{a:1}` and `{a:1,b:undefined}` agree.
    .filter(([, member]) => member !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, member]) => `${JSON.stringify(key)}:${stableStringify(member)}`);
  return `{${entries.join(',')}}`;
}

function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Fingerprint of the effective rule set.
 *
 * Separate from the plan hash so the two failure modes stay distinguishable:
 * "you changed the rules" and "the store changed" need different explanations to
 * an operator, and different next actions.
 */
export function hashRules(rules: AutomationRules): string {
  return sha256(`rules:v1:${stableStringify(rules)}`);
}

/**
 * One canonical line per action, containing only execution-relevant fields.
 *
 * Money is formatted to 2dp exactly as it will be sent to Shopify, so a float
 * representation difference (25 vs 25.0000000001) cannot produce a spurious
 * mismatch - the comparison happens on the value that will actually be written.
 */
function canonicaliseActions(plan: AutomationPlan): string[] {
  return plan.actions.map((action) => {
    if (action.type === 'visibility') {
      return stableStringify({
        type: 'visibility',
        productId: action.shopifyProductId,
        from: action.from,
        to: action.to,
      });
    }
    return stableStringify({
      type: 'price',
      productId: action.shopifyProductId,
      variantId: action.shopifyVariantId,
      from: action.from.toFixed(2),
      to: action.to.toFixed(2),
      currency: action.currencyCode,
      costSource: action.costSource,
      clamped: action.clamped,
    });
  });
}

/**
 * Fingerprint of the plan's action list.
 *
 * Lines are SORTED before hashing. Execution order is deterministic given the
 * same product order, but product order comes from Shopify pagination and is not
 * guaranteed stable between two reads. Sorting means a reordered-but-identical
 * plan is correctly recognised as identical, while any added, removed or altered
 * action still changes the hash.
 */
export function hashPlan(plan: AutomationPlan): string {
  const lines = canonicaliseActions(plan).sort();
  // The count is hashed alongside the lines so that duplicate-action bugs cannot
  // be masked by set-like collapsing.
  return sha256(`plan:v1:${lines.length}:${lines.join('\n')}`);
}

/**
 * What the plan was computed over.
 *
 * Bound to the preview separately from the hashes because a scope change is a
 * different mistake: previewing 50 products and then applying to 250 is not a
 * stale plan, it is a different request, and saying so precisely is more useful
 * than a generic mismatch.
 */
export interface PlanScope {
  /** Shopify search syntax, or null for the whole catalogue. */
  query: string | null;
  maxProducts: number;
  /** Explicit product list (webhook-scoped runs), or null. Sorted. */
  productIds: string[] | null;
}

export function normaliseScope(scope: {
  query?: string | undefined;
  maxProducts: number;
  productIds?: readonly string[] | undefined;
}): PlanScope {
  return {
    query: scope.query ?? null,
    maxProducts: scope.maxProducts,
    productIds:
      scope.productIds === undefined || scope.productIds.length === 0
        ? null
        : [...scope.productIds].sort(),
  };
}

export function hashScope(scope: PlanScope): string {
  return sha256(`scope:v1:${stableStringify(scope)}`);
}

/** Human-friendly short form for logs and UI. Never used for comparison. */
export function shortHash(hash: string): string {
  return hash.slice(0, 12);
}
