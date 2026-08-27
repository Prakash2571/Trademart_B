/**
 * Auth-wiring guard.
 *
 * Every router that can change the Shopify store or app state must be mounted
 * behind requireOperatorForWrites (which enforces an operator on every
 * POST/PUT/PATCH/DELETE). A router accidentally mounted under
 * requireOperatorForReads would be world-writable whenever
 * OPERATOR_PROTECT_READS is false - exactly the hole operator auth closes.
 *
 * This reads the real src/app.ts so a future mis-mount fails the build rather
 * than shipping an open mutation endpoint.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const APP = readFileSync(join(process.cwd(), 'src', 'app.ts'), 'utf8');

/** The line mounting a given router, or undefined. */
function mountLine(router: string): string | undefined {
  return APP.split('\n').find(
    (line) => line.includes(router) && line.includes('app.use('),
  );
}

describe('write routers are guarded', () => {
  // Routers that expose POST/PUT/PATCH/DELETE against the store or app state.
  // webhookAdminRouter is deliberately NOT here: it is held to the stricter
  // requireOperator, asserted in its own block below.
  const writeRouters = [
    'automationRouter',
    'productsWriteRouter',
    'publicationsWriteRouter',
    'inventoryWriteRouter',
    'manualCostRouter',
    // Changes which orders are flagged and what price Research recommends. Not a Shopify
    // write, but still store configuration nobody anonymous should be able to change.
    'dropshippingWriteRouter',
    // Creates Shopify DRAFT products, and changes research state.
    'intelligenceWriteRouter',
  ];

  for (const router of writeRouters) {
    it(`${router} is mounted behind requireOperatorForWrites`, () => {
      const line = mountLine(router);
      assert.ok(line !== undefined, `${router} is not mounted in app.ts`);
      assert.ok(
        line.includes('requireOperatorForWrites'),
        `${router} must be mounted with requireOperatorForWrites, got: ${line?.trim()}`,
      );
    });
  }
});

describe('read routers stay on the read guard', () => {
  // The mirror of the above. A READ router accidentally mounted with
  // requireOperatorForWrites would leave its GETs open even when
  // OPERATOR_PROTECT_READS is true, because that guard only checks mutating methods.
  const readRouters = ['dropshippingRouter', 'intelligenceRouter'];

  for (const router of readRouters) {
    it(`${router} is mounted behind requireOperatorForReads`, () => {
      // Matched with the leading comma so `dropshippingRouter` cannot match the
      // `dropshippingWriteRouter` line, and `intelligenceRouter` cannot match
      // `intelligenceWriteRouter`.
      const line = mountLine(`, ${router})`);
      assert.ok(line !== undefined, `${router} is not mounted in app.ts`);
      assert.ok(
        line.includes('requireOperatorForReads'),
        `${router} must be mounted with requireOperatorForReads, got: ${line?.trim()}`,
      );
    });
  }
});

describe('the audit trail is privileged, not merely a read', () => {
  it('auditRouter requires an operator even when reads are otherwise open', () => {
    // The audit trail records WHO changed WHAT. Behind requireOperatorForWrites it
    // would be world-readable whenever OPERATOR_PROTECT_READS is false, which
    // leaks operator identities and the store's change history to anyone. It must
    // use the unconditional requireOperator.
    const line = mountLine('auditRouter') ?? '';
    assert.notEqual(line, '', 'auditRouter is not mounted in app.ts');
    assert.ok(
      /requireOperator\b(?!For)/.test(line),
      `auditRouter must be mounted with requireOperator (not the writes-only or reads-only guard), got: ${line.trim()}`,
    );
  });
});

describe('webhook ADMINISTRATION requires an operator for reads as well as writes', () => {
  // The distinction that matters in this module: the RECEIVER is a delivery
  // endpoint that Shopify calls and must stay public (HMAC secures it), while
  // webhook ADMINISTRATION is an operator tool. Its reads are not harmless:
  //   GET /webhooks/status        - is a signing secret configured, where does the
  //                                callback point, is persistence up
  //   GET /webhooks/subscriptions - the live integration wiring in Shopify
  //   GET /webhooks/events        - delivery history, topics, failures
  // Behind requireOperatorForWrites all of that is world-readable whenever
  // OPERATOR_PROTECT_READS is false.
  const CONTROLLER = readFileSync(
    join(process.cwd(), 'src', 'webhooks', 'webhooks.controller.ts'),
    'utf8',
  );

  it('webhookAdminRouter is mounted behind the unconditional requireOperator', () => {
    const line = mountLine('webhookAdminRouter') ?? '';
    assert.notEqual(line, '', 'webhookAdminRouter is not mounted in app.ts');
    assert.ok(
      /requireOperator\b(?!For)/.test(line),
      `webhook administration must use requireOperator, not the writes-only or reads-only guard, got: ${line.trim()}`,
    );
  });

  it('the public receiver router carries ONLY the receiver route', () => {
    // Any other route defined on webhooksRouter is public by construction,
    // because that router is mounted with no guard. This is how GET
    // /webhooks/status came to be anonymously readable.
    const routes = [...CONTROLLER.matchAll(/webhooksRouter\.(get|post|put|patch|delete)\(\s*\n?\s*'([^']+)'/g)]
      .map((match) => `${(match[1] as string).toUpperCase()} ${match[2] as string}`);

    assert.deepEqual(
      routes,
      ['POST /webhooks/shopify'],
      `webhooksRouter is mounted unguarded, so every route on it is public. Move anything that is not the raw-body receiver to webhookAdminRouter. Found: ${routes.join(', ')}`,
    );
  });

  it('every management route lives on the admin router', () => {
    for (const route of [
      '/webhooks/status',
      '/webhooks/subscriptions',
      '/webhooks/events',
      '/webhooks/register',
      '/webhooks/unregister',
    ]) {
      assert.ok(
        CONTROLLER.includes(`webhookAdminRouter.get(\n  '${route}'`) ||
          CONTROLLER.includes(`webhookAdminRouter.post(\n  '${route}'`),
        `${route} must be declared on webhookAdminRouter`,
      );
    }
  });
});

describe('public routers are intentionally public', () => {
  it('publicDiagnosticsRouter is mounted with no guard, and is version-only', () => {
    // It is public because a deploy check must read it before anyone signs in.
    // That is only acceptable while it exposes build identity and nothing else,
    // so this asserts the mount stays unguarded AND that the store-data
    // diagnostics live on the separate guarded router.
    const line = mountLine('publicDiagnosticsRouter') ?? '';
    assert.notEqual(line, '', 'publicDiagnosticsRouter is not mounted in app.ts');
    assert.ok(
      !line.includes('requireOperator'),
      'publicDiagnosticsRouter is deliberately public; guarding it would break pre-login deploy checks',
    );

    // ', diagnosticsRouter' and not 'diagnosticsRouter', because the latter is a
    // substring of publicDiagnosticsRouter and would match the public mount.
    const guarded = mountLine(', diagnosticsRouter') ?? '';
    assert.ok(
      guarded.includes('requireOperatorForReads'),
      'diagnosticsRouter (integrity findings name products) must be behind requireOperatorForReads',
    );
  });

  it('the webhook RECEIVER is mounted before the JSON body parser', () => {
    // Raw body is required for HMAC verification; a global JSON parser ahead of
    // it would consume the body and break every signature check.
    const receiver = APP.indexOf("app.use('/api', webhooksRouter)");
    const jsonParser = APP.indexOf('express.json(');
    assert.ok(receiver !== -1, 'webhook receiver mount not found');
    assert.ok(jsonParser !== -1, 'express.json mount not found');
    assert.ok(receiver < jsonParser, 'webhook receiver must precede express.json()');
  });

  it('the webhook receiver is NOT behind an operator guard (Shopify cannot log in)', () => {
    const line = mountLine('webhooksRouter');
    assert.ok(line !== undefined);
    assert.ok(!line.includes('requireOperator'), 'the receiver is secured by HMAC, not operator auth');
  });

  it('the Razorpay receiver is unguarded and ahead of the JSON parser', () => {
    // Same reasoning as Shopify's: Razorpay cannot present an operator credential,
    // and its signature is computed over the raw bytes. Guarding it would silently
    // stop every payment webhook; parsing before it would break every signature.
    const line = mountLine('storefront.razorpayWebhookRouter') ?? '';
    assert.notEqual(line, '', 'the Razorpay webhook receiver is not mounted in app.ts');
    assert.ok(
      !line.includes('requireOperator'),
      'the Razorpay receiver is secured by HMAC, not operator auth',
    );

    const receiver = APP.indexOf('storefront.razorpayWebhookRouter');
    const jsonParser = APP.indexOf('express.json(');
    assert.ok(receiver < jsonParser, 'the Razorpay receiver must precede express.json()');
  });

  it('storefront guest commerce is not behind an operator guard', () => {
    // Customers have no operator session. These routers carry their own tighter
    // rate limiters instead, which is what app.ts asserts by mounting them with a
    // limiter and no auth middleware.
    for (const router of [
      'storefront.catalogRouter',
      'storefront.checkoutRouter',
      'storefront.ordersRouter',
    ]) {
      const line = mountLine(router) ?? '';
      assert.notEqual(line, '', `${router} is not mounted in app.ts`);
      assert.ok(
        !line.includes('requireOperator'),
        `${router} serves guest customers and must not require an operator, got: ${line.trim()}`,
      );
      assert.ok(
        line.includes('RateLimiter'),
        `${router} is public, so it must be mounted with its own rate limiter, got: ${line.trim()}`,
      );
    }
  });

  it('operator and oauth routers are reachable without an operator session', () => {
    // You cannot sign in if signing in requires being signed in; Shopify calls
    // the OAuth callback and cannot present a session.
    assert.ok(APP.includes("app.use('/api/operator', operatorRouter)"));
    assert.ok(APP.includes("app.use('/api/auth', oauthRouter)"));
  });
});
