/**
 * Order queries.
 * https://shopify.dev/docs/api/admin-graphql/latest/queries/orders
 *
 * `customer` and `email` are protected customer data and require both
 * read_customers and Shopify's protected customer data approval. The FULL
 * document requests them; the BASIC document omits them so order financials
 * still load for apps without that approval.
 *
 * All money is read from *Set { shopMoney } so values stay in the shop's
 * currency and are never recomputed locally.
 */

const MONEY = /* GraphQL */ `
  shopMoney {
    amount
    currencyCode
  }
`;

const ORDER_CORE_FIELDS = /* GraphQL */ `
  id
  name
  createdAt
  processedAt
  updatedAt
  displayFinancialStatus
  displayFulfillmentStatus
  currencyCode
  tags
  note
  currentSubtotalPriceSet {
    ${MONEY}
  }
  currentTotalPriceSet {
    ${MONEY}
  }
  currentTotalTaxSet {
    ${MONEY}
  }
  currentTotalDiscountsSet {
    ${MONEY}
  }
  totalShippingPriceSet {
    ${MONEY}
  }
  shippingLine {
    title
    carrierIdentifier
    originalPriceSet {
      ${MONEY}
    }
  }
  fulfillments(first: 10) {
    id
    status
    createdAt
    trackingInfo {
      company
      number
      url
    }
  }
  lineItems(first: 50) {
    edges {
      node {
        id
        title
        quantity
        sku
        vendor
        variant {
          id
          title
          sku
        }
        product {
          id
          title
          vendor
          productType
          tags
        }
        originalUnitPriceSet {
          ${MONEY}
        }
        discountedTotalSet {
          ${MONEY}
        }
      }
    }
  }
`;

const CUSTOMER_FIELDS = /* GraphQL */ `
  email
  customer {
    id
    displayName
    email
    numberOfOrders
  }
`;

export const ORDERS_QUERY_FULL = /* GraphQL */ `
  query TrademartOrders($first: Int!, $after: String, $query: String) {
    orders(first: $first, after: $after, query: $query, sortKey: CREATED_AT, reverse: true) {
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          ${ORDER_CORE_FIELDS}
          ${CUSTOMER_FIELDS}
        }
      }
    }
  }
`;

export const ORDERS_QUERY_BASIC = /* GraphQL */ `
  query TrademartOrdersBasic($first: Int!, $after: String, $query: String) {
    orders(first: $first, after: $after, query: $query, sortKey: CREATED_AT, reverse: true) {
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          ${ORDER_CORE_FIELDS}
        }
      }
    }
  }
`;

export const ORDER_BY_ID_QUERY_FULL = /* GraphQL */ `
  query TrademartOrder($id: ID!) {
    order(id: $id) {
      ${ORDER_CORE_FIELDS}
      ${CUSTOMER_FIELDS}
    }
  }
`;

export const ORDER_BY_ID_QUERY_BASIC = /* GraphQL */ `
  query TrademartOrderBasic($id: ID!) {
    order(id: $id) {
      ${ORDER_CORE_FIELDS}
    }
  }
`;
