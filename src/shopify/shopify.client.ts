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
import { config, isShopifyConfigured } from '../config';
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

function assertConfigured(): string {
  if (!isShopifyConfigured() || config.shopify.accessToken === null) {
    throw new AppError(
      'SHOPIFY_NOT_CONFIGURED',
      'Shopify is not configured. Set SHOPIFY_ACCESS_TOKEN in the backend .env file and restart the server.',
    );
  }
  return config.shopify.accessToken;
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
 */
export async function shopifyGraphql<T>(
  query: string,
  variables: Record<string, unknown> = {},
  meta: { operation: string } = { operation: 'anonymous' },
): Promise<GraphqlResult<T>> {
  const accessToken = assertConfigured();
  let lastError: AppError | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
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
