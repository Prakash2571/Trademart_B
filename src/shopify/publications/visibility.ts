/**
 * "Can customers actually see this product?" - as a pure function.
 *
 * VISIBILITY IS A CONJUNCTION, AND BOTH HALVES ARE EASY TO GET WRONG
 * -----------------------------------------------------------------
 *   status === 'ACTIVE'        means "not draft and not archived". It does NOT
 *                              mean published. An ACTIVE product that is not on
 *                              the Online Store is invisible to customers while
 *                              looking live in the Shopify admin - the bug that
 *                              motivated this whole module.
 *   published to Online Store  does NOT mean visible either. A DRAFT product
 *                              published to the channel is still hidden.
 *
 * So visibility is `ACTIVE && published to the Online Store`, computed in ONE
 * place that both the API and the UI read rather than re-derived by each caller.
 * Every place that re-derived it was a place the two halves could drift, and the
 * failure mode is telling an operator a product is on sale when customers cannot
 * see it.
 *
 * Publication to some OTHER channel (POS, a marketplace) deliberately does not
 * count. It is real publication, but it does not put the product on the web
 * storefront, and "visible" here means "a customer browsing the shop can find it".
 * `publishedAnywhere` still reports it, because that is a different question.
 *
 * WHY THIS IS A SEPARATE, DEPENDENCY-FREE MODULE
 * ----------------------------------------------
 * publications.service.ts imports the Shopify client, which imports the config
 * singleton, and config/index.ts calls process.exit(1) on invalid env. Keeping the
 * decision here means it can be unit tested exhaustively with no network and no
 * configured store - the test process is not killed at import time. The name is
 * `resolveCustomerVisibility`, not `decideVisibility`, because
 * automation/visibility.rules.ts already owns that name for a different question
 * (should automation SET this product ACTIVE or DRAFT?).
 */

import type { ProductPublicationState } from './publications.types';

export interface ProductVisibility {
  shopifyProductId: string;
  /** DRAFT | ACTIVE | ARCHIVED, or null when Shopify withheld it. */
  status: string | null;
  publications: ProductPublicationState[];
  /** The Online Store entry, when the app can see that channel. */
  onlineStore: ProductPublicationState | null;
  /** Published to at least one channel - NOT the same as visible. */
  publishedAnywhere: boolean;
  /** The honest answer. */
  visibleToCustomers: boolean;
  /**
   * Always populated. A bare `false` sends an operator hunting through Shopify to
   * work out which half is missing.
   */
  reason: string;
}

/** Finds the Online Store channel by name; its id differs per shop. */
function findOnlineStore(
  publications: ProductPublicationState[],
): ProductPublicationState | null {
  return (
    publications.find((entry) => entry.name.toLowerCase() === 'online store') ??
    publications.find((entry) => entry.name.toLowerCase().includes('online store')) ??
    null
  );
}

export function resolveCustomerVisibility(input: {
  shopifyProductId: string;
  status: string | null;
  publications: ProductPublicationState[];
}): ProductVisibility {
  const { shopifyProductId, status, publications } = input;

  const onlineStore = findOnlineStore(publications);
  const publishedAnywhere = publications.some((entry) => entry.isPublished);
  const onOnlineStore = onlineStore?.isPublished === true;
  const isActive = status === 'ACTIVE';
  const visibleToCustomers = isActive && onOnlineStore;

  let reason: string;
  if (visibleToCustomers) {
    reason = 'Status is ACTIVE and the product is published to the Online Store.';
  } else if (status === null) {
    // Fail loud rather than reporting a confident `false`: without the status the
    // answer is unknown, and claiming "not visible" could simply be wrong.
    reason =
      'Shopify did not return the product status, so visibility cannot be determined. read_products is required.';
  } else if (onlineStore === null) {
    // Checked before the status branches: if the channel is not visible to the app
    // at all, that is the blocking unknown regardless of status.
    reason = publishedAnywhere
      ? 'The product is published to another channel, but no Online Store publication is visible to this app, so web-storefront visibility cannot be confirmed. read_publications is required.'
      : 'No Online Store publication is visible to this app, so the product cannot be confirmed as on sale. read_publications is required.';
  } else if (!isActive && !onOnlineStore) {
    reason = `Status is ${status} and the product is not published to the Online Store, so customers cannot see it.`;
  } else if (!isActive) {
    reason = `The product is published to the Online Store but its status is ${status}, so it is still hidden. Setting it ACTIVE would make it visible immediately.`;
  } else {
    reason =
      'Status is ACTIVE but the product is not published to the Online Store, so customers cannot see it even though it looks live in the Shopify admin.';
  }

  return {
    shopifyProductId,
    status,
    publications,
    onlineStore,
    publishedAnywhere,
    visibleToCustomers,
    reason,
  };
}
