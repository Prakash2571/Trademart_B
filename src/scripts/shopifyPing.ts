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
import { getTokenProvider } from '../shopify/token';

type CheckResult = { name: string; ok: boolean; detail: string };

/**
 * Reports credential SHAPE, never content.
 *
 * A wrong secret is invisible, but a blank, truncated or accidentally swapped
 * value shows up immediately in the length. Shopify client ids and secrets are
 * normally 32 hex characters.
 */
function describeCredentials(): string {
  const parts: string[] = [];
  const { clientId, clientSecret, accessToken } = config.shopify;

  parts.push(
    clientId === null
      ? 'client_id NOT SET'
      : `client_id ${clientId.length} chars${clientId.length !== 32 ? ' (expected 32 - check for a truncated paste)' : ''}`,
  );
  parts.push(
    clientSecret === null
      ? 'client_secret NOT SET'
      : `client_secret ${clientSecret.length} chars${clientSecret.length !== 32 ? ' (expected 32 - check for a truncated paste)' : ''}`,
  );

  // Catches pasting the same value into both fields.
  if (clientId !== null && clientSecret !== null && clientId === clientSecret) {
    parts.push('WARNING: client_id and client_secret are identical');
  }
  if (accessToken !== null) {
    parts.push('static token override ACTIVE');
  }

  return parts.join(', ');
}

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
  console.log(`  auth strategy: ${config.shopify.authStrategy}`);
  // Lengths only - enough to spot a blank, truncated or swapped value without
  // ever printing a credential.
  console.log(`  credentials  : ${describeCredentials()}`);
  console.log('');

  if (!isShopifyConfigured()) {
    console.error(
      'No Shopify credentials configured. Set SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET in .env and re-run.',
    );
    process.exit(1);
  }

  const results: CheckResult[] = [];

  // Proves the client credentials grant works before anything else is tried.
  results.push(
    await check('access token (client credentials grant)', async () => {
      const provider = getTokenProvider();
      if (provider === null) throw new Error('No token provider configured.');
      await provider.getAccessToken(config.shopify.storeDomain);
      const diagnostics = provider.describe(config.shopify.storeDomain);
      const lifetime =
        diagnostics.expiresInSeconds === null
          ? 'no expiry reported'
          : `expires in ${diagnostics.expiresInSeconds}s`;
      const scopes =
        diagnostics.scopes.length > 0
          ? `granted scopes: ${diagnostics.scopes.join(', ')}`
          : 'granted scopes not reported';
      return `${diagnostics.strategy} | ${lifetime} | ${scopes}`;
    }),
  );

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
      const { counts, issues } = await getCounts();
      const suffix =
        issues.length > 0
          ? ` | issues: ${issues.map((issue) => issue.code).join(', ')}`
          : '';
      return `products=${counts.products ?? 'n/a'} orders=${counts.orders ?? 'n/a'} customers=${counts.customers ?? 'n/a'}${suffix}`;
    }),
  );

  console.log('Results');
  for (const result of results) {
    console.log(`  [${result.ok ? 'PASS' : 'FAIL'}] ${result.name}`);
    console.log(`         ${result.detail}`);
  }

  // Gate on authentication first, then the shop query - if the token could not
  // be obtained, every later failure is just a consequence of that.
  const tokenCheck = results[0];
  if (!tokenCheck?.ok) {
    console.error(
      '\nConnection test FAILED - could not obtain an access token. Check SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET and that the app is installed on the store.',
    );
    process.exit(1);
  }

  const shopCheck = results[1];
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
