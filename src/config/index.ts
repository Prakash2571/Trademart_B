/**
 * Loads .env, validates it, and exposes a frozen config object.
 *
 * If validation fails the process exits immediately with a readable list of
 * problems - a misconfigured server should never start and then fail
 * mysteriously on the first Shopify call.
 */

import dotenv from 'dotenv';

import { logger } from '../common/logger';
import { validateEnv, type AppConfig } from './env.validation';

dotenv.config();

/**
 * Reports the problems and terminates.
 *
 * Ends with a `throw` so the return type is provably `never` from control flow
 * alone, rather than relying on `process.exit` being typed as `never`.
 */
function failFast(problems: string[]): never {
  logger.error('Invalid environment configuration. Server will not start.', {
    problems,
  });
  for (const problem of problems) {
    console.error(`  - ${problem}`);
  }
  console.error('\nSee .env.example for the expected values.');
  process.exit(1);
  throw new Error('Invalid environment configuration.');
}

const result = validateEnv(process.env);

for (const warning of result.warnings) {
  logger.warn(warning);
}

export const config: AppConfig = Object.freeze(
  result.config ?? failFast(result.errors),
);

/**
 * True when the backend can obtain an Admin API token - either from client
 * credentials or from an explicit static token override.
 */
export const isShopifyConfigured = (): boolean => config.shopify.authStrategy !== 'NONE';

/** True when a Mongo connection string was supplied. */
export const isDatabaseConfigured = (): boolean => config.mongoUri !== null;

/**
 * True when the OAuth redirect flow can run.
 *
 * All three are genuinely required: the client id/secret sign the handshake and
 * exchange the code, and APP_URL forms the redirect_uri that Shopify compares
 * character-for-character against its allow-list.
 */
export const isOAuthConfigured = (): boolean =>
  config.appUrl !== null &&
  config.shopify.clientId !== null &&
  config.shopify.clientSecret !== null;

/**
 * True when offline tokens can be encrypted before being persisted. Without it
 * the OAuth callback refuses to store a token rather than writing plaintext.
 */
export const isTokenEncryptionConfigured = (): boolean =>
  config.tokenEncryptionKey !== null;

/** True when webhook subscriptions can be registered with a reachable URL. */
export const isWebhookRegistrationConfigured = (): boolean =>
  config.shopify.webhookCallbackUrl !== null;

export type { AppConfig } from './env.validation';
