/**
 * Shopify Admin GraphQL 2026-07 orderCreate contract.
 * orderCreate does not support Shopify's @idempotent directive. The adapter uses
 * sourceIdentifier reconciliation plus a durable local lease before this mutation.
 */
export const KANAY_ORDER_CREATE_MUTATION = /* GraphQL */ `
  mutation KanayStoreOrderCreate($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
    orderCreate(order: $order, options: $options) {
      order {
        id
        name
        createdAt
        sourceIdentifier
        displayFinancialStatus
        currentTotalPriceSet {
          shopMoney { amount currencyCode }
        }
      }
      userErrors { field message }
    }
  }
`;

export const KANAY_ORDER_BY_SOURCE_IDENTIFIER_QUERY = /* GraphQL */ `
  query KanayStoreOrderBySourceIdentifier($query: String!) {
    orders(first: 2, query: $query, sortKey: CREATED_AT) {
      nodes {
        id
        name
        createdAt
        sourceIdentifier
        displayFinancialStatus
        currentTotalPriceSet {
          shopMoney { amount currencyCode }
        }
      }
    }
  }
`;
