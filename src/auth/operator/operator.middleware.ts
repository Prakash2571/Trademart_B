/**
 * Operator authentication middleware.
 *
 * WHY THIS EXISTS
 * ---------------
 * Before this, /api/automation/apply could change every price in a live Shopify
 * store and was callable by anyone who knew the URL. CORS did not prevent that:
 * CORS is a policy the BROWSER enforces on cross-origin scripts, and it has no
 * effect on curl, a server, or a script. Restricting an origin is not
 * authentication.
 *
 * TWO CREDENTIAL TYPES
 * --------------------
 *   Session cookie  - for the browser console. HttpOnly, so JavaScript (and
 *                     therefore XSS) cannot read it. Requires a CSRF token,
 *                     because the browser attaches cookies automatically.
 *   Bearer API key   - for curl, cron and server-to-server. Exempt from CSRF: a
 *                     browser never attaches an Authorization header on its own,
 *                     so a cross-site request cannot forge one.
 *
 * FAILS CLOSED
 * ------------
 * With no credentials configured, every guarded route is refused. The opposite
 * reading - "auth not set up, so writes are open" - is exactly the hole this
 * closes.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { AppError } from '../../common/errors';
import { logger } from '../../common/logger';
import { config, isOperatorConfigured } from '../../config';
import {
  CSRF_COOKIE,
  CSRF_HEADER,
  SESSION_COOKIE,
  parseCookies,
  serialiseCookie,
} from './cookies';
import { csrfTokensMatch, methodRequiresCsrf } from './csrf';
import { apiKeyMatches } from './password';
import { createSessionToken, shouldRenewSession, verifySessionToken } from './session';

/** How the caller proved who they are. */
export type OperatorAuthMethod = 'SESSION' | 'API_KEY';

export interface AuthenticatedOperator {
  username: string;
  method: OperatorAuthMethod;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by requireOperator / attachOperator. */
      operator?: AuthenticatedOperator;
    }
  }
}

/** Reads the bearer token, if any. */
function bearerToken(req: Request): string | undefined {
  const header = req.header('authorization');
  if (header === undefined) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim();
}

/**
 * Re-issues the session cookie when it is past halfway through its life, so an
 * active operator gets a sliding window without weakening the absolute cap.
 */
function renewSessionCookie(res: Response, username: string): void {
  const secret = config.operator.sessionSecret;
  if (secret === null) return;

  const token = createSessionToken(username, secret, {
    ttlMs: config.operator.sessionTtlMs,
  });
  res.append(
    'Set-Cookie',
    serialiseCookie(SESSION_COOKIE, token, {
      maxAgeSeconds: Math.floor(config.operator.sessionTtlMs / 1000),
      httpOnly: true,
      secure: config.operator.secureCookies,
      sameSite: 'Lax',
    }),
  );
}

/**
 * Identifies the caller without enforcing anything.
 *
 * Returns null when unauthenticated. Never throws - callers decide whether the
 * absence of an operator is fatal.
 */
export function resolveOperator(
  req: Request,
  res?: Response,
): AuthenticatedOperator | null {
  // API key first: it is unambiguous and cheap, and lets a script authenticate
  // even when session cookies are not configured at all.
  const configuredKey = config.operator.apiKey;
  const supplied = bearerToken(req);
  if (configuredKey !== null && supplied !== undefined) {
    if (apiKeyMatches(supplied, configuredKey)) {
      return { username: config.operator.username, method: 'API_KEY' };
    }
    // A wrong key is not silently downgraded to "anonymous" - that would make a
    // typo in a cron job look like a missing-cookie problem.
    return null;
  }

  const cookies = parseCookies(req.header('cookie'));
  const verification = verifySessionToken(
    cookies[SESSION_COOKIE],
    config.operator.sessionSecret,
  );
  if (!verification.valid) return null;

  if (res !== undefined && shouldRenewSession(verification.session)) {
    renewSessionCookie(res, verification.session.username);
  }

  return { username: verification.session.username, method: 'SESSION' };
}

/**
 * Enforces CSRF for cookie-authenticated state-changing requests.
 *
 * Deliberately skipped for API_KEY: that credential is not attached
 * automatically by a browser, so it is not forgeable cross-site.
 */
function enforceCsrf(req: Request, operator: AuthenticatedOperator): void {
  if (operator.method !== 'SESSION') return;
  if (!methodRequiresCsrf(req.method)) return;

  const cookies = parseCookies(req.header('cookie'));
  if (!csrfTokensMatch(cookies[CSRF_COOKIE], req.header(CSRF_HEADER))) {
    throw new AppError(
      'CSRF_INVALID',
      `Missing or invalid CSRF token. Read the ${CSRF_COOKIE} cookie and send it in the ${CSRF_HEADER} header, or use GET /api/operator/csrf to obtain one.`,
    );
  }
}

/**
 * Requires an authenticated operator. Use on every route that can change the
 * Shopify store or this app's configuration.
 */
export const requireOperator: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  if (!isOperatorConfigured()) {
    // Fail closed, with an actionable message rather than a bare 401.
    next(
      new AppError(
        'OPERATOR_NOT_CONFIGURED',
        'No operator credentials are configured, so management endpoints are locked. Set OPERATOR_PASSWORD_HASH + SESSION_SECRET (see npm run operator:hash), or OPERATOR_API_KEY for scripts.',
      ),
    );
    return;
  }

  const operator = resolveOperator(req, res);
  if (operator === null) {
    // Logged at info, not warn: an expired cookie is routine, and a noisy log
    // here would drown the genuine signals.
    logger.info('Rejected unauthenticated request to a management endpoint.', {
      method: req.method,
      path: req.path,
    });
    next(
      new AppError(
        'UNAUTHORIZED',
        'Authentication required. Sign in at POST /api/operator/login, or send an Authorization: Bearer <OPERATOR_API_KEY> header.',
      ),
    );
    return;
  }

  try {
    enforceCsrf(req, operator);
  } catch (error) {
    next(error);
    return;
  }

  req.operator = operator;
  next();
};

/**
 * Requires an operator ONLY for state-changing methods, leaving reads public.
 *
 * Used on routers that mix reads and writes so that turning auth on cannot black
 * out a dashboard that has no login screen deployed yet. Mutations are still
 * always protected.
 */
export const requireOperatorForWrites: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  if (!methodRequiresCsrf(req.method)) {
    // Read-only: attach the operator if present, but never demand one.
    const operator = resolveOperator(req, res);
    if (operator !== null) req.operator = operator;
    next();
    return;
  }
  requireOperator(req, res, next);
};

/**
 * Requires an operator for reads too, but only when OPERATOR_PROTECT_READS is
 * on. Lets an operator lock the whole console down once the login UI exists.
 */
export const requireOperatorForReads: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  if (!config.operator.protectReads) {
    const operator = resolveOperator(req, res);
    if (operator !== null) req.operator = operator;
    next();
    return;
  }
  requireOperator(req, res, next);
};
