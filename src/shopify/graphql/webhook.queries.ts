/**
 * Webhook subscription queries and mutations.
 * https://shopify.dev/docs/api/admin-graphql/latest/mutations/webhookSubscriptionCreate
 * https://shopify.dev/docs/api/admin-graphql/latest/queries/webhookSubscriptions
 *
 * Registration is done over the Admin API rather than declared in
 * shopify.app.toml because the callback URL is environment-specific (a tunnel
 * locally, a real host in production) and the app config is shared across both.
 *
 * Note the topic argument is a WebhookSubscriptionTopic ENUM, so it uses the
 * GraphQL form (ORDERS_CREATE), while the X-Shopify-Topic header on a delivery
 * uses the REST form (orders/create). webhook.registration.ts converts between
 * them.
 */

/** Subscriptions currently registered, so registration can be idempotent. */
export const WEBHOOK_SUBSCRIPTIONS_QUERY = /* GraphQL */ `
  query TrademartWebhookSubscriptions($first: Int!, $after: String) {
    webhookSubscriptions(first: $first, after: $after) {
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          id
          topic
          createdAt
          updatedAt
          endpoint {
            __typename
            ... on WebhookHttpEndpoint {
              callbackUrl
            }
          }
        }
      }
    }
  }
`;

export const WEBHOOK_SUBSCRIPTION_CREATE_MUTATION = /* GraphQL */ `
  mutation TrademartWebhookSubscriptionCreate(
    $topic: WebhookSubscriptionTopic!
    $webhookSubscription: WebhookSubscriptionInput!
  ) {
    webhookSubscriptionCreate(
      topic: $topic
      webhookSubscription: $webhookSubscription
    ) {
      webhookSubscription {
        id
        topic
        endpoint {
          __typename
          ... on WebhookHttpEndpoint {
            callbackUrl
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
 * Used to repoint a topic at a new callback URL (e.g. a fresh tunnel) without
 * deleting and recreating the subscription.
 */
export const WEBHOOK_SUBSCRIPTION_UPDATE_MUTATION = /* GraphQL */ `
  mutation TrademartWebhookSubscriptionUpdate(
    $id: ID!
    $webhookSubscription: WebhookSubscriptionInput!
  ) {
    webhookSubscriptionUpdate(id: $id, webhookSubscription: $webhookSubscription) {
      webhookSubscription {
        id
        topic
        endpoint {
          __typename
          ... on WebhookHttpEndpoint {
            callbackUrl
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

export const WEBHOOK_SUBSCRIPTION_DELETE_MUTATION = /* GraphQL */ `
  mutation TrademartWebhookSubscriptionDelete($id: ID!) {
    webhookSubscriptionDelete(id: $id) {
      deletedWebhookSubscriptionId
      userErrors {
        field
        message
      }
    }
  }
`;
