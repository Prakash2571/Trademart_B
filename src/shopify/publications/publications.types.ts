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
