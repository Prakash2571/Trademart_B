/**
 * Operator session routes.
 *
 * POST /api/operator/login   - exchange username+password for a session cookie
 * POST /api/operator/logout  - clear the session
 * GET  /api/operator/me      - who am I / am I signed in
 * GET  /api/operator/csrf    - issue a CSRF token for the frontend
 *
 * These four are deliberately NOT behind requireOperator (you cannot sign in if
 * signing in requires being signed in). `me` answers for both states instead.
 */

import { Router } from 'express';
import rateLimit from 'express-rate-limit';

import { recordAudit } from '../../audit/audit.service';
import { AppError } from '../../common/errors';
import { asyncHandler, sendSuccess } from '../../common/http';
import { logger } from '../../common/logger';
import { setActor } from '../../common/requestContext';
import {
  config,
  isOperatorConfigured,
  isOperatorPasswordLoginConfigured,
} from '../../config';
import {
  CSRF_COOKIE,
  CSRF_HEADER,
  SESSION_COOKIE,
  clearCookie,
  serialiseCookie,
} from './cookies';
import { createCsrfToken } from './csrf';
import { resolveOperator } from './operator.middleware';
import { verifyPassword } from './password';
import { createSessionToken } from './session';

export const operatorRouter = Router();

/**
 * Strict limiter on login only.
 *
 * The global /api limiter allows 300/minute, which is far too generous for a
 * password endpoint. Keyed by IP; behind nginx this is the real client because
 * app.ts sets `trust proxy`.
 */
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  // Successful sign-ins should not count toward the lockout.
  skipSuccessfulRequests: true,
  message: {
    success: false,
    code: 'RATE_LIMITED',
    message: 'Too many sign-in attempts. Wait 15 minutes and try again.',
  },
});

/** Cookie attributes shared by the session and CSRF cookies. */
function cookieBase(): { secure: boolean; sameSite: 'Lax'; path: string } {
  return { secure: config.operator.secureCookies, sameSite: 'Lax', path: '/' };
}

function issueSession(username: string): string[] {
  const secret = config.operator.sessionSecret;
  if (secret === null) {
    throw new AppError(
      'OPERATOR_NOT_CONFIGURED',
      'SESSION_SECRET is not configured, so a session cookie cannot be issued.',
    );
  }

  const maxAgeSeconds = Math.floor(config.operator.sessionTtlMs / 1000);
  const token = createSessionToken(username, secret, {
    ttlMs: config.operator.sessionTtlMs,
  });

  return [
    serialiseCookie(SESSION_COOKIE, token, {
      ...cookieBase(),
      maxAgeSeconds,
      httpOnly: true,
    }),
    // Readable by the frontend on purpose - it has to echo this back in a header.
    serialiseCookie(CSRF_COOKIE, createCsrfToken(), {
      ...cookieBase(),
      maxAgeSeconds,
      httpOnly: false,
    }),
  ];
}

operatorRouter.post(
  '/login',
  loginLimiter,
  asyncHandler(async (req, res) => {
    if (!isOperatorPasswordLoginConfigured()) {
      throw new AppError(
        'OPERATOR_NOT_CONFIGURED',
        'Password login is not configured. Set OPERATOR_PASSWORD_HASH (npm run operator:hash) and SESSION_SECRET, then restart.',
      );
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const username = typeof body['username'] === 'string' ? body['username'].trim() : '';
    const password = typeof body['password'] === 'string' ? body['password'] : '';

    if (username.length === 0 || password.length === 0) {
      throw new AppError('LOGIN_FAILED', 'Username and password are required.');
    }

    // Non-null: isOperatorPasswordLoginConfigured() proved both are set.
    const expectedUser = config.operator.username;
    const passwordHash = config.operator.passwordHash as string;

    // The password is verified even when the username is wrong, so both failures
    // take the same time and neither reveals which one was incorrect.
    const passwordOk = await verifyPassword(password, passwordHash);
    const usernameOk = username === expectedUser;

    if (!usernameOk || !passwordOk) {
      // One generic message for both cases - never "no such user".
      logger.warn('Failed operator sign-in attempt.', { ip: req.ip });
      // Audited as a security event. A run of these from one address is the
      // signal that matters, and it is invisible if only successes are recorded.
      // The ATTEMPTED username is stored; the password never is.
      await recordAudit({
        action: 'LOGIN_FAILED',
        resourceType: 'SESSION',
        actor: username.length === 0 ? 'unknown' : username,
        authMethod: 'SESSION',
        result: 'FAILURE',
        metadata: { ip: req.ip ?? null, reason: 'Invalid username or password.' },
      });
      throw new AppError('LOGIN_FAILED', 'Invalid username or password.');
    }

    for (const cookie of issueSession(expectedUser)) {
      res.append('Set-Cookie', cookie);
    }

    logger.info('Operator signed in.', { username: expectedUser });
    // A fresh token is minted here rather than any earlier cookie being reused,
    // which is what prevents session fixation: a pre-login cookie an attacker
    // planted cannot survive a successful sign-in.
    setActor(expectedUser, 'SESSION');
    await recordAudit({
      action: 'LOGIN',
      resourceType: 'SESSION',
      actor: expectedUser,
      authMethod: 'SESSION',
      after: { sessionTtlHours: Math.round(config.operator.sessionTtlMs / 3_600_000) },
      metadata: { ip: req.ip ?? null },
    });
    sendSuccess(res, {
      username: expectedUser,
      method: 'SESSION',
      expiresInSeconds: Math.floor(config.operator.sessionTtlMs / 1000),
      csrfHeader: CSRF_HEADER,
      csrfCookie: CSRF_COOKIE,
    });
  }),
);

operatorRouter.post(
  '/logout',
  asyncHandler(async (req, res) => {
    // Deliberately succeeds even when not signed in: a logout that errors leaves
    // a confused client holding a cookie it cannot clear.
    const operator = resolveOperator(req);

    res.append('Set-Cookie', clearCookie(SESSION_COOKIE, cookieBase()));
    res.append('Set-Cookie', clearCookie(CSRF_COOKIE, { ...cookieBase(), httpOnly: false }));

    if (operator !== null) {
      logger.info('Operator signed out.', { username: operator.username });
      await recordAudit({
        action: 'LOGOUT',
        resourceType: 'SESSION',
        actor: operator.username,
        authMethod: operator.method,
        metadata: { ip: req.ip ?? null },
      });
    }
    sendSuccess(res, { signedOut: true });
  }),
);

operatorRouter.get(
  '/me',
  asyncHandler(async (req, res) => {
    // Always 200. The frontend calls this on load to decide between the console
    // and the login screen, and a 401 here would be indistinguishable from a
    // backend fault.
    const operator = resolveOperator(req, res);
    sendSuccess(res, {
      authenticated: operator !== null,
      username: operator?.username ?? null,
      method: operator?.method ?? null,
      /** False means nobody can sign in until the server is configured. */
      loginConfigured: isOperatorPasswordLoginConfigured(),
      operatorConfigured: isOperatorConfigured(),
      /** When true, reads need a session too, not just writes. */
      readsProtected: config.operator.protectReads,
      csrfHeader: CSRF_HEADER,
      csrfCookie: CSRF_COOKIE,
    });
  }),
);

operatorRouter.get(
  '/csrf',
  asyncHandler(async (_req, res) => {
    // Issues a fresh pair so a client that lost the cookie can recover without
    // signing in again. Safe to call unauthenticated: on its own the token
    // grants nothing, it only has to match the cookie.
    const token = createCsrfToken();
    res.append(
      'Set-Cookie',
      serialiseCookie(CSRF_COOKIE, token, {
        ...cookieBase(),
        maxAgeSeconds: Math.floor(config.operator.sessionTtlMs / 1000),
        httpOnly: false,
      }),
    );
    sendSuccess(res, { csrfToken: token, header: CSRF_HEADER, cookie: CSRF_COOKIE });
  }),
);
