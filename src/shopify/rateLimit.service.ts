/**
 * Shopify rate-limit reporting.
 *
 * Reads only from data Shopify ALREADY gave us on real requests. Nothing here
 * ever calls Shopify to ask how much quota is left - a poll like that would spend
 * the very budget it is reporting on, and would do so most often exactly when the
 * budget is tight and somebody is watching the dashboard.
 *
 * The breaker state machine lives in shopify.breaker.ts; this module only
 * composes it with the last observed throttle status for presentation.
 */

import { getBreakerSnapshot, type BreakerSnapshot } from './shopify.breaker';
import { getLastThrottleStatus } from './shopify.client';
import type { ShopifyCostExtension } from './shopify.throttle';

export interface RateLimitReport {
  /** Null until a Shopify request has actually been made. */
  throttle: {
    currentlyAvailable: number | null;
    maximumAvailable: number | null;
    restoreRate: number | null;
    /** Percentage of the bucket still available, for a progress bar. */
    availablePercentage: number | null;
    lastRequestedQueryCost: number | null;
    lastActualQueryCost: number | null;
  } | null;
  breaker: BreakerSnapshot;
  /** Where the numbers came from, so nobody mistakes them for a live probe. */
  source: 'last-shopify-response' | 'none';
  note: string;
}

export function getRateLimitReport(): RateLimitReport {
  const cost: ShopifyCostExtension | null = getLastThrottleStatus();
  const status = cost?.throttleStatus;

  const currentlyAvailable = status?.currentlyAvailable ?? null;
  const maximumAvailable = status?.maximumAvailable ?? null;

  return {
    throttle:
      cost === null
        ? null
        : {
            currentlyAvailable,
            maximumAvailable,
            restoreRate: status?.restoreRate ?? null,
            availablePercentage:
              currentlyAvailable !== null &&
              maximumAvailable !== null &&
              maximumAvailable > 0
                ? Math.round((currentlyAvailable / maximumAvailable) * 100)
                : null,
            lastRequestedQueryCost: cost.requestedQueryCost ?? null,
            lastActualQueryCost: cost.actualQueryCost ?? null,
          },
    breaker: getBreakerSnapshot(),
    source: cost === null ? 'none' : 'last-shopify-response',
    note:
      cost === null
        ? 'No Shopify request has been made yet, so there is no throttle data. This is never fetched on demand: polling Shopify to ask about quota would consume the quota it reports.'
        : 'Taken from the extensions.cost block of the most recent real Shopify response.',
  };
}
