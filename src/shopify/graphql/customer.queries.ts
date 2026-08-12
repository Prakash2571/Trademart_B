/**
 * Customer queries.
 * https://shopify.dev/docs/api/admin-graphql/latest/queries/customers
 *
 * Protected customer data: Shopify restricts PII fields (email, phone, name,
 * addresses) to apps that have been granted protected customer data access.
 * Trademart therefore requests a MINIMAL document by default and only asks for
 * PII when explicitly enabled, and never persists it.
 * https://shopify.dev/docs/apps/launch/protected-customer-data
 */

const CUSTOMER_SAFE_FIELDS = /* GraphQL */ `
  id
  createdAt
  updatedAt
  state
  numberOfOrders
  amountSpent {
    amount
    currencyCode
  }
  tags
`;

export const CUSTOMERS_QUERY_FULL = /* GraphQL */ `
  query TrademartCustomers($first: Int!, $after: String, $query: String) {
    customers(first: $first, after: $after, query: $query, sortKey: UPDATED_AT, reverse: true) {
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          ${CUSTOMER_SAFE_FIELDS}
          displayName
          firstName
          lastName
          email
          defaultAddress {
            city
            province
            country
            countryCodeV2
          }
        }
      }
    }
  }
`;

export const CUSTOMERS_QUERY_BASIC = /* GraphQL */ `
  query TrademartCustomersBasic($first: Int!, $after: String, $query: String) {
    customers(first: $first, after: $after, query: $query, sortKey: UPDATED_AT, reverse: true) {
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          ${CUSTOMER_SAFE_FIELDS}
        }
      }
    }
  }
`;

/** Cheap count used by the dashboard. */
export const CUSTOMERS_COUNT_QUERY = /* GraphQL */ `
  query TrademartCustomersCount {
    customersCount {
      count
      precision
    }
  }
`;
