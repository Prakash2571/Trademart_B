/**
 * The single place Trademart talks to Shopify.
 *
 * Everything goes through `shopifyGraphql`, which owns:
 *   - authentication header (never logged)
 *   - request timeout
 *   - HTTP failure classification
 *   - GraphQL `errors` classification
 *   - throttle-aware retry with exponential backoff
 *   - refusal to retry permission errors
 *
 * GraphQL Admin API only - the REST Admin API is legacy as of 2024-10.
 */

import { AppError } from '../common/errors';
import { logger } from '../common/logger';
import { config } from '../config';
import { getTokenProvider } from './token';
import type { ShopifyTokenProvider, TokenDiagnostics } from './token/token.types';
import { recordShopifyOutcome } from './shopify.breaker';
import {
  mapGraphqlErrors,
  mapHttpFailure,
  mapNetworkFailure,
  type ShopifyGraphqlError,
} from './shopify.errors';
import {
  MAX_ATTEMPTS,
  computeBackoffDelay,
  parseRetryAfter,
  sleep,
  type ShopifyCostExtension,
} from './shopify.throttle';

const REQUEST_TIMEOUT_MS = 20000;

interface GraphqlResponseBody<T> {
  data?: T | null;
  errors?: ShopifyGraphqlError[] | null;
  extensions?: { cost?: ShopifyCostExtension } | null;
}

export interface GraphqlResult<T> {
  data: T;
  cost: ShopifyCostExtension | null;
}

/** Last observed throttle state, surfaced for diagnostics. */
let lastCost: ShopifyCostExtension | null = null;

export function getLastThrottleStatus(): ShopifyCostExtension | null {
  return lastCost;
}

function requireTokenProvider(): ShopifyTokenProvider {
  const provider = getTokenProvider();
  if (provider === null) {
    throw new AppError(
      'SHOPIFY_NOT_CONFIGURED',
      'Shopify is not configured. Set SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET in the backend .env file and restart the server.',
    );
  }
  return provider;
}

/** Non-secret token status for the diagnostics endpoints. */
export function getTokenDiagnostics(): TokenDiagnostics | null {
  const provider = getTokenProvider();
  if (provider === null) return null;
  return provider.describe(config.shopify.storeDomain);
}

async function executeOnce<T>(
  query: string,
  variables: Record<string, unknown>,
  accessToken: string,
): Promise<GraphqlResult<T>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(config.shopify.graphqlEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Shopify-Access-Token': accessToken,
        'User-Agent': 'Trademart/0.1 (+https://github.com/trademart)',
      },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });
  } catch (error) {
    throw mapNetworkFailure(error);
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => '');
    const error = mapHttpFailure(response.status, bodyText);
    if (response.status === 429) {
      const retryAfter = parseRetryAfter(response.headers.get('Retry-After'));
      throw new AppError(error.code, error.message, {
        status: error.status,
        retryable: true,
        details: { retryAfterSeconds: retryAfter },
      });
    }
    throw error;
  }

  let body: GraphqlResponseBody<T>;
  try {
    body = (await response.json()) as GraphqlResponseBody<T>;
  } catch {
    throw new AppError(
      'SHOPIFY_HTTP_ERROR',
      'Shopify returned a response that was not valid JSON.',
    );
  }

  lastCost = body.extensions?.cost ?? null;

  // A 200 can still carry errors (including THROTTLED) - never ignore them.
  const graphqlError = mapGraphqlErrors(body.errors);
  if (graphqlError !== null) {
    // Partial data alongside errors happens with per-field access denials.
    if (graphqlError.code === 'SHOPIFY_SCOPE_MISSING' && body.data) {
      logger.warn('Shopify returned partial data with an access denial.', {
        reason: graphqlError.message,
      });
    }
    throw graphqlError;
  }

  if (body.data === null || body.data === undefined) {
    throw new AppError(
      'SHOPIFY_GRAPHQL_ERROR',
      'Shopify returned an empty data payload.',
    );
  }

  return { data: body.data, cost: lastCost };
}

/**
 * Runs a GraphQL operation against the Admin API, retrying only failures that
 * can plausibly succeed on a second attempt.
 *
 * Reports the FINAL outcome to the circuit breaker. Deliberately final and not
 * per-attempt: an operation that was throttled once and then succeeded is not a
 * degraded dependency, it is the retry logic doing its job, and counting the
 * intermediate failure would trip the breaker during normal throttled operation.
 * One breaker failure therefore means "an operation failed even after all its
 * retries", which is the signal worth pausing bulk writes over.
 *
 * Reads report outcomes too, even though reads are never blocked. They are the
 * majority of traffic, so they detect a degraded Shopify soonest, and the breaker
 * only ever gates bulk writes - so there is no cost to letting them inform it.
 */
export async function shopifyGraphql<T>(
  query: string,
  variables: Record<string, unknown> = {},
  meta: { operation: string } = { operation: 'anonymous' },
): Promise<GraphqlResult<T>> {
  try {
    const result = await executeWithRetries<T>(query, variables, meta);
    recordShopifyOutcome({ ok: true });
    return result;
  } catch (error) {
    recordShopifyOutcome({
      ok: false,
      code: error instanceof AppError ? error.code : undefined,
    });
    throw error;
  }
}

async function executeWithRetries<T>(
  query: string,
  variables: Record<string, unknown>,
  meta: { operation: string },
): Promise<GraphqlResult<T>> {
  const provider = requireTokenProvider();
  const shopDomain = config.shopify.storeDomain;
  let lastError: AppError | null = null;
  // A 401 gets one free re-auth attempt; it must not consume a throttle retry.
  let reauthenticated = false;
  let attempt = 0;

  while (attempt < MAX_ATTEMPTS) {
    attempt += 1;

    // The provider serves a cached token and only contacts Shopify when the
    // current one is missing or close to expiry.
    let accessToken: string;
    try {
      const token = await provider.getAccessToken(shopDomain);
      accessToken = token.accessToken;
    } catch (error) {
      const appError = error instanceof AppError ? error : mapNetworkFailure(error);
      lastError = appError;
      if (!appError.retryable || attempt === MAX_ATTEMPTS) {
        logger.warn('Could not obtain a Shopify access token.', {
          operation: meta.operation,
          attempt,
          code: appError.code,
        });
        throw appError;
      }
      await sleep(computeBackoffDelay(attempt));
      continue;
    }

    try {
      const result = await executeOnce<T>(query, variables, accessToken);
      if (attempt > 1) {
        logger.info('Shopify request succeeded after retry.', {
          operation: meta.operation,
          attempt,
        });
      }
      return result;
    } catch (error) {
      const appError = error instanceof AppError ? error : mapNetworkFailure(error);
      lastError = appError;

      // Shopify rejected the token. If we can mint a new one (client
      // credentials), the token was probably revoked or rotated early - discard
      // it and try once more. A static token cannot be refreshed, so it falls
      // through and surfaces the error.
      if (
        appError.code === 'SHOPIFY_UNAUTHORIZED' &&
        provider.canRefresh &&
        !reauthenticated
      ) {
        reauthenticated = true;
        provider.invalidate(shopDomain);
        logger.warn('Shopify rejected the access token; re-authenticating once.', {
          operation: meta.operation,
        });
        attempt -= 1;
        continue;
      }

      // Permission/config errors are terminal - do not hammer Shopify.
      if (!appError.retryable || attempt === MAX_ATTEMPTS) {
        logger.warn('Shopify request failed.', {
          operation: meta.operation,
          attempt,
          code: appError.code,
          retryable: appError.retryable,
          reason: appError.message,
        });
        throw appError;
      }

      const retryAfterSeconds =
        appError.details &&
        typeof appError.details === 'object' &&
        'retryAfterSeconds' in appError.details
          ? ((appError.details as { retryAfterSeconds?: number | null }).retryAfterSeconds ??
            null)
          : null;

      const delay = computeBackoffDelay(attempt, { retryAfterSeconds });
      logger.warn('Shopify request throttled/failed - backing off.', {
        operation: meta.operation,
        attempt,
        code: appError.code,
        delayMs: delay,
      });
      await sleep(delay);
    }
  }

  throw lastError ?? new AppError('INTERNAL_ERROR', 'Shopify request failed.');
}
