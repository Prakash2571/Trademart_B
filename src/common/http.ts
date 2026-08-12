/**
 * Shared HTTP helpers: consistent envelopes + async error forwarding.
 *
 * Success:  { success: true, data, meta? }
 * Failure:  { success: false, code, message, details? }
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';

export interface SuccessBody<T, M extends object = object> {
  success: true;
  data: T;
  meta?: M;
}

/**
 * `M` is a generic object rather than Record<string, unknown> so typed metadata
 * (e.g. PageMeta) can be passed without needing an index signature.
 */
export function sendSuccess<T, M extends object = object>(
  res: Response,
  data: T,
  meta?: M,
): void {
  const body: SuccessBody<T, M> = { success: true, data };
  if (meta !== undefined) body.meta = meta;
  res.json(body);
}

/**
 * Wraps an async handler so rejected promises reach the Express error
 * middleware instead of hanging the request. Errors are never swallowed.
 */
export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}
