/**
 * Webhook HMAC verification tests.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  computeWebhookHmac,
  isExpectedShopDomain,
  verifyWebhookSignature,
} from './webhook.verify';

const SECRET = 'test_webhook_secret';
const BODY = JSON.stringify({ id: 12345, name: '#1001' });

describe('verifyWebhookSignature', () => {
  it('accepts a correctly signed payload', () => {
    const signature = computeWebhookHmac(BODY, SECRET);
    const result = verifyWebhookSignature(Buffer.from(BODY), signature, SECRET);

    assert.equal(result.valid, true);
  });

  it('rejects a tampered payload', () => {
    const signature = computeWebhookHmac(BODY, SECRET);
    const result = verifyWebhookSignature(
      Buffer.from(BODY.replace('12345', '99999')),
      signature,
      SECRET,
    );

    assert.equal(result.valid, false);
  });

  it('rejects a signature produced with a different secret', () => {
    const signature = computeWebhookHmac(BODY, 'wrong_secret');
    const result = verifyWebhookSignature(Buffer.from(BODY), signature, SECRET);

    assert.equal(result.valid, false);
  });

  it('rejects when no secret is configured', () => {
    const result = verifyWebhookSignature(Buffer.from(BODY), 'anything', null);

    assert.equal(result.valid, false);
    assert.match(result.valid === false ? result.reason : '', /not configured/);
  });

  it('rejects a missing signature header', () => {
    const result = verifyWebhookSignature(Buffer.from(BODY), undefined, SECRET);

    assert.equal(result.valid, false);
    assert.match(result.valid === false ? result.reason : '', /Missing/);
  });

  it('rejects a missing raw body', () => {
    const result = verifyWebhookSignature(undefined, 'sig', SECRET);

    assert.equal(result.valid, false);
  });

  it('does not throw on a malformed base64 signature', () => {
    const result = verifyWebhookSignature(Buffer.from(BODY), '!!!not-base64!!!', SECRET);

    assert.equal(result.valid, false);
  });

  it('is byte-exact: whitespace changes invalidate the signature', () => {
    const signature = computeWebhookHmac(BODY, SECRET);
    const result = verifyWebhookSignature(Buffer.from(`${BODY} `), signature, SECRET);

    assert.equal(result.valid, false);
  });
});

describe('isExpectedShopDomain', () => {
  it('matches case-insensitively', () => {
    assert.equal(
      isExpectedShopDomain(
        'TestStoreMart-uk8mmby.myshopify.com',
        'teststoremart-uk8mmby.myshopify.com',
      ),
      true,
    );
  });

  it('rejects another shop or a missing header', () => {
    assert.equal(
      isExpectedShopDomain('evil.myshopify.com', 'teststoremart-uk8mmby.myshopify.com'),
      false,
    );
    assert.equal(isExpectedShopDomain(undefined, 'teststoremart-uk8mmby.myshopify.com'), false);
  });
});
