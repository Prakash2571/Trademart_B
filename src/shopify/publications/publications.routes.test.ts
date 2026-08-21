/**
 * Route-path guard for the publications controllers.
 *
 * WHY THIS EXISTS
 * ---------------
 * Both publication routers are mounted at `/api/shopify` in app.ts, exactly like
 * productsRouter and shopifyRouter. So their route STRINGS must be relative to
 * that mount - `/publications`, `/products/:id/publish` - NOT `/shopify/...`.
 *
 * They previously carried a `/shopify/` prefix, which Express appends to the
 * mount: the endpoints resolved at `/api/shopify/shopify/publications`. That is a
 * double prefix, it 404s, and it silently disagreed with BOTH the controller's own
 * header documentation and every call the frontend makes. Nothing caught it,
 * because the routes have no request-level tests and CI only typechecks and builds.
 *
 * This reads the real controller source and fails the build if the prefix ever
 * comes back, since the failure mode is invisible until a publish 404s in
 * production.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const SOURCE = readFileSync(
  join(process.cwd(), 'src', 'shopify', 'publications', 'publications.controller.ts'),
  'utf8',
);
const APP = readFileSync(join(process.cwd(), 'src', 'app.ts'), 'utf8');

/** Every string literal passed as the first argument to a router .get/.post. */
function routePaths(): string[] {
  const paths: string[] = [];
  const re = /Router\.(?:get|post|put|patch|delete)\(\s*'([^']+)'/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(SOURCE)) !== null) {
    if (match[1] !== undefined) paths.push(match[1]);
  }
  return paths;
}

describe('publications routes are relative to the /api/shopify mount', () => {
  const paths = routePaths();

  it('declares the four expected routes', () => {
    assert.deepEqual(new Set(paths), new Set([
      '/publications',
      '/products/:id/publications',
      '/products/:id/publish',
      '/products/:id/unpublish',
    ]));
  });

  it('no route string carries a /shopify prefix (the mount already provides it)', () => {
    for (const path of paths) {
      assert.ok(
        !path.startsWith('/shopify'),
        `Route "${path}" starts with /shopify, but the router is mounted at /api/shopify, so this resolves at /api/shopify/shopify${path} and 404s. Drop the prefix.`,
      );
    }
  });

  it('both routers are still mounted at /api/shopify in app.ts', () => {
    // If the mount is ever changed to /api, the route strings would need the
    // prefix back - this pins the assumption the paths above rely on.
    assert.match(APP, /app\.use\('\/api\/shopify', requireOperatorForReads, publicationsRouter\)/);
    assert.match(APP, /app\.use\('\/api\/shopify', requireOperatorForWrites, publicationsWriteRouter\)/);
  });

  it('the documented external paths match mount + route', () => {
    // The header comment promises /api/shopify/publications etc. Confirm the code
    // now delivers exactly that.
    const external = paths.map((p) => `/api/shopify${p}`);
    assert.ok(external.includes('/api/shopify/publications'));
    assert.ok(external.includes('/api/shopify/products/:id/publish'));
    assert.ok(external.includes('/api/shopify/products/:id/unpublish'));
    assert.ok(external.includes('/api/shopify/products/:id/publications'));
  });
});
