/**
 * Product queries.
 * https://shopify.dev/docs/api/admin-graphql/latest/queries/products
 *
 * Two tiers, because inventory-related fields (`totalInventory`,
 * `inventoryQuantity`, `inventoryItem.unitCost`) require read_inventory in
 * addition to read_products. When read_inventory is absent, Shopify denies
 * those fields and would fail the whole document - so the service retries with
 * the BASIC document and flags the degradation in the response meta.
 *
 * `edges { node }` is used rather than `nodes` for maximum version tolerance.
 */

const PRODUCT_CORE_FIELDS = /* GraphQL */ `
  id
  title
  handle
  description(truncateAt: 600)
  status
  vendor
  productType
  tags
  createdAt
  updatedAt
  featuredImage {
    url
    altText
  }
  priceRangeV2 {
    minVariantPrice {
      amount
      currencyCode
    }
    maxVariantPrice {
      amount
      currencyCode
    }
  }
`;

const VARIANT_CORE_FIELDS = /* GraphQL */ `
  id
  title
  sku
  price
  compareAtPrice
  barcode
  availableForSale
`;

export const PRODUCTS_QUERY_FULL = /* GraphQL */ `
  query TrademartProducts($first: Int!, $after: String, $query: String) {
    products(first: $first, after: $after, query: $query, sortKey: UPDATED_AT, reverse: true) {
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          ${PRODUCT_CORE_FIELDS}
          totalInventory
          variants(first: 25) {
            edges {
              node {
                ${VARIANT_CORE_FIELDS}
                inventoryQuantity
                inventoryItem {
                  id
                  tracked
                  unitCost {
                    amount
                    currencyCode
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

export const PRODUCTS_QUERY_BASIC = /* GraphQL */ `
  query TrademartProductsBasic($first: Int!, $after: String, $query: String) {
    products(first: $first, after: $after, query: $query, sortKey: UPDATED_AT, reverse: true) {
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          ${PRODUCT_CORE_FIELDS}
          variants(first: 25) {
            edges {
              node {
                ${VARIANT_CORE_FIELDS}
              }
            }
          }
        }
      }
    }
  }
`;

export const PRODUCT_BY_ID_QUERY_FULL = /* GraphQL */ `
  query TrademartProduct($id: ID!) {
    product(id: $id) {
      ${PRODUCT_CORE_FIELDS}
      descriptionHtml
      totalInventory
      variants(first: 100) {
        edges {
          node {
            ${VARIANT_CORE_FIELDS}
            inventoryQuantity
            inventoryItem {
              id
              tracked
              unitCost {
                amount
                currencyCode
              }
            }
          }
        }
      }
    }
  }
`;

export const PRODUCT_BY_ID_QUERY_BASIC = /* GraphQL */ `
  query TrademartProductBasic($id: ID!) {
    product(id: $id) {
      ${PRODUCT_CORE_FIELDS}
      descriptionHtml
      variants(first: 100) {
        edges {
          node {
            ${VARIANT_CORE_FIELDS}
          }
        }
      }
    }
  }
`;
