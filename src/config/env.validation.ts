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

export interface ShopifyConfig {
  storeDomain: string;
  apiVersion: string;
  accessToken: string | null;
  clientId: string | null;
  clientSecret: string | null;
  webhookSecret: string | null;
  /** Fully-qualified GraphQL Admin API endpoint. */
  graphqlEndpoint: string;
}

export interface AppConfig {
  nodeEnv: NodeEnv;
  isProduction: boolean;
  port: number;
  frontendUrl: string;
  mongoUri: string | null;
  shopify: ShopifyConfig;
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

const NODE_ENVS: readonly NodeEnv[] = ['development', 'test', 'production'];
const MYSHOPIFY_DOMAIN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;
const API_VERSION = /^\d{4}-\d{2}$/;

type RawEnv = Record<string, string | undefined>;

function read(env: RawEnv, key: string): string | null {
  const value = env[key];
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
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
  const accessToken = read(env, 'SHOPIFY_ACCESS_TOKEN');
  if (accessToken === null) {
    const message =
      'SHOPIFY_ACCESS_TOKEN not set - Shopify endpoints will return SHOPIFY_NOT_CONFIGURED until it is supplied.';
    if (isProduction) errors.push('SHOPIFY_ACCESS_TOKEN is required when NODE_ENV=production.');
    else warnings.push(message);
  }

  const webhookSecret = read(env, 'SHOPIFY_WEBHOOK_SECRET');
  if (webhookSecret === null) {
    warnings.push(
      'SHOPIFY_WEBHOOK_SECRET not set - webhook routes will reject all deliveries.',
    );
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
      mongoUri,
      shopify: {
        storeDomain,
        apiVersion,
        accessToken,
        clientId: read(env, 'SHOPIFY_CLIENT_ID'),
        clientSecret: read(env, 'SHOPIFY_CLIENT_SECRET'),
        webhookSecret,
        graphqlEndpoint: `https://${storeDomain}/admin/api/${apiVersion}/graphql.json`,
      },
    },
    errors,
    warnings,
  };
}
