/**
 * Product-edit execution against the Shopify Admin API.
 *
 * The decision of WHAT may change is validated in product.write.ts (pure); this
 * module only performs the calls. Each concern uses its own narrow mutation:
 *   - scalar fields + status via productUpdate
 *   - tags via tagsAdd / tagsRemove (never a wholesale replace)
 *   - variant prices via productVariantsBulkUpdate
 *
 * Every step maps Shopify userErrors and stops on the first, so a partially
 * applied edit reports exactly what did and did not happen rather than pretending
 * it all worked.
 *
 * Requires the write_products scope; a missing scope surfaces as
 * SHOPIFY_SCOPE_MISSING from the shared error mapper.
 */

import { AppError } from '../common/errors';
import { logger } from '../common/logger';
import {
  PRODUCT_UPDATE_MUTATION,
  PRODUCT_VARIANTS_PRICE_UPDATE_MUTATION,
  TAGS_ADD_MUTATION,
  TAGS_REMOVE_MUTATION,
} from '../shopify/graphql/product.mutations';
import { shopifyGraphql } from '../shopify/shopify.client';
import { mapUserErrors } from '../shopify/shopify.errors';
import {
  buildProductUpdateInput,
  buildVariantBulkInput,
  type ProductEditRequest,
} from './product.write';

type UserErrors = { field?: string[] | null; message?: string }[];

export interface ProductEditResult {
  shopifyProductId: string;
  /** Which concerns actually ran, for the response and the audit log. */
  applied: {
    fields: boolean;
    tagsAdded: number;
    tagsRemoved: number;
    variantsUpdated: number;
  };
}

/** Applies a validated edit to one product. */
export async function editProduct(
  productGid: string,
  request: ProductEditRequest,
): Promise<ProductEditResult> {
  const applied = { fields: false, tagsAdded: 0, tagsRemoved: 0, variantsUpdated: 0 };

  // 1. Scalar fields + status.
  const productInput = buildProductUpdateInput(productGid, request.fields);
  if (productInput !== null) {
    const result = await shopifyGraphql<{
      productUpdate: { userErrors: UserErrors } | null;
    }>(PRODUCT_UPDATE_MUTATION, { product: productInput }, { operation: 'productUpdate' });
    const error = mapUserErrors(result.data.productUpdate?.userErrors);
    if (error !== null) throw error;
    applied.fields = true;
  }

  // 2. Tags - add then remove. Order matters only if the same tag appears in
  // both lists; validateProductEdit does not prevent that, so remove-after-add
  // gives the caller a predictable "net remove" result.
  if (request.addTags.length > 0) {
    const result = await shopifyGraphql<{ tagsAdd: { userErrors: UserErrors } | null }>(
      TAGS_ADD_MUTATION,
      { id: productGid, tags: request.addTags },
      { operation: 'tagsAdd' },
    );
    const error = mapUserErrors(result.data.tagsAdd?.userErrors);
    if (error !== null) throw error;
    applied.tagsAdded = request.addTags.length;
  }
  if (request.removeTags.length > 0) {
    const result = await shopifyGraphql<{ tagsRemove: { userErrors: UserErrors } | null }>(
      TAGS_REMOVE_MUTATION,
      { id: productGid, tags: request.removeTags },
      { operation: 'tagsRemove' },
    );
    const error = mapUserErrors(result.data.tagsRemove?.userErrors);
    if (error !== null) throw error;
    applied.tagsRemoved = request.removeTags.length;
  }

  // 3. Variant prices / compare-at.
  const variantInput = buildVariantBulkInput(request.variants);
  if (variantInput.length > 0) {
    const result = await shopifyGraphql<{
      productVariantsBulkUpdate: { userErrors: UserErrors } | null;
    }>(
      PRODUCT_VARIANTS_PRICE_UPDATE_MUTATION,
      { productId: productGid, variants: variantInput },
      { operation: 'productVariantsBulkUpdate' },
    );
    const error = mapUserErrors(result.data.productVariantsBulkUpdate?.userErrors);
    if (error !== null) throw error;
    applied.variantsUpdated = variantInput.length;
  }

  if (!applied.fields && applied.tagsAdded === 0 && applied.tagsRemoved === 0 && applied.variantsUpdated === 0) {
    // Should not happen (validateProductEdit rejects empty), but never claim a
    // no-op succeeded.
    throw new AppError('VALIDATION_ERROR', 'Nothing was changed.');
  }

  logger.info('Edited Shopify product.', { shopifyProductId: productGid, ...applied });
  return { shopifyProductId: productGid, applied };
}
