/**
 * Publication shapes, in a dependency-free module.
 *
 * Separate from publications.service.ts so that visibility.ts - which is pure and
 * must stay unit-testable - can use them without importing the service, and
 * therefore without importing the Shopify client and the config singleton (which
 * calls process.exit(1) on invalid env).
 */

/** A Shopify sales channel. */
export interface Publication {
  id: string;
  name: string;
}

/** A product's state on one channel. */
export interface ProductPublicationState {
  publicationId: string;
  name: string;
  isPublished: boolean;
  publishDate: string | null;
}

/**
 * Publication state on ONE named channel - and it is deliberately three-valued.
 *
 * A boolean cannot express this domain honestly. "Shopify did not report this
 * channel" is not the same fact as "Shopify reported this channel as unpublished",
 * and collapsing the two is how a product with unknown publication ends up treated
 * as deliberately unpublished - or worse, the reverse.
 *
 *   PUBLISHED    Shopify explicitly confirmed isPublished === true.
 *   UNPUBLISHED  Shopify explicitly reported the channel, and it is not published.
 *   UNKNOWN      The app could not see the channel at all: missing
 *                read_publications, a channel that does not exist on this shop, or
 *                no configured identity to look for. Never a licence to sell.
 *
 * Every gate in this codebase treats UNKNOWN exactly as it treats UNPUBLISHED when
 * deciding whether a customer may buy. They are separated so operators are told
 * WHICH problem they have, not so anything becomes sellable.
 */
export type ChannelPublicationStatus = 'PUBLISHED' | 'UNPUBLISHED' | 'UNKNOWN';

/**
 * How to identify a sales channel.
 *
 * `publicationId` is preferred and wins when both are given: a merchant can rename
 * a custom channel at any time, and two channels can share a display name, but the
 * publication GID is stable. `name` exists because the Online Store's id differs
 * per shop, so name matching is the only way to find it generically.
 */
export interface SalesChannelSelector {
  publicationId?: string | null;
  name?: string | null;
}
