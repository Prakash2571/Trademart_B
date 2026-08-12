/**
 * Environment/config validation tests.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { validateEnv } from './env.validation';

const VALID = {
  SHOPIFY_STORE_DOMAIN: 'teststoremart-uk8mmby.myshopify.com',
  SHOPIFY_ACCESS_TOKEN: 'shpat_example',
  MONGODB_URI: 'mongodb://127.0.0.1:27017/trademart',
  FRONTEND_URL: 'http://localhost:3000',
} as const;

describe('validateEnv', () => {
  it('accepts a valid environment and builds the GraphQL endpoint', () => {
    const result = validateEnv({ ...VALID, PORT: '4000' });

    assert.deepEqual(result.errors, []);
    assert.ok(result.config);
    assert.equal(result.config.port, 4000);
    assert.equal(
      result.config.shopify.graphqlEndpoint,
      'https://teststoremart-uk8mmby.myshopify.com/admin/api/2026-07/graphql.json',
    );
  });

  it('defaults the API version to 2026-07 and the port to 4000', () => {
    const result = validateEnv(VALID);

    assert.equal(result.config?.shopify.apiVersion, '2026-07');
    assert.equal(result.config?.port, 4000);
  });

  it('rejects the admin.shopify.com URL explicitly', () => {
    const result = validateEnv({
      ...VALID,
      SHOPIFY_STORE_DOMAIN: 'admin.shopify.com/store/teststoremart-uk8mmby',
    });

    assert.equal(result.config, null);
    assert.ok(result.errors.some((error) => error.includes('admin.shopify.com')));
  });

  it('normalises a domain supplied with a protocol or trailing path', () => {
    const result = validateEnv({
      ...VALID,
      SHOPIFY_STORE_DOMAIN: 'https://teststoremart-uk8mmby.myshopify.com/',
    });

    assert.deepEqual(result.errors, []);
    assert.equal(
      result.config?.shopify.storeDomain,
      'teststoremart-uk8mmby.myshopify.com',
    );
  });

  it('rejects a non-myshopify domain', () => {
    const result = validateEnv({ ...VALID, SHOPIFY_STORE_DOMAIN: 'example.com' });

    assert.equal(result.config, null);
    assert.ok(result.errors.some((error) => error.includes('myshopify.com')));
  });

  it('requires the store domain', () => {
    const result = validateEnv({ SHOPIFY_ACCESS_TOKEN: 'shpat_x' });

    assert.equal(result.config, null);
    assert.ok(result.errors.some((error) => error.includes('SHOPIFY_STORE_DOMAIN')));
  });

  it('rejects a malformed API version', () => {
    const result = validateEnv({ ...VALID, SHOPIFY_API_VERSION: '2026/07' });

    assert.equal(result.config, null);
    assert.ok(result.errors.some((error) => error.includes('SHOPIFY_API_VERSION')));
  });

  it('rejects a non-numeric or out-of-range port', () => {
    assert.ok(validateEnv({ ...VALID, PORT: 'abc' }).errors.length > 0);
    assert.ok(validateEnv({ ...VALID, PORT: '70000' }).errors.length > 0);
  });

  it('rejects a Mongo URI with the wrong scheme', () => {
    const result = validateEnv({ ...VALID, MONGODB_URI: 'postgres://localhost/x' });

    assert.equal(result.config, null);
    assert.ok(result.errors.some((error) => error.includes('MONGODB_URI')));
  });

  it('accepts mongodb+srv URIs', () => {
    const result = validateEnv({
      ...VALID,
      MONGODB_URI: 'mongodb+srv://user:pass@cluster.mongodb.net/trademart',
    });

    assert.deepEqual(result.errors, []);
  });

  it('warns but still boots when the token and Mongo URI are missing in development', () => {
    const result = validateEnv({ SHOPIFY_STORE_DOMAIN: VALID.SHOPIFY_STORE_DOMAIN });

    assert.deepEqual(result.errors, []);
    assert.ok(result.config);
    assert.equal(result.config.shopify.accessToken, null);
    assert.equal(result.config.mongoUri, null);
    assert.ok(result.warnings.some((warning) => warning.includes('SHOPIFY_ACCESS_TOKEN')));
    assert.ok(result.warnings.some((warning) => warning.includes('MONGODB_URI')));
  });

  it('requires the token and Mongo URI in production', () => {
    const result = validateEnv({
      NODE_ENV: 'production',
      SHOPIFY_STORE_DOMAIN: VALID.SHOPIFY_STORE_DOMAIN,
      FRONTEND_URL: 'https://app.example.com',
    });

    assert.equal(result.config, null);
    assert.ok(result.errors.some((error) => error.includes('SHOPIFY_ACCESS_TOKEN')));
    assert.ok(result.errors.some((error) => error.includes('MONGODB_URI')));
  });

  it('rejects an unknown NODE_ENV', () => {
    const result = validateEnv({ ...VALID, NODE_ENV: 'staging' });

    assert.equal(result.config, null);
    assert.ok(result.errors.some((error) => error.includes('NODE_ENV')));
  });

  it('rejects a FRONTEND_URL without a scheme and strips trailing slashes', () => {
    assert.ok(validateEnv({ ...VALID, FRONTEND_URL: 'localhost:3000' }).errors.length > 0);
    assert.equal(
      validateEnv({ ...VALID, FRONTEND_URL: 'http://localhost:3000/' }).config
        ?.frontendUrl,
      'http://localhost:3000',
    );
  });

  it('treats blank strings as unset', () => {
    const result = validateEnv({ ...VALID, SHOPIFY_ACCESS_TOKEN: '   ' });

    assert.equal(result.config?.shopify.accessToken, null);
  });
});
