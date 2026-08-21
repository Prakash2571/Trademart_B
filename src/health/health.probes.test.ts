/**
 * Probe-wiring guard.
 *
 * Liveness and readiness answer two different questions, and the orchestrator
 * does different things with the answers: liveness failing means RESTART ME,
 * readiness failing means STOP SENDING TRAFFIC.
 *
 * Pointing a Docker HEALTHCHECK at readiness is therefore a real outage
 * generator: a temporary Mongo blip would report the container unhealthy, Docker
 * (or the autoheal profile in deploy/docker-compose.yml) would restart it, and a
 * restart cannot fix a dependency living in another container. The result is a
 * crash loop caused by a database hiccup.
 *
 * The mistake is easy to make and invisible until the day the database blips, so
 * it is asserted here rather than left to review.
 *
 * Paths resolve from process.cwd(), which is the repo root under `npm test` -
 * same convention as config/deployment.env.test.ts.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

function repoFile(...segments: string[]): string {
  return readFileSync(join(process.cwd(), ...segments), 'utf8');
}

const DOCKERFILE = repoFile('Dockerfile');
const HEALTH_CONTROLLER = repoFile('src', 'health', 'health.controller.ts');

/** The HEALTHCHECK instruction, including its continuation lines. */
function healthcheckInstruction(): string {
  const lines = DOCKERFILE.split('\n');
  const start = lines.findIndex((line) => line.trimStart().startsWith('HEALTHCHECK'));
  if (start === -1) return '';

  const collected: string[] = [];
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    collected.push(line);
    if (!line.trimEnd().endsWith('\\')) break;
  }
  return collected.join('\n');
}

describe('the container healthcheck is a LIVENESS probe', () => {
  const instruction = healthcheckInstruction();

  it('exists', () => {
    assert.notEqual(instruction, '', 'the Dockerfile has no HEALTHCHECK instruction');
  });

  it('probes /api/health/live', () => {
    assert.match(
      instruction,
      /\/api\/health\/live/,
      'the healthcheck must probe /api/health/live, which checks only this process',
    );
  });

  it('does NOT probe readiness', () => {
    // A readiness failure means "stop sending traffic", not "restart me". Wiring
    // it here turns a dependency outage into a container crash loop.
    assert.doesNotMatch(
      instruction,
      /\/api\/health\/ready/,
      'readiness must not drive the container healthcheck - use it from a load balancer or deploy gate instead',
    );
  });
});

describe('the probes keep their contracts', () => {
  it('all three routes are registered', () => {
    for (const route of ["'/health'", "'/health/live'", "'/health/ready'"]) {
      assert.ok(
        HEALTH_CONTROLLER.includes(route),
        `health.controller.ts no longer registers ${route}`,
      );
    }
  });

  it('liveness depends on no dependency status', () => {
    // Extract the /health/live handler body and assert it touches neither the
    // database nor Shopify. If it ever did, it would stop being a liveness probe
    // and start being able to restart the container over someone else's outage.
    const start = HEALTH_CONTROLLER.indexOf("'/health/live'");
    assert.notEqual(start, -1, 'the /health/live route is missing');
    const end = HEALTH_CONTROLLER.indexOf("healthRouter.get(", start + 1);
    const body = HEALTH_CONTROLLER.slice(start, end === -1 ? undefined : end);

    for (const forbidden of ['getDatabaseStatus', 'isDatabaseConfigured', 'getBreakerState']) {
      assert.ok(
        !body.includes(forbidden),
        `/health/live must not consult ${forbidden}: a dependency being down is not a reason to restart this process`,
      );
    }
  });

  it('/health still reports status ok at the top level, unwrapped', () => {
    // The documented contract other probes already read.
    assert.match(HEALTH_CONTROLLER, /status: 'ok',\n\s+service: 'trademart-backend'/);
  });

  it('neither probe calls Shopify', () => {
    // A probe running every 30 seconds must not spend Shopify rate-limit budget.
    // Readiness reports the cached breaker state observed from real traffic.
    assert.ok(
      !HEALTH_CONTROLLER.includes('shopifyGraphql'),
      'health probes must never call Shopify - they would burn rate-limit budget on every interval',
    );
  });
});
