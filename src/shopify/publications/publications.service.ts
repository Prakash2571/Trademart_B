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
import { config } from '../../config';
import { impliedScopes } from '../capabilities';
import {
  resolveHeadlessChannelStatus,
  type HeadlessChannelStatus,
} from './headless.status';
import { verifyPublicationState } from './publication.verify';
import type {
  Publication,
  ProductPublicationState,
  SalesChannelSelector,
} from './publications.types';
import {
  resolveCustomerVisibility,
  resolveHeadlessVisibility,
  type ProductVisibility,
  type HeadlessVisibility,
} from './visibility';

type UserErrors = { field?: string[] | null; message?: string }[];

// Re-exported so existing importers of these types from this module keep working;
// they now live in publications.types.ts so the pure visibility module can use them
// without importing the Shopify client (and therefore the config singleton).
export type {
  Publication,
  ProductPublicationState,
  ChannelPublicationStatus,
  SalesChannelSelector,
} from './publications.types';
export type { ProductVisibility, HeadlessVisibility } from './visibility';
export type { HeadlessChannelStatus } from './headless.status';

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

/** Publication state plus the single, honest "can customers see this?" answer. */
export async function getProductVisibility(
  shopifyProductId: string,
): Promise<ProductVisibility> {
  const product = await fetchProductPublications(shopifyProductId);
  return resolveCustomerVisibility({
    shopifyProductId,
    status: product?.status ?? null,
    publications: toState(product),
  });
}

/* ===========================================================================
 * HEADLESS SALES CHANNEL
 *
 * The custom storefront is a separate publication from the themed Online Store.
 * Nothing here falls back to the Online Store: publishing to the wrong channel is
 * worse than refusing, because it silently exposes a product on a storefront the
 * operator did not choose.
 * =========================================================================== */

/** The configured headless channel identity, or null when none is configured. */
export function headlessChannelSelector(): SalesChannelSelector | null {
  const publicationId = config.shopify.headlessPublicationId;
  const name = config.shopify.headlessChannelName;
  if (publicationId === null && name === null) return null;
  return { publicationId, name };
}

/** True when an operator has told Trademart which channel is the custom storefront. */
export const isHeadlessChannelConfigured = (): boolean => headlessChannelSelector() !== null;

/**
 * The configured headless publication as Shopify reports it, or null.
 *
 * Resolved against the live publication list so a stale or wrong id surfaces as
 * "not found" here rather than as a confusing userError from the mutation.
 */
export async function findHeadlessPublication(): Promise<Publication | null> {
  const selector = headlessChannelSelector();
  if (selector === null) return null;

  const publications = await listPublications();

  const id = selector.publicationId?.trim();
  if (id !== undefined && id !== '') {
    return publications.find((publication) => publication.id === id) ?? null;
  }

  const name = selector.name?.trim().toLowerCase();
  if (name === undefined || name === '') return null;
  return (
    publications.find((publication) => publication.name.trim().toLowerCase() === name) ??
    publications.find((publication) => publication.name.trim().toLowerCase().includes(name)) ??
    null
  );
}

/**
 * Operational readiness of the headless channel, for the operator console.
 *
 * `granted` is the app's scope list, or null when the token strategy does not report
 * scopes (static tokens do not). Null is treated as "assume the scope is present"
 * ONLY for reporting: a real Shopify call still fails loudly if it is not, and
 * reporting SCOPE_MISSING on a working deployment would be the worse lie.
 */
export async function getHeadlessChannelStatus(
  granted: readonly string[] | null,
): Promise<HeadlessChannelStatus> {
  const selector = headlessChannelSelector();

  const has = (scope: string): boolean =>
    granted === null ? true : impliedScopes(granted).has(scope);
  const canReadPublications = has('read_publications');
  const canPublish = has('write_publications');

  // Only ask Shopify when the answer could be meaningful. An unconfigured channel
  // or a missing read scope makes the lookup pointless, and a failed lookup here
  // would be reported as "not found", which is a different and misleading problem.
  let resolved: Publication | null = null;
  if (selector !== null && canReadPublications) {
    resolved = await findHeadlessPublication();
  }

  return resolveHeadlessChannelStatus({
    selector,
    resolved,
    canReadPublications,
    canPublish,
  });
}

/**
 * "Can a customer buy this on the custom headless storefront?"
 *
 * Requires ACTIVE status AND confirmed publication to the headless channel. With no
 * headless channel configured the answer is an explicit UNKNOWN, never a hopeful yes.
 */
export async function getHeadlessVisibility(
  shopifyProductId: string,
): Promise<HeadlessVisibility> {
  const product = await fetchProductPublications(shopifyProductId);
  return resolveHeadlessVisibility({
    shopifyProductId,
    status: product?.status ?? null,
    publications: toState(product),
    headlessChannel: headlessChannelSelector() ?? {},
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

  // READ-BACK VERIFICATION.
  //
  // An empty userErrors array means Shopify accepted the mutation, NOT that the
  // product is now published. The state was already being re-fetched here and then
  // returned unexamined, so a write that silently did not take effect was reported
  // to the operator as a success - and a product believed published but absent from
  // the channel is exactly the failure this module exists to prevent.
  const state = await getProductPublications(shopifyProductId);
  assertPublicationState(shopifyProductId, targets, state, 'published');

  logger.info('Published product to publications, verified by read-back.', {
    shopifyProductId,
    publications: targets.map((publication) => publication.name),
  });

  return { shopifyProductId, published: targets, state };
}

/** Confirms the post-write state matches intent, or throws. Rule lives in publication.verify.ts. */
function assertPublicationState(
  shopifyProductId: string,
  targets: Publication[],
  state: ProductPublicationState[],
  expected: 'published' | 'unpublished',
): void {
  const failures = verifyPublicationState({ targets, state, expected });
  if (failures.length === 0) return;

  throw new AppError(
    'SHOPIFY_GRAPHQL_ERROR',
    `Shopify accepted the ${expected === 'published' ? 'publish' : 'unpublish'} but the read-back did not confirm it for product ${shopifyProductId}: ${failures.join('; ')}. The channel state is NOT what was requested; do not treat this product as ${expected}.`,
  );
}

/**
 * Publishes to the configured headless channel, verified by read-back.
 *
 * Refuses rather than defaulting to the Online Store when no headless channel is
 * configured or the configured one cannot be found.
 */
export async function publishProductToHeadless(
  shopifyProductId: string,
): Promise<PublishResult> {
  const selector = headlessChannelSelector();
  if (selector === null) {
    throw new AppError(
      'VALIDATION_ERROR',
      'No headless sales channel is configured, so there is no custom storefront to publish to. Set SHOPIFY_HEADLESS_PUBLICATION_ID (preferred) or SHOPIFY_HEADLESS_CHANNEL_NAME.',
    );
  }

  const headless = await findHeadlessPublication();
  if (headless === null) {
    const available = (await listPublications()).map((p) => p.name).join(', ') || 'none';
    throw new AppError(
      'SHOPIFY_GRAPHQL_ERROR',
      `The configured headless sales channel (${selector.publicationId ?? selector.name}) is not visible to this app, so publishing would target the wrong storefront. Available publications: ${available}.`,
    );
  }

  return publishProduct(shopifyProductId, [headless.id]);
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

  // Verified for the same reason as publishing: "Shopify accepted it" is not
  // "the product is off the channel". An unpublish believed done but not done
  // leaves a product buyable that the operator thinks they withdrew.
  const state = await getProductPublications(shopifyProductId);
  assertPublicationState(shopifyProductId, targets, state, 'unpublished');

  logger.info('Unpublished product from publications, verified by read-back.', {
    shopifyProductId,
    publications: targets.map((publication) => publication.name),
  });

  return { shopifyProductId, published: targets, state };
}
