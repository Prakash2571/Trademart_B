/**
 * The one error path for public storefront routes.
 *
 * There used to be two near-identical copies of this - one in the checkout router,
 * one in the orders router - and a third body (the origin rejection) that skipped
 * the contract entirely and answered with the flat keys only, no nested `error`
 * object and no requestId. Kanay reads `code` to decide what to tell a customer,
 * and an operator diagnosing a failed checkout has nothing but the requestId to
 * search the logs with, so a failure path that omits either is a failure path
 * nobody can act on.
 *
 * Non-StorefrontError failures are deliberately forwarded to the central Express
 * error handler instead of being formatted here: it is the thing that knows how to
 * turn an unexpected throw into a 500 without leaking a stack trace.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { buildErrorBody } from '../../common/errorBody';
import { getRequestId } from '../../common/requestContext';
import { StorefrontError, type StorefrontErrorCode } from '../checkout/storefront.error';

/** Writes a StorefrontError in the canonical contract. */
export function sendStorefrontError(res: Response, error: StorefrontError): void {
  res.status(error.status).json(
    buildErrorBody<StorefrontErrorCode>({
      code: error.code,
      message: error.message,
      details: error.details,
      requestId: getRequestId(),
    }),
  );
}

/**
 * Wraps a storefront handler.
 *
 * Customer-facing messages come from StorefrontError and are written for a
 * shopper; anything else is an internal fault and goes to the central handler,
 * which never puts an internal message on the wire.
 */
export function storefrontHandler(
  fn: (req: Request, res: Response) => Promise<void>,
): RequestHandler {
  return (req, res, next: NextFunction) => {
    fn(req, res).catch((error: unknown) => {
      if (!(error instanceof StorefrontError)) {
        next(error);
        return;
      }
      sendStorefrontError(res, error);
    });
  };
}

/**
 * Rejects a browser request from an origin this storefront does not serve.
 *
 * NOT a security control, and it must not be read as one: an Origin header is set
 * by the browser and simply absent from curl or a server, so this stops a
 * misconfigured site pointing at the wrong backend - nothing more. The controls
 * that matter are elsewhere: the price is recomputed server-side, payments are
 * HMAC-verified, and order reads need a token. Requests with NO Origin are allowed
 * through on purpose, because that is what a server-to-server caller and a health
 * check look like.
 */
export function requireAllowedOrigin(allowedOrigins: readonly string[]): RequestHandler {
  const allowed = new Set(allowedOrigins.map((origin) => origin.replace(/\/+$/, '')));
  return (req, res, next) => {
    const origin = req.header('Origin');
    if (origin !== undefined && !allowed.has(origin.replace(/\/+$/, ''))) {
      sendStorefrontError(
        res,
        new StorefrontError(
          'VALIDATION_ERROR',
          'This storefront origin is not allowed.',
          403,
        ),
      );
      return;
    }
    next();
  };
}
