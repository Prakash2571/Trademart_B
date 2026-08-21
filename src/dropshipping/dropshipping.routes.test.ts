/**
 * Route and wiring guard for the dropshipping module.
 *
 * Two things this stops, both of which have already happened once in this codebase:
 *
 *   1. A double path prefix. publicationsRouter carried its own `/shopify` prefix on
 *      top of a `/api/shopify` mount, so every route resolved at
 *      `/api/shopify/shopify/...` and 404'd - invisibly, because CI only typechecks
 *      and builds. dropshippingRouter is mounted at `/api`, so its paths MUST start
 *      with `/dropshipping`.
 *
 *   2. A write route appearing in a read-only module. This module reports on Shopify
 *      orders and must never change them: fulfilling, refunding and cancelling stay
 *      in Shopify, where the merchant's own process and audit trail live. A POST here
 *      mounted behind requireOperatorForReads would be world-writable whenever
 *      OPERATOR_PROTECT_READS is false.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const CONTROLLER = readFileSync(
  join(process.cwd(), 'src', 'dropshipping', 'dropshipping.controller.ts'),
  'utf8',
);
const APP = readFileSync(join(process.cwd(), 'src', 'app.ts'), 'utf8');

/** Every (method, path) pair registered on the router. */
function routes(): { method: string; path: string }[] {
  const found: { method: string; path: string }[] = [];
  const re = /dropshippingRouter\.(get|post|put|patch|delete)\(\s*'([^']+)'/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(CONTROLLER)) !== null) {
    if (match[1] !== undefined && match[2] !== undefined) {
      found.push({ method: match[1], path: match[2] });
    }
  }
  return found;
}

describe('dropshipping routes are relative to the /api mount', () => {
  const registered = routes();

  it('registers the expected read routes', () => {
    assert.deepEqual(
      new Set(registered.map((route) => route.path)),
      new Set([
        '/dropshipping/orders',
        '/dropshipping/orders/:id',
        '/dropshipping/dashboard',
        '/dropshipping/settings',
      ]),
    );
  });

  it('every path starts with /dropshipping and none double-prefixes /api', () => {
    for (const route of registered) {
      assert.ok(
        route.path.startsWith('/dropshipping'),
        `Route "${route.path}" must start with /dropshipping - the router is mounted at /api.`,
      );
      assert.ok(
        !route.path.startsWith('/api'),
        `Route "${route.path}" double-prefixes the mount and would resolve at /api/api/... and 404.`,
      );
    }
  });

  it('is mounted at /api behind the operator read guard', () => {
    assert.match(
      APP,
      /app\.use\('\/api', requireOperatorForReads, dropshippingRouter\)/,
      'dropshippingRouter must be mounted at /api with requireOperatorForReads',
    );
  });
});

describe('the dropshipping module is read-only', () => {
  it('registers no state-changing routes', () => {
    // If a write is ever genuinely needed here it must go on a SEPARATE router behind
    // requireOperatorForWrites, and auth.wiring.test.ts must assert that - which is
    // why this fails loudly rather than being quietly relaxed.
    const writes = routes().filter((route) => route.method !== 'get');
    assert.deepEqual(
      writes,
      [],
      `Dropshipping is read-only, but found: ${writes.map((w) => `${w.method.toUpperCase()} ${w.path}`).join(', ')}. Move writes to a router behind requireOperatorForWrites.`,
    );
  });

  it('does not import a Shopify mutation', () => {
    // A mutation import here would mean this module had grown the ability to change
    // the store, which is the thing the read-only boundary exists to prevent.
    assert.ok(
      !/MUTATION/.test(CONTROLLER),
      'the dropshipping controller must not reference a Shopify mutation',
    );
  });
});
