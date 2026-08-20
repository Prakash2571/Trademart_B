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

/** A product's current publication state across all channels. */
export async function getProductPublications(
  shopifyProductId: string,
): Promise<ProductPublicationState[]> {
  const result = await shopifyGraphql<{
    product: {
      resourcePublicationsV2: {
        nodes: {
          isPublished: boolean;
          publishDate: string | null;
          publication: Publication;
        }[];
      };
    } | null;
  }>(PRODUCT_PUBLICATIONS_QUERY, { id: shopifyProductId }, { operation: 'getProductPublications' });

  const nodes = result.data.product?.resourcePublicationsV2?.nodes ?? [];
  return nodes.map((node) => ({
    publicationId: node.publication.id,
    name: node.publication.name,
    isPublished: node.isPublished,
    publishDate: node.publishDate ?? null,
  }));
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
