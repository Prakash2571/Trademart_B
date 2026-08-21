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
  it('defaults to the scopes the dashboard actually reads', () => {
    const result = validateEnv(VALID);

    assert.deepEqual(result.config?.shopify.scopes, [
      'read_products',
      'read_orders',
      'read_customers',
      'read_inventory',
      // Needed to tell whether a product is really on the Online Store. Without
      // it, visibility could only be guessed from `status`, which is wrong in
      // both directions.
      'read_publications',
    ]);
  });

  it('does NOT request write_publications by default', () => {
    // Publishing changes what customers see, so it stays opt-in rather than
    // arriving silently with an app update.
    const result = validateEnv(VALID);

    assert.ok(!(result.config?.shopify.scopes ?? []).includes('write_publications'));
    assert.ok(
      result.warnings.some((w) => w.includes('write_publications')),
      'expected a warning that publishing is unavailable without the scope',
    );
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
      // FRONTEND_URL must be https in production - a Secure cookie is dropped by
      // the browser over plain http, so the two settings are not independent.
      validateEnv({ ...VALID, NODE_ENV: 'production', FRONTEND_URL: 'https://app.example.com' })
        .config?.operator.secureCookies,
      true,
    );
  });
});

describe('validateEnv - production hardening', () => {
  const PROD = {
    ...VALID,
    NODE_ENV: 'production',
    FRONTEND_URL: 'https://app.example.com',
  } as const;

  it('accepts a sound production configuration', () => {
    assert.deepEqual(validateEnv(PROD).errors, []);
  });

  it('rejects a non-https FRONTEND_URL in production', () => {
    const result = validateEnv({ ...PROD, FRONTEND_URL: 'http://app.example.com' });

    assert.ok(result.errors.some((e) => e.includes('FRONTEND_URL')));
    assert.equal(result.config, null);
  });

  it('rejects a wildcard CORS origin in production', () => {
    // credentials:true with a wildcard origin would expose the session cookie.
    assert.ok(
      validateEnv({ ...PROD, FRONTEND_URL: 'https://*.example.com' }).errors.some((e) =>
        e.includes('wildcard'),
      ),
    );
  });

  it('refuses AUTOMATION_ENABLED in production with no operator credentials', () => {
    // Otherwise /api/automation/apply is callable by anyone who finds the URL.
    const result = validateEnv({ ...PROD, AUTOMATION_ENABLED: 'true' });

    assert.ok(result.errors.some((e) => e.includes('AUTOMATION_ENABLED')));
  });

  it('rejects a placeholder SESSION_SECRET that is long enough to pass a length check', () => {
    const result = validateEnv({
      ...PROD,
      SESSION_SECRET: 'change-me-change-me-change-me-change-me',
      OPERATOR_PASSWORD_HASH: 'scrypt$16384$8$1$salt$hash',
    });

    assert.ok(result.errors.some((e) => e.includes('SESSION_SECRET')));
  });

  it('allows development to stay easy to run', () => {
    // The same values that are errors in production are not even warnings worth
    // blocking on locally.
    assert.deepEqual(validateEnv({ ...VALID, FRONTEND_URL: 'http://localhost:3000' }).errors, []);
  });
});

describe('validateEnv - store mode and live-store writes', () => {
  it('defaults SHOPIFY_STORE_MODE to production, so an undeclared store is assumed real', () => {
    assert.equal(validateEnv(VALID).config?.shopify.storeMode, 'production');
  });

  it('accepts an explicit development declaration', () => {
    assert.equal(
      validateEnv({ ...VALID, SHOPIFY_STORE_MODE: 'development' }).config?.shopify.storeMode,
      'development',
    );
  });

  it('rejects an unknown store mode rather than falling back', () => {
    assert.ok(
      validateEnv({ ...VALID, SHOPIFY_STORE_MODE: 'staging' }).errors.some((e) =>
        e.includes('SHOPIFY_STORE_MODE'),
      ),
    );
  });

  it('defaults ALLOW_LIVE_STORE_WRITES to false', () => {
    assert.equal(validateEnv(VALID).config?.allowLiveStoreWrites, false);
  });

  it('warns loudly when live-store writes are acknowledged', () => {
    const result = validateEnv({ ...VALID, ALLOW_LIVE_STORE_WRITES: 'true' });

    assert.equal(result.config?.allowLiveStoreWrites, true);
    assert.ok(result.warnings.some((w) => w.includes('ALLOW_LIVE_STORE_WRITES')));
  });

  it('rejects a non-boolean ALLOW_LIVE_STORE_WRITES instead of treating it as falsy', () => {
    // A typo silently disabling a guard is confusing; silently enabling it would
    // be dangerous. Either way it must be an error.
    assert.ok(
      validateEnv({ ...VALID, ALLOW_LIVE_STORE_WRITES: 'yes' }).errors.some((e) =>
        e.includes('ALLOW_LIVE_STORE_WRITES'),
      ),
    );
  });

  it('validates the Online Store publication pin', () => {
    assert.ok(
      validateEnv({ ...VALID, SHOPIFY_ONLINE_STORE_PUBLICATION_ID: '12345' }).errors.length > 0,
    );
    assert.equal(
      validateEnv({
        ...VALID,
        SHOPIFY_ONLINE_STORE_PUBLICATION_ID: 'gid://shopify/Publication/123',
      }).config?.shopify.onlineStorePublicationId,
      'gid://shopify/Publication/123',
    );
  });
});

describe('validateEnv - inventory and retention', () => {
  it('defaults MAX_INVENTORY_DELTA to 500', () => {
    assert.equal(validateEnv(VALID).config?.maxInventoryDelta, 500);
  });

  it('rejects a non-numeric MAX_INVENTORY_DELTA', () => {
    assert.ok(validateEnv({ ...VALID, MAX_INVENTORY_DELTA: 'lots' }).errors.length > 0);
  });

  it('applies retention defaults', () => {
    const retention = validateEnv(VALID).config?.retention;

    assert.equal(retention?.webhookEventDays, 45);
    assert.equal(retention?.idempotencyKeyHours, 48);
    assert.equal(retention?.auditLogDays, 730);
    assert.equal(retention?.previewMinutes, 15);
  });

  it('rejects a retention value outside its bounds', () => {
    // Audit retention below 30 days would defeat the point of the audit trail.
    assert.ok(validateEnv({ ...VALID, RETENTION_AUDIT_DAYS: '5' }).errors.length > 0);
  });
});
