/**
 * Shopify error-handling tests using recorded/mocked payload shapes.
 * No network access required.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  mapGraphqlErrors,
  mapHttpFailure,
  mapNetworkFailure,
  mapUserErrors,
} from './shopify.errors';

describe('mapHttpFailure', () => {
  it('maps 401 to an unauthorized error that is not retryable', () => {
    const error = mapHttpFailure(401, '[API] Invalid API key or access token');

    assert.equal(error.code, 'SHOPIFY_UNAUTHORIZED');
    assert.equal(error.status, 401);
    assert.equal(error.retryable, false);
  });

  it('maps 403 to a missing scope error', () => {
    const error = mapHttpFailure(403, 'Forbidden');
    assert.equal(error.code, 'SHOPIFY_SCOPE_MISSING');
    assert.equal(error.status, 403);
  });

  it('maps 404 to a hint about the domain/API version', () => {
    const error = mapHttpFailure(404, 'Not Found');
    assert.equal(error.code, 'SHOPIFY_NOT_FOUND');
    assert.match(error.message, /myshopify\.com/);
  });

  it('maps 429 to a retryable throttle error', () => {
    const error = mapHttpFailure(429, 'Too Many Requests');
    assert.equal(error.code, 'SHOPIFY_THROTTLED');
    assert.equal(error.status, 429);
    assert.equal(error.retryable, true);
  });

  it('maps 5xx to a retryable error', () => {
    const error = mapHttpFailure(503, 'Service Unavailable');
    assert.equal(error.code, 'SHOPIFY_HTTP_ERROR');
    assert.equal(error.retryable, true);
  });

  it('treats 402 and 423 as terminal, not retryable', () => {
    assert.equal(mapHttpFailure(402, '').retryable, false);
    assert.equal(mapHttpFailure(423, '').retryable, false);
  });

  it('does not echo the response body for auth failures', () => {
    const token = 'shpat_abcdef1234567890';
    const error = mapHttpFailure(401, `token ${token} rejected`);
    assert.ok(!error.message.includes(token));
  });
});

describe('mapGraphqlErrors', () => {
  it('returns null when there are no errors', () => {
    assert.equal(mapGraphqlErrors(undefined), null);
    assert.equal(mapGraphqlErrors(null), null);
    assert.equal(mapGraphqlErrors([]), null);
  });

  it('detects THROTTLED inside a 200 response', () => {
    const error = mapGraphqlErrors([
      {
        message: 'Throttled',
        extensions: { code: 'THROTTLED' },
      },
    ]);

    assert.equal(error?.code, 'SHOPIFY_THROTTLED');
    assert.equal(error?.retryable, true);
  });

  it('detects ACCESS_DENIED and names the required scope', () => {
    const error = mapGraphqlErrors([
      {
        message:
          'Access denied for customers field. Required access: `read_customers` access scope.',
        extensions: { code: 'ACCESS_DENIED' },
      },
    ]);

    assert.equal(error?.code, 'SHOPIFY_SCOPE_MISSING');
    assert.match(error?.message ?? '', /read_customers/);
    assert.equal(error?.retryable, false, 'permission errors must never be retried');
  });

  it('detects a scope problem from the message alone', () => {
    const error = mapGraphqlErrors([
      { message: 'This app is not approved to access the Customer object.' },
    ]);

    assert.equal(error?.code, 'SHOPIFY_SCOPE_MISSING');
  });

  it('maps UNAUTHENTICATED to an unauthorized error', () => {
    const error = mapGraphqlErrors([
      { message: 'Unauthenticated', extensions: { code: 'UNAUTHENTICATED' } },
    ]);

    assert.equal(error?.code, 'SHOPIFY_UNAUTHORIZED');
  });

  it('maps MAX_COST_EXCEEDED to a query-cost error', () => {
    const error = mapGraphqlErrors([
      { message: 'Query cost is too high', extensions: { code: 'MAX_COST_EXCEEDED' } },
    ]);

    assert.equal(error?.code, 'SHOPIFY_GRAPHQL_ERROR');
    assert.match(error?.message ?? '', /too expensive/);
  });

  it('falls back to a generic GraphQL error and keeps the details', () => {
    const error = mapGraphqlErrors([
      { message: "Field 'nope' doesn't exist on type 'Shop'" },
    ]);

    assert.equal(error?.code, 'SHOPIFY_GRAPHQL_ERROR');
    assert.match(error?.message ?? '', /doesn't exist/);
    assert.ok(error?.details);
  });

  it('produces the documented failure envelope', () => {
    const error = mapGraphqlErrors([
      {
        message: 'Access denied for customer field. Required access: `read_customers`.',
        extensions: { code: 'ACCESS_DENIED' },
      },
    ]);
    const body = error!.toBody();

    assert.equal(body.success, false);
    assert.equal(body.code, 'SHOPIFY_SCOPE_MISSING');
    assert.equal(typeof body.message, 'string');
  });
});

describe('mapUserErrors', () => {
  it('returns null when empty', () => {
    assert.equal(mapUserErrors([]), null);
    assert.equal(mapUserErrors(undefined), null);
  });

  it('summarises field-level user errors', () => {
    const error = mapUserErrors([
      { field: ['input', 'title'], message: 'can not be blank' },
      { field: null, message: 'something else' },
    ]);

    assert.equal(error?.code, 'SHOPIFY_USER_ERROR');
    assert.equal(error?.status, 422);
    assert.match(error?.message ?? '', /input\.title: can not be blank/);
    assert.match(error?.message ?? '', /something else/);
  });
});

describe('mapNetworkFailure', () => {
  it('marks network failures retryable', () => {
    const error = mapNetworkFailure(new Error('getaddrinfo ENOTFOUND'));
    assert.equal(error.code, 'SHOPIFY_NETWORK_ERROR');
    assert.equal(error.retryable, true);
  });

  it('recognises aborts as timeouts, with their own code', () => {
    // A distinct code because the two need different handling: a network error
    // means the request never landed, whereas a timeout is ambiguous and the
    // write may already have been applied.
    const error = mapNetworkFailure(new Error('This operation was aborted'));
    assert.equal(error.code, 'SHOPIFY_TIMEOUT');
    assert.match(error.message, /timed out/);
    assert.equal(error.retryable, true);
  });

  it('treats an explicit timeout message as a timeout too', () => {
    // Undici does not always phrase this as an abort.
    const error = mapNetworkFailure(new Error('Request timed out after 20000ms'));
    assert.equal(error.code, 'SHOPIFY_TIMEOUT');
  });

  it('keeps a DNS failure as a network error, not a timeout', () => {
    const error = mapNetworkFailure(new Error('getaddrinfo ENOTFOUND shop.myshopify.com'));
    assert.equal(error.code, 'SHOPIFY_NETWORK_ERROR');
  });
});
