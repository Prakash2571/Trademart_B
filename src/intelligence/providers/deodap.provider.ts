/**
 * DeoDap, as a research source - the counterpart of tradelle.provider.ts.
 *
 * THIS PROVIDER SUPPLIES NOTHING, AND THAT IS THE POINT
 * ----------------------------------------------------
 * Every capability is false, exactly as for Tradelle, and for the same reasons.
 * DeoDap reaches Trademart the way Tradelle does:
 *
 *   SHOPIFY_BRIDGE          DeoDap's own Shopify app pushes products into Shopify and
 *                           fulfils the orders it receives there. Real - which is why
 *                           the supplier module can CLASSIFY a Shopify product or order
 *                           line as DeoDap's (src/suppliers/deodap).
 *   MANUAL                  an operator reads a DeoDap product page and types values
 *                           in. That is what manual.provider.ts is for.
 *   DIRECT_API_UNAVAILABLE  there is no documented public DeoDap API, and none is
 *                           configured. Nothing here calls DeoDap over the network.
 *
 * It is registered so describeResearchCapabilities() can say "DeoDap has no API" in
 * DeoDap's own words, instead of leaving an unexplained blank for an operator who
 * researches on DeoDap.
 *
 * Pure: no network, no config, no clock.
 */

import type { DeodapProviderMode } from '../candidate.types';
import { NO_RESEARCH_CAPABILITIES, type ResearchProvider } from './provider.types';

/** Where an operator can check the claim. */
export const DEODAP_DOCUMENTATION = 'https://dropshipping.deodap.com';

/**
 * The modes through which DeoDap data can reach Trademart, and how. Reported verbatim
 * by the capabilities route so the UI cannot drift from the truth.
 */
export const DEODAP_MODES: Readonly<Record<DeodapProviderMode, string>> = Object.freeze({
  SHOPIFY_BRIDGE:
    'DeoDap lists products into Shopify through its own Shopify app and fulfils the orders it receives there. Trademart reads that data from Shopify, and can identify which products and orders are DeoDap\u2019s.',
  MANUAL:
    'An operator reads a DeoDap product page and records the figures in Trademart. This is the only route for demand, trend and competition data.',
  DIRECT_API_UNAVAILABLE:
    'DeoDap publishes no documented public API, and none is configured. Trademart makes no network calls to DeoDap and does not scrape its pages.',
});

/**
 * How DeoDap data currently reaches Trademart. A constant for the same reason as
 * tradelleResearchMode(): no credential exists that could change the answer.
 */
export function deodapResearchMode(): DeodapProviderMode {
  return 'DIRECT_API_UNAVAILABLE';
}

const NO_API =
  'DeoDap publishes no documented public API and none is configured, so Trademart cannot fetch this. Record the figure manually, or read it from Shopify where DeoDap\u2019s app has already written it.';

export const deodapResearchProvider: ResearchProvider = {
  providerName: 'DeoDap',
  source: 'DEODAP',

  // Every flag false: an accurate description of an integration that does not exist.
  capabilities: { ...NO_RESEARCH_CAPABILITIES },

  limitations: {
    demand: NO_API,
    trend: NO_API,
    competition: NO_API,
    seasonality: NO_API,
    storePerformance:
      'DeoDap does not know how this store trades; that comes from the store\u2019s own Shopify orders.',
    fulfillmentHistory:
      'Delivery outcomes are measured from the store\u2019s own Shopify orders, which is where DeoDap\u2019s fulfillments appear.',
    supplierCommercials: `${NO_API} A DeoDap cost reaches Trademart from Shopify\u2019s "cost per item" (if DeoDap\u2019s app writes it), a manual cost, or a DeoDap price list.`,
  },

  // No fetch methods at all, for the same reason as Tradelle: an unimplemented method
  // that returned null would be indistinguishable from a source that found nothing.
};
