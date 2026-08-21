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

/**
 * General scalar update: title, descriptionHtml, vendor, productType, status.
 * Only the fields present in `product` are changed; tags and variants are NOT
 * set here (they go through their own surgical mutations).
 */
export const PRODUCT_UPDATE_MUTATION = /* GraphQL */ `
  mutation TrademartProductUpdate($product: ProductUpdateInput!) {
    productUpdate(product: $product) {
      product {
        id
        title
        vendor
        productType
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
        compareAtPrice
        updatedAt
      }
      userErrors {
        field
        message
      }
    }
  }
`;


/**
 * Creates a product plus its initial default variant (step 1 of 2).
 *
 * `media` attaches images by URL (Shopify fetches them). To set real variant
 * prices/SKUs, follow with PRODUCT_VARIANTS_BULK_CREATE_MUTATION using the
 * REMOVE_STANDALONE_VARIANT strategy, which replaces the auto-created default.
 * https://shopify.dev/docs/api/admin-graphql/latest/mutations/productCreate
 */
export const PRODUCT_CREATE_MUTATION = /* GraphQL */ `
  mutation TrademartProductCreate(
    $product: ProductCreateInput!
    $media: [CreateMediaInput!]
  ) {
    productCreate(product: $product, media: $media) {
      product {
        id
        title
        status
        handle
        options {
          id
          name
        }
        variants(first: 1) {
          edges {
            node {
              id
            }
          }
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

/**
 * Creates the real variants (step 2 of 2). REMOVE_STANDALONE_VARIANT removes the
 * default variant productCreate made, so the product ends up with exactly the
 * variants supplied here.
 */
export const PRODUCT_VARIANTS_BULK_CREATE_MUTATION = /* GraphQL */ `
  mutation TrademartVariantsBulkCreate(
    $productId: ID!
    $variants: [ProductVariantsBulkInput!]!
  ) {
    productVariantsBulkCreate(
      productId: $productId
      variants: $variants
      strategy: REMOVE_STANDALONE_VARIANT
    ) {
      productVariants {
        id
        price
        sku
        selectedOptions {
          name
          value
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;
