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
    # displayStatus is the field that actually says WHERE the parcel is
    # (IN_TRANSIT, OUT_FOR_DELIVERY, DELIVERED, ATTEMPTED_DELIVERY...). The plain
    # status field only distinguishes OPEN / SUCCESS / CANCELLED / ERROR, which
    # cannot answer "has it shipped, and where is it?".
    displayStatus
    createdAt
    updatedAt
    # Shopify's own delivery estimate and observed transitions. Used to detect a
    # delay against ETA rather than guessing from elapsed time alone.
    estimatedDeliveryAt
    inTransitAt
    deliveredAt
    # trackingInfo can hold several parcels for one fulfillment (split shipment).
    trackingInfo {
      company
      number
      url
    }
    # The carrier's own scan history, newest first. This is what a customer-facing
    # "where is my order" timeline is built from.
    events(first: 20, sortKey: HAPPENED_AT, reverse: true) {
      edges {
        node {
          id
          status
          happenedAt
          message
        }
      }
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
        # Which service fulfils this line. A Tradelle-managed line names its
        # fulfillment service here, which is stronger evidence of the supplier
        # than vendor or tags (both of which a merchant can edit by hand).
        fulfillmentService {
          handle
          serviceName
        }
        variant {
          id
          title
          sku
          # Shopify's "cost per item" for the variant sold. This is the supplier
          # cost AS AT the order, and it is the only per-order cost signal Shopify
          # provides - without it, order economics have no supplier cost at all.
          inventoryItem {
            unitCost {
              amount
              currencyCode
            }
          }
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
