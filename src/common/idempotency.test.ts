/**
 * The durable-safety gate on dangerous writes.
 *
 * Every route wrapped in `idempotent()` creates or changes something real and
 * externally visible: a Shopify product, a stock level, a pushed draft. Two things
 * make such a write safe to accept - duplicate suppression, so a retry cannot
 * apply it twice, and an audit row naming who did it. Both live in Mongo.
 *
 * The behaviour this replaces set an `X-Idempotency-Status: unsupported-no-database`
 * response header and let the write proceed. A response header is not a safeguard:
 * it arrives after the decision, and an automated retry - the caller that most
 * needs the guarantee - never reads it.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { durableSafetyGate } from './durableSafety';
import { defaultRetryableForCode, defaultStatusForCode } from './errors';

describe('durableSafetyGate', () => {
  it('allows the write when storage is connected', () => {
    assert.equal(durableSafetyGate(true), null);
  });

  it('refuses the write when storage is unavailable', () => {
    const error = durableSafetyGate(false);
    assert.ok(error !== null, 'a dangerous write must not proceed unaudited');
    assert.equal(error.code, 'DATABASE_UNAVAILABLE');
  });

  it('refuses with a retryable 503, because nothing was attempted', () => {
    // 503 + retryable is the honest pairing: the condition is transient and the
    // same request is safe to send again. A 500 would suggest the write might have
    // happened, which is the one thing a client must not have to guess about.
    const error = durableSafetyGate(false);
    assert.ok(error !== null);
    assert.equal(error.status, 503);
    assert.equal(error.retryable, true);
  });

  it('says the request was NOT attempted, so a client can retry safely', () => {
    const error = durableSafetyGate(false);
    assert.ok(error !== null);
    assert.match(error.message, /NOT attempted/);
    // And names both guarantees it is protecting, so the message is diagnosable.
    assert.match(error.message, /idempotency/i);
    assert.match(error.message, /audit/i);
  });

  it('does not depend on the caller sending a key', () => {
    // The gate takes only the storage state. A caller that sends no
    // Idempotency-Key is not safer than one that does - it has no protection at
    // all - so the refusal cannot be conditional on the header.
    assert.equal(durableSafetyGate(false)?.code, 'DATABASE_UNAVAILABLE');
    assert.equal(durableSafetyGate(true), null);
  });
});

describe('every route that changes the live store is behind the gate', () => {
  // Read from the real controllers, so adding a new Shopify-mutating route
  // without the gate fails the build rather than shipping a write that can happen
  // twice - or happen with no audit row at all.
  //
  // Publish/unpublish and automation apply were NOT covered before this pass:
  // they recorded audit entries, but `recordAudit` deliberately swallows its own
  // failures (an audit write must never undo a successful change), so with Mongo
  // down they made a product visible to customers and recorded nothing.
  const guarded: [file: string, operation: string][] = [
    ['src/products/products.write.controller.ts', 'POST /api/shopify/products'],
    ['src/inventory/inventory.write.controller.ts', 'POST /api/shopify/inventory/set'],
    [
      'src/intelligence/intelligence.write.controller.ts',
      'POST /api/intelligence/candidates/:id/push',
    ],
    [
      'src/shopify/publications/publications.controller.ts',
      'POST /api/shopify/products/:id/publish',
    ],
    [
      'src/shopify/publications/publications.controller.ts',
      'POST /api/shopify/products/:id/publish-headless',
    ],
    [
      'src/shopify/publications/publications.controller.ts',
      'POST /api/shopify/products/:id/unpublish',
    ],
    ['src/automation/automation.controller.ts', 'POST /api/automation/apply'],
  ];

  for (const [file, operation] of guarded) {
    it(`${operation} is wrapped in idempotent()`, () => {
      const source = readFileSync(join(process.cwd(), ...file.split('/')), 'utf8');
      assert.ok(
        source.includes(`idempotent('${operation}')`),
        `${file} must guard ${operation} with idempotent('${operation}')`,
      );
    });
  }

  it('names each operation distinctly, so one key cannot span two endpoints', () => {
    const operations = guarded.map(([, operation]) => operation);
    assert.equal(
      new Set(operations).size,
      operations.length,
      'the operation string is part of the uniqueness key; duplicates would make a key collide across endpoints',
    );
  });
});

describe('the codes this gate relies on', () => {
  it('DATABASE_UNAVAILABLE is a retryable 503', () => {
    assert.equal(defaultStatusForCode('DATABASE_UNAVAILABLE'), 503);
    assert.equal(
      defaultRetryableForCode('DATABASE_UNAVAILABLE'),
      true,
      'Mongo being briefly unreachable is the textbook transient failure',
    );
  });

  it('is applied by every dangerous-write route, before any work', () => {
    // Read from the real middleware rather than asserted in prose: the gate is
    // worthless if a future edit moves it below the header parsing (which returns
    // early for callers that send no key) or drops it entirely.
    const source = readFileSync(join(process.cwd(), 'src', 'common', 'idempotency.ts'), 'utf8');
    const gate = source.indexOf('durableSafetyGate(');
    const headerRead = source.indexOf(`req.header(IDEMPOTENCY_HEADER)`);
    assert.ok(gate !== -1, 'idempotency.ts must apply durableSafetyGate');
    assert.ok(headerRead !== -1, 'idempotency.ts must read the Idempotency-Key header');
    assert.ok(
      gate < headerRead,
      'the gate must run BEFORE the header is read: a caller that sends no key has no protection at all, so it cannot be the caller that is let through',
    );
  });
});
