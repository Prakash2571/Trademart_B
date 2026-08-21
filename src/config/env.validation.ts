/**
 * Environment validation.
 *
 * Pure and import-free on purpose: it takes a plain record instead of reading
 * `process.env` directly, which makes it directly unit testable.
 *
 * Philosophy for this MVP:
 *  - Anything structurally wrong (bad port, admin.shopify.com domain, bad API
 *    version) is a hard error - it would fail confusingly later.
 *  - Missing-but-optional credentials (Mongo URI, Shopify token, webhook
 *    secret) are warnings in development so the server still boots and can
 *    report its own degraded state. In production they are errors.
 */

export type NodeEnv = 'development' | 'test' | 'production';

/**
 * How the backend obtains an Admin API access token.
 *  CLIENT_CREDENTIALS - exchange client id/secret automatically (preferred)
 *  STATIC_TOKEN       - a pre-issued token supplied via SHOPIFY_ACCESS_TOKEN
 *  NONE               - no credentials; Shopify routes report not configured
 */
export type ShopifyAuthStrategy =
  | 'CLIENT_CREDENTIALS'
  | 'STATIC_TOKEN'
  | 'OAUTH_OFFLINE'
  | 'NONE';

/**
 * Which token source the backend prefers.
 *
 *   auto  - the historical behaviour: static token, else client credentials.
 *   oauth - prefer a per-merchant offline token captured by the redirect flow,
 *           falling back to client credentials when no store has installed yet.
 *
 * This exists so adding OAuth cannot silently change how an already-working
 * single-store deployment authenticates. `auto` is the default.
 */
export type ShopifyAuthMode = 'auto' | 'oauth';

/**
 * What KIND of store this deployment points at.
 *
 * This is an operator declaration, and it is deliberately NOT trusted on its
 * own - `shopify/storeMode.ts` compares it against Shopify's own
 * `shop.plan.partnerDevelopment` and treats a mismatch as a live store. The
 * declared value only decides what happens when Shopify cannot be reached to
 * confirm, and it defaults to `production` so an unverifiable store is treated
 * as real.
 */
export type ShopifyStoreMode = 'development' | 'production';

export interface ShopifyConfig {
  storeDomain: string;
  apiVersion: string;
  accessToken: string | null;
  clientId: string | null;
  clientSecret: string | null;
  webhookSecret: string | null;
  authStrategy: ShopifyAuthStrategy;
  authMode: ShopifyAuthMode;
  /** Scopes requested by the OAuth redirect flow, in Shopify's comma form. */
  scopes: string[];
  /** Fully-qualified GraphQL Admin API endpoint. */
  graphqlEndpoint: string;
  /** Endpoint used by the client credentials grant AND the OAuth code exchange. */
  tokenEndpoint: string;
  /**
   * The exact value to paste into "Allowed redirection URL(s)" in the Shopify
   * Dev Dashboard. Derived here so no caller has to rebuild it and get it wrong
   * - Shopify compares this string exactly.
   */
  oauthRedirectUri: string | null;
  /** Where webhook deliveries should be sent. Null until APP_URL is set. */
  webhookCallbackUrl: string | null;
  /** Operator's declaration of the store kind. Verified against Shopify, never trusted alone. */
  storeMode: ShopifyStoreMode;
  /**
   * Optional pin for the Online Store publication GID.
   *
   * Normally resolved from Shopify and cached. Setting it explicitly removes a
   * lookup and is useful when a shop has several publications with confusing
   * names.
   */
  onlineStorePublicationId: string | null;
}

export interface AppConfig {
  nodeEnv: NodeEnv;
  isProduction: boolean;
  port: number;
  frontendUrl: string;
  /**
   * Public HTTPS origin of THIS backend, as reachable by Shopify. Distinct from
   * frontendUrl (the browser app). Null when unset, which disables OAuth and
   * webhook registration rather than guessing a URL Shopify cannot reach.
   */
  appUrl: string | null;
  mongoUri: string | null;
  /** AES-256-GCM key for encrypting offline tokens at rest. */
  tokenEncryptionKey: string | null;
  /**
   * Master kill switch for storefront writes (prices and visibility).
   *
   * Defaults to FALSE. Preview endpoints always work; nothing can mutate the
   * shop until this is deliberately turned on, so deploying automation cannot
   * change a live storefront by accident.
   */
  automationEnabled: boolean;
  /**
   * Whether webhook deliveries trigger automation runs automatically.
   *
   * Separate from `automationEnabled` on purpose: "Trademart may write" and
   * "Trademart writes without me asking" are different levels of trust, and a
   * merchant may reasonably want the first without the second.
   */
  automationOnWebhook: boolean;
  /**
   * Explicit acknowledgement that automated tooling may write to a store that is
   * NOT a Shopify development store.
   *
   * Defaults to FALSE. Normal merchant actions through the signed-in console are
   * unaffected; this gates the things that mutate a store without a human
   * deciding to - smoke tests, seed scripts, dev utilities. The default means a
   * test run pointed at a real shop fails loudly instead of editing it.
   */
  allowLiveStoreWrites: boolean;
  /**
   * Largest absolute inventory change a normal write may make without the caller
   * setting `confirmLargeChange: true`. Enforced server-side; a frontend
   * confirmation dialog is not a control.
   */
  maxInventoryDelta: number;
  retention: RetentionConfig;
  operator: OperatorConfig;
  shopify: ShopifyConfig;
}

/**
 * How long each class of operational data is kept.
 *
 * Expressed here rather than hard-coded in the models so the policy is visible
 * in one place and reviewable against docs/DATA_RETENTION.md.
 */
export interface RetentionConfig {
  /** Webhook delivery records, including payloads. */
  webhookEventDays: number;
  /** Idempotency keys. Long enough to cover a client retry storm, no longer. */
  idempotencyKeyHours: number;
  /**
   * Operator audit entries. Longest retention by design: "who changed this
   * price" must still be answerable months later.
   */
  auditLogDays: number;
  /** Automation preview tokens. Short: a stale preview must not be appliable. */
  previewMinutes: number;
}

export interface OperatorConfig {
  username: string;
  /** scrypt$N$r$p$salt$hash. Null when no password login is configured. */
  passwordHash: string | null;
  /** HMAC key for session cookies. Null disables cookie sessions entirely. */
  sessionSecret: string | null;
  /**
   * Pre-shared key for non-browser clients (curl, cron). Null disables it.
   * Exempt from CSRF because a browser never attaches it automatically.
   */
  apiKey: string | null;
  sessionTtlMs: number;
  /**
   * When true, READ endpoints also require a signed-in operator.
   *
   * Defaults to false so enabling auth cannot black out an existing dashboard
   * before its login screen is deployed. Mutations are ALWAYS protected
   * regardless of this setting.
   */
  protectReads: boolean;
  /**
   * Whether to mark cookies Secure. Derived from NODE_ENV: a Secure cookie is
   * dropped by the browser over plain http, which would make local development
   * impossible to sign in to.
   */
  secureCookies: boolean;
}

export interface EnvValidationResult {
  /** Present only when `errors` is empty. */
  config: AppConfig | null;
  errors: string[];
  warnings: string[];
}

export const DEFAULT_PORT = 4000;
export const DEFAULT_FRONTEND_URL = 'http://localhost:3000';
export const DEFAULT_SHOPIFY_API_VERSION = '2026-07';

/**
 * Scopes requested by the OAuth redirect flow when SHOPIFY_SCOPES is unset.
 *
 * Deliberately the minimum Trademart actually reads. `read_customers` is
 * included because the dashboard's customer count uses `customersCount`, which
 * fails outright without it.
 */
export const DEFAULT_SHOPIFY_SCOPES = [
  'read_products',
  'read_orders',
  'read_customers',
  'read_inventory',
  // Needed to READ publication state. Without it Trademart cannot tell whether a
  // product is actually on the Online Store, and would be reduced to inferring
  // visibility from `status` - which is exactly the bug this app must not have.
  // Reading is harmless; PUBLISHING additionally needs write_publications, which
  // is deliberately NOT requested by default.
  'read_publications',
] as const;

/** Scope required to publish/unpublish. Opt-in: it changes what customers see. */
export const PUBLICATION_WRITE_SCOPE = 'write_publications';

/** Path of the OAuth callback. Kept as a constant so config and docs agree. */
export const OAUTH_CALLBACK_PATH = '/api/auth/callback';
/** Path of the webhook receiver, matching webhooks.controller.ts. */
export const WEBHOOK_RECEIVER_PATH = '/api/webhooks/shopify';

const NODE_ENVS: readonly NodeEnv[] = ['development', 'test', 'production'];
const AUTH_MODES: readonly ShopifyAuthMode[] = ['auto', 'oauth'];
const STORE_MODES: readonly ShopifyStoreMode[] = ['development', 'production'];
export const MYSHOPIFY_DOMAIN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;
const API_VERSION = /^\d{4}-\d{2}$/;
/** Shopify scope names are lowercase snake_case, e.g. read_products. */
const SCOPE_NAME = /^[a-z][a-z0-9_]*$/;

type RawEnv = Record<string, string | undefined>;

function read(env: RawEnv, key: string): string | null {
  const value = env[key];
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Strict boolean parsing: only "true"/"false" are accepted.
 *
 * Anything else is an error rather than a falsy default, because the values this
 * is used for are safety switches. `ALLOW_LIVE_STORE_WRITES=yes` silently
 * meaning "no" is confusing; silently meaning "yes" would be dangerous.
 */
function readBoolean(
  env: RawEnv,
  key: string,
  fallback: boolean,
  errors: string[],
): boolean {
  const raw = read(env, key);
  if (raw === null) return fallback;
  const normalised = raw.toLowerCase();
  if (normalised === 'true') return true;
  if (normalised === 'false') return false;
  errors.push(`${key} must be "true" or "false" (received "${raw}").`);
  return fallback;
}

/** Bounded integer parsing with a default. */
function readInt(
  env: RawEnv,
  key: string,
  options: { min: number; max: number; fallback: number },
  errors: string[],
): number {
  const raw = read(env, key);
  if (raw === null) return options.fallback;
  if (!/^\d+$/.test(raw)) {
    errors.push(`${key} must be a non-negative integer (received "${raw}").`);
    return options.fallback;
  }
  const parsed = Number(raw);
  if (parsed < options.min || parsed > options.max) {
    errors.push(`${key} must be between ${options.min} and ${options.max}.`);
    return options.fallback;
  }
  return parsed;
}

/**
 * Byte length of a hex or base64 encoded key, or -1 when it is neither.
 *
 * Buffer.from(..., 'base64') silently discards invalid characters, so the
 * encoding is confirmed by pattern first - otherwise "not-a-real-key" would
 * decode to some incidental number of bytes and could pass a length check.
 */
export function decodeKeyLength(value: string): number {
  if (/^[0-9a-fA-F]+$/.test(value) && value.length % 2 === 0) {
    return value.length / 2;
  }
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    return Buffer.from(value, 'base64').length;
  }
  return -1;
}

export function validateEnv(env: RawEnv): EnvValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // ---- NODE_ENV ----------------------------------------------------------
  const rawNodeEnv = read(env, 'NODE_ENV');
  let nodeEnv: NodeEnv = 'development';
  if (rawNodeEnv !== null) {
    if ((NODE_ENVS as readonly string[]).includes(rawNodeEnv)) {
      nodeEnv = rawNodeEnv as NodeEnv;
    } else {
      errors.push(
        `NODE_ENV must be one of ${NODE_ENVS.join(', ')} (received "${rawNodeEnv}").`,
      );
    }
  }
  const isProduction = nodeEnv === 'production';

  // ---- PORT --------------------------------------------------------------
  const rawPort = read(env, 'PORT');
  let port = DEFAULT_PORT;
  if (rawPort !== null) {
    if (!/^\d+$/.test(rawPort)) {
      errors.push(`PORT must be an integer (received "${rawPort}").`);
    } else {
      const parsed = Number(rawPort);
      if (parsed < 1 || parsed > 65535) {
        errors.push(`PORT must be between 1 and 65535 (received ${parsed}).`);
      } else {
        port = parsed;
      }
    }
  }

  // ---- FRONTEND_URL ------------------------------------------------------
  const rawFrontend = read(env, 'FRONTEND_URL');
  let frontendUrl = DEFAULT_FRONTEND_URL;
  if (rawFrontend !== null) {
    if (!/^https?:\/\/.+/.test(rawFrontend)) {
      errors.push(
        `FRONTEND_URL must start with http:// or https:// (received "${rawFrontend}").`,
      );
    } else {
      frontendUrl = rawFrontend.replace(/\/+$/, '');
    }
  } else {
    warnings.push(
      `FRONTEND_URL not set - defaulting CORS origin to ${DEFAULT_FRONTEND_URL}.`,
    );
  }

  // ---- APP_URL -----------------------------------------------------------
  //
  // The backend's own public origin. Shopify has to be able to reach it, which
  // is why localhost is called out explicitly: a tunnel is required locally.
  const rawAppUrl = read(env, 'APP_URL');
  let appUrl: string | null = null;
  if (rawAppUrl !== null) {
    if (!/^https?:\/\/.+/.test(rawAppUrl)) {
      errors.push(
        `APP_URL must start with http:// or https:// (received "${rawAppUrl}").`,
      );
    } else if (isProduction && !rawAppUrl.startsWith('https://')) {
      // Shopify refuses non-HTTPS redirect URIs, and an OAuth code over plain
      // HTTP is interceptable.
      errors.push('APP_URL must use https:// when NODE_ENV=production.');
    } else {
      appUrl = rawAppUrl.replace(/\/+$/, '');
      if (/^https?:\/\/(localhost|127\.0\.0\.1)/.test(appUrl)) {
        warnings.push(
          `APP_URL points at ${appUrl}, which Shopify cannot reach. OAuth callbacks and webhook deliveries will not arrive - use a public tunnel URL for local testing.`,
        );
      }
    }
  } else {
    warnings.push(
      'APP_URL not set - the OAuth redirect flow and webhook registration are disabled. Set it to this backend\'s public https origin to enable them.',
    );
  }

  // ---- MONGODB_URI -------------------------------------------------------
  const mongoUri = read(env, 'MONGODB_URI');
  if (mongoUri === null) {
    const message =
      'MONGODB_URI not set - persistence is disabled (Shopify reads and pricing still work).';
    if (isProduction) errors.push('MONGODB_URI is required when NODE_ENV=production.');
    else warnings.push(message);
  } else if (!/^mongodb(\+srv)?:\/\//.test(mongoUri)) {
    errors.push('MONGODB_URI must start with mongodb:// or mongodb+srv://.');
  }

  // ---- SHOPIFY_STORE_DOMAIN ---------------------------------------------
  const rawDomain = read(env, 'SHOPIFY_STORE_DOMAIN');
  let storeDomain = '';
  if (rawDomain === null) {
    errors.push('SHOPIFY_STORE_DOMAIN is required (e.g. your-store.myshopify.com).');
  } else {
    const normalised = rawDomain
      .replace(/^https?:\/\//, '')
      .replace(/\/.*$/, '')
      .toLowerCase();
    if (normalised.startsWith('admin.shopify.com')) {
      errors.push(
        'SHOPIFY_STORE_DOMAIN must be the .myshopify.com domain, not the admin.shopify.com URL.',
      );
    } else if (!MYSHOPIFY_DOMAIN.test(normalised)) {
      errors.push(
        `SHOPIFY_STORE_DOMAIN must look like your-store.myshopify.com (received "${rawDomain}").`,
      );
    } else {
      storeDomain = normalised;
    }
  }

  // ---- SHOPIFY_API_VERSION ----------------------------------------------
  const rawApiVersion = read(env, 'SHOPIFY_API_VERSION');
  let apiVersion = DEFAULT_SHOPIFY_API_VERSION;
  if (rawApiVersion !== null) {
    if (!API_VERSION.test(rawApiVersion)) {
      errors.push(
        `SHOPIFY_API_VERSION must look like YYYY-MM (received "${rawApiVersion}").`,
      );
    } else {
      apiVersion = rawApiVersion;
    }
  }

  // ---- Credentials -------------------------------------------------------
  //
  // Client credentials is the primary path: the app exchanges its own id and
  // secret for a short-lived token automatically, so nothing is pasted by hand.
  // SHOPIFY_ACCESS_TOKEN remains an explicit override for pre-issued tokens.
  const clientId = read(env, 'SHOPIFY_CLIENT_ID');
  const clientSecret = read(env, 'SHOPIFY_CLIENT_SECRET');
  const accessToken = read(env, 'SHOPIFY_ACCESS_TOKEN');

  const hasClientCredentials = clientId !== null && clientSecret !== null;

  // Half-configured credentials are always a mistake, never a deliberate state.
  if (clientId !== null && clientSecret === null) {
    errors.push('SHOPIFY_CLIENT_SECRET is required when SHOPIFY_CLIENT_ID is set.');
  }
  if (clientSecret !== null && clientId === null) {
    errors.push('SHOPIFY_CLIENT_ID is required when SHOPIFY_CLIENT_SECRET is set.');
  }

  let authStrategy: ShopifyAuthStrategy = 'NONE';
  if (accessToken !== null) {
    authStrategy = 'STATIC_TOKEN';
    if (hasClientCredentials) {
      warnings.push(
        'Both SHOPIFY_ACCESS_TOKEN and client credentials are set - the static token takes precedence. Unset SHOPIFY_ACCESS_TOKEN to use automatic token refresh.',
      );
    } else {
      warnings.push(
        'Using the SHOPIFY_ACCESS_TOKEN override. Prefer SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET so tokens refresh automatically.',
      );
    }
  } else if (hasClientCredentials) {
    authStrategy = 'CLIENT_CREDENTIALS';
  } else {
    const message =
      'No Shopify credentials set - Shopify endpoints will return SHOPIFY_NOT_CONFIGURED. Set SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET.';
    if (isProduction) {
      errors.push(
        'Shopify authentication is required when NODE_ENV=production: set SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET.',
      );
    } else {
      warnings.push(message);
    }
  }

  // ---- SHOPIFY_WEBHOOK_SECRET -------------------------------------------
  //
  // Shopify signs APP webhook deliveries with the app's CLIENT SECRET - there is
  // no separate "webhook secret" to find for subscriptions created through the
  // Admin API or app config:
  // https://shopify.dev/docs/apps/build/webhooks/ignore-duplicates
  //
  // So an unset SHOPIFY_WEBHOOK_SECRET falls back to the client secret instead of
  // rejecting every delivery. Without this the default configuration silently
  // fails HMAC verification and sends people hunting for a value that does not
  // exist for their setup.
  //
  // The explicit variable is still honoured, because webhooks created by hand in
  // the Shopify admin (Settings -> Notifications) DO get their own secret.
  const explicitWebhookSecret = read(env, 'SHOPIFY_WEBHOOK_SECRET');
  const webhookSecret = explicitWebhookSecret ?? clientSecret;
  if (explicitWebhookSecret === null && clientSecret === null) {
    warnings.push(
      'Neither SHOPIFY_WEBHOOK_SECRET nor SHOPIFY_CLIENT_SECRET is set - webhook routes will reject all deliveries.',
    );
  } else if (explicitWebhookSecret === null) {
    warnings.push(
      'SHOPIFY_WEBHOOK_SECRET not set - verifying webhooks with SHOPIFY_CLIENT_SECRET, which is what Shopify signs app webhook deliveries with. Set it explicitly only for webhooks created by hand in the Shopify admin.',
    );
  }

  // ---- SHOPIFY_SCOPES ----------------------------------------------------
  //
  // Only used by the OAuth redirect flow. Under Shopify-managed installation the
  // scopes come from shopify.app.toml instead, so a mismatch between the two is
  // worth warning about but cannot be detected from here.
  const rawScopes = read(env, 'SHOPIFY_SCOPES');
  let scopes: string[] = [...DEFAULT_SHOPIFY_SCOPES];
  if (rawScopes !== null) {
    const parsed = rawScopes
      .split(/[,\s]+/)
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0);
    const invalid = parsed.filter((entry) => !SCOPE_NAME.test(entry));
    if (invalid.length > 0) {
      errors.push(
        `SHOPIFY_SCOPES contains invalid scope name(s): ${invalid.join(', ')}. Use a comma-separated list like read_products,read_orders.`,
      );
    } else if (parsed.length === 0) {
      errors.push('SHOPIFY_SCOPES was set but contained no scopes.');
    } else {
      // De-duplicate: Shopify rejects a repeated scope in the authorize URL.
      scopes = [...new Set(parsed)];
    }
  }

  // ---- SHOPIFY_AUTH_MODE -------------------------------------------------
  const rawAuthMode = read(env, 'SHOPIFY_AUTH_MODE');
  let authMode: ShopifyAuthMode = 'auto';
  if (rawAuthMode !== null) {
    const normalised = rawAuthMode.toLowerCase();
    if ((AUTH_MODES as readonly string[]).includes(normalised)) {
      authMode = normalised as ShopifyAuthMode;
    } else {
      errors.push(
        `SHOPIFY_AUTH_MODE must be one of ${AUTH_MODES.join(', ')} (received "${rawAuthMode}").`,
      );
    }
  }

  // In oauth mode the effective strategy is OAUTH_OFFLINE, not client
  // credentials - even though the client id/secret are still required, because
  // they are what performs the handshake and signs the callback.
  if (authMode === 'oauth' && accessToken === null) {
    if (!hasClientCredentials) {
      errors.push(
        'SHOPIFY_AUTH_MODE=oauth requires SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET to run the handshake.',
      );
    }
    if (appUrl === null) {
      errors.push(
        'SHOPIFY_AUTH_MODE=oauth requires APP_URL, which forms the redirect_uri Shopify calls back.',
      );
    }
    authStrategy = 'OAUTH_OFFLINE';
  }

  // ---- TOKEN_ENCRYPTION_KEY ---------------------------------------------
  //
  // Required only by the OAuth flow, which must never write a token to Mongo in
  // plaintext. Validated as 32 bytes of base64 or hex so a too-short key fails
  // at boot instead of at the first install.
  const tokenEncryptionKey = read(env, 'TOKEN_ENCRYPTION_KEY');
  if (tokenEncryptionKey !== null && decodeKeyLength(tokenEncryptionKey) !== 32) {
    errors.push(
      'TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes. Generate one with: openssl rand -base64 32',
    );
  }
  if (authMode === 'oauth' && tokenEncryptionKey === null) {
    errors.push(
      'TOKEN_ENCRYPTION_KEY is required when SHOPIFY_AUTH_MODE=oauth, because offline access tokens must be encrypted at rest.',
    );
  }

  // ---- AUTOMATION_ENABLED ------------------------------------------------
  //
  // Off unless explicitly "true". Any other value is rejected rather than
  // treated as falsy: a typo like AUTOMATION_ENABLED=yes silently disabling
  // writes is confusing, and silently ENABLING them would be dangerous.
  const rawAutomation = read(env, 'AUTOMATION_ENABLED');
  let automationEnabled = false;
  if (rawAutomation !== null) {
    const normalised = rawAutomation.toLowerCase();
    if (normalised === 'true') automationEnabled = true;
    else if (normalised === 'false') automationEnabled = false;
    else {
      errors.push(
        `AUTOMATION_ENABLED must be "true" or "false" (received "${rawAutomation}").`,
      );
    }
  }
  // ---- AUTOMATION_ON_WEBHOOK ---------------------------------------------
  const rawOnWebhook = read(env, 'AUTOMATION_ON_WEBHOOK');
  let automationOnWebhook = false;
  if (rawOnWebhook !== null) {
    const normalised = rawOnWebhook.toLowerCase();
    if (normalised === 'true') automationOnWebhook = true;
    else if (normalised === 'false') automationOnWebhook = false;
    else {
      errors.push(
        `AUTOMATION_ON_WEBHOOK must be "true" or "false" (received "${rawOnWebhook}").`,
      );
    }
  }
  if (automationOnWebhook && !automationEnabled) {
    // Not an error - the triggers simply stay dormant - but silently doing
    // nothing would look like a bug.
    warnings.push(
      'AUTOMATION_ON_WEBHOOK=true but AUTOMATION_ENABLED is false, so webhook-triggered runs will be skipped. Enable both for hands-off syncing.',
    );
  }
  if (automationOnWebhook && webhookSecret === null) {
    warnings.push(
      'AUTOMATION_ON_WEBHOOK=true but SHOPIFY_WEBHOOK_SECRET is not set, so every delivery is rejected and nothing will ever trigger.',
    );
  }

  if (automationEnabled) {
    // Writing prices/status needs write_products. Warn rather than error: the
    // scopes may come from shopify.app.toml under managed installation, which
    // this validator cannot see.
    if (!scopes.includes('write_products')) {
      warnings.push(
        'AUTOMATION_ENABLED=true but SHOPIFY_SCOPES does not include write_products - price and visibility writes will fail with SHOPIFY_SCOPE_MISSING.',
      );
    }
    warnings.push(
      'AUTOMATION_ENABLED=true - Trademart may change product prices and visibility in the live store. Use POST /api/automation/preview first.',
    );
  }

  // Publication is a separate capability from product writes: write_products can
  // set a product ACTIVE, but only write_publications puts it on the Online
  // Store. Warned (not errored) because managed installation supplies scopes from
  // shopify.app.toml, which this validator cannot see.
  if (!scopes.includes('read_publications')) {
    warnings.push(
      'SHOPIFY_SCOPES does not include read_publications - Trademart cannot verify whether a product is actually published to the Online Store, so publication state will be reported as unknown rather than guessed from status.',
    );
  }
  if (!scopes.includes(PUBLICATION_WRITE_SCOPE)) {
    warnings.push(
      `SHOPIFY_SCOPES does not include ${PUBLICATION_WRITE_SCOPE} - publishing and unpublishing will fail with SHOPIFY_SCOPE_MISSING. Products can still be created and edited; they will simply stay off the Online Store. Add it when you want Trademart to publish.`,
    );
  }

  // ---- SHOPIFY_STORE_MODE ------------------------------------------------
  //
  // Declares whether this deployment points at a development store or a real
  // one. Defaults to `production`: an undeclared store must be assumed real, so
  // that forgetting to set anything is the SAFE outcome rather than the unsafe
  // one.
  //
  // This value is never trusted on its own - shopify/storeMode.ts checks it
  // against Shopify's shop.plan.partnerDevelopment and reports a disagreement.
  const rawStoreMode = read(env, 'SHOPIFY_STORE_MODE');
  let storeMode: ShopifyStoreMode = 'production';
  if (rawStoreMode !== null) {
    const normalised = rawStoreMode.toLowerCase();
    if ((STORE_MODES as readonly string[]).includes(normalised)) {
      storeMode = normalised as ShopifyStoreMode;
    } else {
      errors.push(
        `SHOPIFY_STORE_MODE must be one of ${STORE_MODES.join(', ')} (received "${rawStoreMode}").`,
      );
    }
  }

  // ---- ALLOW_LIVE_STORE_WRITES -------------------------------------------
  const allowLiveStoreWrites = readBoolean(env, 'ALLOW_LIVE_STORE_WRITES', false, errors);
  if (allowLiveStoreWrites) {
    warnings.push(
      'ALLOW_LIVE_STORE_WRITES=true - automated tooling (tests, seed and dev scripts) is permitted to mutate a NON-development store. Unset this outside a deliberate, supervised operation.',
    );
  }
  if (storeMode === 'development' && isProduction) {
    // Not an error: a staging deployment legitimately runs NODE_ENV=production
    // against a development store. But it is worth saying out loud.
    warnings.push(
      'SHOPIFY_STORE_MODE=development with NODE_ENV=production - treating this as a staging deployment against a Shopify development store.',
    );
  }

  // ---- SHOPIFY_ONLINE_STORE_PUBLICATION_ID -------------------------------
  const onlineStorePublicationId = read(env, 'SHOPIFY_ONLINE_STORE_PUBLICATION_ID');
  if (
    onlineStorePublicationId !== null &&
    !onlineStorePublicationId.startsWith('gid://shopify/Publication/')
  ) {
    errors.push(
      'SHOPIFY_ONLINE_STORE_PUBLICATION_ID must be a gid://shopify/Publication/... value. Leave it unset to let Trademart discover it.',
    );
  }

  // ---- MAX_INVENTORY_DELTA -----------------------------------------------
  //
  // A server-side cap on how far a single stock write may move. The frontend also
  // confirms large changes, but a browser dialog is not a control - anything that
  // can be bypassed with curl has to be enforced here too.
  const maxInventoryDelta = readInt(
    env,
    'MAX_INVENTORY_DELTA',
    { min: 1, max: 1_000_000, fallback: 500 },
    errors,
  );

  // ---- Retention ---------------------------------------------------------
  const retention: RetentionConfig = {
    webhookEventDays: readInt(
      env,
      'RETENTION_WEBHOOK_EVENT_DAYS',
      { min: 1, max: 365, fallback: 45 },
      errors,
    ),
    idempotencyKeyHours: readInt(
      env,
      'RETENTION_IDEMPOTENCY_HOURS',
      { min: 1, max: 720, fallback: 48 },
      errors,
    ),
    auditLogDays: readInt(
      env,
      'RETENTION_AUDIT_DAYS',
      { min: 30, max: 3650, fallback: 730 },
      errors,
    ),
    previewMinutes: readInt(
      env,
      'AUTOMATION_PREVIEW_TTL_MINUTES',
      { min: 1, max: 120, fallback: 15 },
      errors,
    ),
  };

  // ---- Operator authentication -------------------------------------------
  //
  // Protects every endpoint that can change the Shopify store. CORS is not
  // authentication: it is a browser-enforced policy that does nothing about a
  // direct request, so without this layer /api/automation/apply is callable by
  // anyone who knows the URL.
  const operatorUsername = read(env, 'OPERATOR_USERNAME') ?? 'operator';
  if (operatorUsername.includes(':')) {
    // ':' is the session payload separator.
    errors.push('OPERATOR_USERNAME must not contain a colon.');
  }

  const operatorPasswordHash = read(env, 'OPERATOR_PASSWORD_HASH');
  if (operatorPasswordHash !== null && !operatorPasswordHash.startsWith('scrypt$')) {
    errors.push(
      'OPERATOR_PASSWORD_HASH must be a scrypt hash of the form scrypt$N$r$p$salt$hash. Generate one with: npm run operator:hash',
    );
  }

  const sessionSecret = read(env, 'SESSION_SECRET');
  // 32 chars is the shortest value that is unreasonable to brute force; a short
  // secret here forges sessions, so it is an error rather than a warning.
  if (sessionSecret !== null && sessionSecret.length < 32) {
    errors.push(
      'SESSION_SECRET must be at least 32 characters. Generate one with: openssl rand -base64 48',
    );
  }

  const operatorApiKey = read(env, 'OPERATOR_API_KEY');
  if (operatorApiKey !== null && operatorApiKey.length < 24) {
    errors.push(
      'OPERATOR_API_KEY must be at least 24 characters. Generate one with: openssl rand -base64 32',
    );
  }

  const rawTtlHours = read(env, 'SESSION_TTL_HOURS');
  let sessionTtlHours = 12;
  if (rawTtlHours !== null) {
    if (!/^\d+$/.test(rawTtlHours)) {
      errors.push(`SESSION_TTL_HOURS must be an integer (received "${rawTtlHours}").`);
    } else {
      const parsed = Number(rawTtlHours);
      if (parsed < 1 || parsed > 720) {
        errors.push('SESSION_TTL_HOURS must be between 1 and 720.');
      } else {
        sessionTtlHours = parsed;
      }
    }
  }

  const rawProtectReads = read(env, 'OPERATOR_PROTECT_READS');
  let protectReads = false;
  if (rawProtectReads !== null) {
    const normalised = rawProtectReads.toLowerCase();
    if (normalised === 'true') protectReads = true;
    else if (normalised === 'false') protectReads = false;
    else {
      errors.push(
        `OPERATOR_PROTECT_READS must be "true" or "false" (received "${rawProtectReads}").`,
      );
    }
  }

  // A usable login needs BOTH a password hash and a session secret. Half of the
  // pair is always a mistake, never a deliberate state.
  const hasPasswordLogin = operatorPasswordHash !== null && sessionSecret !== null;
  if (operatorPasswordHash !== null && sessionSecret === null) {
    errors.push('SESSION_SECRET is required when OPERATOR_PASSWORD_HASH is set.');
  }
  if (sessionSecret !== null && operatorPasswordHash === null && operatorApiKey === null) {
    warnings.push(
      'SESSION_SECRET is set but OPERATOR_PASSWORD_HASH is not, so nobody can sign in. Generate a hash with: npm run operator:hash',
    );
  }

  if (!hasPasswordLogin && operatorApiKey === null) {
    // Fail CLOSED: with no credentials the middleware denies every mutation.
    // Loud, because the alternative reading - "auth is off, so writes are open" -
    // would be a serious hole.
    const message =
      'No operator credentials configured (OPERATOR_PASSWORD_HASH + SESSION_SECRET, or OPERATOR_API_KEY). All management endpoints - automation apply/approve/rules and webhook registration - will refuse with UNAUTHORIZED.';
    if (isProduction) warnings.push(`${message} Set them before using the console.`);
    else warnings.push(message);
  }
  if (protectReads && !hasPasswordLogin && operatorApiKey === null) {
    errors.push(
      'OPERATOR_PROTECT_READS=true would lock every endpoint with no way to sign in. Configure OPERATOR_PASSWORD_HASH + SESSION_SECRET first.',
    );
  }

  // ---- Production hardening ----------------------------------------------
  //
  // Configurations that are merely awkward in development but genuinely unsafe
  // in production. These are ERRORS there and silent (or warnings) elsewhere, so
  // a local machine stays easy to run while a real deployment cannot boot into a
  // state nobody intended.
  if (isProduction) {
    // A wildcard origin with credentials:true is forbidden by the CORS spec and
    // would, if a browser honoured it, expose the session cookie to any site.
    if (frontendUrl === '*' || frontendUrl.includes('*')) {
      errors.push(
        'FRONTEND_URL must be an exact origin in production - a wildcard CORS origin cannot be used with credentialed requests.',
      );
    }
    if (!frontendUrl.startsWith('https://')) {
      errors.push(
        `FRONTEND_URL must use https:// when NODE_ENV=production (received "${frontendUrl}"). The operator session cookie is marked Secure and a browser will not send it over plain http.`,
      );
    }

    // Automation writes to a real store. Leaving it enabled with no way to
    // authenticate means the apply endpoint is reachable by anyone who finds it.
    if (automationEnabled && !hasPasswordLogin && operatorApiKey === null) {
      errors.push(
        'AUTOMATION_ENABLED=true in production with no operator credentials. Configure OPERATOR_PASSWORD_HASH + SESSION_SECRET (or OPERATOR_API_KEY) before allowing storefront writes.',
      );
    }

    // Placeholder secrets copied straight out of the example file. Length checks
    // alone would pass these.
    const placeholder = /(change[-_ ]?me|example|placeholder|your[-_ ]?secret|xxxx|s3cret|password123)/i;
    if (sessionSecret !== null && placeholder.test(sessionSecret)) {
      errors.push(
        'SESSION_SECRET looks like a placeholder value. Generate a real one: openssl rand -base64 48',
      );
    }
    if (operatorApiKey !== null && placeholder.test(operatorApiKey)) {
      errors.push(
        'OPERATOR_API_KEY looks like a placeholder value. Generate a real one: openssl rand -base64 32',
      );
    }
    if (operatorPasswordHash === null && operatorApiKey === null) {
      warnings.push(
        'No operator password hash in production - the console cannot be signed into. Generate one with: npm run operator:hash',
      );
    }

    // Reads include cost prices, margins and customer counts. Open by default is
    // a deliberate convenience for first deploys, but it is worth flagging.
    if (!protectReads) {
      warnings.push(
        'OPERATOR_PROTECT_READS=false in production - read endpoints (including costs and margins) are reachable without signing in. Set it to true once the login screen is deployed.',
      );
    }

    // Debug switches in production produce noisy logs and can widen what is
    // printed. Warned rather than blocked so an emergency debug session is still
    // possible.
    if (read(env, 'DEBUG') !== null) {
      warnings.push('DEBUG is set in production - verbose third-party logging is enabled.');
    }
    const logLevel = read(env, 'LOG_LEVEL');
    if (logLevel !== null && logLevel.toLowerCase() === 'debug') {
      warnings.push('LOG_LEVEL=debug in production - expect high log volume.');
    }

    if (sessionTtlHours > 168) {
      warnings.push(
        `SESSION_TTL_HOURS=${sessionTtlHours} - an operator session lasting over a week widens the window for a stolen cookie.`,
      );
    }
  }

  if (errors.length > 0) {
    return { config: null, errors, warnings };
  }

  return {
    config: {
      nodeEnv,
      isProduction,
      port,
      frontendUrl,
      appUrl,
      mongoUri,
      tokenEncryptionKey,
      automationEnabled,
      automationOnWebhook,
      allowLiveStoreWrites,
      maxInventoryDelta,
      retention,
      operator: {
        username: operatorUsername,
        passwordHash: operatorPasswordHash,
        sessionSecret,
        apiKey: operatorApiKey,
        sessionTtlMs: sessionTtlHours * 60 * 60 * 1000,
        protectReads,
        // Secure cookies are dropped over plain http, which would make local
        // development unable to sign in at all.
        secureCookies: isProduction,
      },
      shopify: {
        storeDomain,
        apiVersion,
        accessToken,
        clientId,
        clientSecret,
        webhookSecret,
        authStrategy,
        authMode,
        scopes,
        graphqlEndpoint: `https://${storeDomain}/admin/api/${apiVersion}/graphql.json`,
        tokenEndpoint: `https://${storeDomain}/admin/oauth/access_token`,
        oauthRedirectUri: appUrl === null ? null : `${appUrl}${OAUTH_CALLBACK_PATH}`,
        webhookCallbackUrl: appUrl === null ? null : `${appUrl}${WEBHOOK_RECEIVER_PATH}`,
        storeMode,
        onlineStorePublicationId,
      },
    },
    errors,
    warnings,
  };
}
