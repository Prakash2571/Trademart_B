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
  const writeRouters = [
    'webhookAdminRouter',
    'automationRouter',
    'productsWriteRouter',
    'publicationsWriteRouter',
    'inventoryWriteRouter',
    'manualCostRouter',
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

describe('public routers are intentionally public', () => {
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

  it('operator and oauth routers are reachable without an operator session', () => {
    // You cannot sign in if signing in requires being signed in; Shopify calls
    // the OAuth callback and cannot present a session.
    assert.ok(APP.includes("app.use('/api/operator', operatorRouter)"));
    assert.ok(APP.includes("app.use('/api/auth', oauthRouter)"));
  });
});
