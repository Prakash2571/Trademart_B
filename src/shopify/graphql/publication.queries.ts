/**
 * Publication (sales channel) documents.
 *
 * WHY THIS EXISTS
 * ---------------
 * `Product.status = ACTIVE` and "customers can see this product" are NOT the
 * same thing. A product can be ACTIVE and published to no sales channel at all,
 * in which case the storefront does not list it; it can equally be published to
 * the Online Store while DRAFT, which also hides it. Deciding visibility from
 * `status` alone is wrong in both directions.
 *
 * The authoritative answer is the resource's publication on the Online Store
 * publication, which is what these documents read and write.
 *
 * SCOPES
 *   read_publications  - required by `publications` and `publishedOnPublication`
 *   write_publications - required by publishablePublish / publishableUnpublish
 *
 * https://shopify.dev/docs/api/admin-graphql/latest/mutations/publishablePublish
 * https://shopify.dev/docs/api/admin-graphql/latest/interfaces/Publishable
 */

/**
 * Lists publications so the Online Store one can be identified by name.
 *
 * `Publication.name` is the long-standing field. Newer API versions move the
 * human label to `catalog.title` and deprecate `name`, so
 * PUBLICATIONS_QUERY_CATALOG below is tried if this document is rejected. Two
 * documents rather than one combined document on purpose: asking for a field the
 * schema no longer has fails the WHOLE query, so they must be separate.
 */
export const PUBLICATIONS_QUERY_NAMED = /* GraphQL */ `
  query TrademartPublications($first: Int!) {
    publications(first: $first) {
      edges {
        node {
          id
          name
        }
      }
    }
  }
`;

/** Fallback for schemas where the label lives on the catalog. */
export const PUBLICATIONS_QUERY_CATALOG = /* GraphQL */ `
  query TrademartPublicationsByCatalog($first: Int!) {
    publications(first: $first) {
      edges {
        node {
          id
          catalog {
            title
          }
        }
      }
    }
  }
`;

/**
 * The verification primitive.
 *
 * `publishedOnPublication` is a non-null Boolean resolved by Shopify against the
 * named publication, so it answers "is this product actually on the Online
 * Store?" without any inference on our side. `status` is returned alongside it so
 * a single round trip confirms both halves of "visible to customers".
 */
export const PRODUCT_PUBLICATION_STATE_QUERY = /* GraphQL */ `
  query TrademartProductPublicationState($id: ID!, $publicationId: ID!) {
    product(id: $id) {
      id
      title
      status
      publishedOnPublication(publicationId: $publicationId)
    }
  }
`;

/**
 * Publishes a product to one or more publications.
 *
 * The selection is deliberately minimal - id and status via an inline fragment
 * on Product - because the count fields on the Publishable interface have
 * changed shape across API versions (`publicationCount` was deprecated in favour
 * of `resourcePublicationsCount { count }`). Publication is verified with a
 * separate, explicit read instead of trusting the mutation's own echo.
 */
export const PUBLISHABLE_PUBLISH_MUTATION = /* GraphQL */ `
  mutation TrademartPublishablePublish($id: ID!, $input: [PublicationInput!]!) {
    publishablePublish(id: $id, input: $input) {
      publishable {
        ... on Product {
          id
          status
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
 * Bulk audit document for the integrity checks.
 *
 * Fetches status, tags and Online Store publication state together, so
 * disagreements between them can be found in one pass instead of one query per
 * product. `publishedOnPublication` is per-node, which is what makes this
 * possible at all.
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

/** Removes a product from one or more publications. */
export const PUBLISHABLE_UNPUBLISH_MUTATION = /* GraphQL */ `
  mutation TrademartPublishableUnpublish($id: ID!, $input: [PublicationInput!]!) {
    publishableUnpublish(id: $id, input: $input) {
      publishable {
        ... on Product {
          id
          status
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;
