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
import { getRequestId } from './requestContext';

export function notFoundHandler(req: Request, res: Response): void {
  // Built through AppError rather than hand-rolled, so a 404 carries the same
  // envelope (including the nested error object and the requestId) as every other
  // failure. A client should not need a special case for one status code.
  const error = new AppError(
    'NOT_FOUND',
    `Route ${req.method} ${req.path} does not exist.`,
  );
  res.status(error.status).json(error.toBody(getRequestId()));
}

export function errorHandler(
  error: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const requestId = getRequestId();

  if (isAppError(error)) {
    // Expected, already-classified failures: return as-is. 5xx still logs at
    // error - an AppError can still mean the server itself is broken.
    const meta = {
      method: req.method,
      path: req.path,
      code: error.code,
      status: error.status,
      reason: error.message,
    };
    if (error.status >= 500) logger.error('Request failed.', meta);
    else logger.warn('Request failed.', meta);

    res.status(error.status).json(error.toBody(requestId));
    return;
  }

  const err = error instanceof Error ? error : new Error(String(error));
  logger.error('Unhandled error.', {
    method: req.method,
    path: req.path,
    reason: err.message,
    stack: err.stack,
  });

  // The generic message is deliberate: an unexpected error's message can contain
  // internals. The requestId is what makes it diagnosable without leaking them.
  const fallback = new AppError('INTERNAL_ERROR', 'An unexpected server error occurred.');
  res.status(fallback.status).json(fallback.toBody(requestId));
}
