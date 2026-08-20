/**
 * Online Store theme queries (read-only).
 * https://shopify.dev/docs/api/admin-graphql/latest/queries/themes
 *
 * Requires the `read_themes` scope. Trademart deliberately exposes READ ONLY for
 * now: the live (MAIN) theme is never modified from here. A safe draft-edit +
 * publish workflow is a later, opt-in feature - see docs.
 *
 * `role` distinguishes the live theme (MAIN) from UNPUBLISHED/DEVELOPMENT/DEMO.
 */

export const THEMES_QUERY = /* GraphQL */ `
  query TrademartThemes($first: Int!, $after: String) {
    themes(first: $first, after: $after) {
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          id
          name
          role
          processing
          createdAt
          updatedAt
        }
      }
    }
  }
`;

/**
 * Reads specific files from one theme by exact filename (e.g. a JSON template or
 * settings_data.json). Filenames are required so this never bulk-downloads a
 * whole theme.
 */
export const THEME_FILES_QUERY = /* GraphQL */ `
  query TrademartThemeFiles($id: ID!, $filenames: [String!], $first: Int!) {
    theme(id: $id) {
      id
      name
      role
      files(first: $first, filenames: $filenames) {
        edges {
          node {
            filename
            contentType
            size
            body {
              ... on OnlineStoreThemeFileBodyText {
                content
              }
              ... on OnlineStoreThemeFileBodyBase64 {
                contentBase64
              }
              ... on OnlineStoreThemeFileBodyUrl {
                url
              }
            }
          }
        }
      }
    }
  }
`;
