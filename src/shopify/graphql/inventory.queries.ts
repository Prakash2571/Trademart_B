/**
 * Inventory queries (read-only).
 * https://shopify.dev/docs/api/admin-graphql/latest/queries/inventoryItems
 *
 * Requires read_inventory. Deliberately read-only: no inventory mutations are
 * implemented in this milestone.
 *
 * `quantities(names:)` is the supported way to read named quantity states.
 */

export const INVENTORY_ITEMS_QUERY = /* GraphQL */ `
  query TrademartInventory($first: Int!, $after: String, $query: String) {
    inventoryItems(first: $first, after: $after, query: $query) {
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          id
          sku
          tracked
          createdAt
          updatedAt
          unitCost {
            amount
            currencyCode
          }
          variant {
            id
            title
            sku
            product {
              id
              title
              status
              vendor
            }
          }
          inventoryLevels(first: 10) {
            edges {
              node {
                id
                location {
                  id
                  name
                  isActive
                }
                quantities(names: ["available", "on_hand", "committed", "incoming"]) {
                  name
                  quantity
                }
              }
            }
          }
        }
      }
    }
  }
`;

/** Counts for the dashboard - cheap queries that avoid paging everything. */
export const COUNTS_QUERY = /* GraphQL */ `
  query TrademartCounts {
    productsCount {
      count
      precision
    }
    ordersCount {
      count
      precision
    }
  }
`;


/**
 * Resolves an inventory item to its owning product.
 *
 * Needed because the `inventory_levels/update` webhook identifies an inventory
 * ITEM, not a product, so automation cannot act on a stock change without this
 * hop. Kept minimal: only the ids required to scope a run.
 */
export const INVENTORY_ITEM_PRODUCT_QUERY = /* GraphQL */ `
  query TrademartInventoryItemProduct($id: ID!) {
    inventoryItem(id: $id) {
      id
      variant {
        id
        product {
          id
        }
      }
    }
  }
`;
