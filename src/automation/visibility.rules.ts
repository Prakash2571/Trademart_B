/**
 * Visibility decisions — should this product be on the storefront?
 *
 * Pure: takes a ProductDto plus a rule set and returns a decision with reasons.
 * No Shopify calls, no database, no clock. That makes every rule interaction
 * unit testable, which matters because a wrong decision here removes a real
 * product from a real shop.
 *
 * Shopify models "shown" in two independent ways and BOTH must agree for a
 * customer to see a product:
 *
 *   status      ACTIVE | DRAFT | ARCHIVED   - does the product exist publicly
 *   publication published to a sales channel - which channels list it
 *
 * This engine drives `status` only, and deliberately so: status is one field,
 * store-wide, and trivially reversible. Unpublishing from individual sales
 * channels needs publication IDs and can silently strip a product from channels
 * the merchant curated by hand, so it is left to a later, explicit feature.
 */

import type { ProductDto, ProductVariantDto } from '../shopify/shopify.types';
import {
  AUTOMATION_HIDDEN_TAG,
  type AutomationRules,
  type VisibilityRules,
} from './rules.types';

/** Shopify product statuses this engine will set. */
export type DesiredStatus = 'ACTIVE' | 'DRAFT';

export type VisibilityDecision =
  /** Change the product's status. */
  | { kind: 'change'; from: string; to: DesiredStatus; reasons: string[] }
  /** Correct already — no write. */
  | { kind: 'noop'; reasons: string[] }
  /** Deliberately not evaluated (exempt, archived, missing data). */
  | { kind: 'skip'; reasons: string[] };

/**
 * True when the product is pinned by hand and automation must not touch it.
 * Tag matching is case-insensitive and trimmed, because merchant-entered tags
 * are inconsistently cased.
 */
export function isExempt(product: ProductDto, exemptTags: readonly string[]): boolean {
  if (exemptTags.length === 0) return false;
  const normalised = new Set(
    product.tags.map((tag) => tag.trim().toLowerCase()).filter((tag) => tag.length > 0),
  );
  return exemptTags.some((tag) => normalised.has(tag.trim().toLowerCase()));
}

/** True when automation is the reason this product is currently hidden. */
export function wasHiddenByAutomation(product: ProductDto): boolean {
  return product.tags.some(
    (tag) => tag.trim().toLowerCase() === AUTOMATION_HIDDEN_TAG.toLowerCase(),
  );
}

/**
 * Stock level across variants, or null when it genuinely cannot be determined.
 *
 * Returns null rather than 0 when `read_inventory` was not granted or nothing is
 * tracked — the codebase's standing rule is that unknown is never zero, and
 * treating "unknown" as "out of stock" would hide a healthy catalogue.
 *
 * Untracked variants are treated as always available, which is how Shopify
 * itself behaves when inventory tracking is off.
 */
export function resolveStock(product: ProductDto): {
  quantity: number | null;
  hasUntrackedVariant: boolean;
} {
  let total = 0;
  let sawTrackedQuantity = false;
  let hasUntrackedVariant = false;

  for (const variant of product.variants) {
    if (variant.inventoryTracked === false) {
      hasUntrackedVariant = true;
      continue;
    }
    if (variant.inventoryQuantity !== null) {
      total += variant.inventoryQuantity;
      sawTrackedQuantity = true;
    }
  }

  // Fall back to the product-level roll-up when no variant reported a quantity.
  if (!sawTrackedQuantity && product.totalInventory !== null) {
    return { quantity: product.totalInventory, hasUntrackedVariant };
  }
  if (!sawTrackedQuantity) {
    return { quantity: null, hasUntrackedVariant };
  }
  return { quantity: total, hasUntrackedVariant };
}

/** True when at least one variant has a usable cost. */
export function hasKnownCost(variants: readonly ProductVariantDto[]): boolean {
  return variants.some(
    (variant) => variant.unitCost !== null && variant.unitCost.amount > 0,
  );
}

/**
 * Decides the desired storefront visibility for one product.
 *
 * `currentMarginPercentage` is supplied by the caller (computed by the price
 * engine from the variant's real cost) and may be null when unknown. It is
 * passed in rather than computed here so this module stays free of pricing
 * arithmetic and the two engines can be tested independently.
 */
export function decideVisibility(
  product: ProductDto,
  rules: AutomationRules,
  currentMarginPercentage: number | null = null,
): VisibilityDecision {
  const visibility: VisibilityRules = rules.visibility;

  if (!visibility.enabled) {
    return { kind: 'skip', reasons: ['Visibility automation is disabled.'] };
  }
  if (isExempt(product, rules.exemptTags)) {
    return {
      kind: 'skip',
      reasons: [`Product carries an exempt tag (${rules.exemptTags.join(', ')}).`],
    };
  }
  // ARCHIVED is a deliberate merchant action meaning "retired". Automation must
  // never resurrect an archived product, so it is left entirely alone.
  if (product.status.toUpperCase() === 'ARCHIVED') {
    return { kind: 'skip', reasons: ['Product is ARCHIVED; automation never changes this.'] };
  }

  const current = product.status.toUpperCase();
  const stock = resolveStock(product);
  const hideReasons: string[] = [];

  if (visibility.hideOutOfStock) {
    if (stock.quantity !== null && stock.quantity <= 0 && !stock.hasUntrackedVariant) {
      hideReasons.push(`Out of stock (tracked quantity ${stock.quantity}).`);
    }
  }

  if (visibility.hideUnknownCost && !hasKnownCost(product.variants)) {
    hideReasons.push('No known cost per item, and hideUnknownCost is enabled.');
  }

  if (
    visibility.hideBelowMinMargin &&
    currentMarginPercentage !== null &&
    currentMarginPercentage < rules.price.minMarginPercentage
  ) {
    hideReasons.push(
      `Margin at current price is ${currentMarginPercentage.toFixed(2)}%, below the ${rules.price.minMarginPercentage}% floor.`,
    );
  }

  if (hideReasons.length > 0) {
    if (current === 'DRAFT') {
      return { kind: 'noop', reasons: ['Already hidden.', ...hideReasons] };
    }
    return { kind: 'change', from: product.status, to: 'DRAFT', reasons: hideReasons };
  }

  // Nothing warrants hiding. Should it be restored?
  if (current === 'DRAFT') {
    if (!visibility.restoreWhenBackInStock) {
      return { kind: 'skip', reasons: ['Hidden, and restoreWhenBackInStock is disabled.'] };
    }
    // Only un-hide what automation hid. A product a merchant drafted by hand
    // (an unfinished listing, a seasonal item) must stay drafted.
    if (!wasHiddenByAutomation(product)) {
      return {
        kind: 'skip',
        reasons: [
          `DRAFT but not tagged ${AUTOMATION_HIDDEN_TAG}, so it was hidden manually. Left alone.`,
        ],
      };
    }
    const reasons = ['No longer meets any hide condition.'];
    if (stock.quantity !== null) reasons.push(`Stock is ${stock.quantity}.`);
    return { kind: 'change', from: product.status, to: 'ACTIVE', reasons };
  }

  return { kind: 'noop', reasons: ['Visible and meets all conditions.'] };
}
