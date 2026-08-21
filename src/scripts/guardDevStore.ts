/**
 * Refuses to proceed unless this deployment points at a Shopify development
 * store (or live writes have been explicitly acknowledged).
 *
 * Meant to be the FIRST line of any script that can mutate a store, so that the
 * check is a precondition rather than something the script author had to
 * remember:
 *
 *     npm run guard:dev-store && ./scripts/seed.sh
 *
 * Exits 0 when writing is permitted, 1 when it is not. Prints the reason either
 * way, because "blocked" without a reason just gets worked around.
 */

import { logger } from '../common/logger';
import { config } from '../config';
import { assertAutomatedWritesAllowed, getStoreSafety } from '../shopify/storeMode';
import { AppError } from '../common/errors';

const operation = process.argv[2] ?? 'automated store write';

async function main(): Promise<void> {
  const safety = await getStoreSafety({ useCache: false });

  console.error('Trademart store safety check');
  console.error(`  store             : ${config.shopify.storeDomain}`);
  console.error(`  declared mode     : ${safety.declaredMode}`);
  console.error(
    `  Shopify says      : ${
      safety.shopifyIsDevelopmentStore === null
        ? 'unknown (could not reach Shopify)'
        : safety.shopifyIsDevelopmentStore
          ? 'development store'
          : 'NOT a development store'
    }`,
  );
  console.error(`  plan              : ${safety.planDisplayName ?? 'unknown'}`);
  console.error(`  effective mode    : ${safety.effectiveMode}`);
  console.error(`  live writes ack'd : ${safety.liveStoreWritesAcknowledged}`);
  console.error('');

  try {
    await assertAutomatedWritesAllowed(operation);
    console.error(`ALLOWED: ${safety.reason}`);
    process.exit(0);
  } catch (error) {
    const appError = error instanceof AppError ? error : null;
    console.error(`BLOCKED: ${appError?.message ?? String(error)}`);
    process.exit(1);
  }
}

void main().catch((error: unknown) => {
  // A crash here must also block. Failing open would defeat the purpose.
  logger.error('Store safety check failed to run; treating that as blocked.', {
    reason: error instanceof Error ? error.message : 'unknown',
  });
  process.exit(1);
});
