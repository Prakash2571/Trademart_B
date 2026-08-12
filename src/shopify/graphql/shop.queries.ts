/**
 * Shop queries - used as the connection test.
 * https://shopify.dev/docs/api/admin-graphql/latest/queries/shop
 *
 * `email` / `contactEmail` depend on granted scopes; the service degrades to
 * SHOP_QUERY_BASIC when Shopify denies them rather than failing the request.
 */

export const SHOP_QUERY_FULL = /* GraphQL */ `
  query TrademartShopInfo {
    shop {
      id
      name
      myshopifyDomain
      email
      contactEmail
      currencyCode
      ianaTimezone
      weightUnit
      primaryDomain {
        host
        url
      }
      plan {
        displayName
        partnerDevelopment
        shopifyPlus
      }
      billingAddress {
        city
        province
        country
        countryCodeV2
      }
    }
  }
`;

export const SHOP_QUERY_BASIC = /* GraphQL */ `
  query TrademartShopInfoBasic {
    shop {
      id
      name
      myshopifyDomain
      currencyCode
      ianaTimezone
      weightUnit
      primaryDomain {
        host
        url
      }
      plan {
        displayName
        partnerDevelopment
        shopifyPlus
      }
    }
  }
`;
