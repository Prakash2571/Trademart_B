/**
 * What an ANONYMOUS caller learns from the health probes.
 *
 * /api/health and /api/health/ready are public because a load balancer cannot
 * sign in. They were also handing out, to anyone who asked: the exact Shopify
 * store domain (which merchant this is), the Admin API version and auth strategy
 * (which attack surface applies), NODE_ENV, and the Mongo driver error string -
 * which routinely names the host and the replica set, and sometimes carries URI
 * fragments.
 *
 * None of that is needed to answer "restart me" or "stop sending traffic".
 * Together it is a free reconnaissance report, retrievable without a credential
 * and leaving no audit trace.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildHealthPayload,
  buildReadinessPayload,
  computeReadiness,
  type HealthInputs,
  type ReadinessInputs,
} from './health.payload';

const inputs = (detailed: boolean, overrides: Partial<HealthInputs> = {}): HealthInputs => ({
  detailed,
  nodeEnv: 'production',
  uptimeSeconds: 4242,
  database: {
    configured: true,
    status: 'error',
    error: 'connect ECONNREFUSED mongo-primary.internal:27017 (replicaSet rs-trademart)',
  },
  shopify: {
    configured: true,
    authStrategy: 'CLIENT_CREDENTIALS',
    storeDomain: 'teststoremart-uk8mmby.myshopify.com',
    apiVersion: '2026-07',
  },
  ...overrides,
});

const readinessInputs = (detailed: boolean): ReadinessInputs => ({
  ...inputs(detailed),
  version: '1.4.0',
  gitSha: 'abc123def456',
  shopifyBreaker: 'open',
});

/** Every string anywhere in a payload, so nothing hides in a nested object. */
function strings(value: unknown, found: string[] = []): string[] {
  if (typeof value === 'string') found.push(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, found);
  else if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) strings(item, found);
  }
  return found;
}

function assertNothingIdentifying(payload: unknown): void {
  const haystack = strings(payload).join(' | ');
  for (const secret of [
    'teststoremart-uk8mmby',
    '2026-07',
    'CLIENT_CREDENTIALS',
    'ECONNREFUSED',
    'mongo-primary.internal',
    'rs-trademart',
  ]) {
    assert.ok(
      !haystack.includes(secret),
      `an anonymous health probe disclosed "${secret}": ${haystack}`,
    );
  }
}

describe('GET /api/health, anonymously', () => {
  it('answers the question a probe asks', () => {
    const body = buildHealthPayload(inputs(false));

    assert.equal(body['status'], 'ok');
    assert.equal(body['service'], 'trademart-backend');
    assert.equal(body['uptimeSeconds'], 4242);
  });

  it('still reports whether storage is up, because that is the point', () => {
    // The value a probe reads must keep working. Only the IDENTIFYING detail goes.
    const checks = buildHealthPayload(inputs(false))['checks'] as Record<string, never>;
    const database = checks['database'] as unknown as Record<string, unknown>;

    assert.equal(database['configured'], true);
    assert.equal(database['status'], 'error');
  });

  it('withholds the store domain, API version, auth strategy, env and DB error', () => {
    assertNothingIdentifying(buildHealthPayload(inputs(false)));
  });

  it('keeps every key, so an existing probe does not break', () => {
    // Anonymous callers get the same DOCUMENT with values removed, not a different
    // one - a probe reading checks.shopify.configured must not start reading
    // undefined.
    const anonymous = buildHealthPayload(inputs(false));
    const operator = buildHealthPayload(inputs(true));

    const keyPaths = (value: unknown, prefix = ''): string[] => {
      if (value === null || typeof value !== 'object') return [prefix];
      return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
        keyPaths(child, prefix === '' ? key : `${prefix}.${key}`),
      );
    };

    for (const path of keyPaths(operator)) {
      assert.ok(
        keyPaths(anonymous).includes(path),
        `anonymous payload is missing the key ${path}`,
      );
    }
  });

  it('says how to see the rest', () => {
    // A withheld field with no explanation reads as a broken deployment.
    assert.match(String(buildHealthPayload(inputs(false))['note']), /operator/i);
    assert.equal(buildHealthPayload(inputs(true))['note'], undefined);
  });
});

describe('GET /api/health, as an operator', () => {
  it('reports the full detail on the same URL', () => {
    const body = buildHealthPayload(inputs(true));
    const checks = body['checks'] as Record<string, Record<string, unknown>>;

    assert.equal(body['environment'], 'production');
    assert.equal(checks['shopify']?.['storeDomain'], 'teststoremart-uk8mmby.myshopify.com');
    assert.equal(checks['shopify']?.['apiVersion'], '2026-07');
    assert.equal(checks['shopify']?.['authStrategy'], 'CLIENT_CREDENTIALS');
    assert.match(String(checks['database']?.['error']), /ECONNREFUSED/);
  });
});

describe('readiness', () => {
  it('is not ready when a configured database is down', () => {
    assert.deepEqual(
      computeReadiness({
        databaseConfigured: true,
        databaseStatus: 'error',
        shopifyConfigured: true,
      }),
      { ready: false, databaseReady: false },
    );
  });

  it('IS ready with no database configured at all', () => {
    // Running without Mongo is a supported configuration - Shopify reads and
    // pricing still work - so reporting it as broken would be a false alarm.
    assert.deepEqual(
      computeReadiness({
        databaseConfigured: false,
        databaseStatus: 'disabled',
        shopifyConfigured: true,
      }),
      { ready: true, databaseReady: true },
    );
  });

  it('is not ready when Shopify is not configured', () => {
    assert.equal(
      computeReadiness({
        databaseConfigured: false,
        databaseStatus: 'disabled',
        shopifyConfigured: false,
      }).ready,
      false,
    );
  });

  it('answers 503 with ready:false, which is what a load balancer reads', () => {
    const { status, body } = buildReadinessPayload(readinessInputs(false));

    assert.equal(status, 503);
    assert.equal(body['ready'], false);
    assert.equal(body['status'], 'unavailable');
  });

  it('discloses nothing identifying to an anonymous caller', () => {
    assertNothingIdentifying(buildReadinessPayload(readinessInputs(false)).body);
  });

  it('keeps build identity public, which is public by design elsewhere', () => {
    // /api/version already serves this unauthenticated so a deploy check can run
    // before anyone signs in; withholding it here would only be inconsistent.
    const { body } = buildReadinessPayload(readinessInputs(false));

    assert.equal(body['version'], '1.4.0');
    assert.equal(body['gitSha'], 'abc123def456');
  });

  it('shows the breaker state to an operator only', () => {
    const anonymous = buildReadinessPayload(readinessInputs(false)).body;
    const operator = buildReadinessPayload(readinessInputs(true)).body;
    const read = (body: Record<string, unknown>): Record<string, unknown> =>
      (body['checks'] as Record<string, Record<string, unknown>>)[
        'shopifyConnectivity'
      ] as Record<string, unknown>;

    assert.equal(read(anonymous)['circuitBreaker'], null);
    assert.equal(read(operator)['circuitBreaker'], 'open');
    assert.equal(read(operator)['degraded'], true);
    // Provenance stays visible to everyone: it stops anyone reading this as a live
    // Shopify probe.
    assert.equal(read(anonymous)['source'], 'cached-from-real-traffic');
  });
});
