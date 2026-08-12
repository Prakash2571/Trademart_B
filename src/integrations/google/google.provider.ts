/**
 * Google Ads placeholder.
 *
 * NOT IMPLEMENTED - deliberately. No endpoints are called and no credentials
 * are read. Present only to reserve the module boundary.
 */

import type { AdPlatformProvider } from '../integration.types';

export const googleAdsProvider: AdPlatformProvider = {
  descriptor: {
    key: 'google',
    displayName: 'Google Ads',
    status: 'PLACEHOLDER',
    requiredEnv: [
      'GOOGLE_ADS_CLIENT_ID',
      'GOOGLE_ADS_CLIENT_SECRET',
      'GOOGLE_ADS_DEVELOPER_TOKEN',
      'GOOGLE_ADS_REFRESH_TOKEN',
    ],
    documentation: 'https://developers.google.com/google-ads/api/docs/start',
  },
  isConfigured(): boolean {
    return false;
  },
};
