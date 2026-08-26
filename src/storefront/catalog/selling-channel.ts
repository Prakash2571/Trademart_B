/**
 * Which Shopify sales channel the Trademart-served storefront sells through.
 *
 * ONE place decides this. The catalog, the collection projection and the checkout
 * adapter must all agree: a product sellable at checkout but absent from the catalog
 * (or the reverse) is a customer-visible inconsistency, and re-deriving the channel
 * per call site is how the two drift.
 *
 * The custom storefront is not the themed Online Store. When an operator has told
 * Trademart which publication represents the custom store
 * (SHOPIFY_HEADLESS_PUBLICATION_ID / SHOPIFY_HEADLESS_CHANNEL_NAME), that is the
 * gate. With nothing configured it falls back to the Online Store, which is what
 * this projection assumed before headless channels existed - so an existing
 * deployment behaves exactly as it did.
 *
 * Note this is a FALLBACK, not a guess about the headless channel: when a headless
 * channel is configured but Shopify does not confirm publication to it, the
 * tri-state resolves to UNKNOWN and the product is withheld. Absence of evidence
 * never becomes permission to sell.
 */

import { config } from '../../config';
import type { SalesChannelSelector } from '../../shopify/publications/publications.types';
import { ONLINE_STORE_SELECTOR } from './publication';

export function storefrontSellingChannel(): SalesChannelSelector {
  const publicationId = config.shopify.headlessPublicationId;
  const name = config.shopify.headlessChannelName;
  if (publicationId === null && name === null) return ONLINE_STORE_SELECTOR;
  return { publicationId, name };
}

/** True when the storefront is gated on a dedicated headless channel rather than the Online Store. */
export const isSellingThroughHeadlessChannel = (): boolean =>
  config.shopify.headlessPublicationId !== null || config.shopify.headlessChannelName !== null;
