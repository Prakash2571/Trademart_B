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
      // The product exists but variants failed. Surface that honestly rather
      // than pretending the whole create succeeded - the operator can retry
      // variants or delete the draft.
      throw new AppError(
        variantError.code,
        `Product ${product.id} was created as ${product.status}, but adding variants failed: ${variantError.message}`,
        { details: variantError.details },
      );
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

  logger.info('Created Shopify product.', {
    shopifyProductId: product.id,
    status,
    published,
    publishError,
    variantsCreated,
    mediaAttached: media.length,
  });

  return {
    shopifyProductId: product.id,
    title: product.title,
    status,
    variantsCreated,
    mediaAttached: media.length,
    published,
    publishError,
    publications,
    variants: createdVariants,
  };
}
