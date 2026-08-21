/**
 * Is this a development store, and may automated tooling write to it?
 *
 * WHY THE DECLARED VALUE IS NOT ENOUGH
 * ------------------------------------
 * `SHOPIFY_STORE_MODE=development` is a human assertion in a file. It is exactly
 * the thing that gets copied from a staging .env into production, or left behind
 * when a dev store's credentials are swapped for real ones. Trusting it alone
 * would mean a test suite could wipe a real catalogue because someone forgot to
 * edit one line.
 *
 * So the declaration is CHECKED against Shopify's own answer -
 * `shop.plan.partnerDevelopment`, which Shopify sets and the operator cannot -
 * and a store only counts as development when BOTH agree. Anything else
 * (disagreement, or Shopify unreachable so no confirmation) is treated as a live
 * store, because that is the direction in which being wrong is survivable.
 *
 * WHAT THIS DOES AND DOES NOT GATE
 * --------------------------------
 * It gates AUTOMATED writes: test suites, seed scripts, smoke tests, dev
 * utilities. It does NOT gate a signed-in operator editing their own shop -
 * running a real store from the console is the whole point of the product.
 * `ALLOW_LIVE_STORE_WRITES=true` is the deliberate override for the rare case of
 * running a tool against a real shop on purpose.
 */

import { AppError } from '../common/errors';
import { logger } from '../common/logger';
import { config } from '../config';
import { getShop } from './shopify.service';

export type EffectiveStoreMode = 'development' | 'production';

export interface StoreSafety {
  /** What SHOPIFY_STORE_MODE claims. */
  declaredMode: EffectiveStoreMode;
  /** True when Shopify actually answered, so the claim could be checked. */
  verified: boolean;
  /** Shopify's own answer (plan.partnerDevelopment). Null when unreachable. */
  shopifyIsDevelopmentStore: boolean | null;
  planDisplayName: string | null;
  /**
   * The mode Trademart ACTS on. 'development' only when the declaration and
   * Shopify agree; everything else resolves to 'production'.
   */
  effectiveMode: EffectiveStoreMode;
  /** True when the declaration and Shopify disagree. Always worth surfacing. */
  mismatch: boolean;
  /** ALLOW_LIVE_STORE_WRITES. */
  liveStoreWritesAcknowledged: boolean;
  /** True when automated tooling is permitted to write. */
  automatedWritesAllowed: boolean;
  /** Plain-language explanation, suitable for an error message or the UI. */
  reason: string;
  checkedAt: string;
}

/**
 * Cached because this is consulted on write paths and must not add a Shopify
 * round trip to each one. Short enough that swapping credentials is noticed
 * quickly; `getShop` has its own cache underneath as well.
 */
const CACHE_TTL_MS = 5 * 60_000;
let cache: { value: StoreSafety; expiresAt: number } | null = null;

export function clearStoreSafetyCache(): void {
  cache = null;
}

function build(
  shopifyIsDevelopmentStore: boolean | null,
  planDisplayName: string | null,
): StoreSafety {
  const declaredMode = config.shopify.storeMode;
  const verified = shopifyIsDevelopmentStore !== null;

  // Both must agree. A single source of truth saying "development" is not
  // enough: the declaration can be stale, and Shopify's answer alone would let a
  // forgotten dev flag in production be overridden by a shop that happens to be
  // a dev store while the operator believed otherwise.
  const effectiveMode: EffectiveStoreMode =
    declaredMode === 'development' && shopifyIsDevelopmentStore === true
      ? 'development'
      : 'production';

  const mismatch =
    verified &&
    ((declaredMode === 'development' && shopifyIsDevelopmentStore === false) ||
      (declaredMode === 'production' && shopifyIsDevelopmentStore === true));

  const liveStoreWritesAcknowledged = config.allowLiveStoreWrites;
  const automatedWritesAllowed =
    effectiveMode === 'development' || liveStoreWritesAcknowledged;

  let reason: string;
  if (effectiveMode === 'development') {
    reason = `${config.shopify.storeDomain} is a Shopify development store and is declared as one, so automated writes are permitted.`;
  } else if (liveStoreWritesAcknowledged) {
    reason = `${config.shopify.storeDomain} is treated as a LIVE store, but ALLOW_LIVE_STORE_WRITES=true explicitly permits automated writes.`;
  } else if (!verified) {
    reason = `Shopify could not confirm whether ${config.shopify.storeDomain} is a development store, so it is treated as live. Automated writes are refused.`;
  } else if (declaredMode === 'development' && shopifyIsDevelopmentStore === false) {
    reason = `SHOPIFY_STORE_MODE says development, but Shopify reports ${config.shopify.storeDomain} is NOT a development store (plan: ${planDisplayName ?? 'unknown'}). Treating it as live and refusing automated writes.`;
  } else {
    reason = `${config.shopify.storeDomain} is a live store, so automated writes are refused.`;
  }

  return {
    declaredMode,
    verified,
    shopifyIsDevelopmentStore,
    planDisplayName,
    effectiveMode,
    mismatch,
    liveStoreWritesAcknowledged,
    automatedWritesAllowed,
    reason,
    checkedAt: new Date().toISOString(),
  };
}

/**
 * Resolves the store's safety posture.
 *
 * Never throws: an unreachable Shopify must not break a diagnostics page. It
 * resolves to the conservative answer instead, which is the safe failure.
 */
export async function getStoreSafety(
  options: { useCache?: boolean } = {},
): Promise<StoreSafety> {
  const useCache = options.useCache ?? true;
  if (useCache && cache !== null && cache.expiresAt > Date.now()) {
    return cache.value;
  }

  let shopifyIsDevelopmentStore: boolean | null = null;
  let planDisplayName: string | null = null;
  try {
    const shop = await getShop();
    shopifyIsDevelopmentStore = shop.isDevelopmentStore;
    planDisplayName = shop.planDisplayName;
  } catch (error) {
    // Unverified resolves to "live", so this degrades safely.
    logger.info('Could not read shop info to confirm the store kind.', {
      reason: error instanceof Error ? error.message : 'unknown',
    });
  }

  const safety = build(shopifyIsDevelopmentStore, planDisplayName);

  if (safety.mismatch) {
    logger.warn('Declared store mode disagrees with Shopify.', {
      declaredMode: safety.declaredMode,
      shopifyIsDevelopmentStore: safety.shopifyIsDevelopmentStore,
      planDisplayName: safety.planDisplayName,
      effectiveMode: safety.effectiveMode,
    });
  }

  cache = { value: safety, expiresAt: Date.now() + CACHE_TTL_MS };
  return safety;
}

/**
 * Refuses an automated write unless the store is a confirmed development store
 * or live writes have been explicitly acknowledged.
 *
 * `operation` appears in the error so the refusal names what was blocked.
 */
export async function assertAutomatedWritesAllowed(operation: string): Promise<StoreSafety> {
  const safety = await getStoreSafety();

  // NODE_ENV=test is treated as automated tooling by definition. Even a confirmed
  // development store still needs the acknowledgement here, because a test run is
  // never something a human is watching.
  const runningTests = config.nodeEnv === 'test';
  const allowed = runningTests
    ? safety.liveStoreWritesAcknowledged || safety.effectiveMode === 'development'
    : safety.automatedWritesAllowed;

  if (!allowed) {
    throw new AppError(
      'LIVE_STORE_WRITE_BLOCKED',
      `Refusing to run "${operation}" against this store. ${safety.reason} If you really mean to run automated tooling against a live store, set ALLOW_LIVE_STORE_WRITES=true for that invocation only.`,
      {
        details: {
          operation,
          declaredMode: safety.declaredMode,
          effectiveMode: safety.effectiveMode,
          shopifyIsDevelopmentStore: safety.shopifyIsDevelopmentStore,
          storeDomain: config.shopify.storeDomain,
        },
      },
    );
  }

  logger.info('Automated write permitted.', {
    operation,
    effectiveMode: safety.effectiveMode,
    acknowledged: safety.liveStoreWritesAcknowledged,
  });
  return safety;
}
