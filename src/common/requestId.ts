/**
 * X-Request-ID middleware.
 *
 * Mounted as the very first middleware so that literally every log line,
 * error body and audit row produced while serving a request can be tied
 * together - including failures inside body parsing and rate limiting.
 *
 * The id is echoed as a response header before the route runs, so it is present
 * even on responses the route never gets to write (a 500 from a later
 * middleware, for example).
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { createContext, resolveRequestId, runWithContext } from './requestContext';

export const REQUEST_ID_HEADER = 'X-Request-ID';

export function requestIdMiddleware(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    // A client-supplied id is honoured only if it is well-formed; see
    // requestContext.isValidRequestId for why that check is not optional.
    const requestId = resolveRequestId(
      req.header(REQUEST_ID_HEADER) ?? req.header('x-correlation-id'),
    );

    res.setHeader(REQUEST_ID_HEADER, requestId);

    const context = createContext(requestId, {
      method: req.method,
      // `req.path` is stable; the full URL can carry query values worth keeping
      // out of every log line.
      path: req.path,
      source: 'http',
    });

    runWithContext(context, () => {
      next();
    });
  };
}
