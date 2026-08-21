/**
 * Structured access log.
 *
 * One JSON line per completed request carrying the fields an operator actually
 * needs to answer "what happened at 14:32?": correlation id, operation, status,
 * duration and which store the request was against.
 *
 * Logged on response `finish` rather than at entry, because a log line written
 * before the work happens cannot report the outcome or the duration - and the
 * outcome is the whole point.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { config } from '../config';
import { logger } from './logger';

/**
 * Paths that are far too frequent and far too boring to log at info.
 * Health probes run every few seconds and would drown everything else.
 */
const QUIET_PATHS = new Set([
  '/api/health',
  '/api/health/live',
  '/api/health/ready',
]);

export function httpLogger(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const startedAt = process.hrtime.bigint();

    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      const quiet = QUIET_PATHS.has(req.path) && res.statusCode < 400;
      if (quiet) return;

      const meta: Record<string, unknown> = {
        operation: `${req.method} ${req.path}`,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Math.round(durationMs),
        storeDomain: config.shopify.storeDomain,
      };

      // Shopify's own throttle state, when the request touched Shopify. Cheap
      // to include and the first thing to check when writes start failing.
      const throttle = res.getHeader('X-Shopify-Available-Points');
      if (throttle !== undefined) meta['shopifyAvailablePoints'] = throttle;

      // 5xx is ours to fix, 4xx is usually the caller's. Different severities so
      // an alert on `level:error` does not fire on every failed login.
      if (res.statusCode >= 500) logger.error('Request completed with a server error.', meta);
      else if (res.statusCode >= 400) logger.warn('Request completed with an error.', meta);
      else logger.info('Request completed.', meta);
    });

    next();
  };
}
