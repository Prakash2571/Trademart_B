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

describe('validateEnv - APP_URL and derived callback URLs', () => {
  it('leaves OAuth and webhook URLs null when APP_URL is unset', () => {
    const result = validateEnv(VALID);

    assert.equal(result.config?.appUrl, null);
    assert.equal(result.config?.shopify.oauthRedirectUri, null);
    assert.equal(result.config?.shopify.webhookCallbackUrl, null);
    assert.ok(result.warnings.some((warning) => warning.includes('APP_URL')));
  });

  it('derives the redirect and webhook URLs from APP_URL', () => {
    const result = validateEnv({ ...VALID, APP_URL: 'https://app.example.com' });

    assert.deepEqual(result.errors, []);
    assert.equal(
      result.config?.shopify.oauthRedirectUri,
      'https://app.example.com/api/auth/callback',
    );
    assert.equal(
      result.config?.shopify.webhookCallbackUrl,
      'https://app.example.com/api/webhooks/shopify',
    );
  });

  it('strips trailing slashes so the redirect URI never doubles up', () => {
    // Shopify compares the redirect_uri exactly; "//api/auth/callback" would not match.
    const result = validateEnv({ ...VALID, APP_URL: 'https://app.example.com///' });

    assert.equal(
      result.config?.shopify.oauthRedirectUri,
      'https://app.example.com/api/auth/callback',
    );
  });

  it('rejects an APP_URL with no scheme', () => {
    const result = validateEnv({ ...VALID, APP_URL: 'app.example.com' });

    assert.equal(result.config, null);
    assert.ok(result.errors.some((error) => error.includes('APP_URL')));
  });

  it('warns that a localhost APP_URL is unreachable by Shopify', () => {
    const result = validateEnv({ ...VALID, APP_URL: 'http://localhost:4000' });

    assert.deepEqual(result.errors, []);
    assert.ok(result.warnings.some((warning) => warning.includes('cannot reach')));
  });

  it('requires https for APP_URL in production', () => {
    const result = validateEnv({
      ...VALID,
      NODE_ENV: 'production',
      APP_URL: 'http://app.example.com',
    });

    assert.equal(result.config, null);
    assert.ok(result.errors.some((error) => error.includes('https')));
  });
});

describe('validateEnv - SHOPIFY_SCOPES', () => {
  it('defaults to every scope the implemented features need', () => {
    const result = validateEnv(VALID);

    // Derived from shopify/capabilities.ts, so this list grows automatically
    // when a feature is added. Asserted explicitly anyway: a silent change to
    // the requested scope list changes what merchants are asked to approve.
    assert.deepEqual(result.config?.shopify.scopes, [
      'read_customers',
      'read_inventory',
      'read_locations',
      'read_orders',
      'read_products',
      'read_publications',
      'read_themes',
      'write_inventory',
      'write_products',
      'write_publications',
    ]);
  });

  it('requests the publication scopes now that publishing is implemented', () => {
    const scopes = validateEnv(VALID).config?.shopify.scopes ?? [];
    assert.ok(scopes.includes('write_publications'), 'write_publications must be requested');
    assert.ok(scopes.includes('read_publications'), 'read_publications must be requested');
  });

  it('defaults to the write scopes the mutations need', () => {
    // Regression guard for the original bug: the default list was read-only
    // long after product and inventory writes shipped, so a fresh install
    // could not perform half the product's features.
    const scopes = validateEnv(VALID).config?.shopify.scopes ?? [];

    assert.ok(scopes.includes('write_products'), 'write_products must be requested');
    assert.ok(scopes.includes('write_inventory'), 'write_inventory must be requested');
    assert.ok(scopes.includes('read_locations'), 'read_locations must be requested');
  });

  it('does not request write_themes, which is not implemented', () => {
    // Requesting permission that cannot be exercised adds install friction and
    // costs merchant trust for no capability.
    const scopes = validateEnv(VALID).config?.shopify.scopes ?? [];

    assert.ok(!scopes.includes('write_themes'));
    assert.ok(!scopes.includes('write_theme_code'));
  });

  it('parses a comma-separated list and lowercases it', () => {
    const result = validateEnv({
      ...VALID,
      SHOPIFY_SCOPES: 'read_products, READ_ORDERS',
    });

    assert.deepEqual(result.config?.shopify.scopes, ['read_products', 'read_orders']);
  });

  it('de-duplicates repeated scopes', () => {
    // Shopify rejects an authorize URL with a repeated scope.
    const result = validateEnv({
      ...VALID,
      SHOPIFY_SCOPES: 'read_products,read_products,read_orders',
    });

    assert.deepEqual(result.config?.shopify.scopes, ['read_products', 'read_orders']);
  });

  it('rejects a scope name with invalid characters', () => {
    const result = validateEnv({ ...VALID, SHOPIFY_SCOPES: 'read products!' });

    assert.equal(result.config, null);
    assert.ok(result.errors.some((error) => error.includes('SHOPIFY_SCOPES')));
  });
});

describe('validateEnv - SHOPIFY_AUTH_MODE and TOKEN_ENCRYPTION_KEY', () => {
  const KEY_B64 = Buffer.alloc(32, 7).toString('base64');

  it('defaults to auto mode, preserving the existing strategy', () => {
    const result = validateEnv(VALID);

    assert.equal(result.config?.shopify.authMode, 'auto');
    assert.equal(result.config?.shopify.authStrategy, 'CLIENT_CREDENTIALS');
  });

  it('rejects an unknown auth mode', () => {
    const result = validateEnv({ ...VALID, SHOPIFY_AUTH_MODE: 'sometimes' });

    assert.equal(result.config, null);
    assert.ok(result.errors.some((error) => error.includes('SHOPIFY_AUTH_MODE')));
  });

  it('switches the strategy to OAUTH_OFFLINE in oauth mode', () => {
    const result = validateEnv({
      ...VALID,
      SHOPIFY_AUTH_MODE: 'oauth',
      APP_URL: 'https://app.example.com',
      TOKEN_ENCRYPTION_KEY: KEY_B64,
    });

    assert.deepEqual(result.errors, []);
    assert.equal(result.config?.shopify.authStrategy, 'OAUTH_OFFLINE');
  });

  it('requires an encryption key in oauth mode', () => {
    const result = validateEnv({
      ...VALID,
      SHOPIFY_AUTH_MODE: 'oauth',
      APP_URL: 'https://app.example.com',
    });

    assert.equal(result.config, null);
    assert.ok(result.errors.some((error) => error.includes('TOKEN_ENCRYPTION_KEY')));
  });

  it('requires APP_URL in oauth mode', () => {
    const result = validateEnv({
      ...VALID,
      SHOPIFY_AUTH_MODE: 'oauth',
      TOKEN_ENCRYPTION_KEY: KEY_B64,
    });

    assert.equal(result.config, null);
    assert.ok(result.errors.some((error) => error.includes('APP_URL')));
  });

  it('accepts a 32-byte key in hex as well as base64', () => {
    const result = validateEnv({
      ...VALID,
      TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('hex'),
    });

    assert.deepEqual(result.errors, []);
  });

  it('rejects a key that does not decode to 32 bytes', () => {
    const result = validateEnv({
      ...VALID,
      TOKEN_ENCRYPTION_KEY: Buffer.alloc(16, 1).toString('base64'),
    });

    assert.equal(result.config, null);
    assert.ok(result.errors.some((error) => error.includes('32 bytes')));
  });

  it('leaves the static token override in charge even in oauth mode', () => {
    // An explicit SHOPIFY_ACCESS_TOKEN is a deliberate debugging override and
    // must keep winning, exactly as it does in auto mode.
    const result = validateEnv({
      ...VALID,
      SHOPIFY_AUTH_MODE: 'oauth',
      APP_URL: 'https://app.example.com',
      TOKEN_ENCRYPTION_KEY: KEY_B64,
      SHOPIFY_ACCESS_TOKEN: 'shpat_example',
    });

    assert.equal(result.config?.shopify.authStrategy, 'STATIC_TOKEN');
  });
});


describe('validateEnv - webhook secret falls back to the client secret', () => {
  it('uses SHOPIFY_CLIENT_SECRET when SHOPIFY_WEBHOOK_SECRET is unset', () => {
    // Shopify signs app webhook deliveries with the client secret, so this is
    // the CORRECT default - not a convenience.
    const result = validateEnv(VALID);

    assert.equal(result.config?.shopify.webhookSecret, 'client-secret-example');
  });

  it('warns that the fallback is in use, so it is never silent', () => {
    const result = validateEnv(VALID);

    assert.ok(
      result.warnings.some((w) => w.includes('SHOPIFY_CLIENT_SECRET')),
      'expected a warning naming the fallback',
    );
  });

  it('prefers an explicit SHOPIFY_WEBHOOK_SECRET when given', () => {
    // Webhooks created by hand in the Shopify admin get their own secret.
    const result = validateEnv({
      ...VALID,
      SHOPIFY_WEBHOOK_SECRET: 'admin-ui-webhook-secret',
    });

    assert.equal(result.config?.shopify.webhookSecret, 'admin-ui-webhook-secret');
  });

  it('is null only when neither secret is available', () => {
    const { SHOPIFY_CLIENT_ID: _id, SHOPIFY_CLIENT_SECRET: _secret, ...rest } = VALID;
    const result = validateEnv(rest);

    assert.equal(result.config?.shopify.webhookSecret, null);
    assert.ok(result.warnings.some((w) => w.includes('reject all deliveries')));
  });
});


describe('validateEnv - operator authentication', () => {
  const HASH = 'scrypt$16384$8$1$c2FsdHNhbHQ=$aGFzaGhhc2hoYXNo';
  const SECRET = 'x'.repeat(48);

  it('defaults to no login configured, and warns rather than errors', () => {
    // Auth being unconfigured must not stop the server booting - the middleware
    // fails closed instead.
    const result = validateEnv(VALID);

    assert.deepEqual(result.errors, []);
    assert.equal(result.config?.operator.passwordHash, null);
    assert.equal(result.config?.operator.sessionSecret, null);
    assert.ok(result.warnings.some((w) => w.includes('management endpoints')));
  });

  it('defaults the operator username to "operator"', () => {
    assert.equal(validateEnv(VALID).config?.operator.username, 'operator');
  });

  it('accepts a password hash plus a session secret', () => {
    const result = validateEnv({
      ...VALID,
      OPERATOR_PASSWORD_HASH: HASH,
      SESSION_SECRET: SECRET,
    });

    assert.deepEqual(result.errors, []);
    assert.equal(result.config?.operator.passwordHash, HASH);
    assert.equal(result.config?.operator.sessionSecret, SECRET);
  });

  it('rejects a password hash with no session secret', () => {
    // Half a credential pair is always a mistake.
    const result = validateEnv({ ...VALID, OPERATOR_PASSWORD_HASH: HASH });

    assert.equal(result.config, null);
    assert.ok(result.errors.some((e) => e.includes('SESSION_SECRET')));
  });

  it('rejects a hash that is not scrypt', () => {
    const result = validateEnv({
      ...VALID,
      OPERATOR_PASSWORD_HASH: 'bcrypt$whatever',
      SESSION_SECRET: SECRET,
    });

    assert.equal(result.config, null);
    assert.ok(result.errors.some((e) => e.includes('scrypt')));
  });

  it('rejects a short session secret', () => {
    const result = validateEnv({
      ...VALID,
      OPERATOR_PASSWORD_HASH: HASH,
      SESSION_SECRET: 'too-short',
    });

    assert.equal(result.config, null);
    assert.ok(result.errors.some((e) => e.includes('SESSION_SECRET')));
  });

  it('rejects a short API key', () => {
    const result = validateEnv({ ...VALID, OPERATOR_API_KEY: 'short' });

    assert.equal(result.config, null);
    assert.ok(result.errors.some((e) => e.includes('OPERATOR_API_KEY')));
  });

  it('accepts an API key alone as a valid operator credential', () => {
    const result = validateEnv({ ...VALID, OPERATOR_API_KEY: 'k'.repeat(32) });

    assert.deepEqual(result.errors, []);
    assert.equal(result.config?.operator.apiKey, 'k'.repeat(32));
    // No "management endpoints locked" warning when a key is present.
    assert.ok(!result.warnings.some((w) => w.includes('management endpoints')));
  });

  it('refuses to protect reads when nobody can sign in', () => {
    // Otherwise the whole console locks with no way in.
    const result = validateEnv({ ...VALID, OPERATOR_PROTECT_READS: 'true' });

    assert.equal(result.config, null);
    assert.ok(result.errors.some((e) => e.includes('OPERATOR_PROTECT_READS')));
  });

  it('allows protected reads once a login exists', () => {
    const result = validateEnv({
      ...VALID,
      OPERATOR_PASSWORD_HASH: HASH,
      SESSION_SECRET: SECRET,
      OPERATOR_PROTECT_READS: 'true',
    });

    assert.deepEqual(result.errors, []);
    assert.equal(result.config?.operator.protectReads, true);
  });

  it('rejects a username containing the payload separator', () => {
    const result = validateEnv({ ...VALID, OPERATOR_USERNAME: 'bad:name' });

    assert.equal(result.config, null);
    assert.ok(result.errors.some((e) => e.includes('OPERATOR_USERNAME')));
  });

  it('validates SESSION_TTL_HOURS bounds', () => {
    assert.ok(
      validateEnv({ ...VALID, SESSION_TTL_HOURS: '0' }).errors.some((e) =>
        e.includes('SESSION_TTL_HOURS'),
      ),
    );
    assert.equal(
      validateEnv({ ...VALID, SESSION_TTL_HOURS: '24' }).config?.operator.sessionTtlMs,
      24 * 60 * 60 * 1000,
    );
  });

  it('derives secureCookies from production', () => {
    assert.equal(validateEnv(VALID).config?.operator.secureCookies, false);
    assert.equal(
      validateEnv({ ...VALID, NODE_ENV: 'production', MONGODB_URI: VALID.MONGODB_URI }).config
        ?.operator.secureCookies,
      true,
    );
  });
});
