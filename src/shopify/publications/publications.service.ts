/**
 * Publication (sales-channel) service.
 *
 * Publishing is distinct from a product's ACTIVE status: ACTIVE only lifts the
 * draft/archived flag, while publishing makes the product visible on a channel.
 * Publication ids are discovered per shop, never hardcoded.
 *
 * Publish/unpublish need write_publications; listing needs read_publications.
 */

import { AppError } from '../../common/errors';
import { logger } from '../../common/logger';
import { mapUserErrors } from '../shopify.errors';
import { shopifyGraphql } from '../shopify.client';
import {
  PRODUCT_PUBLICATIONS_QUERY,
  PUBLICATIONS_QUERY,
  PUBLISHABLE_PUBLISH_MUTATION,
  PUBLISHABLE_UNPUBLISH_MUTATION,
} from './publication.queries';

type UserErrors = { field?: string[] | null; message?: string }[];

export interface Publication {
  id: string;
  name: string;
}

export interface ProductPublicationState {
  publicationId: string;
  name: string;
  isPublished: boolean;
  publishDate: string | null;
}

export interface PublishResult {
  shopifyProductId: string;
  /** Publications the product was published to in this call. */
  published: Publication[];
  /** Full current publication state after the operation. */
  state: ProductPublicationState[];
}

/** Lists the store's publications (sales channels). Requires read_publications. */
export async function listPublications(): Promise<Publication[]> {
  const result = await shopifyGraphql<{ publications: { nodes: Publication[] } }>(
    PUBLICATIONS_QUERY,
    {},
    { operation: 'listPublications' },
  );
  return result.data.publications?.nodes ?? [];
}

/**
 * The Online Store publication, or null when the store has none visible to the
 * app. Matched by name because the id differs per shop; Shopify names this
 * channel "Online Store".
 */
export async function findOnlineStorePublication(): Promise<Publication | null> {
  const publications = await listPublications();
  return (
    publications.find((publication) => publication.name.toLowerCase() === 'online store') ??
    publications.find((publication) => publication.name.toLowerCase().includes('online store')) ??
    null
  );
}

/**
 * Whether customers can actually see a product, and why.
 *
 * VISIBILITY IS A CONJUNCTION, AND BOTH HALVES ARE EASY TO GET WRONG:
 *
 *   status === 'ACTIVE'          means "not draft and not archived". It does NOT
 *                                mean published. An ACTIVE product that is not on
 *                                the Online Store is invisible while looking live
 *                                in the Shopify admin - the bug that motivated
 *                                this whole module.
 *   published to Online Store    does NOT mean visible either. A DRAFT product
 *                                published to the channel is still hidden.
 *
 * So visibility is `ACTIVE && published to the Online Store`, and it is computed
 * in ONE place that both the API and the UI read, rather than being re-derived by
 * each caller - which is how the two halves drift apart.
 *
 * Publication to some OTHER channel (POS, a marketplace) deliberately does not
 * count. It is real publication, but it does not put the product on the web
 * storefront, and "visible" in this product means "a customer browsing the shop
 * can find it".
 *
 * `reason` is always populated, because a bare `false` sends an operator hunting
 * through Shopify to work out which half is missing.
 */
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
  reason: string;
}

interface ProductPublicationsResponse {
  product: {
    status: string | null;
    resourcePublicationsV2: {
      nodes: {
        isPublished: boolean;
        publishDate: string | null;
        publication: Publication;
      }[];
    };
  } | null;
}

async function fetchProductPublications(
  shopifyProductId: string,
): Promise<ProductPublicationsResponse['product']> {
  const result = await shopifyGraphql<ProductPublicationsResponse>(
    PRODUCT_PUBLICATIONS_QUERY,
    { id: shopifyProductId },
    { operation: 'getProductPublications' },
  );
  return result.data.product ?? null;
}

function toState(
  product: ProductPublicationsResponse['product'],
): ProductPublicationState[] {
  const nodes = product?.resourcePublicationsV2?.nodes ?? [];
  return nodes.map((node) => ({
    publicationId: node.publication.id,
    name: node.publication.name,
    isPublished: node.isPublished,
    publishDate: node.publishDate ?? null,
  }));
}

/** A product's current publication state across all channels. */
export async function getProductPublications(
  shopifyProductId: string,
): Promise<ProductPublicationState[]> {
  return toState(await fetchProductPublications(shopifyProductId));
}

/**
 * The visibility decision, as a pure function.
 *
 * Split out from the Shopify call so it can be unit tested exhaustively with no
 * network - which matters because this is the rule the entire "is it on sale?"
 * story depends on, and every branch of it is a bug someone has actually hit.
 */
export function decideVisibility(input: {
  shopifyProductId: string;
  status: string | null;
  publications: ProductPublicationState[];
}): ProductVisibility {
  const { shopifyProductId, status, publications } = input;

  const onlineStore =
    publications.find((entry) => entry.name.toLowerCase() === 'online store') ??
    publications.find((entry) => entry.name.toLowerCase().includes('online store')) ??
    null;

  const publishedAnywhere = publications.some((entry) => entry.isPublished);
  const onOnlineStore = onlineStore?.isPublished === true;
  const isActive = status === 'ACTIVE';
  const visibleToCustomers = isActive && onOnlineStore;

  let reason: string;
  if (visibleToCustomers) {
    reason = 'Status is ACTIVE and the product is published to the Online Store.';
  } else if (status === null) {
    // Fail loud rather than reporting a confident `false`: without the status the
    // answer is unknown, and claiming "not visible" could be wrong.
    reason =
      'Shopify did not return the product status, so visibility cannot be determined. read_products is required.';
  } else if (!isActive && !onOnlineStore) {
    reason = `Status is ${status} and the product is not published to the Online Store, so customers cannot see it.`;
  } else if (!isActive) {
    reason = `The product is published to the Online Store but its status is ${status}, so it is still hidden. Setting it ACTIVE would make it visible immediately.`;
  } else if (onlineStore === null) {
    reason = publishedAnywhere
      ? 'Status is ACTIVE and the product is published to another channel, but no Online Store publication is visible to this app, so web-storefront visibility cannot be confirmed. read_publications is required.'
      : 'Status is ACTIVE but no Online Store publication is visible to this app, so the product cannot be confirmed as on sale. read_publications is required.';
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

/** Publication state plus the single, honest "can customers see this?" answer. */
export async function getProductVisibility(
  shopifyProductId: string,
): Promise<ProductVisibility> {
  const product = await fetchProductPublications(shopifyProductId);
  return decideVisibility({
    shopifyProductId,
    status: product?.status ?? null,
    publications: toState(product),
  });
}

/**
 * Publishes a product to the given publications, or to the Online Store when
 * none are specified.
 *
 * Throws (rather than guessing) when no publication can be resolved, so a caller
 * never silently publishes to the wrong channel or to nothing.
 */
export async function publishProduct(
  shopifyProductId: string,
  publicationIds?: string[],
): Promise<PublishResult> {
  let targets: Publication[];

  if (publicationIds !== undefined && publicationIds.length > 0) {
    const all = await listPublications();
    const byId = new Map(all.map((publication) => [publication.id, publication]));
    const unknown = publicationIds.filter((id) => !byId.has(id));
    if (unknown.length > 0) {
      throw new AppError(
        'VALIDATION_ERROR',
        `Unknown publication id(s): ${unknown.join(', ')}. Call GET /api/shopify/publications for valid ids.`,
      );
    }
    targets = publicationIds.map((id) => byId.get(id) as Publication);
  } else {
    const onlineStore = await findOnlineStorePublication();
    if (onlineStore === null) {
      const available = (await listPublications()).map((p) => p.name).join(', ') || 'none';
      throw new AppError(
        'SHOPIFY_GRAPHQL_ERROR',
        `No Online Store publication was found, so there is no default channel to publish to. Pass explicit publicationIds. Available publications: ${available}.`,
      );
    }
    targets = [onlineStore];
  }

  const result = await shopifyGraphql<{
    publishablePublish: { userErrors: UserErrors } | null;
  }>(
    PUBLISHABLE_PUBLISH_MUTATION,
    { id: shopifyProductId, input: targets.map((publication) => ({ publicationId: publication.id })) },
    { operation: 'publishablePublish' },
  );

  const error = mapUserErrors(result.data.publishablePublish?.userErrors);
  if (error !== null) throw error;

  logger.info('Published product to publications.', {
    shopifyProductId,
    publications: targets.map((publication) => publication.name),
  });

  return {
    shopifyProductId,
    published: targets,
    state: await getProductPublications(shopifyProductId),
  };
}

/** Removes a product from the given publications (or the Online Store). */
export async function unpublishProduct(
  shopifyProductId: string,
  publicationIds?: string[],
): Promise<PublishResult> {
  let targets: Publication[];

  if (publicationIds !== undefined && publicationIds.length > 0) {
    const all = await listPublications();
    const byId = new Map(all.map((publication) => [publication.id, publication]));
    targets = publicationIds
      .filter((id) => byId.has(id))
      .map((id) => byId.get(id) as Publication);
    if (targets.length === 0) {
      throw new AppError(
        'VALIDATION_ERROR',
        'None of the supplied publicationIds exist for this store.',
      );
    }
  } else {
    const onlineStore = await findOnlineStorePublication();
    if (onlineStore === null) {
      throw new AppError(
        'SHOPIFY_GRAPHQL_ERROR',
        'No Online Store publication was found; pass explicit publicationIds to unpublish.',
      );
    }
    targets = [onlineStore];
  }

  const result = await shopifyGraphql<{
    publishableUnpublish: { userErrors: UserErrors } | null;
  }>(
    PUBLISHABLE_UNPUBLISH_MUTATION,
    { id: shopifyProductId, input: targets.map((publication) => ({ publicationId: publication.id })) },
    { operation: 'publishableUnpublish' },
  );

  const error = mapUserErrors(result.data.publishableUnpublish?.userErrors);
  if (error !== null) throw error;

  logger.info('Unpublished product from publications.', {
    shopifyProductId,
    publications: targets.map((publication) => publication.name),
  });

  return {
    shopifyProductId,
    published: targets,
    state: await getProductPublications(shopifyProductId),
  };
}
