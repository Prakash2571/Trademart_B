/**
 * Development-store safety for automated TOOLING.
 *
 * This guards dev/test/seed/smoke scripts - NOT normal operator actions. A
 * signed-in operator may of course operate their live store; the danger is a
 * script (a write smoke test, a seeder, a `npm test` that reached the network)
 * mutating a real, customer-facing store by accident.
 *
 * The decision never trusts the manually-set SHOPIFY_STORE_MODE alone. When
 * Shopify's real `shop.isDevelopmentStore` is known it wins, because a typo in
 * an env var must not be able to reclassify a live store as safe.
 *
 * A live store is writable by tooling ONLY when ALLOW_LIVE_STORE_WRITES=true
 * (default false), the explicit acknowledgement the operator opts into.
 *
 * Pure by design (inputs are passed in, config is read at the call site) so it
 * can be unit tested without loading the config singleton.
 */

import { AppError } from '../common/errors';

export type StoreClassification = 'DEVELOPMENT' | 'LIVE' | 'UNKNOWN';

export interface StoreSafetyInput {
  /** Shopify's real flag when known (from getShop), else null. */
  shopIsDevelopmentStore?: boolean | null;
  /** Operator's declared mode (config.shopify.storeMode). */
  storeMode: 'development' | 'production' | null;
  /** config.shopify.allowLiveStoreWrites. */
  allowLiveStoreWrites: boolean;
}

export interface StoreSafety {
  classification: StoreClassification;
  /** Where the classification came from. */
  source: 'shopify' | 'config' | 'unknown';
  /** Whether automated tooling may perform writes. */
  toolingWritesAllowed: boolean;
  allowLiveStoreWrites: boolean;
  reason: string;
}

/** Classifies the store and decides whether tooling may write. Pure. */
export function resolveStoreSafety(input: StoreSafetyInput): StoreSafety {
  const { shopIsDevelopmentStore, storeMode, allowLiveStoreWrites: allow } = input;

  let classification: StoreClassification;
  let source: StoreSafety['source'];

  if (shopIsDevelopmentStore === true) {
    classification = 'DEVELOPMENT';
    source = 'shopify';
  } else if (shopIsDevelopmentStore === false) {
    classification = 'LIVE';
    source = 'shopify';
  } else if (storeMode === 'development') {
    classification = 'DEVELOPMENT';
    source = 'config';
  } else if (storeMode === 'production') {
    classification = 'LIVE';
    source = 'config';
  } else {
    classification = 'UNKNOWN';
    source = 'unknown';
  }

  // A development store is always writable by tooling. A live or UNKNOWN store
  // (fail safe: unknown is treated as potentially live) requires the explicit
  // ALLOW_LIVE_STORE_WRITES acknowledgement.
  const toolingWritesAllowed = classification === 'DEVELOPMENT' || allow;

  const reason =
    classification === 'DEVELOPMENT'
      ? `Development store (${source}); tooling writes allowed.`
      : classification === 'LIVE'
        ? allow
          ? `Live store (${source}), but ALLOW_LIVE_STORE_WRITES=true acknowledges it.`
          : `Live store (${source}); tooling writes refused. Set ALLOW_LIVE_STORE_WRITES=true to override.`
        : allow
          ? 'Store type unknown, but ALLOW_LIVE_STORE_WRITES=true acknowledges the risk.'
          : 'Store type unknown; treated as live. Tooling writes refused. Set SHOPIFY_STORE_MODE=development or ALLOW_LIVE_STORE_WRITES=true.';

  return { classification, source, toolingWritesAllowed, allowLiveStoreWrites: allow, reason };
}

/**
 * Throws unless automated tooling is allowed to write to the current store.
 *
 * Call at the top of any dev/test/seed/smoke script BEFORE any Shopify write.
 * Normal operator endpoints must NOT call this - it would block legitimate
 * live-store operation.
 */
export function assertToolingWritesAllowed(input: StoreSafetyInput): StoreSafety {
  const safety = resolveStoreSafety(input);
  if (!safety.toolingWritesAllowed) {
    throw new AppError('LIVE_STORE_WRITE_BLOCKED', safety.reason);
  }
  return safety;
}
