import { createHash } from 'node:crypto';

import { config } from '../../config';
import { ProductCandidateModel } from '../../database/models/ProductCandidate';
import { shopifyGraphql } from '../../shopify/shopify.client';
import { loadCatalogEvidenceByProductIds } from '../catalog/catalog.repository';
import { projectStorefrontProduct } from '../catalog/projection';
import { inrAmountToPaise } from '../catalog/sellability';
import { storefrontSellingChannel } from '../catalog/selling-channel';
import type { RawCatalogProduct, RawCatalogVariant } from '../catalog/shopify.catalog';
import type {
  AuthoritativeCheckoutLine,
  CheckoutCatalogPort,
  RequestedCheckoutLine,
} from './checkout.types';
import { StorefrontError } from './storefront.error';

const CHECKOUT_PRODUCTS_QUERY = /* GraphQL */ `
  query KanayCheckoutProducts($ids: [ID!]!) {
    shop { currencyCode }
    nodes(ids: $ids) {
      ... on Product {
        id
        handle
        title
        description
        status
        vendor
        productType
        tags
        createdAt
        updatedAt
        seo { title description }
        featuredMedia { ... on MediaImage { image { url altText } } }
        media(first: 12) { nodes { ... on MediaImage { image { url altText } } } }
        variants(first: 100) {
          nodes {
            id
            title
            sku
            price
            compareAtPrice
            availableForSale
            inventoryQuantity
            inventoryItem { tracked }
            selectedOptions { name value }
          }
        }
        collections(first: 20) {
          nodes {
            id handle title
            resourcePublicationsV2(first: 50) {
              nodes { isPublished publication { id name } }
            }
          }
        }
        resourcePublicationsV2(first: 50) {
          nodes { isPublished publishDate publication { id name } }
        }
      }
    }
  }
`;

interface CandidateMappingRow {
  pushedShopifyProductId?: unknown;
  pushedVariantMappings?: unknown;
}

/**
 * Explicit variant node type for checkout revalidation.
 * Extends RawCatalogVariant with inventory fields returned by the checkout query.
 */
type CheckoutRawVariantNode = RawCatalogVariant & {
  inventoryQuantity?: number | null;
  inventoryItem?: { tracked?: boolean | null } | null;
};

/**
 * Checkout raw product: same as RawCatalogProduct but with the enriched variant nodes.
 * Still assignable to RawCatalogProduct for projectStorefrontProduct() because
 * CheckoutRawVariantNode extends RawCatalogVariant.
 */
type CheckoutRawProduct = Omit<RawCatalogProduct, 'variants'> & {
  variants?: { nodes?: CheckoutRawVariantNode[] | null } | null;
};

function productPublicId(shopifyGid: string): string {
  const digest = createHash('sha256')
    .update(`kanay-product-v1\0${shopifyGid}`)
    .digest('base64url')
    .slice(0, 24);
  return `kp_${digest}`;
}

function mappingEntries(raw: unknown): { publicVariantId: string; shopifyVariantId: string }[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as Record<string, unknown>)['publicVariantId'] === 'string' &&
      typeof (entry as Record<string, unknown>)['shopifyVariantId'] === 'string'
    ) {
      return [
        {
          publicVariantId: (entry as Record<string, unknown>)['publicVariantId'] as string,
          shopifyVariantId: (entry as Record<string, unknown>)['shopifyVariantId'] as string,
        },
      ];
    }
    return [];
  });
}

/**
 * Safely convert bigint paise to number. Throws PRICE_INVALID if the value
 * exceeds Number.MAX_SAFE_INTEGER (no floating-point arithmetic used).
 */
function paiseBigintToNumber(paise: bigint): number {
  if (paise > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new StorefrontError(
      'PRICE_INVALID',
      'Item price is outside the representable range.',
      422,
    );
  }
  return Number(paise);
}

export class StorefrontCatalogCheckoutAdapter implements CheckoutCatalogPort {
  public async revalidateLines(
    requestedLines: RequestedCheckoutLine[],
  ): Promise<AuthoritativeCheckoutLine[]> {
    // Resolve each line's durable identity.
    // The line may supply opaque publicVariantId OR shopifyVariantId (or both).
    const publicVariantIds = requestedLines
      .map((line) => line.variantId)
      .filter((id) => !id.startsWith('gid://'));
    const shopifyVariantIdsFromBrowser = requestedLines
      .filter((line) => line.shopifyVariantId !== undefined)
      .map((line) => line.shopifyVariantId as string);

    // Query by the opaque public variant IDs (primary identity).
    const candidateRows = (await ProductCandidateModel.find(
      {
        shopDomain: config.shopify.storeDomain,
        pushState: 'SUCCEEDED',
        pushedShopifyProductId: { $type: 'string' },
        pushedVariantMappings: { $elemMatch: { publicVariantId: { $in: publicVariantIds } } },
      },
      { pushedShopifyProductId: 1, pushedVariantMappings: 1 },
    ).lean()) as unknown as CandidateMappingRow[];

    const resolved = new Map<
      string,
      { shopifyProductId: string; shopifyVariantId: string }
    >();
    const ambiguous = new Set<string>();
    for (const row of candidateRows) {
      if (typeof row.pushedShopifyProductId !== 'string') continue;
      for (const mapping of mappingEntries(row.pushedVariantMappings)) {
        if (!publicVariantIds.includes(mapping.publicVariantId)) continue;
        if (resolved.has(mapping.publicVariantId)) {
          ambiguous.add(mapping.publicVariantId);
          resolved.delete(mapping.publicVariantId);
        } else if (!ambiguous.has(mapping.publicVariantId)) {
          resolved.set(mapping.publicVariantId, {
            shopifyProductId: row.pushedShopifyProductId,
            shopifyVariantId: mapping.shopifyVariantId,
          });
        }
      }
    }

    if (requestedLines.some((line) => !resolved.has(line.variantId))) {
      throw new StorefrontError(
        'VARIANT_UNAVAILABLE',
        'That option is no longer available. Please choose another.',
        409,
      );
    }

    // SECURITY: Cross-check any browser-supplied shopifyVariantId against the resolved mapping.
    // A browser-supplied Shopify id must NEVER select a variant the mapping does not authorise.
    for (const line of requestedLines) {
      if (line.shopifyVariantId !== undefined) {
        const authoritative = resolved.get(line.variantId);
        if (authoritative && authoritative.shopifyVariantId !== line.shopifyVariantId) {
          throw new StorefrontError(
            'VARIANT_UNAVAILABLE',
            'That option is no longer available. Please choose another.',
            409,
          );
        }
      }
    }

    const productIds = [...new Set([...resolved.values()].map((value) => value.shopifyProductId))];
    const [{ data }, evidence] = await Promise.all([
      shopifyGraphql<{ shop: { currencyCode: string }; nodes: (CheckoutRawProduct | null)[] }>(
        CHECKOUT_PRODUCTS_QUERY,
        { ids: productIds },
        { operation: 'revalidateKanayCheckout' },
      ),
      loadCatalogEvidenceByProductIds(productIds),
    ]);
    const products = new Map(
      data.nodes.flatMap((product) => (product?.id ? [[product.id, product] as const] : [])),
    );
    const now = new Date();

    return requestedLines.map((line) => {
      const identity = resolved.get(line.variantId)!;
      if (line.productId !== productPublicId(identity.shopifyProductId)) {
        throw new StorefrontError('PRODUCT_UNAVAILABLE', 'This item is no longer available.', 409);
      }
      const rawProduct = products.get(identity.shopifyProductId);
      const candidateEvidence = evidence.get(identity.shopifyProductId) ?? null;
      if (!rawProduct || !candidateEvidence) {
        throw new StorefrontError('PRODUCT_UNAVAILABLE', 'This item is no longer available.', 409);
      }
      // CheckoutRawProduct is assignable to RawCatalogProduct (variants field is compatible)
      // The SAME channel the catalog gated on. If checkout resolved a different
      // channel, a product could be addable to a cart yet absent from the store, or
      // browsable yet unbuyable - the price and availability the customer saw would
      // not be the ones enforced here.
      const projected = projectStorefrontProduct({
        product: rawProduct as RawCatalogProduct,
        shopCurrencyCode: data.shop.currencyCode,
        evidence: candidateEvidence,
        now,
        sellingChannel: storefrontSellingChannel(),
      });
      const publicVariant = projected?.detail.variants.find((variant) => variant.id === line.variantId);
      const rawVariant = (rawProduct.variants?.nodes ?? []).find(
        (variant) => variant.id === identity.shopifyVariantId,
      );
      const unitPricePaiseBigint = publicVariant ? inrAmountToPaise(publicVariant.price.amount) : null;
      if (!projected || !publicVariant || !rawVariant || unitPricePaiseBigint === null) {
        throw new StorefrontError('VARIANT_UNAVAILABLE', 'That option is no longer available.', 409);
      }

      // Safe bigint -> number conversion (rejects astronomically large values)
      const unitPricePaise = paiseBigintToNumber(unitPricePaiseBigint);

      // Honour expectedUnitPricePaise as display snapshot: mismatch surfaces PRICE_CHANGED
      if (
        line.expectedUnitPricePaise !== undefined &&
        line.expectedUnitPricePaise !== unitPricePaise
      ) {
        throw new StorefrontError(
          'PRICE_CHANGED',
          'The price for this item has changed. Please review your cart.',
          409,
        );
      }

      const image = projected.detail.images[0];
      return {
        publicProductId: line.productId,
        publicVariantId: line.variantId,
        shopifyProductId: identity.shopifyProductId,
        shopifyVariantId: identity.shopifyVariantId,
        title: projected.detail.title,
        variantTitle: publicVariant.title || null,
        selectedOptions: publicVariant.selectedOptions,
        image: image ? { url: image.url, alt: image.alt || null } : null,
        quantity: line.quantity,
        unitPricePaise,
        currencyCode: 'INR' as const,
        availableQuantity:
          rawVariant.inventoryItem?.tracked === true && Number.isInteger(rawVariant.inventoryQuantity)
            ? Math.max(0, rawVariant.inventoryQuantity ?? 0)
            : null,
        sellability: publicVariant.availability,
        // Re-read from the live product, not taken from the request. The MOQ the checkout
        // enforces is the one Shopify carries right now, so a stale browser (or a crafted
        // request) cannot buy under a minimum the merchant has since raised.
        minimumOrderQuantity: projected.summary.minimumOrderQuantity ?? null,
      };
    });
  }
}
