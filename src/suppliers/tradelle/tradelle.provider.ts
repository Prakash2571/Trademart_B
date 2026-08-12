/**
 * Tradelle provider.
 *
 * IMPORTANT - current known limitation:
 * Tradelle documents a *Shopify integration* (importing products into Shopify
 * and automatic fulfillment of Shopify orders). It does not publish a public
 * production API, so there are no cost/shipping endpoints to call.
 *   https://help.tradelle.io/
 *   https://help.tradelle.io/en/category/shopify-integrations-i2j4s8/
 *   https://help.tradelle.io/en/category/fulfillment-shipping-1kipzd4/
 *
 * Therefore:
 *   - getSupplierCost / getShippingCost return null. They are NOT stubbed with
 *     invented numbers and no fake endpoints are called.
 *   - identifyProduct only uses signals that Tradelle actually writes into
 *     Shopify, and returns false until such a signal is present.
 *
 * Once Tradelle is installed on the dev store, inspect a real imported product
 * and extend TRADELLE_SIGNALS with what is actually observed.
 */

import { logger } from '../../common/logger';
import type { ProductIdentitySignals, SupplierProvider } from '../supplier.types';

/** Lowercase markers considered reliable evidence of a Tradelle product. */
const TRADELLE_VENDOR_MARKERS = ['tradelle'];
const TRADELLE_TAG_MARKERS = ['tradelle'];
const TRADELLE_FULFILLMENT_MARKERS = ['tradelle'];

function normalise(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

/**
 * Pure classification helper - exported for unit testing.
 * Returns the evidence strings that justified a match (empty = no match).
 */
export function collectTradelleEvidence(signals: ProductIdentitySignals): string[] {
  const evidence: string[] = [];

  const vendor = normalise(signals.vendor);
  if (vendor && TRADELLE_VENDOR_MARKERS.some((marker) => vendor.includes(marker))) {
    evidence.push(`vendor="${signals.vendor}"`);
  }

  for (const tag of signals.tags ?? []) {
    const normalised = normalise(tag);
    if (normalised && TRADELLE_TAG_MARKERS.some((marker) => normalised.includes(marker))) {
      evidence.push(`tag="${tag}"`);
    }
  }

  for (const service of signals.fulfillmentServices ?? []) {
    const normalised = normalise(service);
    if (
      normalised &&
      TRADELLE_FULFILLMENT_MARKERS.some((marker) => normalised.includes(marker))
    ) {
      evidence.push(`fulfillmentService="${service}"`);
    }
  }

  return evidence;
}

export const tradelleProvider: SupplierProvider = {
  providerName: 'TRADELLE',

  identifyProduct(signals: ProductIdentitySignals): boolean {
    return collectTradelleEvidence(signals).length > 0;
  },

  async getSupplierCost(): Promise<number | null> {
    // No public Tradelle API is documented. Returning null keeps margin
    // calculations honest instead of inventing a cost.
    logger.debug('Tradelle supplier cost requested but no public API is documented.');
    return null;
  },

  async getShippingCost(): Promise<number | null> {
    // Tradelle's internal shipping cost is a supplier-side value that Shopify
    // does not expose. Unresolved for now - see README.
    return null;
  },
};
