/**
 * DeoDap provider - the same shape as Tradelle.
 *
 * DeoDap is an Indian wholesale and dropshipping supplier. Like Tradelle, it has no
 * public API that could be verified (see deodap.api.ts), but it does have its own
 * Shopify app, listed on the Shopify App Store. So the working bridge is the same:
 *
 *   Trademart -> Shopify API -> Shopify store -> DeoDap Shopify app -> DeoDap fulfilment
 *
 * DeoDap's app brings products into Shopify and picks up the Shopify orders for them.
 * Trademart manages those products through Shopify and watches the orders move there;
 * it never calls DeoDap. The two capabilities declared are therefore the Tradelle
 * pair: identification, and products reaching Shopify through the supplier's app.
 *
 * What the app writes into Shopify has not been verified from here. Identification
 * therefore also takes SKU prefixes the operator configures, and the orders page can
 * be switched to MANUAL for a store that does not use the app (deodap.settings.ts).
 *
 * No method below returns an invented number. getSupplierCost/getShippingCost are
 * deliberately absent rather than returning null, so there is nothing for a caller to
 * mistake for a working feed. Costs come from Shopify's cost per item (if the app
 * fills it in), a manual cost, or a DeoDap price list.
 */

import {
  NO_SUPPLIER_CAPABILITIES,
  type ProductIdentitySignals,
  type SupplierProvider,
} from '../supplier.types';
import { collectDeodapEvidence } from './deodap.identify';

export const deodapProvider: SupplierProvider = {
  providerName: 'DEODAP',

  // Declared, not inferred - the same honesty rule as Tradelle.
  capabilities: {
    ...NO_SUPPLIER_CAPABILITIES,
    identifyProduct: true,
    shopifyIntegration: true,
  },

  limitations: {
    searchProducts:
      "Product discovery happens inside DeoDap's own Shopify app (or on DeoDap's website), which pushes products into Shopify. Trademart reads them from Shopify afterwards. A DeoDap product CSV can also be imported on the DeoDap import page.",
    getProduct:
      'DeoDap publishes no catalogue API. Product details are read from Shopify once DeoDap\u2019s app has imported the product.',
    getSupplierCost:
      "DeoDap publishes no documented public API, so there is no cost endpoint to call. Use Shopify's cost per item (if DeoDap's app writes it on import), a manual cost, or a DeoDap price list on the cost sync page.",
    getShippingQuote:
      'DeoDap shipping charges are a DeoDap-side value that no public API exposes. Record them with the manual cost, or include a shipping column in a DeoDap file.',
    getInventory:
      "Stock is kept in Shopify by DeoDap's app, where Trademart reads it. There is no DeoDap stock API.",
    createOrder:
      "DeoDap fulfils Shopify orders through its own Shopify app; there is no public order API for Trademart to call. Products imported through Trademart's CSV import are not known to that app, so their orders are placed by hand and recorded on the DeoDap orders page.",
    cancelOrder: "Cancel with DeoDap, in DeoDap's app or with DeoDap directly.",
    getOrder:
      'Progress is read from the Shopify order that DeoDap\u2019s app updates. There is no DeoDap order API.',
    getTracking:
      "DeoDap's app adds tracking to the Shopify order when it ships, and Trademart reads it from there. There is no DeoDap tracking API.",
  },

  identifyProduct(signals: ProductIdentitySignals): boolean {
    return collectDeodapEvidence(signals).length > 0;
  },
};
