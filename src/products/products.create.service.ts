/**
 * Product creation against the Shopify Admin API.
 *
 * THE ORDER OF OPERATIONS IS THE FEATURE
 * --------------------------------------
 *   1. productCreate as DRAFT              (invisible, whatever was requested)
 *   2. productVariantsBulkCreate           (prices, SKUs, barcodes)
 *   3. media is attached during step 1
 *   4. publishablePublish to Online Store
 *   5. VERIFY publication by reading it back
 *   6. only now, set the desired status (ACTIVE)
 *   7. VERIFY the final state and report exactly what is true
 *
 * If step 4 or 5 fails, the product is deliberately LEFT AS DRAFT and the result
 * reports a partial success. That is the safe end state: an unpublished draft
 * costs nothing, whereas an ACTIVE product that was never really published looks
 * live in the admin while being invisible to customers - and an ACTIVE product
 * that IS published but has no variants priced is worse still.
 *
 * `visibleToCustomers` is only ever set from a verified read. Nothing in this
 * module infers visibility from `status`.
 *
 * Requires write_products, plus write_publications to publish.
 */

import { AppError, toAppError } from '../common/errors';
import { logger } from '../common/logger';
import {
  PRODUCT_CREATE_MUTATION,
  PRODUCT_STATUS_UPDATE_MUTATION,
  PRODUCT_VARIANTS_BULK_CREATE_MUTATION,
} from '../shopify/graphql/product.mutations';
import {
  notRequestedOutcome,
  tryGetProductPublicationState,
  tryPublishToOnlineStore,
  type PublicationOutcome,
} from '../shopify/publication.service';
import { shopifyGraphql } from '../shopify/shopify.client';
import { mapUserErrors } from '../shopify/shopify.errors';
import {
  buildMediaInput,
  buildProductCreateInput,
  buildVariantsCreateInput,
  type ProductCreateRequest,
} from './product.create';

type UserErrors = { field?: string[] | null; message?: string }[];

export interface ProductCreateResult {
  shopifyProductId: string;
  title: string;
  /** The status Shopify reports NOW - not the status that was requested. */
  status: string;
  /** What the caller asked for, so a divergence is visible in the response. */
  desiredStatus: string;
  variantsCreated: number;
  mediaAttached: number;
  publication: PublicationOutcome;
  /**
   * The ONLY field a UI may use to tell an operator customers can see this.
   * True requires a verified ACTIVE status AND verified Online Store publication.
   */
  visibleToCustomers: boolean;
  /**
   * True when the product exists but did not reach the requested end state.
   * The product is safe (DRAFT), but the operator has something to finish.
   */
  partialSuccess: boolean;
  /** Human-readable, ordered account of what did not go to plan. */
  warnings: string[];
}

interface CreateResponse {
  productCreate: {
    product: { id: string; title: string; status: string } | null;
    userErrors: UserErrors;
  } | null;
}

interface VariantsResponse {
  productVariantsBulkCreate: {
    productVariants: { id: string }[] | null;
    userErrors: UserErrors;
  } | null;
}

interface StatusUpdateResponse {
  productUpdate: {
    product: { id: string; status: string } | null;
    userErrors: UserErrors;
  } | null;
}

/** Sets the product status. Used only after publication has been confirmed. */
async function setProductStatus(productGid: string, status: string): Promise<string> {
  const result = await shopifyGraphql<StatusUpdateResponse>(
    PRODUCT_STATUS_UPDATE_MUTATION,
    { product: { id: productGid, status } },
    { operation: 'productCreateSetFinalStatus' },
  );
  const userError = mapUserErrors(result.data.productUpdate?.userErrors);
  if (userError !== null) throw userError;

  const applied = result.data.productUpdate?.product?.status ?? null;
  if (applied === null) {
    throw new AppError(
      'SHOPIFY_GRAPHQL_ERROR',
      'Shopify did not report the product status after the update, so the final state could not be confirmed.',
    );
  }
  return applied;
}

/**
 * Creates a product and, if asked, publishes it - reporting only what is true.
 *
 * Never throws once the product exists: from that point on, failures are folded
 * into `warnings` / `partialSuccess` so the caller always learns the product's id
 * and its real state. Throwing after creation would orphan a product the operator
 * does not know about.
 */
export async function createProduct(
  request: ProductCreateRequest,
): Promise<ProductCreateResult> {
  const media = buildMediaInput(request);
  const warnings: string[] = [];

  // --- Step 1: product + default variant + media, always as DRAFT ----------
  const created = await shopifyGraphql<CreateResponse>(
    PRODUCT_CREATE_MUTATION,
    {
      product: buildProductCreateInput(request),
      media: media.length > 0 ? media : undefined,
    },
    { operation: 'productCreate' },
  );

  const createError = mapUserErrors(created.data.productCreate?.userErrors);
  if (createError !== null) throw createError;

  const product = created.data.productCreate?.product ?? null;
  if (product === null) {
    throw new AppError('SHOPIFY_GRAPHQL_ERROR', 'productCreate returned no product.');
  }

  const productId = product.id;
  let currentStatus = product.status;

  // --- Step 2: replace the default standalone variant with the real ones ----
  let variantsCreated = 0;
  const variantInput = buildVariantsCreateInput(request);
  if (variantInput.length > 0) {
    try {
      const variants = await shopifyGraphql<VariantsResponse>(
        PRODUCT_VARIANTS_BULK_CREATE_MUTATION,
        { productId, variants: variantInput },
        { operation: 'productVariantsBulkCreate' },
      );
      const variantError = mapUserErrors(
        variants.data.productVariantsBulkCreate?.userErrors,
      );
      if (variantError !== null) throw variantError;
      variantsCreated =
        variants.data.productVariantsBulkCreate?.productVariants?.length ?? 0;
    } catch (error) {
      // The product exists as a DRAFT with a single default variant. That is a
      // safe, recoverable state - but it must NOT be published or activated,
      // because its prices are not what the operator entered.
      const appError = toAppError(error);
      logger.warn('Variant creation failed; leaving the product as an unpublished draft.', {
        shopifyProductId: productId,
        code: appError.code,
      });
      warnings.push(
        `Variants could not be created (${appError.code}: ${appError.message}). The product was left as a DRAFT with Shopify's default variant, and was NOT published - its prices are not the ones you entered. Fix the variants, then publish it.`,
      );

      return {
        shopifyProductId: productId,
        title: product.title,
        status: currentStatus,
        desiredStatus: request.desiredStatus,
        variantsCreated: 0,
        mediaAttached: media.length,
        publication: notRequestedOutcome(),
        visibleToCustomers: false,
        partialSuccess: true,
        warnings,
      };
    }
  }

  // --- Steps 4/5: publish, then verify -------------------------------------
  let publication: PublicationOutcome = notRequestedOutcome();
  if (request.publishToOnlineStore) {
    const attempt = await tryPublishToOnlineStore(productId);
    publication = attempt.outcome;

    if (!publication.published) {
      // The whole point of P0: publication failed, so the product STAYS DRAFT.
      warnings.push(
        `The product was created but could NOT be published to the Online Store (${publication.error?.code ?? 'PUBLICATION_FAILED'}: ${publication.error?.message ?? 'unknown reason'}). It has been left as a DRAFT and is not visible to customers. Retry publishing from the product page once the cause is fixed.`,
      );
      return {
        shopifyProductId: productId,
        title: product.title,
        status: currentStatus,
        desiredStatus: request.desiredStatus,
        variantsCreated,
        mediaAttached: media.length,
        publication,
        visibleToCustomers: false,
        partialSuccess: true,
        warnings,
      };
    }
  }

  // --- Step 6: only now apply the desired status ----------------------------
  if (request.desiredStatus !== currentStatus) {
    try {
      currentStatus = await setProductStatus(productId, request.desiredStatus);
    } catch (error) {
      const appError = toAppError(error);
      logger.warn('Final status update failed after a successful publication.', {
        shopifyProductId: productId,
        desiredStatus: request.desiredStatus,
        code: appError.code,
      });
      warnings.push(
        `The product was created${publication.published ? ' and published' : ''}, but its status could not be set to ${request.desiredStatus} (${appError.code}: ${appError.message}). It remains ${currentStatus}, so customers cannot see it yet.`,
      );
    }
  }

  // --- Step 7: verify the final state --------------------------------------
  //
  // Read back rather than assembling the answer from what we believe we did.
  // This is what makes `visibleToCustomers` trustworthy.
  let visibleToCustomers = false;
  const finalState = await tryGetProductPublicationState(productId);
  if (finalState !== null) {
    currentStatus = finalState.status;
    visibleToCustomers = finalState.visibleToCustomers;
    if (request.publishToOnlineStore && !finalState.visibleToCustomers) {
      warnings.push(
        `Final check: Shopify reports status=${finalState.status} and publishedToOnlineStore=${finalState.publishedToOnlineStore}, so the product is NOT yet visible to customers.`,
      );
    }
  } else if (request.publishToOnlineStore) {
    // Publication was verified in step 5, but the final combined read failed.
    // Refuse to upgrade that into a visibility claim.
    warnings.push(
      'The final state could not be re-read from Shopify, so Trademart cannot confirm the product is visible to customers. Check the product page.',
    );
  }

  const partialSuccess = warnings.length > 0;

  logger.info('Created Shopify product.', {
    shopifyProductId: productId,
    status: currentStatus,
    desiredStatus: request.desiredStatus,
    variantsCreated,
    mediaAttached: media.length,
    publicationRequested: publication.requested,
    publicationVerified: publication.published,
    visibleToCustomers,
    partialSuccess,
  });

  return {
    shopifyProductId: productId,
    title: product.title,
    status: currentStatus,
    desiredStatus: request.desiredStatus,
    variantsCreated,
    mediaAttached: media.length,
    publication,
    visibleToCustomers,
    partialSuccess,
    warnings,
  };
}
