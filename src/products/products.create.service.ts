/**
 * Product creation against the Shopify Admin API.
 *
 * Runs the two-step model: productCreate (product + default variant + media),
 * then productVariantsBulkCreate with REMOVE_STANDALONE_VARIANT to install the
 * real variants. Validation lives in product.create.ts (pure); this only calls.
 *
 * The product is created as DRAFT by default (see validateProductCreate), so a
 * new/imported product never lands on the storefront unreviewed - matching the
 * review-gate principle the automation layer already follows.
 *
 * Requires the write_products scope.
 */

import { AppError } from '../common/errors';
import { logger } from '../common/logger';
import {
  PRODUCT_CREATE_MUTATION,
  PRODUCT_STATUS_UPDATE_MUTATION,
  PRODUCT_VARIANTS_BULK_CREATE_MUTATION,
} from '../shopify/graphql/product.mutations';
import {
  getProductPublications,
  publishProduct,
} from '../shopify/publications/publications.service';
import { shopifyGraphql } from '../shopify/shopify.client';
import { mapUserErrors } from '../shopify/shopify.errors';
import {
  buildMediaInput,
  buildProductCreateInput,
  buildVariantsCreateInput,
  type ProductCreateRequest,
} from './product.create';

type UserErrors = { field?: string[] | null; message?: string }[];

/**
 * A created variant with enough identity to map it back to the form row the
 * operator entered, so manual costs can be saved against the real Shopify
 * variant id without a second round-trip or assuming input order.
 */
export interface CreatedVariant {
  shopifyVariantId: string;
  sku: string | null;
  optionValues: { name: string; value: string }[];
}

export interface ProductCreateResult {
  shopifyProductId: string;
  title: string;
  /** Final status: DRAFT unless publish was requested AND verified. */
  status: string;
  variantsCreated: number;
  mediaAttached: number;
  /** True only when publication to a sales channel was requested and verified. */
  published: boolean;
  /** Set when publish was requested but failed; the product was left DRAFT. */
  publishError: string | null;
  /**
   * What the caller ASKED for, so a divergence from `status` is visible in the
   * response instead of having to be inferred.
   */
  desiredStatus: string;
  /**
   * The ONLY field a UI may use to tell an operator customers can see this.
   * Requires a verified ACTIVE status AND a verified sales-channel publication -
   * never inferred from `status` alone, which is wrong in both directions.
   */
  visibleToCustomers: boolean;
  /**
   * True when the product EXISTS but did not reach the requested end state. The
   * product is safe (DRAFT), but the operator has something left to finish.
   */
  partialSuccess: boolean;
  /** Ordered, human-readable account of what did not go to plan. */
  warnings: string[];
  /** Channels the product is on, when a publish was attempted. */
  publications: { publicationId: string; name: string; isPublished: boolean }[];
  /**
   * The variants that now exist on the product, with their SKU and selected
   * option values. When explicit variants were supplied these are the created
   * ones; otherwise it is the single default variant productCreate made. The
   * caller maps its form rows to these (by SKU, then by option values) to
   * persist per-variant manual costs.
   */
  variants: CreatedVariant[];
}

interface CreateResponse {
  productCreate: {
    product: {
      id: string;
      title: string;
      status: string;
      variants: { edges: { node: { id: string } }[] } | null;
    } | null;
    userErrors: UserErrors;
  } | null;
}

interface VariantsResponse {
  productVariantsBulkCreate: {
    productVariants:
      | { id: string; sku: string | null; selectedOptions: { name: string; value: string }[] }[]
      | null;
    userErrors: UserErrors;
  } | null;
}

/** Creates a product (DRAFT unless the request asked for ACTIVE). */
export async function createProduct(
  request: ProductCreateRequest,
): Promise<ProductCreateResult> {
  const media = buildMediaInput(request);

  // Step 1: product + default variant + media.
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

  // Step 2: replace the default standalone variant with the real ones.
  let variantsCreated = 0;
  let createdVariants: CreatedVariant[] = [];
  const variantInput = buildVariantsCreateInput(request);
  if (variantInput.length > 0) {
    const variants = await shopifyGraphql<VariantsResponse>(
      PRODUCT_VARIANTS_BULK_CREATE_MUTATION,
      { productId: product.id, variants: variantInput },
      { operation: 'productVariantsBulkCreate' },
    );
    const variantError = mapUserErrors(variants.data.productVariantsBulkCreate?.userErrors);
    if (variantError !== null) {
      // The product EXISTS. Throwing here would orphan it: the caller would see a
      // generic failure, never learn the id, and the draft would sit in Shopify
      // with nobody tracking it. So this returns a partial success instead.
      //
      // It is also deliberately NOT published and NOT activated - its prices are
      // Shopify's default, not the ones the operator entered, so putting it on
      // sale would be worse than leaving it as a draft to fix.
      const defaultId = product.variants?.edges?.[0]?.node.id ?? null;
      logger.warn('Variant creation failed; leaving an unpublished draft.', {
        shopifyProductId: product.id,
        code: variantError.code,
      });
      return {
        shopifyProductId: product.id,
        title: product.title,
        status: product.status,
        desiredStatus: request.publish ? 'ACTIVE' : request.status,
        variantsCreated: 0,
        mediaAttached: media.length,
        published: false,
        publishError: null,
        publications: [],
        variants:
          defaultId === null
            ? []
            : [{ shopifyVariantId: defaultId, sku: null, optionValues: [] }],
        visibleToCustomers: false,
        partialSuccess: true,
        warnings: [
          `The product was created but its variants could not be added (${variantError.code}: ${variantError.message}). It was left as a DRAFT with Shopify's default variant and was NOT published, because its prices are not the ones you entered. Fix the variants, then publish it.`,
        ],
      };
    }
    const created = variants.data.productVariantsBulkCreate?.productVariants ?? [];
    variantsCreated = created.length;
    createdVariants = created.map((v) => ({
      shopifyVariantId: v.id,
      sku: v.sku ?? null,
      optionValues: v.selectedOptions ?? [],
    }));
  } else {
    // No explicit variants: the product keeps productCreate's default variant.
    // Return its id so a single manual cost can still be attached.
    const defaultId = product.variants?.edges?.[0]?.node.id ?? null;
    if (defaultId !== null) {
      createdVariants = [{ shopifyVariantId: defaultId, sku: null, optionValues: [] }];
    }
  }

  // Step 3 (optional): publish + activate. The product was created DRAFT; only
  // now, if requested, do we make it live - and only via the safe order
  // publish -> verify -> set ACTIVE. If any step fails the product is LEFT
  // DRAFT (never ACTIVE-but-invisible), and the failure is reported.
  let status = product.status;
  let published = false;
  let publishError: string | null = null;
  let publications: ProductCreateResult['publications'] = [];

  if (request.publish) {
    try {
      const result = await publishProduct(product.id);
      publications = result.state.map((entry) => ({
        publicationId: entry.publicationId,
        name: entry.name,
        isPublished: entry.isPublished,
      }));
      const verified = publications.some((entry) => entry.isPublished);
      if (verified) {
        const activated = await shopifyGraphql<{
          productUpdate: {
            product: { id: string; status: string } | null;
            userErrors: UserErrors;
          } | null;
        }>(
          PRODUCT_STATUS_UPDATE_MUTATION,
          { product: { id: product.id, status: 'ACTIVE' } },
          { operation: 'productCreateActivate' },
        );
        const activateError = mapUserErrors(activated.data.productUpdate?.userErrors);
        if (activateError !== null) throw activateError;
        status = activated.data.productUpdate?.product?.status ?? 'ACTIVE';
        published = true;
      } else {
        publishError =
          'Publish returned but no sales channel reports the product as published; it was left as DRAFT.';
      }
    } catch (error) {
      publishError =
        error instanceof AppError ? `${error.code}: ${error.message}` : 'Publication failed.';
      if (publications.length === 0) {
        try {
          publications = await getProductPublications(product.id);
        } catch {
          publications = [];
        }
      }
      // status stays DRAFT.
    }
  }

  // Both halves, verified. A product that is ACTIVE but on no sales channel is
  // invisible, and one published while DRAFT is invisible too, so neither alone
  // may be reported as visibility.
  const visibleToCustomers = status === 'ACTIVE' && published;

  const warnings: string[] = [];
  if (publishError !== null) {
    warnings.push(
      `The product was created but could NOT be published (${publishError}). It has been left as a DRAFT and is not visible to customers. Retry publishing from the product page once the cause is fixed.`,
    );
  }
  const desiredStatus = request.publish ? 'ACTIVE' : request.status;
  if (publishError === null && status !== desiredStatus) {
    warnings.push(
      `The product was created but its status is ${status}, not the requested ${desiredStatus}.`,
    );
  }

  logger.info('Created Shopify product.', {
    shopifyProductId: product.id,
    status,
    desiredStatus,
    published,
    visibleToCustomers,
    publishError,
    variantsCreated,
    mediaAttached: media.length,
  });

  return {
    shopifyProductId: product.id,
    title: product.title,
    status,
    desiredStatus,
    variantsCreated,
    mediaAttached: media.length,
    published,
    publishError,
    publications,
    variants: createdVariants,
    visibleToCustomers,
    partialSuccess: warnings.length > 0,
    warnings,
  };
}
