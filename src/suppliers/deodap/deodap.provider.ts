/**
 * DeoDap provider.
 *
 * DeoDap is an Indian wholesale and dropshipping supplier. It has not published an
 * API that could be verified (see deodap.api.ts), so, like Tradelle, the only
 * capability declared here is identification. Everything else is false, with the
 * reason and the manual way to do it written out for the Suppliers page.
 *
 * What DOES work today is not a provider capability in this sense, because none of it
 * calls DeoDap:
 *   - importing a DeoDap product CSV into Shopify as drafts (deodap.service.ts)
 *   - updating recorded costs from a newer DeoDap price list
 *   - recording DeoDap order numbers and tracking against Shopify orders
 *
 * No method below returns an invented number. getSupplierCost/getShippingCost are
 * deliberately absent rather than returning null, so there is nothing for a caller to
 * mistake for a working feed.
 */

import {
  NO_SUPPLIER_CAPABILITIES,
  type ProductIdentitySignals,
  type SupplierProvider,
} from '../supplier.types';
import { collectDeodapEvidence } from './deodap.identify';

export const deodapProvider: SupplierProvider = {
  providerName: 'DEODAP',

  capabilities: {
    ...NO_SUPPLIER_CAPABILITIES,
    identifyProduct: true,
  },

  limitations: {
    shopifyIntegration:
      'DeoDap lists apps on the Shopify App Store, but Trademart has not verified what they write into Shopify. DeoDap products reach Shopify through the Trademart CSV import instead.',
    searchProducts:
      'DeoDap has no documented catalogue API. Download a product CSV from DeoDap and import it on the DeoDap import page.',
    getProduct:
      'DeoDap has no documented catalogue API. Product details come from the CSV you import.',
    getSupplierCost:
      'DeoDap has no documented cost API. The DeoDap cost in your CSV is recorded as a manual cost, and uploading a newer price list on the DeoDap cost sync page updates it.',
    getShippingQuote:
      'DeoDap shipping charges are not available from an API. Include a shipping column in the CSV to record them.',
    getInventory:
      'DeoDap has no live stock feed. Stock in an uploaded price list is shown for information and does not change Shopify stock.',
    createOrder:
      'Orders cannot be sent to DeoDap automatically. Place them with DeoDap yourself, then record the DeoDap order number on the DeoDap orders page.',
    cancelOrder: 'Cancel DeoDap orders with DeoDap directly.',
    getOrder: 'DeoDap order status is recorded by hand on the DeoDap orders page.',
    getTracking:
      'Enter DeoDap tracking details on the DeoDap orders page. Trademart does not send them to Shopify yet, so fulfil the order in Shopify with the same tracking number.',
  },

  identifyProduct(signals: ProductIdentitySignals): boolean {
    return collectDeodapEvidence(signals).length > 0;
  },
};
