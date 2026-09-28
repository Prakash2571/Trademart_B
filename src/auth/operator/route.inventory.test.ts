/**
 * The route inventory must stay complete.
 *
 * WHY THIS TEST EXISTS
 * --------------------
 * Both information leaks found in the second hardening pass were the same shape: a
 * route that had quietly ended up on a router mounted without a guard. `GET
 * /api/webhooks/status` was declared on the webhook RECEIVER router, and `GET
 * /api/auth/status` on the public OAuth router. Neither was a bad decision at the
 * time - each was one line next to routes that genuinely must be public - and neither
 * was visible unless you already knew to look.
 *
 * The defence is enumeration. docs/ROUTE_SECURITY.md lists every route with the
 * control that protects it, and this test parses the routers out of the source and
 * compares. A new route is then a documentation change as well as a code change, and
 * the reviewer is told what the access column has to say.
 *
 * It deliberately checks EXISTENCE, not the access column: a test cannot infer intent,
 * and pretending to would produce a green build that proves nothing. The mount-level
 * guarantees are asserted separately in auth.wiring.test.ts.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const SRC = join(process.cwd(), 'src');
const INVENTORY = readFileSync(join(process.cwd(), 'docs', 'ROUTE_SECURITY.md'), 'utf8');

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, found);
    else if (entry.name.endsWith('.ts') && !entry.name.includes('.test.')) found.push(full);
  }
  return found;
}

interface DeclaredRoute {
  router: string;
  method: string;
  path: string;
  file: string;
}

/**
 * Every route registered on an Express router in src/.
 *
 * Matches `<something>Router.get('/path'` and the locally-named `router.post('/path'`
 * used by the storefront factories.
 */
function declaredRoutes(): DeclaredRoute[] {
  const routes: DeclaredRoute[] = [];
  for (const file of sourceFiles(SRC)) {
    const source = readFileSync(file, 'utf8');
    const pattern =
      /(\w*[Rr]outer)\.(get|post|put|patch|delete)\(\s*\n?\s*['"`]([^'"`]+)['"`]/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      routes.push({
        router: match[1] as string,
        method: (match[2] as string).toUpperCase(),
        path: match[3] as string,
        file: file.slice(SRC.length + 1),
      });
    }
  }
  return routes;
}

/**
 * Mount prefix for each router, so a declared path can be compared with the
 * documented full path. Kept as data rather than parsed out of app.ts, because the
 * mount prefix is the one part of this that genuinely needs a human decision - and
 * auth.wiring.test.ts already asserts the guards at those mount points.
 */
const MOUNT: Record<string, string> = {
  healthRouter: '/api',
  publicDiagnosticsRouter: '/api',
  operatorRouter: '/api/operator',
  oauthRouter: '/api/auth',
  oauthAdminRouter: '/api/auth',
  webhooksRouter: '/api',
  webhookAdminRouter: '/api',
  automationRouter: '/api',
  auditRouter: '/api',
  diagnosticsRouter: '/api',
  operationsRouter: '/api',
  analyticsRouter: '/api',
  pricingRouter: '/api',
  suppliersRouter: '/api',
  manualCostRouter: '/api',
  // Mounted at its own prefix so its unconditional operator guard runs only there.
  deodapRouter: '/api/suppliers/deodap',
  themesRouter: '/api',
  dropshippingRouter: '/api',
  dropshippingWriteRouter: '/api',
  intelligenceRouter: '/api',
  intelligenceWriteRouter: '/api',
  customersRouter: '/api/shopify',
  inventoryRouter: '/api/shopify',
  inventoryWriteRouter: '/api/shopify',
  ordersRouter: '/api/shopify',
  productsRouter: '/api/shopify',
  productsWriteRouter: '/api/shopify',
  publicationsRouter: '/api/shopify',
  publicationsWriteRouter: '/api/shopify',
  shopifyRouter: '/api/shopify',
  storefrontCatalogRouter: '/api',
  // The storefront checkout/orders/razorpay factories build a local `router`, all
  // mounted at /api.
  router: '/api',
};

/** Full paths the inventory documents, from its markdown tables. */
function documentedRoutes(): Set<string> {
  const documented = new Set<string>();
  for (const line of INVENTORY.split('\n')) {
    const match = /^\|\s*(GET|POST|PUT|PATCH|DELETE)\s*\|\s*`([^`]+)`/.exec(line.trim());
    if (match) documented.add(`${match[1] as string} ${match[2] as string}`);
  }
  return documented;
}

describe('every route is in docs/ROUTE_SECURITY.md', () => {
  const routes = declaredRoutes();
  const documented = documentedRoutes();

  it('found the routers (so the parser has not silently stopped working)', () => {
    // Without this, every assertion below could pass vacuously.
    assert.ok(routes.length >= 80, `only found ${routes.length} routes`);
    assert.ok(documented.size >= 80, `only found ${documented.size} documented routes`);
  });

  it('knows the mount prefix for every router it found', () => {
    const unknown = [...new Set(routes.map((route) => route.router))].filter(
      (router) => MOUNT[router] === undefined,
    );
    assert.deepEqual(
      unknown,
      [],
      `add these routers to the MOUNT map (and to docs/ROUTE_SECURITY.md): ${unknown.join(', ')}`,
    );
  });

  it('documents every declared route', () => {
    const missing = routes
      .map((route) => `${route.method} ${MOUNT[route.router] ?? '?'}${route.path}`)
      .filter((full) => !documented.has(full))
      .sort();

    assert.deepEqual(
      [...new Set(missing)],
      [],
      `these routes exist but are not in docs/ROUTE_SECURITY.md. Add a row stating who may call them, whether CSRF applies, which limiter, and whether they need the database:\n  ${[
        ...new Set(missing),
      ].join('\n  ')}`,
    );
  });

  it('documents no route that no longer exists', () => {
    // Stale rows are worse than missing ones: they describe a control for something
    // that is not there, and make the inventory look more complete than it is.
    const actual = new Set(
      routes.map((route) => `${route.method} ${MOUNT[route.router] ?? '?'}${route.path}`),
    );
    const stale = [...documented].filter((full) => !actual.has(full)).sort();

    assert.deepEqual(
      stale,
      [],
      `docs/ROUTE_SECURITY.md documents routes that do not exist:\n  ${stale.join('\n  ')}`,
    );
  });
});

describe('no route mutates behind a GET', () => {
  // A GET that changes state is reachable from a link, a prefetch and a crawler, and
  // is exempt from the CSRF check by design - the check only guards mutating methods.
  // The OAuth callback is the one exception and is called out explicitly.
  const MUTATING_HINTS = [
    'publish',
    'unpublish',
    'apply',
    'approve',
    'reject',
    'retry',
    'register',
    'unregister',
    'verify',
    'set',
    'push',
    'analyze',
    'watch',
  ];

  it('no GET path reads like an action', () => {
    const suspicious = declaredRoutes()
      .filter((route) => route.method === 'GET')
      .filter((route) =>
        MUTATING_HINTS.some((hint) =>
          route.path.toLowerCase().split(/[/-]/).includes(hint),
        ),
      )
      .map((route) => `${route.router} GET ${route.path}`);

    assert.deepEqual(
      suspicious,
      [],
      `these GET routes look like actions. A GET must not change state - it is followed by prefetchers and exempt from CSRF: ${suspicious.join(', ')}`,
    );
  });

  it('the OAuth callback is the documented exception', () => {
    // GET /api/auth/callback DOES change state: it exchanges the code and stores an
    // offline token. It has to be a GET because Shopify redirects a browser to it,
    // and it is secured by HMAC over the raw query string plus a signed, shop-bound
    // state nonce - so it is safe, but it must stay deliberate.
    const controller = readFileSync(
      join(SRC, 'auth', 'oauth.controller.ts'),
      'utf8',
    );
    assert.ok(controller.includes('verifyOAuthHmac'), 'the callback must verify the HMAC');
    assert.ok(controller.includes('verifyOAuthState'), 'the callback must verify the state nonce');
  });
});
