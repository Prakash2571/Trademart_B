/**
 * Product write mutations.
 *
 * The FIRST writes in this codebase — everything else is read-only. Each one is
 * deliberately narrow: it changes one thing, so a bug cannot have broad blast
 * radius on a live storefront.
 *
 * API-shape notes that matter:
 *
 *  - `productUpdate` takes `product: ProductUpdateInput!`. The older
 *    `input: ProductInput!` form was split into Create/Update inputs in 2024-10
 *    and deprecated; this app targets 2026-07, so the new form is required.
 *    https://shopify.dev/changelog/productinput-split-into-productcreateinput-and-productupdateinput-in-2024-10
 *
 *  - Tags are changed with `tagsAdd` / `tagsRemove`, NOT via ProductUpdateInput's
 *    `tags` field. That field REPLACES the entire tag list, which would silently
 *    delete merchant tags. Add/remove are surgical.
 *
 *  - Prices go through `productVariantsBulkUpdate`, which is the only supported
 *    path since the new product model. `price` is a Money scalar and must be
 *    sent as a STRING ("25.00"), never a float.
 *    https://shopify.dev/docs/api/admin-graphql/latest/mutations/productVariantsBulkUpdate
 */

/** Sets a product's status (ACTIVE / DRAFT / ARCHIVED). */
export const PRODUCT_STATUS_UPDATE_MUTATION = /* GraphQL */ `
  mutation TrademartProductStatusUpdate($product: ProductUpdateInput!) {
    productUpdate(product: $product) {
      product {
        id
        status
        updatedAt
      }
      userErrors {
        field
        message
      }
    }
  }
`;

/** Adds tags without disturbing existing ones. */
export const TAGS_ADD_MUTATION = /* GraphQL */ `
  mutation TrademartTagsAdd($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      node {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

/** Removes tags without disturbing existing ones. */
export const TAGS_REMOVE_MUTATION = /* GraphQL */ `
  mutation TrademartTagsRemove($id: ID!, $tags: [String!]!) {
    tagsRemove(id: $id, tags: $tags) {
      node {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

/**
 * Updates variant prices for one product.
 *
 * Only `id` and `price` are sent. Passing more fields risks clobbering data this
 * feature has no business touching.
 */
export const PRODUCT_VARIANTS_PRICE_UPDATE_MUTATION = /* GraphQL */ `
  mutation TrademartVariantPriceUpdate(
    $productId: ID!
    $variants: [ProductVariantsBulkInput!]!
  ) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants {
        id
        price
        updatedAt
      }
      userErrors {
        field
        message
      }
    }
  }
`;
