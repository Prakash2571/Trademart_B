/**
 * Publication (sales-channel) GraphQL.
 *
 * A Shopify product's `status: ACTIVE` only means it is not draft/archived - it
 * does NOT mean customers can see it. Visibility on the Online Store (or any
 * channel) is a separate concept: the product must be PUBLISHED to that
 * channel's publication. Activating without publishing leaves a newly created
 * product invisible, which is why this exists.
 *
 * Scopes:
 *   - listing publications and reading a product's publication state: read_publications
 *   - publishing / unpublishing: write_publications
 *
 * Publication ids are DISCOVERED (never hardcoded): a store's Online Store
 * publication id differs per shop. https://shopify.dev/docs/api/admin-graphql
 */

/** All publications (sales channels) the app can see. */
export const PUBLICATIONS_QUERY = /* GraphQL */ `
  query TrademartPublications {
    publications(first: 50) {
      nodes {
        id
        name
      }
    }
  }
`;

/**
 * A product's publication state, per publication.
 * resourcePublicationsV2 reports which channels it is (or is scheduled to be)
 * published on, so the UI can show "published to Online Store" honestly.
 */
export const PRODUCT_PUBLICATIONS_QUERY = /* GraphQL */ `
  query TrademartProductPublications($id: ID!) {
    product(id: $id) {
      id
      # Fetched alongside the publications because visibility needs BOTH: an
      # unpublished ACTIVE product is invisible, and so is a published DRAFT one.
      # Answering "can customers see this?" from either half alone is wrong.
      status
      resourcePublicationsV2(first: 50) {
        nodes {
          isPublished
          publishDate
          publication {
            id
            name
          }
        }
      }
    }
  }
`;

/**
 * Bulk status-vs-publication audit, for the integrity report.
 *
 * Uses `publishedOnPublication(publicationId:)` rather than resourcePublicationsV2
 * because this runs over hundreds of products: the boolean is one field per
 * product, whereas a nested connection per product would multiply the query cost
 * and get the sweep throttled.
 */
export const PRODUCTS_PUBLICATION_AUDIT_QUERY = /* GraphQL */ `
  query TrademartProductsPublicationAudit(
    $first: Int!
    $after: String
    $publicationId: ID!
  ) {
    products(first: $first, after: $after) {
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          id
          title
          status
          tags
          publishedOnPublication(publicationId: $publicationId)
        }
      }
    }
  }
`;

/** Publishes a resource (product) to one or more publications. */
export const PUBLISHABLE_PUBLISH_MUTATION = /* GraphQL */ `
  mutation TrademartPublishablePublish($id: ID!, $input: [PublicationInput!]!) {
    publishablePublish(id: $id, input: $input) {
      publishable {
        availablePublicationsCount {
          count
        }
        resourcePublicationsCount {
          count
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

/** Removes a resource (product) from one or more publications. */
export const PUBLISHABLE_UNPUBLISH_MUTATION = /* GraphQL */ `
  mutation TrademartPublishableUnpublish($id: ID!, $input: [PublicationInput!]!) {
    publishableUnpublish(id: $id, input: $input) {
      publishable {
        resourcePublicationsCount {
          count
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;
