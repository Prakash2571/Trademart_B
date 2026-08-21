/**
 * Tradelle, as a research source.
 *
 * THIS PROVIDER SUPPLIES NOTHING, AND THAT IS THE POINT
 * ----------------------------------------------------
 * Every capability is false. It exists so the system has somewhere honest to record
 * what Tradelle actually is, instead of leaving a gap that the UI would fill with an
 * optimistic assumption.
 *
 * What Tradelle really is, as far as Trademart can verify:
 *
 *   SHOPIFY_BRIDGE          Tradelle pushes products into Shopify and fulfils orders
 *                           through it. This is real, and it is how production works -
 *                           which is why the supplier module can CLASSIFY a Shopify
 *                           product as Tradelle's from fulfillment service and vendor
 *                           signals.
 *   MANUAL                  an operator reads a Tradelle page and types values in.
 *                           That is what manual.provider.ts is for.
 *   DIRECT_API_UNAVAILABLE  there is no documented public Tradelle API, and none is
 *                           configured. Nothing here calls Tradelle over the network.
 *
 * There is deliberately no DIRECT_API mode in TradelleProviderMode. Adding one, even
 * unused, would let the rest of the system start assuming a capability that does not
 * exist - and the first thing that assumption would produce is a supplier cost nobody
 * verified, feeding a margin that decides a purchase.
 *
 * WHY IT IS REGISTERED AT ALL
 * ---------------------------
 * describeResearchCapabilities() reads every provider's limitations to explain what is
 * missing. Leaving Tradelle out would mean the UI could not say "Tradelle has no API,
 * so demand comes from your own entry" - it would only be able to show an unexplained
 * blank. A stated absence is worth more than a silent one.
 *
 * Pure: no network, no config, no clock.
 */

import type { TradelleProviderMode } from '../candidate.types';
import { NO_RESEARCH_CAPABILITIES, type ResearchProvider } from './provider.types';

/** Documentation an operator can check the claim against. */
export const TRADELLE_DOCUMENTATION = 'https://tradelle.io';

/**
 * The modes through which Tradelle data can reach Trademart, and how.
 *
 * Exported so the controller can report it verbatim rather than the UI hard-coding a
 * sentence that could drift from the truth.
 */
export const TRADELLE_MODES: Readonly<Record<TradelleProviderMode, string>> = Object.freeze({
  SHOPIFY_BRIDGE:
    'Tradelle lists products into Shopify and fulfils orders through it. Trademart reads that data from Shopify, and can identify which products and orders are Tradelle\u2019s.',
  MANUAL:
    'An operator reads a Tradelle product page and records the figures in Trademart. This is the only route for demand, trend and competition data.',
  DIRECT_API_UNAVAILABLE:
    'Tradelle publishes no documented public API, and none is configured. Trademart makes no network calls to Tradelle and does not scrape its pages.',
});

/**
 * How Tradelle data currently reaches Trademart.
 *
 * A constant rather than a check, because there is no credential that could change the
 * answer. When a real API appears this becomes a configuration read, and the change
 * will be visible in one place.
 */
export function tradelleResearchMode(): TradelleProviderMode {
  return 'DIRECT_API_UNAVAILABLE';
}

const NO_API =
  'Tradelle publishes no documented public API and none is configured, so Trademart cannot fetch this. Record the figure manually, or read it from Shopify where Tradelle has already written it.';

export const tradelleResearchProvider: ResearchProvider = {
  providerName: 'Tradelle',
  source: 'TRADELLE',

  // Every flag false. Not a placeholder to be filled in later - an accurate
  // description of an integration that does not exist.
  capabilities: { ...NO_RESEARCH_CAPABILITIES },

  limitations: {
    demand: NO_API,
    trend: NO_API,
    competition: NO_API,
    seasonality: NO_API,
    storePerformance:
      'Tradelle does not know how this store trades; that comes from the store\u2019s own Shopify orders.',
    fulfillmentHistory:
      'Delivery outcomes are measured from the store\u2019s own Shopify orders, which is where Tradelle\u2019s fulfillments appear.',
    supplierCommercials: `${NO_API} Tradelle writes its cost into Shopify\u2019s "cost per item" when it lists a product, which is where Trademart reads it from.`,
  },

  // No fetch methods at all. An unimplemented method that returned null would be
  // indistinguishable from a provider that tried and found nothing.
};
