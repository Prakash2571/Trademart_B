/**
 * Refuses to proceed unless this deployment points at a Shopify development
 * store (or live writes have been explicitly acknowledged).
 *
 * Meant to be the FIRST line of any script that can mutate a store, so the check
 * is a precondition rather than something each script author had to remember:
 *
 *     npm run guard:dev-store && ./scripts/smoke-test.sh
 *
 * Exits 0 when writing is permitted, 1 when it is not, and prints the reason
 * either way - "blocked" with no reason just gets worked around.
 *
 * WHY THIS EXISTS SEPARATELY FROM OPERATOR AUTH
 * --------------------------------------------
 * A signed-in operator may of course operate their own live store. The danger is
 * a SCRIPT - a write smoke test, a seeder, an `npm test` that reached the network
 * - silently mutating a real, customer-facing store. So this guards tooling, and
 * no normal API endpoint calls it.
 *
 * Diagnostics go to stderr, so a caller can capture stdout without the banner
 * ending up in whatever it is piping.
 */

import { AppError } from '../common/errors';
import { logger } from '../common/logger';
import { config } from '../config';
import { getShop } from '../shopify/shopify.service';
import { assertToolingWritesAllowed, resolveStoreSafety } from '../shopify/storeSafety';

const operation = process.argv[2] ?? 'automated store write';

async function main(): Promise<void> {
  /**
   * Shopify's real flag, which OVERRIDES the declared SHOPIFY_STORE_MODE.
   *
   * Uncached: a stale answer is the wrong answer right after a credential swap,
   * which is exactly when this gets run.
   *
   * If Shopify cannot be reached this stays null, and resolveStoreSafety treats
   * UNKNOWN as potentially live. That fail-safe is the whole point: a script must
   * not become allowed to write to a live store just because the check that would
   * have identified it was unavailable.
   */
  let shopIsDevelopmentStore: boolean | null = null;
  let planDisplayName: string | null = null;
  let lookupError: string | null = null;

  try {
    const shop = await getShop({ useCache: false });
    shopIsDevelopmentStore = shop.isDevelopmentStore;
    planDisplayName = shop.planDisplayName;
  } catch (error) {
    lookupError = error instanceof Error ? error.message : 'unknown';
  }

  const input = {
    shopIsDevelopmentStore,
    storeMode: config.shopify.storeMode,
    allowLiveStoreWrites: config.shopify.allowLiveStoreWrites,
  };
  const safety = resolveStoreSafety(input);

  console.error('Trademart store safety check');
  console.error(`  operation          : ${operation}`);
  console.error(`  store              : ${config.shopify.storeDomain}`);
  console.error(`  declared mode      : ${config.shopify.storeMode ?? 'not set'}`);
  console.error(
    `  Shopify says       : ${
      shopIsDevelopmentStore === null
        ? `unknown${lookupError === null ? '' : ` (${lookupError})`}`
        : shopIsDevelopmentStore
          ? 'development store'
          : 'NOT a development store'
    }`,
  );
  console.error(`  plan               : ${planDisplayName ?? 'unknown'}`);
  console.error(`  classification     : ${safety.classification} (from ${safety.source})`);
  console.error(`  live writes ack'd  : ${safety.allowLiveStoreWrites}`);
  console.error('');

  try {
    assertToolingWritesAllowed(input);
    console.error(`ALLOWED: ${safety.reason}`);
    process.exit(0);
  } catch (error) {
    const appError = error instanceof AppError ? error : null;
    console.error(`BLOCKED: ${appError?.message ?? String(error)}`);
    process.exit(1);
  }
}

void main().catch((error: unknown) => {
  // A crash here must also block. Failing open would defeat the entire purpose:
  // the one situation where the guard is most needed is the one where something
  // unexpected is wrong with the configuration.
  logger.error('Store safety check failed to run; treating that as blocked.', {
    reason: error instanceof Error ? error.message : 'unknown',
  });
  process.exit(1);
});
