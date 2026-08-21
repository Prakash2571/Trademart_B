/**
 * Deployment drift guard.
 *
 * A variable the code reads but Compose never passes is a deployment bug that
 * is invisible in development: the process boots, the variable is simply
 * absent, and the feature depending on it is quietly dead. That is exactly how
 * APP_URL ended up empty in a live deployment, silently disabling both the
 * OAuth redirect flow and webhook registration with nothing in the logs to say
 * a variable was missing.
 *
 * These tests read the real deploy/ files and compare them against the real
 * source, so adding a variable to env.validation.ts without wiring it through
 * Compose fails the build instead of failing in production.
 *
 * Paths resolve from process.cwd(), which is the repo root under `npm test`.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

function repoFile(...segments: string[]): string {
  return readFileSync(join(process.cwd(), ...segments), 'utf8');
}

/**
 * Every variable the backend reads, extracted from the one place that reads
 * them. env.validation.ts takes a plain record and uses read(env, 'KEY')
 * exclusively, so this is authoritative rather than a hand-kept list.
 */
function variablesReadBySource(): string[] {
  const source = repoFile('src', 'config', 'env.validation.ts');
  const matches = source.matchAll(/read\(env,\s*'([A-Z_0-9]+)'\)/g);
  return [...new Set([...matches].map((match) => match[1] as string))].sort();
}

/** Keys in the `environment:` mapping of a Compose service. */
function composeServiceEnv(service: string): Map<string, string> {
  const lines = repoFile('deploy', 'docker-compose.yml').split('\n');

  const serviceIndex = lines.findIndex((line) => line === `  ${service}:`);
  assert.notEqual(serviceIndex, -1, `service ${service} not found in docker-compose.yml`);

  let index = serviceIndex + 1;
  // Find this service's environment: block, stopping at the next service.
  while (index < lines.length && lines[index] !== '    environment:') {
    if (/^ {2}\S/.test(lines[index] as string)) {
      throw new Error(`service ${service} has no environment: block`);
    }
    index += 1;
  }

  const env = new Map<string, string>();
  for (index += 1; index < lines.length; index += 1) {
    const line = lines[index] as string;
    if (line.trim().length === 0 || line.trimStart().startsWith('#')) continue;
    // Dedent to service level or below ends the block.
    if (/^ {0,4}\S/.test(line)) break;
    const match = /^ {6}([A-Za-z_][A-Za-z_0-9]*):\s*(.*)$/.exec(line);
    if (match) env.set(match[1] as string, (match[2] as string).trim());
  }
  return env;
}

/** Variable names documented in an .env file, including commented examples. */
function documentedVariables(...segments: string[]): Set<string> {
  const content = repoFile(...segments);
  const names = new Set<string>();
  for (const line of content.split('\n')) {
    const match = /^\s*#?\s*([A-Z_][A-Z_0-9]*)=/.exec(line);
    if (match) names.add(match[1] as string);
  }
  return names;
}

describe('Compose passes every variable the backend reads', () => {
  const required = variablesReadBySource();
  const backendEnv = composeServiceEnv('backend');

  it('finds the expected variables in the source', () => {
    // Sanity check on the extraction itself: if the regex silently stopped
    // matching, every assertion below would vacuously pass.
    assert.ok(required.length >= 20, `only found ${required.length} variables`);
    assert.ok(required.includes('SHOPIFY_CLIENT_SECRET'));
    assert.ok(required.includes('OPERATOR_PROTECT_READS'));
  });

  it('passes all of them to the backend service', () => {
    const missing = required.filter((name) => !backendEnv.has(name));

    assert.deepEqual(
      missing,
      [],
      `docker-compose.yml does not pass: ${missing.join(', ')}. A variable the code reads but Compose omits is dead configuration.`,
    );
  });

  it('does not pass variables the backend never reads', () => {
    // Catches a renamed variable leaving a stale entry behind, which reads as
    // working configuration but does nothing.
    const known = new Set(required);
    const extra = [...backendEnv.keys()].filter((name) => !known.has(name));

    assert.deepEqual(
      extra,
      [],
      `docker-compose.yml passes variables no code reads: ${extra.join(', ')}`,
    );
  });
});

describe('Compose derives origins from DOMAIN', () => {
  const backendEnv = composeServiceEnv('backend');

  it('derives APP_URL from DOMAIN rather than defaulting to empty', () => {
    // Regression guard. `${APP_URL:-}` let a missing value through as "",
    // which disables OAuth and webhook registration silently. nginx always
    // serves /api on https://${DOMAIN}, so blank is never the right default.
    const appUrl = backendEnv.get('APP_URL');

    assert.ok(appUrl !== undefined, 'APP_URL must be passed');
    assert.ok(
      appUrl.includes('${DOMAIN}'),
      `APP_URL should fall back to https://\${DOMAIN}, got: ${appUrl}`,
    );
    assert.notEqual(appUrl, '${APP_URL:-}');
  });

  it('derives FRONTEND_URL from DOMAIN', () => {
    const frontendUrl = backendEnv.get('FRONTEND_URL');

    assert.ok(frontendUrl !== undefined, 'FRONTEND_URL must be passed');
    assert.ok(frontendUrl.includes('${DOMAIN}'));
  });

  it('pins NODE_ENV and PORT to literals', () => {
    // These are stack facts, not operator choices: the container always runs
    // production on 4000, and nginx proxies to that port by name.
    assert.equal(backendEnv.get('NODE_ENV'), 'production');
    assert.equal(backendEnv.get('PORT'), '"4000"');
  });
});

describe('deploy/.env.example documents the operator-settable variables', () => {
  const required = variablesReadBySource();
  const documented = documentedVariables('deploy', '.env.example');

  /**
   * Fixed by docker-compose.yml, so an operator setting them in .env would have
   * no effect. Deliberately NOT documented as knobs.
   */
  const pinnedByCompose = new Set(['NODE_ENV', 'PORT']);

  it('documents every variable an operator can actually set', () => {
    const undocumented = required.filter(
      (name) => !pinnedByCompose.has(name) && !documented.has(name),
    );

    assert.deepEqual(
      undocumented,
      [],
      `deploy/.env.example does not mention: ${undocumented.join(', ')}. An undocumented variable is one nobody will set.`,
    );
  });

  it('documents the deployment-only variables the stack needs', () => {
    // Not read by the backend, but required by Compose/nginx/certbot.
    for (const name of ['DOMAIN', 'LETSENCRYPT_EMAIL', 'TLS_MODE']) {
      assert.ok(documented.has(name), `deploy/.env.example must document ${name}`);
    }
  });

  it('documents NEXT_PUBLIC_API_BASE_URL for the frontend build', () => {
    assert.ok(documented.has('NEXT_PUBLIC_API_BASE_URL'));
  });
});

describe('the backend .env.example stays in step with the code', () => {
  const required = variablesReadBySource();
  const documented = documentedVariables('.env.example');

  it('documents every variable the backend reads', () => {
    const undocumented = required.filter((name) => !documented.has(name));

    assert.deepEqual(
      undocumented,
      [],
      `.env.example does not mention: ${undocumented.join(', ')}`,
    );
  });
});

describe('secrets never reach the frontend', () => {
  const frontendEnv = composeServiceEnv('frontend');

  it('passes no secret to the frontend service', () => {
    // The frontend is a public browser bundle plus a thin Node server. Anything
    // here is one `docker inspect` from being read, and any NEXT_PUBLIC_* value
    // is compiled into JavaScript the visitor downloads.
    const secrets = [
      'SHOPIFY_CLIENT_SECRET',
      'SHOPIFY_ACCESS_TOKEN',
      'SHOPIFY_WEBHOOK_SECRET',
      'TOKEN_ENCRYPTION_KEY',
      'SESSION_SECRET',
      'OPERATOR_API_KEY',
      'OPERATOR_PASSWORD_HASH',
      'MONGODB_URI',
    ];

    for (const secret of secrets) {
      assert.ok(
        !frontendEnv.has(secret),
        `${secret} must never be passed to the frontend service`,
      );
    }
  });

  it('exposes only NEXT_PUBLIC_API_BASE_URL as a frontend build arg', () => {
    const compose = readFileSync(
      join(process.cwd(), 'deploy', 'docker-compose.yml'),
      'utf8',
    );
    const lines = compose.split('\n');
    const frontendIndex = lines.findIndex((line) => line === '  frontend:');
    const argsIndex = lines.findIndex(
      (line, index) => index > frontendIndex && line === '      args:',
    );

    assert.notEqual(argsIndex, -1, 'frontend build args block not found');

    const args: string[] = [];
    for (let index = argsIndex + 1; index < lines.length; index += 1) {
      const line = lines[index] as string;
      if (line.trim().length === 0 || line.trimStart().startsWith('#')) continue;
      if (/^ {0,6}\S/.test(line)) break;
      const match = /^ {8}([A-Za-z_][A-Za-z_0-9]*):/.exec(line);
      if (match) args.push(match[1] as string);
    }

    assert.deepEqual(args, ['NEXT_PUBLIC_API_BASE_URL']);
  });
});

describe('only nginx publishes host ports', () => {
  const compose = repoFile('deploy', 'docker-compose.yml');

  it('gives backend and frontend expose, never ports', () => {
    // `expose` is internal-network only; `ports` publishes to the host and
    // would bypass nginx, TLS and the rate limiter entirely.
    for (const service of ['backend', 'frontend'] as const) {
      const lines = compose.split('\n');
      const start = lines.findIndex((line) => line === `  ${service}:`);
      let end = lines.length;
      for (let index = start + 1; index < lines.length; index += 1) {
        if (/^ {2}\S/.test(lines[index] as string)) {
          end = index;
          break;
        }
      }
      const block = lines.slice(start, end).join('\n');

      assert.ok(block.includes('expose:'), `${service} should use expose:`);
      assert.ok(
        !/^\s{4}ports:/m.test(block),
        `${service} must not publish host ports - only nginx may`,
      );
    }
  });

  it('does not publish the local-db Mongo overlay to the host', () => {
    const overlay = repoFile('deploy', 'docker-compose.local-db.yml');

    assert.ok(
      !/^\s{4}ports:/m.test(overlay),
      'the bundled Mongo must stay on the internal network',
    );
  });
});
