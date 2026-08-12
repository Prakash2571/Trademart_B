/**
 * Environment/config validation tests.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { validateEnv } from './env.validation';

const VALID = {
  SHOPIFY_STORE_DOMAIN: 'teststoremart-uk8mmby.myshopify.com',
  SHOPIFY_CLIENT_ID: 'client-id-example',
  SHOPIFY_CLIENT_SECRET: 'client-secret-example',
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
    const result = validateEnv({ SHOPIFY_CLIENT_ID: 'x', SHOPIFY_CLIENT_SECRET: 'y' });

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

  it('warns but still boots when credentials and Mongo URI are missing in development', () => {
    const result = validateEnv({ SHOPIFY_STORE_DOMAIN: VALID.SHOPIFY_STORE_DOMAIN });

    assert.deepEqual(result.errors, []);
    assert.ok(result.config);
    assert.equal(result.config.shopify.authStrategy, 'NONE');
    assert.equal(result.config.mongoUri, null);
    assert.ok(result.warnings.some((warning) => warning.includes('SHOPIFY_CLIENT_ID')));
    assert.ok(result.warnings.some((warning) => warning.includes('MONGODB_URI')));
  });

  it('requires credentials and a Mongo URI in production', () => {
    const result = validateEnv({
      NODE_ENV: 'production',
      SHOPIFY_STORE_DOMAIN: VALID.SHOPIFY_STORE_DOMAIN,
      FRONTEND_URL: 'https://app.example.com',
    });

    assert.equal(result.config, null);
    assert.ok(result.errors.some((error) => error.includes('SHOPIFY_CLIENT_ID')));
    assert.ok(result.errors.some((error) => error.includes('MONGODB_URI')));
  });

  it('builds the client credentials token endpoint', () => {
    const result = validateEnv(VALID);

    assert.equal(
      result.config?.shopify.tokenEndpoint,
      'https://teststoremart-uk8mmby.myshopify.com/admin/oauth/access_token',
    );
  });

  it('selects CLIENT_CREDENTIALS when a client id and secret are present', () => {
    const result = validateEnv(VALID);

    assert.deepEqual(result.errors, []);
    assert.equal(result.config?.shopify.authStrategy, 'CLIENT_CREDENTIALS');
    assert.equal(result.config?.shopify.accessToken, null);
  });

  it('rejects a half-configured credential pair', () => {
    const missingSecret = validateEnv({
      SHOPIFY_STORE_DOMAIN: VALID.SHOPIFY_STORE_DOMAIN,
      SHOPIFY_CLIENT_ID: 'only-the-id',
    });
    assert.equal(missingSecret.config, null);
    assert.ok(
      missingSecret.errors.some((error) => error.includes('SHOPIFY_CLIENT_SECRET is required')),
    );

    const missingId = validateEnv({
      SHOPIFY_STORE_DOMAIN: VALID.SHOPIFY_STORE_DOMAIN,
      SHOPIFY_CLIENT_SECRET: 'only-the-secret',
    });
    assert.equal(missingId.config, null);
    assert.ok(missingId.errors.some((error) => error.includes('SHOPIFY_CLIENT_ID is required')));
  });

  it('lets an explicit static token override client credentials, with a warning', () => {
    const result = validateEnv({ ...VALID, SHOPIFY_ACCESS_TOKEN: 'shpat_override' });

    assert.deepEqual(result.errors, []);
    assert.equal(result.config?.shopify.authStrategy, 'STATIC_TOKEN');
    assert.ok(result.warnings.some((warning) => warning.includes('takes precedence')));
  });

  it('selects STATIC_TOKEN when only an access token is supplied', () => {
    const result = validateEnv({
      SHOPIFY_STORE_DOMAIN: VALID.SHOPIFY_STORE_DOMAIN,
      SHOPIFY_ACCESS_TOKEN: 'shpat_only',
    });

    assert.deepEqual(result.errors, []);
    assert.equal(result.config?.shopify.authStrategy, 'STATIC_TOKEN');
    assert.ok(result.warnings.some((warning) => warning.includes('refresh automatically')));
  });

  it('accepts client credentials in production', () => {
    const result = validateEnv({
      ...VALID,
      NODE_ENV: 'production',
      FRONTEND_URL: 'https://app.example.com',
    });

    assert.deepEqual(result.errors, []);
    assert.equal(result.config?.shopify.authStrategy, 'CLIENT_CREDENTIALS');
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
