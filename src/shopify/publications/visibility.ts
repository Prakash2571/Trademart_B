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

import type {
  ChannelPublicationStatus,
  ProductPublicationState,
  SalesChannelSelector,
} from './publications.types';

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


/* ===========================================================================
 * CHANNEL-AWARE PUBLICATION
 *
 * resolveCustomerVisibility above answers one specific question: "can a customer
 * browsing the THEMED ONLINE STORE find this product?". A custom headless
 * storefront is a DIFFERENT sales channel with its own publication record, so that
 * function cannot answer for it, and widening it to mean "visible somewhere" would
 * destroy the distinction it exists to protect.
 *
 * What follows resolves publication per channel, three-valued, so "ACTIVE and on
 * the Online Store" and "ACTIVE and on the headless channel" stay separate facts.
 * ACTIVE is never redefined as customer-visible anywhere in here.
 * =========================================================================== */

/** Matches a channel by GID when given one, otherwise by exact then substring name. */
function findChannel(
  publications: ProductPublicationState[],
  selector: SalesChannelSelector,
): ProductPublicationState | null {
  const id = selector.publicationId?.trim();
  if (id !== undefined && id !== '') {
    return publications.find((entry) => entry.publicationId === id) ?? null;
  }

  const name = selector.name?.trim().toLowerCase();
  if (name === undefined || name === '') return null;

  return (
    publications.find((entry) => entry.name.trim().toLowerCase() === name) ??
    publications.find((entry) => entry.name.trim().toLowerCase().includes(name)) ??
    null
  );
}

/** True when the selector carries no usable channel identity at all. */
function selectorIsEmpty(selector: SalesChannelSelector): boolean {
  const id = selector.publicationId?.trim() ?? '';
  const name = selector.name?.trim() ?? '';
  return id === '' && name === '';
}

export interface ChannelPublication {
  status: ChannelPublicationStatus;
  /** The matched entry, or null when the app could not see the channel. */
  entry: ProductPublicationState | null;
  /** Why the status is what it is. Always populated. */
  reason: string;
}

/**
 * Publication state for one channel.
 *
 * A channel the app cannot see is UNKNOWN, never UNPUBLISHED. Shopify returning no
 * publications at all - the shape when read_publications was not granted - is also
 * UNKNOWN. Inferring "not published" from silence would let a missing scope look
 * like a deliberate merchant decision.
 */
export function resolveChannelPublication(
  publications: ProductPublicationState[],
  selector: SalesChannelSelector,
): ChannelPublication {
  if (selectorIsEmpty(selector)) {
    return {
      status: 'UNKNOWN',
      entry: null,
      reason:
        'No sales channel was configured to check, so publication cannot be confirmed. Set the channel id or name.',
    };
  }

  if (publications.length === 0) {
    return {
      status: 'UNKNOWN',
      entry: null,
      reason:
        'Shopify returned no publications for this product, so publication cannot be confirmed. read_publications is required.',
    };
  }

  const entry = findChannel(publications, selector);
  if (entry === null) {
    const label = selector.publicationId?.trim() || selector.name?.trim() || 'the channel';
    return {
      status: 'UNKNOWN',
      entry: null,
      reason: `No publication matching ${label} is visible to this app, so publication cannot be confirmed. Check the channel exists on this shop and that read_publications is granted.`,
    };
  }

  return entry.isPublished
    ? { status: 'PUBLISHED', entry, reason: `Published to ${entry.name}.` }
    : { status: 'UNPUBLISHED', entry, reason: `Not published to ${entry.name}.` };
}

export interface HeadlessVisibility {
  shopifyProductId: string;
  /** DRAFT | ACTIVE | ARCHIVED, or null when Shopify withheld it. */
  status: string | null;
  /** Whether the product's own status permits selling. Not sufficient alone. */
  isActive: boolean;
  /** Publication on the themed Online Store - reported, never conflated. */
  onlineStore: ChannelPublicationStatus;
  /** Publication on the custom headless channel. */
  headless: ChannelPublicationStatus;
  /**
   * The conjunction, and the only field a caller should gate a sale on:
   * status === 'ACTIVE' AND Shopify confirmed headless publication.
   */
  sellableOnHeadlessStorefront: boolean;
  reason: string;
}

/**
 * "Can a customer buy this on the CUSTOM headless storefront?"
 *
 * Both halves are required and neither implies the other:
 *   - A DRAFT product published to the headless channel is not sellable.
 *   - An ACTIVE product absent from the headless channel is not sellable, even
 *     though it may be perfectly visible on the themed Online Store.
 *
 * UNKNOWN headless publication is not sellable. That is the whole point: the store
 * fails closed when Shopify has not confirmed publication, rather than showing a
 * product a customer cannot actually purchase.
 */
export function resolveHeadlessVisibility(input: {
  shopifyProductId: string;
  status: string | null;
  publications: ProductPublicationState[];
  headlessChannel: SalesChannelSelector;
  onlineStoreChannel?: SalesChannelSelector;
}): HeadlessVisibility {
  const { shopifyProductId, status, publications, headlessChannel } = input;

  const headless = resolveChannelPublication(publications, headlessChannel);
  const onlineStore = resolveChannelPublication(
    publications,
    input.onlineStoreChannel ?? { name: 'online store' },
  );

  const isActive = status === 'ACTIVE';
  const sellableOnHeadlessStorefront = isActive && headless.status === 'PUBLISHED';

  let reason: string;
  if (sellableOnHeadlessStorefront) {
    reason = `Status is ACTIVE and Shopify confirmed publication to ${headless.entry?.name ?? 'the headless channel'}.`;
  } else if (status === null) {
    reason =
      'Shopify did not return the product status, so headless sellability cannot be determined. read_products is required.';
  } else if (!isActive && headless.status === 'PUBLISHED') {
    reason = `The product is published to the headless channel but its status is ${status}, so it is not sellable. Setting it ACTIVE would make it sellable immediately.`;
  } else if (!isActive) {
    reason = `Status is ${status} and ${lowerFirst(headless.reason)}`;
  } else {
    reason = `Status is ACTIVE but ${lowerFirst(headless.reason)}`;
  }

  return {
    shopifyProductId,
    status,
    isActive,
    onlineStore: onlineStore.status,
    headless: headless.status,
    sellableOnHeadlessStorefront,
    reason,
  };
}

function lowerFirst(value: string): string {
  return value.length === 0 ? value : value[0]!.toLowerCase() + value.slice(1);
}
