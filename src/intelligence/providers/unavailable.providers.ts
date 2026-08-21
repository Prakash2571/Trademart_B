/**
 * Keyword and trend integrations that are NOT built.
 *
 * Google Ads keyword planning and Google Trends are the two sources that would turn
 * demand, competition and trend from a hand-typed figure into a measurement. Neither
 * is implemented here. These declarations record that precisely, including what it
 * would take, so the gap is documented rather than merely absent.
 *
 * WHY BOTH LIVE IN ONE FILE
 * -------------------------
 * They are the same statement twice - "not implemented, here is what it would need".
 * Two files would be two copies of the same block comment drifting apart. When either
 * gains a real implementation it moves into its own module with its own client, and
 * that move is the signal that something changed.
 *
 * HOW THIS DIFFERS FROM A MISSING CREDENTIAL
 * ------------------------------------------
 * The supplier module's doctrine is that missing credentials are NOT a capability
 * question: a provider whose API needs a key it has not been given should still declare
 * the capability true and fail loudly at call time. That rule is right, and it does not
 * apply here. There is no client, no query, no parsing - supplying the credentials
 * today would change nothing. So the capability is false, and the limitation says
 * "not implemented" rather than "not configured", because those send an operator to
 * two different places.
 *
 * Pure: no network, no config, no clock.
 */

import type { IntegrationDescriptor } from '../../integrations/integration.types';
import { NO_RESEARCH_CAPABILITIES, type ResearchProvider } from './provider.types';

/* ===========================================================================
 * Google Ads - keyword volume and competition
 * ======================================================================== */

/**
 * Reuses the existing IntegrationDescriptor shape so the research module's unbuilt
 * integrations are described the same way the ad-platform ones already are, and a
 * single UI component can render both.
 */
export const GOOGLE_ADS_RESEARCH_DESCRIPTOR: Readonly<IntegrationDescriptor> = Object.freeze({
  key: 'google_ads_keyword_planning',
  displayName: 'Google Ads keyword planning',
  status: 'PLACEHOLDER',
  requiredEnv: [
    'GOOGLE_ADS_DEVELOPER_TOKEN',
    'GOOGLE_ADS_CLIENT_ID',
    'GOOGLE_ADS_CLIENT_SECRET',
    'GOOGLE_ADS_REFRESH_TOKEN',
    'GOOGLE_ADS_CUSTOMER_ID',
  ],
  documentation:
    'https://developers.google.com/google-ads/api/docs/keyword-planning/generate-keyword-ideas',
});

const GOOGLE_ADS_NOT_BUILT =
  'The Google Ads keyword planning integration is not implemented - there is no client and no query, so supplying credentials would not enable it. Until it exists, search volume and competition come from figures an operator records by hand.';

export const googleAdsResearchProvider: ResearchProvider = {
  providerName: 'Google Ads keyword planning',
  source: 'GOOGLE_ADS',

  // False because it is NOT BUILT, not because a key is missing. Declaring true here
  // would make gatherSignals call a method that does not exist and report the
  // capability as available-but-empty, which reads as "no demand for this product"
  // rather than "we cannot measure demand".
  capabilities: { ...NO_RESEARCH_CAPABILITIES },

  limitations: {
    demand: GOOGLE_ADS_NOT_BUILT,
    competition: GOOGLE_ADS_NOT_BUILT,
    trend:
      'Google Ads reports historical monthly volumes rather than a trend line; momentum would have to be derived from them, and that derivation is not implemented.',
    seasonality:
      'Seasonality would be inferred from twelve months of keyword volumes. Not implemented.',
    storePerformance: 'Google Ads knows nothing about this store\u2019s own sales.',
    fulfillmentHistory: 'Google Ads knows nothing about this store\u2019s deliveries.',
    supplierCommercials: 'Google Ads is not a supplier.',
  },
};

/* ===========================================================================
 * Google Trends - momentum and seasonality
 * ======================================================================== */

export const GOOGLE_TRENDS_RESEARCH_DESCRIPTOR: Readonly<IntegrationDescriptor> = Object.freeze({
  key: 'google_trends',
  displayName: 'Google Trends',
  status: 'PLACEHOLDER',
  // Empty, and that absence is the honest answer: there is no official Google Trends
  // API to hold a credential for. Listing an invented variable would imply one exists.
  requiredEnv: [],
  documentation: 'https://trends.google.com/trends/',
});

const NO_TRENDS_API =
  'Google Trends has no official public API. Reaching it would mean scraping an interface Google does not support for automated access, which would break without warning and is not something to build a purchasing decision on. Trend direction therefore comes from a figure an operator records by hand.';

export const googleTrendsResearchProvider: ResearchProvider = {
  providerName: 'Google Trends',
  source: 'GOOGLE_TRENDS',

  capabilities: { ...NO_RESEARCH_CAPABILITIES },

  limitations: {
    trend: NO_TRENDS_API,
    seasonality: NO_TRENDS_API,
    demand:
      'Google Trends reports relative interest on a 0-100 scale, not absolute search volume. It could never answer "how many people search for this", which is what the demand factor needs.',
    competition: 'Google Trends does not report competition.',
    storePerformance: 'Google Trends knows nothing about this store\u2019s own sales.',
    fulfillmentHistory: 'Google Trends knows nothing about this store\u2019s deliveries.',
    supplierCommercials: 'Google Trends is not a supplier.',
  },
};
