/**
 * Which research providers exist, and in what order they are preferred.
 *
 * A module-level array plus helpers, matching src/suppliers/supplier.registry.ts. No
 * DI container and no dynamic registration: the set of providers is a fact about the
 * build, and making it configurable would mean a deployment could silently lose demand
 * data.
 *
 * ORDER IS MEANINGFUL. gatherSignals() takes the FIRST provider that declares a
 * capability and returns data, so a measured source must sit above a hand-typed one.
 * Today the measured slots (store performance, fulfillment history) and the hand-typed
 * slots (demand, trend, competition, seasonality) do not overlap, so nothing competes -
 * but when Google Ads is built it goes ABOVE the operator entry, and this comment is
 * where that decision is recorded.
 *
 * Pure: no config, no network.
 */

import { manualResearchProvider } from './manual.provider';
import {
  describeResearchCapabilities,
  type CapabilityAvailability,
  type ResearchProvider,
} from './provider.types';
import { tradelleResearchProvider } from './tradelle.provider';
import {
  googleAdsResearchProvider,
  googleTrendsResearchProvider,
} from './unavailable.providers';

/**
 * Providers that need no per-request data.
 *
 * The Shopify performance provider is absent because it is built per analysis from
 * fetched orders - see createShopifyPerformanceProvider and researchProvidersFor.
 */
export const staticResearchProviders: readonly ResearchProvider[] = Object.freeze([
  // Measured sources first, once they exist.
  googleAdsResearchProvider,
  googleTrendsResearchProvider,
  // The operator's own entry is last among the market sources: it is real data and the
  // only one available today, but if a measured source ever answers, it should win.
  manualResearchProvider,
  // Supplies nothing. Registered so its limitations can be reported rather than
  // leaving an unexplained blank where Tradelle should be.
  tradelleResearchProvider,
]);

/**
 * The full provider list for one analysis.
 *
 * `storePerformance` is passed in because it is built from Shopify data the caller
 * fetched. Null when the store's history could not be read at all, in which case store
 * fit and fulfillment quality are simply unscored - which is correct, and better than
 * registering a provider that would report zeros.
 */
export function researchProvidersFor(
  storePerformance: ResearchProvider | null,
): ResearchProvider[] {
  return storePerformance === null
    ? [...staticResearchProviders]
    : [storePerformance, ...staticResearchProviders];
}

/**
 * What the research module can and cannot measure right now.
 *
 * Reported to the UI so it can state the truth plainly instead of implying live market
 * data. With no Shopify history available the honest answer today is that four of the
 * seven capabilities are met only by a figure an operator typed in, and two cannot be
 * met at all.
 */
export function describeResearchSupport(
  storePerformance: ResearchProvider | null = null,
): CapabilityAvailability[] {
  return describeResearchCapabilities(researchProvidersFor(storePerformance));
}
