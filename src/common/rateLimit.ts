/**
 * Rate-limit responses that obey the API error contract.
 *
 * express-rate-limit's `message` option takes a STATIC body, so every limiter in
 * this service answered with the flat keys only:
 *
 *   { success: false, code: 'RATE_LIMITED', message: '...' }
 *
 * No nested `error` object and - the part that actually costs someone time - no
 * requestId. A 429 is exactly the response a client is most likely to report
 * ("checkout kept failing"), and it was the one response with nothing to quote and
 * nothing to correlate against the logs.
 *
 * A `handler` is used instead of `message` so the body can be built per request,
 * from the same buildErrorBody as every other failure.
 */

import type { Request, RequestHandler, Response } from 'express';
import rateLimit, { type Options } from 'express-rate-limit';

import { buildErrorBody } from './errorBody';
import { logger } from './logger';
import { getRequestId } from './requestContext';

/** Named so a log line says WHICH limiter fired, without a high-cardinality label. */
export type RateLimitScope =
  | 'global'
  | 'operator-login'
  | 'storefront-catalog'
  | 'storefront-checkout'
  | 'storefront-tracking';

export function rateLimitHandler(scope: RateLimitScope, message: string): RequestHandler {
  return (req: Request, res: Response) => {
    // Logged at warn, with the scope and path but never the body: a limiter firing
    // is either an attack or a client bug, and both need to be visible. The IP is
    // deliberately omitted - it is in the access log and is personal data here.
    logger.warn('Rate limit exceeded.', { scope, method: req.method, path: req.path });
    res.status(429).json(
      buildErrorBody({ code: 'RATE_LIMITED', message, requestId: getRequestId() }),
    );
  };
}

/**
 * Builds a limiter with the shared response behaviour.
 *
 * `standardHeaders: 'draft-7'` keeps RateLimit / RateLimit-Policy on the response
 * so a well-behaved client can back off before being refused.
 */
export function createRateLimiter(input: {
  scope: RateLimitScope;
  windowMs: number;
  limit: number;
  message: string;
  skipSuccessfulRequests?: boolean;
}): RequestHandler {
  const options: Partial<Options> = {
    windowMs: input.windowMs,
    limit: input.limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: rateLimitHandler(input.scope, input.message),
  };
  if (input.skipSuccessfulRequests !== undefined) {
    options.skipSuccessfulRequests = input.skipSuccessfulRequests;
  }
  return rateLimit(options);
}
