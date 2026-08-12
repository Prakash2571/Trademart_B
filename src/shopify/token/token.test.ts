/**
 * Client credentials token tests.
 *
 * The transport and the clock are both injected, so caching, refresh timing and
 * single-flight behaviour are verified deterministically with no network and no
 * real waiting.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AppError } from '../../common/errors';
import { mapTokenFailure } from '../shopify.errors';
import { ClientCredentialsTokenProvider } from './clientCredentials.provider';
import { StaticTokenProvider } from './static.provider';
import {
  computeExpiresAt,
  effectiveSafetyWindowMs,
  isTokenUsable,
  parseScopes,
  secondsUntilExpiry,
  type CachedToken,
} from './token.cache';
import type { RawTokenResponse, TokenFetcher } from './token.types';

const SHOP = 'teststoremart-uk8mmby.myshopify.com';
const HOUR_MS = 60 * 60 * 1000;

/** A controllable clock. */
function clock(start = 1_000_000_000_000) {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

/** Records every call so we can assert how often Shopify was contacted. */
function fakeFetcher(
  responses: { status: number; body: RawTokenResponse }[],
): { fetcher: TokenFetcher; calls: number } {
  const state = { calls: 0 };
  const fetcher: TokenFetcher = async () => {
    const response = responses[Math.min(state.calls, responses.length - 1)];
    state.calls += 1;
    if (response === undefined) throw new Error('no response configured');
    return response;
  };
  return {
    fetcher,
    get calls() {
      return state.calls;
    },
  } as { fetcher: TokenFetcher; calls: number };
}

function okResponse(token: string, expiresIn = 86399, scope = 'read_products,read_orders') {
  return { status: 200, body: { access_token: token, expires_in: expiresIn, scope } };
}

/* --------------------------------------------------------------- cache math -- */

describe('token.cache', () => {
  const base: CachedToken = {
    accessToken: 'shpat_x',
    issuedAt: 0,
    expiresAt: 24 * HOUR_MS,
    scopes: [],
  };

  it('treats a fresh token as usable', () => {
    assert.equal(isTokenUsable(base, 1000), true);
  });

  it('treats a token inside the safety window as stale', () => {
    // Expires at 24h; default window is 5 minutes.
    assert.equal(isTokenUsable(base, 24 * HOUR_MS - 60_000), false);
    assert.equal(isTokenUsable(base, 24 * HOUR_MS - 10 * 60_000), true);
  });

  it('treats an expired token as unusable', () => {
    assert.equal(isTokenUsable(base, 24 * HOUR_MS + 1), false);
  });

  it('treats a null token and an empty token as unusable', () => {
    assert.equal(isTokenUsable(null, 0), false);
    assert.equal(isTokenUsable({ ...base, accessToken: '' }, 0), false);
  });

  it('treats a non-expiring token as always usable', () => {
    assert.equal(isTokenUsable({ ...base, expiresAt: null }, Number.MAX_SAFE_INTEGER), true);
  });

  it('caps the safety window at half the lifetime for short-lived tokens', () => {
    // A 60s token must not be considered stale on arrival just because the
    // default window is 5 minutes - that would refresh forever.
    const shortLived: CachedToken = {
      accessToken: 'shpat_x',
      issuedAt: 0,
      expiresAt: 60_000,
      scopes: [],
    };
    assert.equal(effectiveSafetyWindowMs(shortLived), 30_000);
    assert.equal(isTokenUsable(shortLived, 0), true);
    assert.equal(isTokenUsable(shortLived, 31_000), false);
  });

  it('converts expires_in into an absolute deadline', () => {
    assert.equal(computeExpiresAt(86399, 1000), 1000 + 86_399_000);
    assert.equal(computeExpiresAt(3599, 0), 3_599_000);
  });

  it('treats a missing or nonsensical expires_in as non-expiring', () => {
    assert.equal(computeExpiresAt(undefined, 0), null);
    assert.equal(computeExpiresAt('86399', 0), null);
    assert.equal(computeExpiresAt(0, 0), null);
    assert.equal(computeExpiresAt(-5, 0), null);
  });

  it('parses comma and space separated scopes', () => {
    assert.deepEqual(parseScopes('read_products,read_orders'), [
      'read_products',
      'read_orders',
    ]);
    assert.deepEqual(parseScopes('read_products read_orders'), [
      'read_products',
      'read_orders',
    ]);
    assert.deepEqual(parseScopes(''), []);
    assert.deepEqual(parseScopes(undefined), []);
  });

  it('reports seconds until expiry', () => {
    assert.equal(secondsUntilExpiry(base, 0), 86400);
    assert.equal(secondsUntilExpiry({ ...base, expiresAt: null }, 0), null);
    assert.equal(secondsUntilExpiry(base, 24 * HOUR_MS + 5000), 0);
  });
});

/* ------------------------------------------------- client credentials grant -- */

describe('ClientCredentialsTokenProvider', () => {
  it('obtains a token and reports its lifetime and scopes', async () => {
    const time = clock();
    const fake = fakeFetcher([okResponse('shpat_first', 86399)]);
    const provider = new ClientCredentialsTokenProvider({
      clientId: 'id',
      clientSecret: 'secret',
      fetcher: fake.fetcher,
      now: time.now,
    });

    const token = await provider.getAccessToken(SHOP);

    assert.equal(token.accessToken, 'shpat_first');
    assert.deepEqual(token.scopes, ['read_products', 'read_orders']);
    assert.equal(token.expiresAt, time.now() + 86_399_000);

    const diagnostics = provider.describe(SHOP);
    assert.equal(diagnostics.strategy, 'CLIENT_CREDENTIALS');
    assert.equal(diagnostics.cached, true);
    assert.equal(diagnostics.fetchCount, 1);
    assert.deepEqual(diagnostics.scopes, ['read_products', 'read_orders']);
  });

  it('sends the documented client_credentials payload to the right shop', async () => {
    const captured: { shopDomain?: string; clientId?: string; clientSecret?: string } = {};
    const provider = new ClientCredentialsTokenProvider({
      clientId: 'the-id',
      clientSecret: 'the-secret',
      fetcher: async (input) => {
        captured.shopDomain = input.shopDomain;
        captured.clientId = input.clientId;
        captured.clientSecret = input.clientSecret;
        return okResponse('shpat_x');
      },
    });

    await provider.getAccessToken(SHOP);

    assert.equal(captured.shopDomain, SHOP);
    assert.equal(captured.clientId, 'the-id');
    assert.equal(captured.clientSecret, 'the-secret');
  });

  it('caches the token - repeated calls do not contact Shopify again', async () => {
    const time = clock();
    const fake = fakeFetcher([okResponse('shpat_first')]);
    const provider = new ClientCredentialsTokenProvider({
      clientId: 'id',
      clientSecret: 'secret',
      fetcher: fake.fetcher,
      now: time.now,
    });

    await provider.getAccessToken(SHOP);
    await provider.getAccessToken(SHOP);
    time.advance(HOUR_MS);
    const third = await provider.getAccessToken(SHOP);

    assert.equal(fake.calls, 1, 'should have fetched exactly once');
    assert.equal(third.accessToken, 'shpat_first');
  });

  it('refreshes automatically as expiry approaches', async () => {
    const time = clock();
    const fake = fakeFetcher([okResponse('shpat_first', 3600), okResponse('shpat_second', 3600)]);
    const provider = new ClientCredentialsTokenProvider({
      clientId: 'id',
      clientSecret: 'secret',
      fetcher: fake.fetcher,
      now: time.now,
    });

    const first = await provider.getAccessToken(SHOP);
    assert.equal(first.accessToken, 'shpat_first');

    // 59 minutes in, only ~60s of life left - inside the safety window.
    time.advance(59 * 60 * 1000);
    const second = await provider.getAccessToken(SHOP);

    assert.equal(second.accessToken, 'shpat_second');
    assert.equal(fake.calls, 2);
    assert.equal(provider.describe(SHOP).fetchCount, 2);
  });

  it('does NOT refresh while the token is comfortably valid', async () => {
    const time = clock();
    const fake = fakeFetcher([okResponse('shpat_first', 3600)]);
    const provider = new ClientCredentialsTokenProvider({
      clientId: 'id',
      clientSecret: 'secret',
      fetcher: fake.fetcher,
      now: time.now,
    });

    await provider.getAccessToken(SHOP);
    time.advance(30 * 60 * 1000); // half an hour into a one-hour token
    await provider.getAccessToken(SHOP);

    assert.equal(fake.calls, 1);
  });

  it('coalesces concurrent requests into a single token fetch', async () => {
    let resolveFetch: ((value: { status: number; body: RawTokenResponse }) => void) | null = null;
    let calls = 0;
    const provider = new ClientCredentialsTokenProvider({
      clientId: 'id',
      clientSecret: 'secret',
      fetcher: () => {
        calls += 1;
        return new Promise((resolve) => {
          resolveFetch = resolve;
        });
      },
    });

    // Ten callers arrive before the first response comes back.
    const pending = Promise.all(
      Array.from({ length: 10 }, () => provider.getAccessToken(SHOP)),
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 1, 'only one token request should be in flight');

    resolveFetch?.(okResponse('shpat_shared'));
    const tokens = await pending;

    assert.equal(calls, 1);
    assert.ok(tokens.every((token) => token.accessToken === 'shpat_shared'));
  });

  it('records the failure reason, then clears it once a token is obtained', async () => {
    const time = clock();
    let calls = 0;
    const provider = new ClientCredentialsTokenProvider({
      clientId: 'id',
      clientSecret: 'secret',
      now: time.now,
      fetcher: async () => {
        calls += 1;
        if (calls === 1) return { status: 401, body: { error: 'invalid_client' } };
        return okResponse('shpat_recovered');
      },
    });

    await assert.rejects(() => provider.getAccessToken(SHOP), (error: unknown) => {
      return error instanceof AppError && error.code === 'SHOPIFY_AUTH_FAILED';
    });
    assert.equal(provider.describe(SHOP).lastError !== null, true);

    // Past the suppression window so a genuine retry happens.
    time.advance(31_000);
    const token = await provider.getAccessToken(SHOP);

    assert.equal(token.accessToken, 'shpat_recovered');
    assert.equal(provider.describe(SHOP).lastError, null);
    assert.equal(provider.describe(SHOP).cached, true);
  });

  it('suppresses repeat token requests after a terminal failure', async () => {
    // Reproduces the observed behaviour: a dashboard load runs several
    // operations, each of which used to trigger its own doomed token request.
    const time = clock();
    let calls = 0;
    const provider = new ClientCredentialsTokenProvider({
      clientId: 'id',
      clientSecret: 'secret',
      now: time.now,
      fetcher: async () => {
        calls += 1;
        return {
          status: 400,
          body: {
            error: 'invalid_request',
            error_description: 'Client credentials cannot be performed on this shop.',
          },
        };
      },
    });

    for (let i = 0; i < 5; i += 1) {
      await assert.rejects(() => provider.getAccessToken(SHOP), (error: unknown) => {
        return error instanceof AppError && error.code === 'SHOPIFY_APP_NOT_INSTALLED';
      });
    }

    assert.equal(calls, 1, 'five operations should cause ONE token request');
  });

  it('retries once the failure suppression window expires', async () => {
    const time = clock();
    let calls = 0;
    const provider = new ClientCredentialsTokenProvider({
      clientId: 'id',
      clientSecret: 'secret',
      now: time.now,
      fetcher: async () => {
        calls += 1;
        if (calls === 1) {
          return { status: 401, body: { error: 'invalid_client' } };
        }
        return okResponse('shpat_after_fix');
      },
    });

    await assert.rejects(() => provider.getAccessToken(SHOP));
    assert.equal(calls, 1);

    // Still suppressed.
    time.advance(29_000);
    await assert.rejects(() => provider.getAccessToken(SHOP));
    assert.equal(calls, 1);

    // Window elapsed - self-heals without a restart.
    time.advance(2_000);
    const token = await provider.getAccessToken(SHOP);
    assert.equal(token.accessToken, 'shpat_after_fix');
    assert.equal(calls, 2);
  });

  it('does NOT suppress retryable failures', async () => {
    const time = clock();
    let calls = 0;
    const provider = new ClientCredentialsTokenProvider({
      clientId: 'id',
      clientSecret: 'secret',
      now: time.now,
      fetcher: async () => {
        calls += 1;
        throw new Error('socket hang up');
      },
    });

    await assert.rejects(() => provider.getAccessToken(SHOP));
    await assert.rejects(() => provider.getAccessToken(SHOP));

    assert.equal(calls, 2, 'transient failures must remain retryable');
  });

  it('clears failure suppression on invalidate()', async () => {
    const time = clock();
    let calls = 0;
    const provider = new ClientCredentialsTokenProvider({
      clientId: 'id',
      clientSecret: 'secret',
      now: time.now,
      fetcher: async () => {
        calls += 1;
        if (calls === 1) return { status: 401, body: { error: 'invalid_client' } };
        return okResponse('shpat_second');
      },
    });

    await assert.rejects(() => provider.getAccessToken(SHOP));
    provider.invalidate(SHOP);
    const token = await provider.getAccessToken(SHOP);

    assert.equal(token.accessToken, 'shpat_second');
    assert.equal(calls, 2);
  });

  it('re-fetches after invalidate(), which is how a 401 is recovered', async () => {
    const fake = fakeFetcher([okResponse('shpat_first'), okResponse('shpat_second')]);
    const provider = new ClientCredentialsTokenProvider({
      clientId: 'id',
      clientSecret: 'secret',
      fetcher: fake.fetcher,
    });

    assert.equal((await provider.getAccessToken(SHOP)).accessToken, 'shpat_first');
    provider.invalidate(SHOP);
    assert.equal(provider.describe(SHOP).cached, false);
    assert.equal((await provider.getAccessToken(SHOP)).accessToken, 'shpat_second');
    assert.equal(fake.calls, 2);
  });

  it('keeps a separate token per shop domain, ready for multi-store OAuth', async () => {
    let calls = 0;
    const provider = new ClientCredentialsTokenProvider({
      clientId: 'id',
      clientSecret: 'secret',
      fetcher: async ({ shopDomain }) => {
        calls += 1;
        return okResponse(`shpat_${shopDomain}`);
      },
    });

    const a = await provider.getAccessToken('a.myshopify.com');
    const b = await provider.getAccessToken('b.myshopify.com');

    assert.equal(a.accessToken, 'shpat_a.myshopify.com');
    assert.equal(b.accessToken, 'shpat_b.myshopify.com');
    assert.equal(calls, 2);
    // Invalidating one store must not affect the other.
    provider.invalidate('a.myshopify.com');
    assert.equal(provider.describe('b.myshopify.com').cached, true);
  });

  it('rejects a 200 response with no access_token', async () => {
    const provider = new ClientCredentialsTokenProvider({
      clientId: 'id',
      clientSecret: 'secret',
      fetcher: async () => ({ status: 200, body: {} }),
    });

    await assert.rejects(() => provider.getAccessToken(SHOP), (error: unknown) => {
      return error instanceof AppError && error.code === 'SHOPIFY_AUTH_FAILED';
    });
  });

  it('maps transport failures to a retryable network error', async () => {
    const provider = new ClientCredentialsTokenProvider({
      clientId: 'id',
      clientSecret: 'secret',
      fetcher: async () => {
        throw new Error('getaddrinfo ENOTFOUND');
      },
    });

    await assert.rejects(() => provider.getAccessToken(SHOP), (error: unknown) => {
      return (
        error instanceof AppError &&
        error.code === 'SHOPIFY_NETWORK_ERROR' &&
        error.retryable
      );
    });
  });

  it('can refresh, so the client is allowed to retry a 401', () => {
    const provider = new ClientCredentialsTokenProvider({
      clientId: 'id',
      clientSecret: 'secret',
      fetcher: async () => okResponse('shpat_x'),
    });
    assert.equal(provider.canRefresh, true);
  });
});

/* --------------------------------------------------------- static override -- */

describe('StaticTokenProvider', () => {
  it('returns the supplied token and never expires it', async () => {
    const provider = new StaticTokenProvider('shpat_static');
    const token = await provider.getAccessToken();

    assert.equal(token.accessToken, 'shpat_static');
    assert.equal(token.expiresAt, null);
    assert.equal(provider.strategy, 'STATIC_TOKEN');
  });

  it('cannot refresh, so a rejected token surfaces instead of looping', () => {
    assert.equal(new StaticTokenProvider('shpat_static').canRefresh, false);
  });

  it('never reports the token value in diagnostics', async () => {
    const diagnostics = new StaticTokenProvider('shpat_supersecret').describe();
    assert.equal(JSON.stringify(diagnostics).includes('shpat_supersecret'), false);
  });
});

/* -------------------------------------------------------- token error maps -- */

describe('mapTokenFailure', () => {
  it('detects the app not being installed on the shop', () => {
    const error = mapTokenFailure(400, {
      error: 'invalid_request',
      error_description: 'Client credentials cannot be performed on this shop.',
    });

    assert.equal(error.code, 'SHOPIFY_APP_NOT_INSTALLED');
    assert.equal(error.retryable, false);
    assert.match(error.message, /not installed/);
  });

  it('detects bad client credentials', () => {
    const error = mapTokenFailure(401, { error: 'invalid_client' });

    assert.equal(error.code, 'SHOPIFY_AUTH_FAILED');
    assert.match(error.message, /SHOPIFY_CLIENT_ID/);
    assert.equal(error.retryable, false);
  });

  it('gives a specific remedy for "Missing or invalid client secret"', () => {
    // Exact wording Shopify returns for a wrong/blank secret.
    const error = mapTokenFailure(400, {
      error: 'invalid_request',
      error_description: 'Missing or invalid client secret',
    });

    assert.equal(error.code, 'SHOPIFY_AUTH_FAILED');
    assert.equal(error.retryable, false);
    assert.match(error.message, /SHOPIFY_CLIENT_SECRET/);
    // The HTTP status is included so the failure mode is diagnosable.
    assert.match(error.message, /HTTP 400/);
    assert.match(error.message, /Missing or invalid client secret/);
  });

  it('gives a specific remedy for an invalid client id', () => {
    const error = mapTokenFailure(400, {
      error: 'invalid_request',
      error_description: 'Missing or invalid client id',
    });

    assert.equal(error.code, 'SHOPIFY_AUTH_FAILED');
    assert.match(error.message, /SHOPIFY_CLIENT_ID/);
  });

  it('detects an unsupported grant type', () => {
    const error = mapTokenFailure(400, { error: 'unsupported_grant_type' });

    assert.equal(error.code, 'SHOPIFY_AUTH_FAILED');
    assert.match(error.message, /client credentials grant/);
  });

  it('explains a 404 as a probable wrong store domain', () => {
    const error = mapTokenFailure(404, {});
    assert.match(error.message, /myshopify\.com/);
  });

  it('marks throttling and 5xx as retryable', () => {
    assert.equal(mapTokenFailure(429, {}).retryable, true);
    assert.equal(mapTokenFailure(503, {}).retryable, true);
  });

  it('never echoes a secret into the message', () => {
    const error = mapTokenFailure(401, {
      error: 'invalid_client',
      error_description: 'secret shpss_abc123 rejected',
    });
    assert.equal(error.message.includes('shpss_abc123'), false);
  });

  it('redacts a token-shaped value even when it names the client secret', () => {
    // Guards the branch that quotes Shopify's description back to the caller.
    const error = mapTokenFailure(400, {
      error: 'invalid_request',
      error_description: 'Missing or invalid client secret shpat_leakme123',
    });

    assert.equal(error.message.includes('shpat_leakme123'), false);
    assert.match(error.message, /REDACTED/);
  });

  it('does not misclassify invalid_client as a client-secret problem', () => {
    // "invalid_client" + "secret" must not join into the substring
    // "client secret" and select the wrong branch.
    const error = mapTokenFailure(401, {
      error: 'invalid_client',
      error_description: 'secret rejected',
    });

    assert.match(error.message, /Shopify rejected the app credentials/);
  });
});
