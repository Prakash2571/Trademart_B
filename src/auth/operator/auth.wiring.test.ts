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

  it('operator and oauth routers are reachable without an operator session', () => {
    // You cannot sign in if signing in requires being signed in; Shopify calls
    // the OAuth callback and cannot present a session.
    assert.ok(APP.includes("app.use('/api/operator', operatorRouter)"));
    assert.ok(APP.includes("app.use('/api/auth', oauthRouter)"));
  });
});
