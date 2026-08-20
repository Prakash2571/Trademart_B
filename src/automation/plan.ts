/**
 * Automation plan builder.
 *
 * Turns a list of products plus a rule set into an explicit, reviewable plan.
 * Pure — building the plan never touches Shopify, which is what makes a genuine
 * dry-run possible: `POST /api/automation/preview` runs exactly this code and
 * simply does not execute the result.
 *
 * The plan is the audit record. Every action carries the reasons that produced
 * it, so "why did my price change?" is answerable after the fact.
 */

import type { ProductDto } from '../shopify/shopify.types';
import { decideVariantPrice, lowestCurrentMargin } from './price.rules';
import { decideVisibility, isExempt, isSelected } from './visibility.rules';
import type { AutomationRules } from './rules.types';

export interface VisibilityAction {
  type: 'visibility';
  shopifyProductId: string;
  title: string;
  from: string;
  to: 'ACTIVE' | 'DRAFT';
  reasons: string[];
}

export interface PriceAction {
  type: 'price';
  shopifyProductId: string;
  shopifyVariantId: string;
  title: string;
  variantTitle: string;
  from: number;
  to: number;
  currencyCode: string;
  currentMarginPercentage: number | null;
  projectedMarginPercentage: number | null;
  clamped: boolean;
  reasons: string[];
}

export type AutomationAction = VisibilityAction | PriceAction;

export interface SkippedItem {
  shopifyProductId: string;
  shopifyVariantId: string | null;
  title: string;
  reasons: string[];
}

export interface AutomationPlan {
  actions: AutomationAction[];
  /**
   * Everything deliberately not acted on, WITH reasons. Surfaced rather than
   * silently dropped: "nothing happened" is only trustworthy if you can see why.
   */
  skipped: SkippedItem[];
  summary: {
    productsConsidered: number;
    visibilityChanges: number;
    priceChanges: number;
    priceIncreases: number;
    priceDecreases: number;
    clamped: number;
    skipped: number;
    /** True when maxItemsPerRun stopped the plan short. */
    truncated: boolean;
  };
}

/**
 * Builds the plan.
 *
 * Ordering note: visibility is decided before price for each product, and the
 * plan is executed in the same order. Hiding a loss-making product before
 * touching its price is the safer sequence — if the run fails midway, the
 * product is hidden rather than left on sale at a half-updated price.
 */
export function buildAutomationPlan(
  products: readonly ProductDto[],
  rules: AutomationRules,
): AutomationPlan {
  const actions: AutomationAction[] = [];
  const skipped: SkippedItem[] = [];
  let truncated = false;

  for (const product of products) {
    // Selection is checked FIRST: a product outside it is not automation's
    // business at all, so it should not even be reported as exempt or evaluated.
    if (!isSelected(product, rules.selection)) {
      skipped.push({
        shopifyProductId: product.shopifyProductId,
        shopifyVariantId: null,
        title: product.title,
        reasons: [
          rules.selection.mode === 'vendor'
            ? `Vendor "${product.vendor ?? 'none'}" is not in the selected vendors (${rules.selection.includeVendors.join(', ')}).`
            : `Product does not carry a selected tag (${rules.selection.includeTags.join(', ')}).`,
        ],
      });
      continue;
    }

    // Checked once here so an exempt product produces a single clear skip rather
    // than one per variant.
    if (isExempt(product, rules.exemptTags)) {
      skipped.push({
        shopifyProductId: product.shopifyProductId,
        shopifyVariantId: null,
        title: product.title,
        reasons: [`Exempt tag present (${rules.exemptTags.join(', ')}).`],
      });
      continue;
    }

    if (actions.length >= rules.maxItemsPerRun) {
      truncated = true;
      break;
    }

    // Computed once and shared: the visibility rule needs the current margin,
    // and recomputing it per engine risks the two disagreeing.
    const currentMargin = lowestCurrentMargin(product.variants, rules.price);

    const visibility = decideVisibility(product, rules, currentMargin);
    if (visibility.kind === 'change') {
      actions.push({
        type: 'visibility',
        shopifyProductId: product.shopifyProductId,
        title: product.title,
        from: visibility.from,
        to: visibility.to,
        reasons: visibility.reasons,
      });
    } else if (visibility.kind === 'skip') {
      skipped.push({
        shopifyProductId: product.shopifyProductId,
        shopifyVariantId: null,
        title: product.title,
        reasons: visibility.reasons,
      });
    }

    // Repricing a product that is being hidden is wasted work and a confusing
    // audit trail, so price rules are skipped for it this run. Once it comes
    // back into stock a later run prices it.
    const beingHidden = visibility.kind === 'change' && visibility.to === 'DRAFT';
    if (beingHidden) {
      skipped.push({
        shopifyProductId: product.shopifyProductId,
        shopifyVariantId: null,
        title: product.title,
        reasons: ['Being hidden this run; price left unchanged.'],
      });
      continue;
    }

    for (const variant of product.variants) {
      if (actions.length >= rules.maxItemsPerRun) {
        truncated = true;
        break;
      }

      const decision = decideVariantPrice(variant, rules.price);
      if (decision.kind === 'change') {
        actions.push({
          type: 'price',
          shopifyProductId: product.shopifyProductId,
          shopifyVariantId: decision.variantId,
          title: product.title,
          variantTitle: variant.title,
          from: decision.from,
          to: decision.to,
          currencyCode: decision.currencyCode,
          currentMarginPercentage: decision.currentMarginPercentage,
          projectedMarginPercentage: decision.projectedMarginPercentage,
          clamped: decision.clamped,
          reasons: decision.reasons,
        });
      } else if (decision.kind === 'skip') {
        skipped.push({
          shopifyProductId: product.shopifyProductId,
          shopifyVariantId: decision.variantId,
          title: product.title,
          reasons: decision.reasons,
        });
      }
    }
  }

  const priceActions = actions.filter((action): action is PriceAction => action.type === 'price');

  return {
    actions,
    skipped,
    summary: {
      productsConsidered: products.length,
      visibilityChanges: actions.filter((action) => action.type === 'visibility').length,
      priceChanges: priceActions.length,
      priceIncreases: priceActions.filter((action) => action.to > action.from).length,
      priceDecreases: priceActions.filter((action) => action.to < action.from).length,
      clamped: priceActions.filter((action) => action.clamped).length,
      skipped: skipped.length,
      truncated,
    },
  };
}
