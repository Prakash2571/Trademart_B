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

export interface SupplierProvider {
  providerName: string;

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
}

export interface IdentificationResult {
  supplier: SupplierClassification;
  /** Human-readable reasons, shown in the UI so classification is auditable. */
  evidence: string[];
}
