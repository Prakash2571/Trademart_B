/**
 * Pure mappers: raw Shopify payloads -> Trademart DTOs.
 *
 * Rules enforced here:
 *  - Missing data becomes `null`, never `0` and never invented.
 *  - Shopify ids stay strings (GIDs).
 *  - Money keeps the original string alongside a parsed number.
 */

import { classifySupplier } from '../suppliers/supplier.registry';
import type {
  CustomerDto,
  FulfillmentDto,
  InventoryItemDto,
  InventoryLevelDto,
  Money,
  OrderDto,
  OrderLineItemDto,
  ProductDto,
  ProductVariantDto,
  RawConnection,
  RawCustomer,
  RawInventoryItem,
  RawMoney,
  RawMoneyBag,
  RawOrder,
  RawProduct,
  RawShop,
  RawVariant,
  ShopDto,
} from './shopify.types';

export function nodes<T>(connection: RawConnection<T> | null | undefined): T[] {
  if (!connection || !Array.isArray(connection.edges)) return [];
  return connection.edges.map((edge) => edge.node).filter((node): node is T => Boolean(node));
}

export function toMoney(raw: RawMoney | null | undefined): Money | null {
  if (!raw || raw.amount === null || raw.amount === undefined) return null;
  const amount = Number(raw.amount);
  if (!Number.isFinite(amount)) return null;
  return { amount, currencyCode: raw.currencyCode, raw: raw.amount };
}

export function toMoneyFromBag(bag: RawMoneyBag | null | undefined): Money | null {
  return toMoney(bag?.shopMoney ?? null);
}

/** Variant `price` is a plain decimal string; currency comes from the shop. */
function toMoneyFromString(
  amount: string | null | undefined,
  currencyCode: string,
): Money | null {
  if (amount === null || amount === undefined || amount === '') return null;
  const parsed = Number(amount);
  if (!Number.isFinite(parsed)) return null;
  return { amount: parsed, currencyCode, raw: amount };
}

function parseCount(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// ---------------------------------------------------------------------------
// Shop
// ---------------------------------------------------------------------------

export function mapShop(raw: RawShop, apiVersion: string): ShopDto {
  return {
    shopifyShopId: raw.id,
    name: raw.name,
    myshopifyDomain: raw.myshopifyDomain,
    primaryDomainUrl: raw.primaryDomain?.url ?? null,
    email: raw.email ?? raw.contactEmail ?? null,
    currencyCode: raw.currencyCode,
    timezone: raw.ianaTimezone ?? null,
    weightUnit: raw.weightUnit ?? null,
    planDisplayName: raw.plan?.displayName ?? null,
    isDevelopmentStore: raw.plan?.partnerDevelopment ?? null,
    isShopifyPlus: raw.plan?.shopifyPlus ?? null,
    country: raw.billingAddress?.country ?? null,
    apiVersion,
  };
}

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

export function mapVariant(raw: RawVariant, currencyCode: string): ProductVariantDto {
  return {
    shopifyVariantId: raw.id,
    title: raw.title,
    sku: raw.sku ?? null,
    barcode: raw.barcode ?? null,
    price: toMoneyFromString(raw.price, currencyCode),
    compareAtPrice: toMoneyFromString(raw.compareAtPrice, currencyCode),
    availableForSale: raw.availableForSale ?? null,
    inventoryQuantity: raw.inventoryQuantity ?? null,
    inventoryItemId: raw.inventoryItem?.id ?? null,
    inventoryTracked: raw.inventoryItem?.tracked ?? null,
    unitCost: toMoney(raw.inventoryItem?.unitCost ?? null),
  };
}

export function mapProduct(raw: RawProduct, currencyCode: string): ProductDto {
  const variants = nodes(raw.variants).map((variant) => mapVariant(variant, currencyCode));
  const classification = classifySupplier({
    vendor: raw.vendor ?? null,
    tags: raw.tags ?? null,
    productType: raw.productType ?? null,
    skus: variants.map((variant) => variant.sku),
  });

  return {
    shopifyProductId: raw.id,
    title: raw.title,
    handle: raw.handle,
    description: raw.description ?? null,
    status: raw.status,
    vendor: raw.vendor ?? null,
    productType: raw.productType ?? null,
    tags: raw.tags ?? [],
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    featuredImageUrl: raw.featuredImage?.url ?? null,
    minPrice: toMoney(raw.priceRangeV2?.minVariantPrice ?? null),
    maxPrice: toMoney(raw.priceRangeV2?.maxVariantPrice ?? null),
    totalInventory: raw.totalInventory ?? null,
    variants,
    supplier: classification.supplier,
    supplierEvidence: classification.evidence,
  };
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

function mapFulfillments(raw: RawOrder): FulfillmentDto[] {
  return (raw.fulfillments ?? []).map((fulfillment) => {
    const tracking = fulfillment.trackingInfo?.[0] ?? null;
    return {
      id: fulfillment.id,
      status: fulfillment.status ?? null,
      createdAt: fulfillment.createdAt ?? null,
      trackingCompany: tracking?.company ?? null,
      trackingNumber: tracking?.number ?? null,
      trackingUrl: tracking?.url ?? null,
    };
  });
}

export function mapOrder(raw: RawOrder): OrderDto {
  const lineItems: OrderLineItemDto[] = nodes(raw.lineItems).map((item) => {
    const classification = classifySupplier({
      vendor: item.vendor ?? item.product?.vendor ?? null,
      tags: item.product?.tags ?? null,
      productType: item.product?.productType ?? null,
      skus: [item.sku ?? item.variant?.sku ?? null],
    });
    return {
      shopifyLineItemId: item.id,
      title: item.title,
      quantity: item.quantity,
      sku: item.sku ?? item.variant?.sku ?? null,
      vendor: item.vendor ?? item.product?.vendor ?? null,
      shopifyVariantId: item.variant?.id ?? null,
      shopifyProductId: item.product?.id ?? null,
      unitPrice: toMoneyFromBag(item.originalUnitPriceSet),
      discountedTotal: toMoneyFromBag(item.discountedTotalSet),
      supplier: classification.supplier,
    };
  });

  // An order counts as TRADELLE only if every classified line item is; mixed
  // orders stay OTHER so nothing is overstated.
  const suppliers = new Set(lineItems.map((item) => item.supplier));
  let supplier: OrderDto['supplier'] = 'UNKNOWN';
  if (suppliers.size === 1) {
    supplier = [...suppliers][0] ?? 'UNKNOWN';
  } else if (suppliers.size > 1) {
    supplier = 'OTHER';
  }

  const customer =
    raw.customer || raw.email
      ? {
          shopifyCustomerId: raw.customer?.id ?? null,
          displayName: raw.customer?.displayName ?? null,
          email: raw.customer?.email ?? raw.email ?? null,
        }
      : null;

  return {
    shopifyOrderId: raw.id,
    name: raw.name,
    createdAt: raw.createdAt,
    processedAt: raw.processedAt ?? null,
    financialStatus: raw.displayFinancialStatus ?? null,
    fulfillmentStatus: raw.displayFulfillmentStatus ?? null,
    currencyCode: raw.currencyCode,
    customer,
    subtotal: toMoneyFromBag(raw.currentSubtotalPriceSet),
    totalDiscounts: toMoneyFromBag(raw.currentTotalDiscountsSet),
    totalShipping: toMoneyFromBag(raw.totalShippingPriceSet),
    totalTax: toMoneyFromBag(raw.currentTotalTaxSet),
    total: toMoneyFromBag(raw.currentTotalPriceSet),
    shippingLine: raw.shippingLine
      ? {
          title: raw.shippingLine.title ?? null,
          carrier: raw.shippingLine.carrierIdentifier ?? null,
          price: toMoneyFromBag(raw.shippingLine.originalPriceSet),
        }
      : null,
    lineItems,
    fulfillments: mapFulfillments(raw),
    supplier,
  };
}

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

export function mapCustomer(raw: RawCustomer): CustomerDto {
  const city = raw.defaultAddress?.city ?? null;
  const country = raw.defaultAddress?.country ?? null;
  const location = [city, country].filter(Boolean).join(', ') || null;

  // Compose a name from the parts only when Shopify withheld displayName but
  // still returned the individual fields.
  const composedName = [raw.firstName, raw.lastName].filter(Boolean).join(' ');

  return {
    shopifyCustomerId: raw.id,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    state: raw.state ?? null,
    ordersCount: parseCount(raw.numberOfOrders),
    amountSpent: toMoney(raw.amountSpent ?? null),
    tags: raw.tags ?? [],
    displayName: raw.displayName ?? (composedName.length > 0 ? composedName : null),
    email: raw.email ?? null,
    location,
  };
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

export function mapInventoryItem(raw: RawInventoryItem): InventoryItemDto {
  const levels: InventoryLevelDto[] = nodes(raw.inventoryLevels).map((level) => {
    const quantities: Record<string, number> = {};
    for (const entry of level.quantities ?? []) {
      quantities[entry.name] = entry.quantity;
    }
    return {
      locationId: level.location?.id ?? null,
      locationName: level.location?.name ?? null,
      quantities,
    };
  });

  const available = levels.reduce<number | null>((sum, level) => {
    const value = level.quantities['available'];
    if (value === undefined) return sum;
    return (sum ?? 0) + value;
  }, null);

  return {
    inventoryItemId: raw.id,
    sku: raw.sku ?? null,
    tracked: raw.tracked ?? null,
    unitCost: toMoney(raw.unitCost ?? null),
    shopifyVariantId: raw.variant?.id ?? null,
    shopifyProductId: raw.variant?.product?.id ?? null,
    productTitle: raw.variant?.product?.title ?? null,
    variantTitle: raw.variant?.title ?? null,
    available,
    levels,
  };
}
