/**
 * Meta Ads placeholder.
 *
 * NOT IMPLEMENTED - deliberately. No endpoints are called and no credentials
 * are read. Present only to reserve the module boundary.
 */

import type { AdPlatformProvider } from '../integration.types';

export const metaAdsProvider: AdPlatformProvider = {
  descriptor: {
    key: 'meta',
    displayName: 'Meta Ads',
    status: 'PLACEHOLDER',
    requiredEnv: ['META_APP_ID', 'META_APP_SECRET', 'META_ACCESS_TOKEN'],
    documentation: 'https://developers.facebook.com/docs/marketing-apis',
  },
  isConfigured(): boolean {
    return false;
  },
};
