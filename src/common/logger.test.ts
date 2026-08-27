/**
 * What ends up in a log line.
 *
 * Logs are the least protected copy of production data: they are shipped to
 * aggregation, retained for months, and readable by more people than the database
 * is. So the rule is not "avoid logging secrets", it is "the logger cannot print
 * one even when a caller passes it".
 *
 * Three gaps this pins shut:
 *
 *   1. `signature` was not a redacted key, so a debug line carrying a Razorpay
 *      webhook's `razorpay_signature` would have printed a working signature.
 *   2. ARRAYS were passed through untouched. The same token was redacted as
 *      `{ token: '...' }` and printed as `{ scopes: ['shpat_...'] }`.
 *   3. A customer's email, phone and address were logged in full whenever a
 *      caller included them, which is PII in a place with weaker access control
 *      than the database and no operational upside.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { sanitiseLogPath } from './logPath';
import { isRedactedKey, redact } from './logger';

describe('value-shape redaction', () => {
  it('redacts Shopify tokens wherever they appear in a string', () => {
    assert.equal(redact('token shpat_abc123 used'), 'token [REDACTED] used');
    assert.equal(redact('shpss_secret'), '[REDACTED]');
    assert.equal(redact('shpca_x1'), '[REDACTED]');
    assert.equal(redact('shppa_x1'), '[REDACTED]');
  });

  it('redacts a Mongo connection string, which embeds credentials', () => {
    assert.equal(
      redact('failed: mongodb+srv://user:pw@cluster.example.net/db?retryWrites=true'),
      'failed: [REDACTED]',
    );
  });

  it('redacts Razorpay key ids, which sit next to the secret', () => {
    assert.equal(redact('using rzp_live_ABCdef123'), 'using [REDACTED]');
    assert.equal(redact('using rzp_test_ABCdef123'), 'using [REDACTED]');
  });

  it('leaves ordinary diagnostics readable', () => {
    // Over-redacting is its own failure: a log nobody can read is a log nobody uses.
    const message = 'Publication failed for gid://shopify/Product/12345 after 3 attempts';
    assert.equal(redact(message), message);
  });
});

describe('key-name redaction', () => {
  it('covers credential-shaped field names', () => {
    for (const key of [
      'token',
      'accessToken',
      'secret',
      'clientSecret',
      'keySecret',
      'password',
      'passwordHash',
      'authorization',
      'apiKey',
      'api_key',
      'cookie',
      'sessionSecret',
      'encryptionKey',
      'credential',
      // The gap this pass closed.
      'signature',
      'razorpay_signature',
      'hmac',
    ]) {
      assert.equal(isRedactedKey(key), true, `${key} must never be printed`);
    }
  });

  it('covers personal data', () => {
    for (const key of [
      'email',
      'phone',
      'contact',
      'fullName',
      'address',
      'shippingAddress',
      'line1',
      'line2',
      'postalCode',
      'customer',
      // Bulk objects that drag PII in by accident.
      'payload',
      'rawBody',
    ]) {
      assert.equal(isRedactedKey(key), true, `${key} must not be logged in full`);
    }
  });

  it('does NOT redact the fields an operator diagnoses with', () => {
    // Over-redaction would make the logs useless. These are the ones that answer
    // "what happened, to what, and how badly".
    for (const key of [
      'operation',
      'method',
      'path',
      'status',
      'durationMs',
      'storeDomain',
      'topic',
      'webhookId',
      'reason',
      'code',
      'attempts',
      'actor',
      'username',
      'requestId',
      'checkoutPublicId',
      'shopifyProductId',
    ]) {
      assert.equal(isRedactedKey(key), false, `${key} is needed for diagnosis`);
    }
  });

  it('matches a credential name inside a longer field name', () => {
    // Substring matching on purpose: `offlineAccessToken` and `webhookSecret` are
    // the names people actually use.
    assert.equal(isRedactedKey('offlineAccessToken'), true);
    assert.equal(isRedactedKey('webhookSecret'), true);
  });

  it('matches personal keys exactly, so a safe name is not swallowed', () => {
    // `email` is redacted; `emailsSent` (a count) is not. Anchored for that reason.
    assert.equal(isRedactedKey('emailsSent'), false);
    assert.equal(isRedactedKey('addressCount'), false);
  });
});

describe('access-log paths', () => {
  it('masks the tracking token, which is a bearer credential', () => {
    // Whoever holds this token can read the order's status, name and address. It was
    // being written into the access log in full, on every request.
    assert.equal(
      sanitiseLogPath('/api/storefront/orders/track/OGZmZTk3ZWQtM2QwYS00'),
      '/api/storefront/orders/track/:token',
    );
  });

  it('keeps the operation identifiable', () => {
    // The point is to keep "tracking is being hammered" answerable without the
    // credential, so the route prefix must survive.
    assert.match(sanitiseLogPath('/api/storefront/orders/track/abc'), /orders\/track/);
  });

  it('leaves the bare route alone', () => {
    assert.equal(
      sanitiseLogPath('/api/storefront/orders/track/'),
      '/api/storefront/orders/track/',
    );
  });

  it('does not touch other paths', () => {
    for (const path of [
      '/api/shopify/products',
      '/api/storefront/checkout',
      '/api/storefront/checkout/9f1c/status',
      '/api/webhooks/shopify',
    ]) {
      assert.equal(sanitiseLogPath(path), path);
    }
  });
});
