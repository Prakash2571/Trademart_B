/**
 * Pure, channel-aware publication predicates.
 *
 * WHY THIS IS NOT IN shopify.catalog.ts
 * ------------------------------------
 * shopify.catalog.ts value-imports shopifyGraphql from shopify/shopify.client,
 * which imports the config singleton, and config/index.ts calls process.exit(1)
 * on invalid env. projection.ts only wanted the publication PREDICATE - no
 * network, no store - but importing it dragged the whole client in and killed
 * any test process without a configured store.
 *
 * Deciding "is this resource published to channel X?" needs nothing but the
 * resourcePublicationsV2 payload Shopify already returned, so it lives here with
 * zero dependencies and is exhaustively unit-testable. Same rule
 * shopify/publications/visibility.ts documents.
 *
 * CHANNEL AWARENESS IS THE POINT
 * ------------------------------
 * "Published" is never a single boolean. A product can be on the Online Store and
 * absent from a headless channel, or the reverse. Every predicate here therefore
 * names the channel it is asking about, and absence of evidence is NEVER treated
 * as publication.
 */

// Type-only, so this module still compiles to zero imports and stays reachable from
// tests without loading the config singleton.
import type {
  ChannelPublicationStatus,
  SalesChannelSelector,
} from '../../shopify/publications/publications.types';

/** The shape of one resourcePublicationsV2 node. */
export interface RawPublication {
  isPublished: boolean;
  publishDate?: string | null;
  publication: { id: string; name: string };
}

/** Anything Shopify returned publications for - a product or a collection. */
export interface PublishableResource {
  resourcePublicationsV2?: { nodes?: RawPublication[] | null } | null;
}

/** Shopify's own name for the themed web storefront channel. */
export const ONLINE_STORE_CHANNEL = 'online store';

function nodes(resource: PublishableResource): RawPublication[] {
  return resource.resourcePublicationsV2?.nodes ?? [];
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * True only when Shopify explicitly confirmed publication to a channel whose name
 * matches. A resource Shopify withheld publications for returns false: unknown is
 * not published.
 */
export function isPublishedToChannelNamed(
  resource: PublishableResource,
  channelName: string,
): boolean {
  const wanted = normalize(channelName);
  if (wanted === '') return false;
  return nodes(resource).some(
    (entry) => entry.isPublished === true && normalize(entry.publication.name) === wanted,
  );
}

/**
 * True only when Shopify explicitly confirmed publication to this publication GID.
 *
 * Preferred over matching by name wherever the channel's id is known: a merchant can
 * rename a custom channel, and two channels can share a display name, but the GID is
 * stable. Headless publication checks use this.
 */
export function isPublishedToPublicationId(
  resource: PublishableResource,
  publicationId: string,
): boolean {
  const wanted = publicationId.trim();
  if (wanted === '') return false;
  return nodes(resource).some(
    (entry) => entry.isPublished === true && entry.publication.id === wanted,
  );
}

/**
 * Online Store publication.
 *
 * Kept as a substring match on the channel name for backwards compatibility with the
 * catalog projection, which has always identified the channel this way because its
 * id differs per shop.
 */
export function isPublishedToOnlineStore(resource: PublishableResource): boolean {
  return nodes(resource).some(
    (entry) => entry.isPublished === true && normalize(entry.publication.name).includes(ONLINE_STORE_CHANNEL),
  );
}

/**
 * The publication entry for a channel, by GID, or null when Shopify did not report it.
 * Callers that must distinguish "unpublished" from "unknown" need the entry, not a boolean.
 */
export function findPublicationById(
  resource: PublishableResource,
  publicationId: string,
): RawPublication | null {
  const wanted = publicationId.trim();
  if (wanted === '') return null;
  return nodes(resource).find((entry) => entry.publication.id === wanted) ?? null;
}


/**
 * Three-valued publication status for a resource on one channel.
 *
 * Mirrors resolveChannelPublication in shopify/publications/visibility.ts, but reads
 * the raw resourcePublicationsV2 payload the catalog already holds rather than the
 * mapped ProductPublicationState, so the projection needs no extra Shopify call.
 *
 * A channel that is not present in the payload is UNKNOWN, never UNPUBLISHED. The
 * app cannot tell "the merchant unpublished it" from "this app cannot see that
 * channel", and only one of those is a merchant decision.
 */
export function resolveChannelPublicationStatus(
  resource: PublishableResource,
  selector: SalesChannelSelector,
): ChannelPublicationStatus {
  const id = selector.publicationId?.trim() ?? '';
  const name = selector.name?.trim().toLowerCase() ?? '';
  if (id === '' && name === '') return 'UNKNOWN';

  const entries = nodes(resource);
  if (entries.length === 0) return 'UNKNOWN';

  let entry: RawPublication | undefined;
  if (id !== '') {
    entry = entries.find((candidate) => candidate.publication.id === id);
  } else {
    entry =
      entries.find((candidate) => normalize(candidate.publication.name) === name) ??
      entries.find((candidate) => normalize(candidate.publication.name).includes(name));
  }

  if (entry === undefined) return 'UNKNOWN';
  return entry.isPublished ? 'PUBLISHED' : 'UNPUBLISHED';
}

/** The Online Store as a selector, for callers that sell through the themed store. */
export const ONLINE_STORE_SELECTOR: SalesChannelSelector = { name: ONLINE_STORE_CHANNEL };
