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
const PORTS = readFileSync(join(process.cwd(), 'src', 'intelligence', 'push.ports.ts'), 'utf8');
const ORCHESTRATOR = readFileSync(
  join(process.cwd(), 'src', 'intelligence', 'push.orchestrator.ts'),
  'utf8',
);
const SERVICE = readFileSync(
  join(process.cwd(), 'src', 'intelligence', 'push.service.ts'),
  'utf8',
);
const APP = readFileSync(join(process.cwd(), 'src', 'app.ts'), 'utf8');

/** Every source file the research module ships, by name, for the publish invariant. */
const RESEARCH_SOURCES: readonly [string, string][] = [
  ['intelligence.controller.ts', READ],
  ['intelligence.write.controller.ts', WRITE],
  ['push.draft.ts', PUSH],
  ['push.ports.ts', PORTS],
  ['push.orchestrator.ts', ORCHESTRATOR],
  ['push.service.ts', SERVICE],
];

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
        'GET /intelligence/candidates/:id/decision',
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

  it('calls no publish operation anywhere in the research module', () => {
    /*
     * The invariant is about the OPERATION, not the import.
     *
     * The earlier version of this test forbade importing publications.service at all.
     * That was the wrong line to draw: the emergency safety path has to be able to HIDE a
     * product it accidentally created visible, and unpublishProduct/getProductVisibility
     * live in that module. Banning the import would have forced either a duplicate
     * Shopify call of our own or leaving a visible product visible.
     *
     * So the rule is direction, not proximity. Research may call the operations that
     * REMOVE visibility or READ it. It may never call the one that GRANTS it.
     */
    const forbidden: readonly [string, RegExp][] = [
      // Anchored on a non-letter so unpublishProduct( does not match publishProduct(.
      ['publishProduct(', /(?<![A-Za-z])publishProduct\s*\(/],
      ['publishablePublish', /publishablePublish/],
      ['publishableId', /publishableId/],
    ];
    for (const [name, source] of RESEARCH_SOURCES) {
      for (const [label, pattern] of forbidden) {
        assert.ok(
          !pattern.test(source),
          `${name} contains "${label}". Research may never call a publish operation - publishing stays in the publications module, performed by an operator who has read the listing.`,
        );
      }
    }
  });

  it('the only publications calls in research are read-only or hide-only', () => {
    // Named explicitly so adding a third one is a deliberate act with a test to change.
    const allowed = new Set(['unpublishProduct', 'getProductVisibility']);
    for (const [name, source] of RESEARCH_SOURCES) {
      for (const match of source.matchAll(/\b(\w*[Pp]ublish\w*)\s*\(/g)) {
        const called = match[1];
        if (called === undefined) continue;
        assert.ok(
          allowed.has(called),
          `${name} calls "${called}()". Only ${[...allowed].join(' and ')} are permitted in research: one removes visibility, the other reads it. Nothing here may grant it.`,
        );
      }
    }
  });

  it('the port surface the orchestration is given has no publish capability', () => {
    /*
     * The orchestration cannot reach Shopify directly - it only has PushPorts. So the
     * strongest form of "it cannot publish" is that no such port exists to call. This
     * asserts the shape of the seam rather than the behaviour of one code path, which is
     * what makes it hold for code nobody has written yet.
     */
    const shopifyPort = /shopify:\s*\{([\s\S]*?)\n {2}\};/.exec(PORTS);
    if (shopifyPort === null) throw new Error('the shopify port block was not found');
    const members = [...shopifyPort[1]!.matchAll(/^\s{4}(\w+)\s*[(:]/gm)].map((m) => m[1]);
    assert.deepEqual(
      new Set(members),
      new Set([
        'findByResearchTag',
        'listCatalogue',
        'createProduct',
        'forceHidden',
      ]),
      'The shopify port surface changed. createProduct makes a DRAFT and forceHidden only removes visibility; a port that could publish must never be added here.',
    );
  });

  it('states the visibility it read back rather than asserting a constant', () => {
    /*
     * The response used to hard-code `published: false`, which is a claim rather than a
     * fact: if Shopify had returned a visible product the API would have said false
     * anyway. It now reports what was READ BACK from Shopify.
     */
    assert.match(WRITE, /published:\s*result\.productState\.published/);
    assert.match(WRITE, /visibleToCustomers:\s*result\.productState\.visibleToCustomers/);
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
