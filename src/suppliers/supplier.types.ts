/**
 * Supplier abstraction.
 *
 * Trademart must not be coupled to any single supplier. Every provider
 * implements this interface; optional methods may return null when the
 * provider has no API for that operation (which is the case for Tradelle
 * today - it documents a Shopify integration, not a public REST API).
 */

export type SupplierClassification = 'TRADELLE' | 'OTHER' | 'UNKNOWN';

/**
 * The Shopify-derived signals a provider is allowed to inspect.
 * Deliberately structured (not the raw product) so providers cannot start
 * depending on incidental fields such as the title.
 */
export interface ProductIdentitySignals {
  vendor?: string | null;
  tags?: string[] | null;
  productType?: string | null;
  skus?: (string | null | undefined)[];
  /** Shopify fulfillment service handle(s), when available. */
  fulfillmentServices?: (string | null | undefined)[];
}

/**
 * What a provider can ACTUALLY do, declared explicitly.
 *
 * Deliberately not inferred from method presence. Tradelle implements
 * getSupplierCost() but that method always returns null, so
 * `typeof provider.getSupplierCost === 'function'` reported the capability as
 * available and the UI promised a supplier cost feed that does not exist.
 *
 * A provider must therefore state its own truth here. `false` means "asking is
 * pointless"; the method may still exist and return null.
 *
 * These flags describe capability, NOT permission or configuration - a provider
 * whose API needs credentials that are missing should still declare `true` and
 * fail at call time with a clear error.
 */
export interface SupplierCapabilities {
  /** Can recognise its own products from Shopify signals. */
  identifyProduct: boolean;
  /** Products reach Shopify through the supplier's own Shopify app. */
  shopifyIntegration: boolean;
  /** Catalogue search against the supplier. */
  searchProducts: boolean;
  /** Fetch a single supplier catalogue product. */
  getProduct: boolean;
  /** Authoritative supplier cost feed. */
  getSupplierCost: boolean;
  /** Shipping price quote to a destination. */
  getShippingQuote: boolean;
  /** Supplier-side stock levels. */
  getInventory: boolean;
  /** Place a fulfillment order with the supplier. */
  createOrder: boolean;
  /** Cancel a previously placed order. */
  cancelOrder: boolean;
  /** Read back a placed order. */
  getOrder: boolean;
  /** Shipment tracking for a placed order. */
  getTracking: boolean;
}

/** Every capability off. Providers spread this and enable what they support. */
export const NO_SUPPLIER_CAPABILITIES: Readonly<SupplierCapabilities> = Object.freeze({
  identifyProduct: false,
  shopifyIntegration: false,
  searchProducts: false,
  getProduct: false,
  getSupplierCost: false,
  getShippingQuote: false,
  getInventory: false,
  createOrder: false,
  cancelOrder: false,
  getOrder: false,
  getTracking: false,
});

/** Minimal supplier catalogue product. Shapes only; no provider returns these yet. */
export interface SupplierProductSummary {
  supplierProductId: string;
  title: string;
  /** Supplier cost, when the provider exposes one. */
  cost: number | null;
  currencyCode: string | null;
  imageUrl?: string | null;
}

export interface SupplierShippingQuote {
  amount: number;
  currencyCode: string;
  estimatedDaysMin?: number | null;
  estimatedDaysMax?: number | null;
}

export interface SupplierOrderRequest {
  /** Trademart's own reference, so a retry cannot duplicate an order. */
  idempotencyKey: string;
  supplierProductId: string;
  quantity: number;
  shipTo: {
    country: string;
    /** Free-form; providers differ too much to model an address here yet. */
    lines: string[];
  };
}

export interface SupplierOrderStatus {
  supplierOrderId: string;
  state: 'PENDING' | 'CONFIRMED' | 'SHIPPED' | 'CANCELLED' | 'UNKNOWN';
  trackingNumber?: string | null;
  trackingUrl?: string | null;
}

/**
 * A supplier integration.
 *
 * Every operation beyond identification is OPTIONAL and returns null when
 * unsupported. The optional surface is declared now so adding a provider with a
 * real API is an additive change - but NOTHING here is faked: a provider that
 * cannot do something declares false in `capabilities` and either omits the
 * method or returns null.
 */
export interface SupplierProvider {
  providerName: string;

  /** The provider's own honest statement of what it supports. */
  capabilities: SupplierCapabilities;

  /** Why a capability is false, shown in the UI. Keyed by capability name. */
  limitations?: Partial<Record<keyof SupplierCapabilities, string>>;

  /**
   * True only when Shopify data reliably proves the product belongs to this
   * supplier. Must never guess from the product title alone.
   */
  identifyProduct?(signals: ProductIdentitySignals): boolean;

  /** Supplier's cost for the product, or null when unavailable. */
  getSupplierCost?(productId: string): Promise<number | null>;

  /** Supplier's shipping cost to a destination, or null when unavailable. */
  getShippingCost?(
    productId: string,
    destinationCountry: string,
  ): Promise<number | null>;

  // ---- Optional future surface. Unimplemented providers omit these. -------
  searchProducts?(query: string): Promise<SupplierProductSummary[] | null>;
  getProduct?(supplierProductId: string): Promise<SupplierProductSummary | null>;
  getShippingQuote?(
    supplierProductId: string,
    destinationCountry: string,
  ): Promise<SupplierShippingQuote | null>;
  getInventory?(supplierProductId: string): Promise<number | null>;
  createOrder?(request: SupplierOrderRequest): Promise<SupplierOrderStatus | null>;
  cancelOrder?(supplierOrderId: string): Promise<boolean>;
  getOrder?(supplierOrderId: string): Promise<SupplierOrderStatus | null>;
  getTracking?(supplierOrderId: string): Promise<SupplierOrderStatus | null>;
}

export interface IdentificationResult {
  supplier: SupplierClassification;
  /** Human-readable reasons, shown in the UI so classification is auditable. */
  evidence: string[];
}
