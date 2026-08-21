/**
 * Publication (Online Store visibility) operations.
 *
 * THE RULE THIS MODULE EXISTS TO ENFORCE
 * --------------------------------------
 * Trademart must never tell an operator "customers can see it" unless Shopify
 * has confirmed BOTH halves:
 *
 *     status === 'ACTIVE'   AND   publishedOnPublication(onlineStore) === true
 *
 * So every write here is followed by an explicit read-back. A mutation that
 * returned no userErrors is evidence that Shopify accepted the request, not that
 * the resulting state is what we wanted - those are different claims, and only
 * the second one is safe to show a human.
 *
 * Scopes: read_publications to read, write_publications to change.
 */

import { AppError, toAppError } from '../common/errors';
import { logger } from '../common/logger';
import { config } from '../config';
import {
  PRODUCT_PUBLICATION_STATE_QUERY,
  PUBLICATIONS_QUERY_CATALOG,
  PUBLICATIONS_QUERY_NAMED,
  PUBLISHABLE_PUBLISH_MUTATION,
  PUBLISHABLE_UNPUBLISH_MUTATION,
} from './graphql/publication.queries';
import { shopifyGraphql } from './shopify.client';
import { mapUserErrors } from './shopify.errors';

/** How many publications to scan. A shop with more than this is unusual. */
const PUBLICATION_PAGE_SIZE = 50;
/**
 * The publication is a stable property of the shop, so it is cached for a long
 * time. The point is that publishing a product must not cost an extra
 * publications lookup every time - that is rate-limit budget spent on a value
 * that effectively never changes.
 */
const PUBLICATION_CACHE_TTL_MS = 30 * 60_000;

/** Shopify's name for the storefront channel. */
const ONLINE_STORE_NAMES = ['online store'];

export interface PublicationRef {
  id: string;
  name: string;
}

/** Verified publication state for one product, as Shopify reports it. */
export interface ProductPublicationState {
  shopifyProductId: string;
  title: string | null;
  status: string;
  publicationId: string;
  publicationName: string;
  /** Shopify's own answer, never inferred from status. */
  publishedToOnlineStore: boolean;
  /**
   * The only field the UI should use to claim customer visibility.
   * ACTIVE-but-unpublished and DRAFT-but-published are both false.
   */
  visibleToCustomers: boolean;
  checkedAt: string;
}

/**
 * The outcome of a publication ATTEMPT, including the failure case.
 *
 * Returned rather than thrown by the create flow, because "the product exists
 * but is not published" is a real, safe state that must be reported honestly
 * instead of collapsing into a generic error.
 */
export interface PublicationOutcome {
  /** Did the caller ask for publication at all? */
  requested: boolean;
  /** Did we get as far as calling Shopify? */
  attempted: boolean;
  /** VERIFIED by read-back. Never set from a mutation's return value alone. */
  published: boolean;
  publicationId: string | null;
  publicationName: string | null;
  verifiedAt: string | null;
  error: { code: string; message: string } | null;
}

export function notRequestedOutcome(): PublicationOutcome {
  return {
    requested: false,
    attempted: false,
    published: false,
    publicationId: null,
    publicationName: null,
    verifiedAt: null,
    error: null,
  };
}

let publicationCache: { value: PublicationRef; expiresAt: number } | null = null;

/** Test/diagnostic hook: forces the next resolve to hit Shopify again. */
export function clearPublicationCache(): void {
  publicationCache = null;
}

interface NamedPublicationsResponse {
  publications: { edges: { node: { id: string; name?: string | null } }[] } | null;
}

interface CatalogPublicationsResponse {
  publications: {
    edges: { node: { id: string; catalog?: { title?: string | null } | null } }[];
  } | null;
}

/**
 * Lists publications, tolerating the `name` -> `catalog.title` migration.
 *
 * The named document is tried first because it is the cheaper query and is what
 * most API versions still accept. A GraphQL-level rejection (the field does not
 * exist on this schema) falls through to the catalog form. A SCOPE failure is
 * NOT retried - a second identical-permission query would fail identically and
 * the operator needs to see the real reason.
 */
async function listPublications(): Promise<PublicationRef[]> {
  try {
    const result = await shopifyGraphql<NamedPublicationsResponse>(
      PUBLICATIONS_QUERY_NAMED,
      { first: PUBLICATION_PAGE_SIZE },
      { operation: 'listPublications' },
    );
    return (result.data.publications?.edges ?? []).map((edge) => ({
      id: edge.node.id,
      name: edge.node.name ?? '',
    }));
  } catch (error) {
    const appError = toAppError(error);
    if (appError.code !== 'SHOPIFY_GRAPHQL_ERROR') throw appError;

    logger.info(
      'publications(name) was rejected; retrying with catalog.title (newer Admin API schema).',
      { reason: appError.message },
    );
    const result = await shopifyGraphql<CatalogPublicationsResponse>(
      PUBLICATIONS_QUERY_CATALOG,
      { first: PUBLICATION_PAGE_SIZE },
      { operation: 'listPublications:catalog' },
    );
    return (result.data.publications?.edges ?? []).map((edge) => ({
      id: edge.node.id,
      name: edge.node.catalog?.title ?? '',
    }));
  }
}

/**
 * Resolves the Online Store publication.
 *
 * An explicit SHOPIFY_ONLINE_STORE_PUBLICATION_ID short-circuits the lookup
 * entirely, which is the escape hatch for a shop whose channels are named
 * unusually.
 */
export async function resolveOnlineStorePublication(): Promise<PublicationRef> {
  const pinned = config.shopify.onlineStorePublicationId;
  if (pinned !== null) {
    return { id: pinned, name: 'Online Store (pinned by configuration)' };
  }

  if (publicationCache !== null && publicationCache.expiresAt > Date.now()) {
    return publicationCache.value;
  }

  const publications = await listPublications();
  const match = publications.find((publication) =>
    ONLINE_STORE_NAMES.includes(publication.name.trim().toLowerCase()),
  );

  if (match === undefined) {
    // Listing what WAS found is the difference between a dead end and a fixable
    // problem: the operator can pin the right id with one env var.
    throw new AppError(
      'PUBLICATION_FAILED',
      'Could not find the "Online Store" sales channel on this shop, so publication state cannot be read or changed. Set SHOPIFY_ONLINE_STORE_PUBLICATION_ID to the correct gid://shopify/Publication/... value.',
      {
        details: {
          publicationsFound: publications.map((publication) => publication.name),
        },
      },
    );
  }

  publicationCache = { value: match, expiresAt: Date.now() + PUBLICATION_CACHE_TTL_MS };
  return match;
}

interface ProductStateResponse {
  product: {
    id: string;
    title?: string | null;
    status: string;
    publishedOnPublication: boolean;
  } | null;
}

/**
 * Reads the verified publication state of one product.
 *
 * This is the single source of truth for "can a customer see this?" and is used
 * by the create flow, the approve flow and the integrity diagnostics alike, so
 * all three necessarily agree.
 */
export async function getProductPublicationState(
  productGid: string,
): Promise<ProductPublicationState> {
  const publication = await resolveOnlineStorePublication();

  const result = await shopifyGraphql<ProductStateResponse>(
    PRODUCT_PUBLICATION_STATE_QUERY,
    { id: productGid, publicationId: publication.id },
    { operation: 'getProductPublicationState' },
  );

  const product = result.data.product;
  if (product === null || product === undefined) {
    throw new AppError(
      'SHOPIFY_NOT_FOUND',
      `No Shopify product found for id ${productGid}.`,
    );
  }

  const publishedToOnlineStore = product.publishedOnPublication === true;
  const status = product.status;

  return {
    shopifyProductId: product.id,
    title: product.title ?? null,
    status,
    publicationId: publication.id,
    publicationName: publication.name,
    publishedToOnlineStore,
    // Both halves. This is the whole point of the module.
    visibleToCustomers: status === 'ACTIVE' && publishedToOnlineStore,
    checkedAt: new Date().toISOString(),
  };
}

interface PublishResponse {
  publishablePublish: {
    publishable: { id?: string; status?: string } | null;
    userErrors: { field?: string[] | null; message?: string }[];
  } | null;
}

interface UnpublishResponse {
  publishableUnpublish: {
    publishable: { id?: string; status?: string } | null;
    userErrors: { field?: string[] | null; message?: string }[];
  } | null;
}

/**
 * Publishes a product to the Online Store and VERIFIES the result.
 *
 * Throws PUBLICATION_FAILED when the read-back does not confirm publication,
 * even if the mutation itself reported success. A mutation that "worked" but left
 * the product unpublished is precisely the case that would otherwise produce a
 * false "customers can see it".
 */
export async function publishToOnlineStore(
  productGid: string,
): Promise<ProductPublicationState> {
  const publication = await resolveOnlineStorePublication();

  const result = await shopifyGraphql<PublishResponse>(
    PUBLISHABLE_PUBLISH_MUTATION,
    { id: productGid, input: [{ publicationId: publication.id }] },
    { operation: 'publishablePublish' },
  );

  const userError = mapUserErrors(result.data.publishablePublish?.userErrors);
  if (userError !== null) {
    throw new AppError(
      'PUBLICATION_FAILED',
      `Shopify refused to publish the product to the Online Store: ${userError.message}`,
      { details: userError.details },
    );
  }

  const state = await getProductPublicationState(productGid);
  if (!state.publishedToOnlineStore) {
    throw new AppError(
      'PUBLICATION_FAILED',
      'Shopify accepted the publish request but the product still reports as NOT published to the Online Store. It has been left as-is; nothing is claiming it is visible.',
      { details: { shopifyProductId: productGid, publicationId: publication.id } },
    );
  }

  logger.info('Published product to the Online Store.', {
    shopifyProductId: productGid,
    publicationId: publication.id,
    status: state.status,
    verified: true,
  });
  return state;
}

/** Removes a product from the Online Store and verifies it is gone. */
export async function unpublishFromOnlineStore(
  productGid: string,
): Promise<ProductPublicationState> {
  const publication = await resolveOnlineStorePublication();

  const result = await shopifyGraphql<UnpublishResponse>(
    PUBLISHABLE_UNPUBLISH_MUTATION,
    { id: productGid, input: [{ publicationId: publication.id }] },
    { operation: 'publishableUnpublish' },
  );

  const userError = mapUserErrors(result.data.publishableUnpublish?.userErrors);
  if (userError !== null) {
    throw new AppError(
      'PUBLICATION_FAILED',
      `Shopify refused to unpublish the product from the Online Store: ${userError.message}`,
      { details: userError.details },
    );
  }

  const state = await getProductPublicationState(productGid);
  if (state.publishedToOnlineStore) {
    // Failing to HIDE something is the more dangerous direction, so this is
    // reported just as loudly as a failed publish.
    throw new AppError(
      'PUBLICATION_FAILED',
      'Shopify accepted the unpublish request but the product still reports as published to the Online Store. Treat it as still visible to customers.',
      { details: { shopifyProductId: productGid, publicationId: publication.id } },
    );
  }

  logger.info('Unpublished product from the Online Store.', {
    shopifyProductId: productGid,
    publicationId: publication.id,
    verified: true,
  });
  return state;
}

/**
 * Publishes without throwing, returning a structured outcome instead.
 *
 * Used by multi-step flows (create-then-publish, approve-then-publish) where the
 * caller must keep going - to leave the product safely DRAFT and report a
 * partial success - rather than unwinding on the first failure.
 */
export async function tryPublishToOnlineStore(
  productGid: string,
): Promise<{ outcome: PublicationOutcome; state: ProductPublicationState | null }> {
  let publicationId: string | null = null;
  let publicationName: string | null = null;

  try {
    const publication = await resolveOnlineStorePublication();
    publicationId = publication.id;
    publicationName = publication.name;

    const state = await publishToOnlineStore(productGid);
    return {
      outcome: {
        requested: true,
        attempted: true,
        published: true,
        publicationId: state.publicationId,
        publicationName: state.publicationName,
        verifiedAt: state.checkedAt,
        error: null,
      },
      state,
    };
  } catch (error) {
    const appError = toAppError(error);
    logger.warn('Publication failed; leaving the product unpublished.', {
      shopifyProductId: productGid,
      code: appError.code,
      reason: appError.message,
    });
    return {
      outcome: {
        requested: true,
        // `attempted` distinguishes "we could not even work out where to publish"
        // from "we asked Shopify and it refused".
        attempted: publicationId !== null,
        published: false,
        publicationId,
        publicationName,
        verifiedAt: null,
        error: { code: appError.code, message: appError.message },
      },
      state: null,
    };
  }
}

/**
 * Best-effort publication state for read paths (product lists, diagnostics).
 *
 * Returns null instead of throwing when publication cannot be read at all - a
 * missing read_publications scope should degrade the visibility column to
 * "unknown", not fail the whole page. Reporting unknown is honest; inferring it
 * from `status` would not be.
 */
export async function tryGetProductPublicationState(
  productGid: string,
): Promise<ProductPublicationState | null> {
  try {
    return await getProductPublicationState(productGid);
  } catch (error) {
    const appError = toAppError(error);
    logger.info('Publication state unavailable for product.', {
      shopifyProductId: productGid,
      code: appError.code,
    });
    return null;
  }
}
