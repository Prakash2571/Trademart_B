/**
 * Where a DeoDap API client plugs in - pure, and deliberately without HTTP code.
 *
 * WHY THERE IS NO CLIENT YET
 * --------------------------
 * DeoDap has not published API documentation that could be checked when this was
 * written: no base URL, authentication scheme, endpoints or response shapes. Guessing
 * them would give code that looks finished and fails against the real service, or
 * worse, sends a merchant's DeoDap login somewhere it should not go. So nothing in
 * Trademart calls DeoDap today, and the UI says so (DEODAP_API_AVAILABILITY).
 *
 * WHAT IS ALREADY BUILT ON THIS CONTRACT
 * --------------------------------------
 * The working features are fed by files the operator uploads and by what the operator
 * records by hand. Each already goes through the step an API client would feed:
 *
 *   catalogue      deodap.catalog.ts turns supplier rows into CatalogProducts, and the
 *                  importer creates Shopify drafts from those. A catalogue API would
 *                  map its response into the same shape.
 *   cost sync      deodap.sync.ts plans cost changes from supplier rows against the
 *                  import ledger. getStock() below would feed the same planner.
 *   orders         deodap.orders.ts extracts the lines to order and records DeoDap
 *                  order numbers and tracking. placeOrder()/getOrder() would write the
 *                  same SupplierOrder records.
 *
 * To add the API: implement DeodapApiClient against the documented endpoints, return
 * it from createDeodapApiClient(), set DEODAP_API_AVAILABILITY.available to true, flip
 * the matching capabilities in deodap.provider.ts, and add routes for the automatic
 * flows. docs/DEODAP.md walks through it.
 */

import type { DeodapOrderStatus } from './deodap.orders';

/** Decrypted DeoDap credentials. Only ever held in memory for the length of a call. */
export type DeodapCredentials =
  | { kind: 'API_KEY'; apiKey: string }
  | { kind: 'ACCOUNT_LOGIN'; username: string; password: string };

/** One product's stock and price as DeoDap reports it. */
export interface DeodapStockLevel {
  supplierRef: string;
  /** Null when DeoDap does not say. Zero means out of stock. */
  quantity: number | null;
  /** What DeoDap charges for one unit. Null when not reported. */
  cost: number | null;
  currencyCode: string | null;
}

/** An order to place with DeoDap. */
export interface DeodapOrderRequest {
  /** Trademart's own reference, so a retry cannot place the same order twice. */
  idempotencyKey: string;
  shopifyOrderName: string;
  lines: { supplierRef: string | null; sku: string | null; quantity: number }[];
  /**
   * Read from Shopify at the moment of placing, sent to DeoDap, and never stored by
   * Trademart. Order snapshots deliberately hold no customer data.
   */
  shipTo: {
    name: string;
    phone: string | null;
    address1: string;
    address2: string | null;
    city: string;
    province: string | null;
    postalCode: string;
    countryCode: string;
  };
}

/** An order as DeoDap reports it back. */
export interface DeodapRemoteOrder {
  supplierOrderId: string;
  status: DeodapOrderStatus;
  trackingCompany: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
}

/** Everything the integration would ask of a DeoDap API. */
export interface DeodapApiClient {
  /** Confirms the stored credentials work, and returns an account label to show. */
  verifyCredentials(): Promise<{ accountLabel: string | null }>;
  getStock(supplierRefs: readonly string[]): Promise<DeodapStockLevel[]>;
  placeOrder(request: DeodapOrderRequest): Promise<DeodapRemoteOrder>;
  getOrder(supplierOrderId: string): Promise<DeodapRemoteOrder>;
}

export interface DeodapApiAvailability {
  available: boolean;
  /** Why the API is unavailable, in words an operator can act on. */
  reason: string;
}

/** Whether anything in Trademart can call DeoDap. Shown on the DeoDap page. */
export const DEODAP_API_AVAILABILITY: Readonly<DeodapApiAvailability> = Object.freeze({
  available: false,
  reason:
    'DeoDap has not published an API that Trademart can verify, so nothing is sent to DeoDap automatically. Import products from a DeoDap CSV, update costs from a newer price list, and record DeoDap order numbers and tracking by hand. When DeoDap provides API access, the client plugs in at src/suppliers/deodap/deodap.api.ts.',
});

/**
 * Returns a DeoDap API client, or null while there is none.
 *
 * Always null today - see the header. Callers must handle null by explaining that
 * the automatic flow is unavailable, never by pretending it succeeded.
 */
export function createDeodapApiClient(
  credentials: DeodapCredentials | null,
): DeodapApiClient | null {
  // Referenced so the signature documents what a real client will receive.
  void credentials;
  return null;
}
