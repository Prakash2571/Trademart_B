/**
 * Route and wiring guard for the research module.
 *
 * Static: it reads the real controller and app.ts, because CI only typechecks and builds.
 * Three failures this catches, two of which have already happened once in this codebase:
 *
 *   1. A double path prefix. publicationsRouter carried its own /shopify prefix on top of
 *      an /api/shopify mount, so every route resolved at /api/shopify/shopify/... and
 *      404'd invisibly.
 *   2. A write route on the READ router, which is mounted behind requireOperatorForReads
 *      and therefore world-writable whenever OPERATOR_PROTECT_READS is false.
 *   3. A publish route appearing in research. The brief forbids auto-publish outright, and
 *      this is the boundary that keeps a scored guess away from customers.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const READ = readFileSync(
  join(process.cwd(), 'src', 'intelligence', 'intelligence.controller.ts'),
  'utf8',
);
const WRITE = readFileSync(
  join(process.cwd(), 'src', 'intelligence', 'intelligence.write.controller.ts'),
  'utf8',
);
const PUSH = readFileSync(join(process.cwd(), 'src', 'intelligence', 'push.draft.ts'), 'utf8');
const APP = readFileSync(join(process.cwd(), 'src', 'app.ts'), 'utf8');

function routes(source: string, router: string): { method: string; path: string }[] {
  const found: { method: string; path: string }[] = [];
  const re = new RegExp(`${router}\\.(get|post|put|patch|delete)\\(\\s*'([^']+)'`, 'g');
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    if (match[1] !== undefined && match[2] !== undefined) {
      found.push({ method: match[1], path: match[2] });
    }
  }
  return found;
}

/* ===========================================================================
 * Paths
 * ======================================================================== */

describe('research routes are relative to the /api mount', () => {
  const all = [
    ...routes(READ, 'intelligenceRouter'),
    ...routes(WRITE, 'intelligenceWriteRouter'),
  ];

  it('registers the expected routes', () => {
    assert.deepEqual(
      new Set(all.map((route) => `${route.method.toUpperCase()} ${route.path}`)),
      new Set([
        'GET /intelligence/capabilities',
        'GET /intelligence/candidates',
        'GET /intelligence/candidates/:id',
        'GET /intelligence/candidates/:id/duplicates',
        'POST /intelligence/candidates',
        'PATCH /intelligence/candidates/:id',
        'POST /intelligence/candidates/:id/analyze',
        'POST /intelligence/candidates/:id/watch',
        'POST /intelligence/candidates/:id/reject',
        'POST /intelligence/candidates/:id/push',
      ]),
    );
  });

  it('every path starts with /intelligence and none double-prefixes /api', () => {
    for (const route of all) {
      assert.ok(
        route.path.startsWith('/intelligence'),
        `Route "${route.path}" must start with /intelligence - the routers are mounted at /api.`,
      );
      assert.ok(
        !route.path.startsWith('/api'),
        `Route "${route.path}" double-prefixes the mount and would resolve at /api/api/... and 404.`,
      );
    }
  });
});

/* ===========================================================================
 * Read/write separation
 * ======================================================================== */

describe('reads and writes are on separate routers', () => {
  it('the read router registers only GET', () => {
    const writes = routes(READ, 'intelligenceRouter').filter((route) => route.method !== 'get');
    assert.deepEqual(
      writes,
      [],
      `The read router is mounted behind requireOperatorForReads, so a write here would be world-writable whenever OPERATOR_PROTECT_READS is false. Found: ${writes
        .map((w) => `${w.method.toUpperCase()} ${w.path}`)
        .join(', ')}`,
    );
  });

  it('the write router registers no GET', () => {
    // A read on the write router would be needlessly gated, and would blur which router
    // carries which guarantee.
    const reads = routes(WRITE, 'intelligenceWriteRouter').filter(
      (route) => route.method === 'get',
    );
    assert.deepEqual(reads, []);
  });

  it('the read router is mounted at /api behind the read guard', () => {
    assert.match(
      APP,
      /app\.use\('\/api', requireOperatorForReads, intelligenceRouter\)/,
      'intelligenceRouter must be mounted at /api with requireOperatorForReads',
    );
  });

  it('the write router is mounted at /api behind the WRITE guard', () => {
    assert.match(
      APP,
      /app\.use\('\/api', requireOperatorForWrites, intelligenceWriteRouter\)/,
      'intelligenceWriteRouter must be mounted at /api with requireOperatorForWrites',
    );
  });
});

/* ===========================================================================
 * It cannot publish
 * ======================================================================== */

describe('research can never publish', () => {
  it('registers no publish or unpublish route', () => {
    const all = [
      ...routes(READ, 'intelligenceRouter'),
      ...routes(WRITE, 'intelligenceWriteRouter'),
    ];
    for (const route of all) {
      assert.ok(
        !/publish/i.test(route.path),
        `Research must not expose "${route.path}". Publishing stays in the publications module, done by an operator who has read the listing.`,
      );
    }
  });

  it('exposes a push route, and it is named push rather than publish', () => {
    const push = routes(WRITE, 'intelligenceWriteRouter').find((route) =>
      route.path.endsWith('/push'),
    );
    if (push === undefined) throw new Error('the push route is missing');
    assert.equal(push.method, 'post');
  });

  it('hard-codes DRAFT and publish false in the request builder', () => {
    // Not a default a caller could override - the literal values, in the source.
    assert.match(PUSH, /status:\s*'DRAFT'/, 'buildDraftRequest must hard-code status DRAFT');
    assert.match(PUSH, /publish:\s*false/, 'buildDraftRequest must hard-code publish false');
    assert.ok(
      !/publish:\s*true/.test(PUSH),
      'nothing in the draft builder may set publish true',
    );
  });

  it('does not import the publication service anywhere in research', () => {
    // An import would mean this module had grown the ability to publish, which is the
    // thing the boundary exists to prevent.
    for (const source of [READ, WRITE, PUSH]) {
      assert.ok(
        !/publications\.service/.test(source),
        'the research module must not import the publication service',
      );
    }
  });

  it('tells the caller plainly that nothing was published', () => {
    assert.match(WRITE, /published: false/);
    assert.ok(WRITE.includes('Nothing has been published'));
  });
});

/* ===========================================================================
 * Refusals that must not be quietly relaxed
 * ======================================================================== */

describe('write routes demand what they should', () => {
  it('reject requires a reason', () => {
    // A rejected candidate with no reason is one somebody researches again in six months.
    assert.ok(WRITE.includes('A reason is required to reject a candidate'));
  });

  it('watch requires an end date', () => {
    assert.ok(WRITE.includes('watchUntil must be an ISO date'));
  });

  it('a duplicate override must be exactly true, not merely truthy', () => {
    // A truthy string from a form would otherwise silently bypass the duplicate block.
    assert.match(WRITE, /allowDuplicate'\]\s*===\s*true/);
  });
});
