/**
 * Terminal error middleware + 404 handler.
 *
 * Converts anything thrown in a route into the documented failure envelope.
 * Unexpected errors are logged in full server-side but reduced to a generic
 * message client-side so internals never leak.
 */

import type { NextFunction, Request, Response } from 'express';

import { AppError, isAppError } from './errors';
import { logger } from './logger';

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    success: false,
    code: 'NOT_FOUND',
    message: `Route ${req.method} ${req.path} does not exist.`,
  });
}

export function errorHandler(
  error: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (isAppError(error)) {
    // Expected, already-classified failures: log at warn, return as-is.
    logger.warn('Request failed.', {
      method: req.method,
      path: req.path,
      code: error.code,
      status: error.status,
      reason: error.message,
    });
    res.status(error.status).json(error.toBody());
    return;
  }

  const err = error instanceof Error ? error : new Error(String(error));
  logger.error('Unhandled error.', {
    method: req.method,
    path: req.path,
    reason: err.message,
    stack: err.stack,
  });

  const fallback = new AppError('INTERNAL_ERROR', 'An unexpected server error occurred.');
  res.status(fallback.status).json(fallback.toBody());
}
