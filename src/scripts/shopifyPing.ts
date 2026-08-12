/**
 * Documented manual integration test against the real dev store.
 *
 *   npm run shopify:ping
 *
 * Requires a real SHOPIFY_ACCESS_TOKEN in .env. This is the ONLY script that
 * talks to Shopify for real - automated tests never need network access.
 *
 * It prints a per-scope pass/fail matrix so missing scopes are immediately
 * obvious, and exits non-zero if the basic shop query fails.
 */

import { AppError } from '../common/errors';
import { config, isShopifyConfigured } from '../config';
import {
  getCounts,
  getShop,
  listCustomers,
  listInventory,
  listOrders,
  listProducts,
} from '../shopify/shopify.service';

type CheckResult = { name: string; ok: boolean; detail: string };

async function check(name: string, run: () => Promise<string>): Promise<CheckResult> {
  try {
    const detail = await run();
    return { name, ok: true, detail };
  } catch (error) {
    const detail =
      error instanceof AppError
        ? `${error.code}: ${error.message}`
        : error instanceof Error
          ? error.message
          : 'unknown error';
    return { name, ok: false, detail };
  }
}

async function main(): Promise<void> {
  console.log('Trademart -> Shopify connection test');
  console.log(`  store        : ${config.shopify.storeDomain}`);
  console.log(`  api version  : ${config.shopify.apiVersion}`);
  console.log(`  endpoint     : ${config.shopify.graphqlEndpoint}`);
  console.log(`  token present: ${isShopifyConfigured() ? 'yes' : 'NO'}`);
  console.log('');

  if (!isShopifyConfigured()) {
    console.error('SHOPIFY_ACCESS_TOKEN is not set. Add it to .env and re-run.');
    process.exit(1);
  }

  const results: CheckResult[] = [];

  results.push(
    await check('shop (connection test)', async () => {
      const shop = await getShop({ useCache: false });
      return `${shop.name} | ${shop.myshopifyDomain} | plan=${shop.planDisplayName ?? 'n/a'} | currency=${shop.currencyCode}`;
    }),
  );

  results.push(
    await check('products (read_products)', async () => {
      const page = await listProducts({ first: 3 });
      const degraded = page.meta.degraded?.length
        ? ` | degraded: ${page.meta.degraded.join(', ')}`
        : '';
      return `${page.meta.count} product(s)${degraded}`;
    }),
  );

  results.push(
    await check('orders (read_orders)', async () => {
      const page = await listOrders({ first: 3 });
      const degraded = page.meta.degraded?.length
        ? ` | degraded: ${page.meta.degraded.join(', ')}`
        : '';
      return `${page.meta.count} order(s)${degraded}`;
    }),
  );

  results.push(
    await check('customers (read_customers + protected data)', async () => {
      const page = await listCustomers({ first: 3 });
      const degraded = page.meta.degraded?.length
        ? ` | PII withheld: ${page.meta.degraded.join(', ')}`
        : '';
      return `${page.meta.count} customer(s)${degraded}`;
    }),
  );

  results.push(
    await check('inventory (read_inventory)', async () => {
      const page = await listInventory({ first: 3 });
      return `${page.meta.count} inventory item(s)`;
    }),
  );

  results.push(
    await check('counts', async () => {
      const { counts, notes } = await getCounts();
      const suffix = notes.length > 0 ? ` | notes: ${notes.length}` : '';
      return `products=${counts.products ?? 'n/a'} orders=${counts.orders ?? 'n/a'} customers=${counts.customers ?? 'n/a'}${suffix}`;
    }),
  );

  console.log('Results');
  for (const result of results) {
    console.log(`  [${result.ok ? 'PASS' : 'FAIL'}] ${result.name}`);
    console.log(`         ${result.detail}`);
  }

  const shopCheck = results[0];
  if (!shopCheck?.ok) {
    console.error('\nConnection test FAILED - the shop query did not succeed.');
    process.exit(1);
  }

  const failures = results.filter((result) => !result.ok).length;
  console.log(
    `\nConnection OK. ${results.length - failures}/${results.length} checks passed.`,
  );
  if (failures > 0) {
    console.log(
      'Failures above are usually missing access scopes - add them to the app, release a new version, then update the install on the store.',
    );
  }
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error('Unexpected error:', error instanceof Error ? error.message : error);
  process.exit(1);
});
