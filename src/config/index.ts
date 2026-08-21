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

/**
 * True when automation is permitted to WRITE to the store.
 *
 * Preview/plan endpoints ignore this; only the apply path consults it, so a
 * misconfigured deployment can always still be inspected safely.
 */
export const isAutomationEnabled = (): boolean => config.automationEnabled;

/**
 * True when webhook deliveries should trigger automation runs.
 *
 * Requires BOTH flags: triggering a run that would then refuse to write is just
 * wasted Shopify calls.
 */
export const isAutomationOnWebhookEnabled = (): boolean =>
  config.automationOnWebhook && config.automationEnabled;

/**
 * True when the operator has explicitly acknowledged that automated tooling may
 * mutate a store that is not a Shopify development store.
 *
 * Only consulted by the live-store guard (shopify/storeMode.ts). Interactive
 * merchant actions in the signed-in console are NOT gated on this - a merchant
 * operating their own live shop is the normal case. It exists to stop test
 * suites, seed scripts and dev utilities from touching a real storefront.
 */
export const isLiveStoreWriteAcknowledged = (): boolean => config.allowLiveStoreWrites;

/** True when the OAuth scope list requests permission to publish. */
export const isPublicationWriteConfigured = (): boolean =>
  config.shopify.scopes.includes('write_publications');

/** True when an operator can sign in with a username and password. */
export const isOperatorPasswordLoginConfigured = (): boolean =>
  config.operator.passwordHash !== null && config.operator.sessionSecret !== null;

/**
 * True when SOME operator credential exists. When false the auth middleware
 * denies every management endpoint - it fails closed, never open.
 */
export const isOperatorConfigured = (): boolean =>
  isOperatorPasswordLoginConfigured() || config.operator.apiKey !== null;

export type { AppConfig } from './env.validation';
