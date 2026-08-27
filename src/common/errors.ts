/**
 * Trademart error model.
 *
 * Deliberately free of external imports so it can be unit tested and reused
 * anywhere (including in pure-logic modules) without pulling in Express.
 *
 * Every failure that leaves the API does so as:
 *   { success: false, code, message, details? }
 */

import { buildErrorBody } from './errorBody';

export type ErrorCode =
  // Shopify
  | 'SHOPIFY_NOT_CONFIGURED'
  | 'SHOPIFY_UNAUTHORIZED'
  | 'SHOPIFY_AUTH_FAILED'
  | 'SHOPIFY_APP_NOT_INSTALLED'
  | 'SHOPIFY_SCOPE_MISSING'
  | 'SHOPIFY_THROTTLED'
  | 'SHOPIFY_GRAPHQL_ERROR'
  | 'SHOPIFY_USER_ERROR'
  | 'SHOPIFY_HTTP_ERROR'
  | 'SHOPIFY_NETWORK_ERROR'
  | 'SHOPIFY_NOT_FOUND'
  /** We gave up waiting on Shopify. Distinct from being unable to reach it. */
  | 'SHOPIFY_TIMEOUT'
  /**
   * Shopify has failed repeatedly (429/5xx/timeouts) and the circuit breaker is
   * open, so bulk writes are refused rather than emitting hundreds of individual
   * failures and leaving a half-applied plan.
   */
  | 'SHOPIFY_DEGRADED'
  // Platform
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'DATABASE_UNAVAILABLE'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR'
  /** Authenticated, but not permitted to do this. */
  | 'FORBIDDEN'
  // Idempotency-Key handling on mutating endpoints
  | 'IDEMPOTENCY_CONFLICT'
  | 'IDEMPOTENCY_IN_PROGRESS'
  // Webhooks
  | 'WEBHOOK_NOT_CONFIGURED'
  | 'WEBHOOK_INVALID_SIGNATURE'
  | 'WEBHOOK_REGISTRATION_FAILED'
  /**
   * A verified delivery could not be made DURABLE (no database, or the insert
   * failed). 503 and retryable on purpose: the sender must redeliver, because
   * acknowledging an event nobody stored drops it permanently - Shopify has its
   * 2xx and will never send it again.
   */
  | 'WEBHOOK_NOT_PERSISTED'
  // OAuth (authorization code grant / redirect flow)
  | 'OAUTH_NOT_CONFIGURED'
  | 'OAUTH_INVALID_REQUEST'
  | 'OAUTH_INVALID_HMAC'
  | 'OAUTH_STATE_INVALID'
  // Encryption of offline tokens at rest
  | 'ENCRYPTION_NOT_CONFIGURED'
  // Storefront automation (price / visibility writes)
  | 'AUTOMATION_DISABLED'
  | 'AUTOMATION_RULES_INVALID'
  | 'AUTOMATION_PRECONDITION_FAILED'
  | 'AUTOMATION_ALREADY_RUNNING'
  // Automation preview -> apply enforcement
  | 'PREVIEW_REQUIRED'
  | 'PREVIEW_NOT_FOUND'
  | 'PREVIEW_EXPIRED'
  | 'PREVIEW_ALREADY_APPLIED'
  | 'PREVIEW_STALE'
  // Cost / money correctness. Pricing refuses rather than guessing.
  | 'COST_UNKNOWN'
  | 'CURRENCY_MISMATCH'
  | 'SUPPLIER_UNAVAILABLE'
  /**
   * The product exists but could not be published to the Online Store. The
   * product is deliberately left DRAFT when this happens.
   */
  | 'PUBLICATION_FAILED'
  /** The resource changed in Shopify since the caller read it (stale write). */
  | 'PRODUCT_CHANGED'
  /** An inventory change exceeded MAX_INVENTORY_DELTA without confirmation. */
  | 'INVENTORY_DELTA_TOO_LARGE'
  // Operator authentication (protects everything that can change the store)
  | 'UNAUTHORIZED'
  | 'CSRF_INVALID'
  | 'LOGIN_FAILED'
  | 'OPERATOR_NOT_CONFIGURED'
  // Storefront / theme safety
  | 'THEME_PROTECTED'
  // Dev/test tooling attempted to write to a non-development store
  | 'LIVE_STORE_WRITE_BLOCKED'
  // ---- Research push safety ----------------------------------------------
  /**
   * The analysis the operator reviewed is no longer the current one.
   *
   * Raised BEFORE any Shopify write. The operator approved a specific
   * recommendation and price; if the underlying costs, settings or store history
   * have moved since, pushing would create a product on a decision nobody
   * approved. The fix is to re-read and re-approve, never to substitute the new
   * numbers silently.
   */
  | 'RECOMMENDATION_CHANGED'
  /**
   * Another push for this candidate holds the claim.
   *
   * Distinct from IDEMPOTENCY_IN_PROGRESS: that means "this exact request is
   * already running", whereas this means "a DIFFERENT operation owns this
   * candidate". Both are 409, and conflating them would tell the operator to
   * retry when they should wait.
   */
  | 'RESEARCH_PUSH_IN_PROGRESS'
  /** The candidate already has a Shopify draft. Pushing again would duplicate it. */
  | 'RESEARCH_ALREADY_PUSHED'
  /**
   * This operation's push claim was taken over by another operation before it could
   * create the product. 409. Zero Shopify writes happened; the operator refreshes and
   * retries. Distinct from RESEARCH_PUSH_IN_PROGRESS, which is raised when a push cannot
   * even start; this is raised when one started and then lost ownership mid-flight.
   */
  | 'PUSH_CLAIM_LOST'
  /*
   * The supplier sourceability gate on a research push. All 409: the request is
   * well-formed, but the product cannot be sourced right now. Deliberately DISTINCT from
   * SUPPLIER_UNAVAILABLE above, which is a 503 meaning the supplier INTEGRATION is down -
   * these mean a specific product's sourceability is not established.
   */
  /** The supplier has this product (or all its variants) marked unavailable. */
  | 'RESEARCH_SUPPLIER_UNAVAILABLE'
  /** Supplier availability has not been verified. Verify before pushing. */
  | 'RESEARCH_SUPPLIER_UNVERIFIED'
  /** Supplier availability was verified once but the check is now stale. Re-verify. */
  | 'RESEARCH_SUPPLIER_STALE'
  /** Requested variants are unavailable or unverified and the selection was not resolved. */
  | 'RESEARCH_SUPPLIER_VARIANTS'
  /**
   * A pushed product is in an unsafe state that could not be repaired.
   *
   * The only code in this group that may be a 500: a Shopify product exists and
   * Trademart could not verify it is hidden. It is never reported as a success,
   * and the response always carries the Shopify product id so a human can finish
   * the job by hand.
   */
  | 'RESEARCH_PUSH_SAFETY';

/**
 * The wire format for a failure.
 *
 * Two shapes are emitted at once, deliberately. The flat
 * `success/code/message/details` keys are what every existing client already
 * reads and must not break; the nested `error` object carries the same values
 * plus `requestId` and is the standardised taxonomy shape. Both are built from
 * the same source values, so they cannot disagree about what went wrong.
 */
export interface ErrorBody {
  success: false;
  code: ErrorCode;
  message: string;
  details?: unknown;
  /** Correlation id for this request. Present whenever the middleware ran. */
  requestId?: string;
  error: {
    code: ErrorCode;
    message: string;
    requestId?: string;
    details?: unknown;
  };
}

/**
 * An error that is safe to surface to the API client.
 * `message` must never contain a token, secret or raw credential.
 */
export class AppError extends Error {
  public readonly code: ErrorCode;
  public readonly status: number;
  public readonly details?: unknown;
  /** True when a retry could plausibly succeed (throttling, 5xx, network). */
  public readonly retryable: boolean;

  constructor(
    code: ErrorCode,
    message: string,
    options: { status?: number; details?: unknown; retryable?: boolean } = {},
  ) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = options.status ?? defaultStatusForCode(code);
    this.details = options.details;
    this.retryable = options.retryable ?? defaultRetryableForCode(code);
    Error.captureStackTrace?.(this, AppError);
  }

  /**
   * `requestId` is passed in rather than read from a global, so this class stays
   * import-free and unit testable in isolation.
   *
   * The construction itself lives in ./errorBody, which is the single source of
   * truth for the wire format - the storefront routers, the origin rejection and
   * the rate limiters all build their bodies from the same function, so no two
   * failure paths can disagree about the contract.
   */
  toBody(requestId?: string | null): ErrorBody {
    return buildErrorBody<ErrorCode>({
      code: this.code,
      message: this.message,
      details: this.details,
      requestId,
    });
  }
}

export function defaultStatusForCode(code: ErrorCode): number {
  switch (code) {
    case 'VALIDATION_ERROR':
    case 'OAUTH_INVALID_REQUEST':
    case 'AUTOMATION_RULES_INVALID':
      return 400;
    // 409: the request is valid but the store/config is not in a state where
    // writing would be safe (e.g. read_inventory missing, so costs are unknown).
    case 'AUTOMATION_PRECONDITION_FAILED':
      return 409;
    // 403: writes are switched off deliberately. Not a 503 - nothing is broken.
    case 'AUTOMATION_DISABLED':
      return 403;
    case 'SHOPIFY_UNAUTHORIZED':
    case 'SHOPIFY_AUTH_FAILED':
      return 401;
    case 'SHOPIFY_SCOPE_MISSING':
    case 'SHOPIFY_APP_NOT_INSTALLED':
      return 403;
    case 'WEBHOOK_INVALID_SIGNATURE':
      return 401;
    // Not signed in, or the session expired. 401 tells the frontend to show the
    // login screen; 403 would imply "signed in but not allowed".
    case 'UNAUTHORIZED':
    case 'LOGIN_FAILED':
      return 401;
    // Authenticated but the request could not be proven to be intentional.
    case 'CSRF_INVALID':
      return 403;
    // Refusing to modify the live theme is a deliberate safety refusal, not a
    // permission error - 409 (conflict with a safe-workflow rule).
    case 'THEME_PROTECTED':
      return 409;
    // A dev/test tool refused to mutate a live store. 403: not a bad request,
    // a deliberate safety refusal.
    case 'LIVE_STORE_WRITE_BLOCKED':
    case 'FORBIDDEN':
      return 403;
    // Apply was attempted without a valid, current, unused preview. 409: the
    // request conflicts with the required preview-then-apply workflow rather
    // than being malformed.
    case 'PREVIEW_REQUIRED':
    case 'PREVIEW_NOT_FOUND':
    case 'PREVIEW_EXPIRED':
    case 'PREVIEW_ALREADY_APPLIED':
    case 'PREVIEW_STALE':
      return 409;
    // A second automation apply arrived while one was already running.
    case 'AUTOMATION_ALREADY_RUNNING':
    // Every "the world moved under you" refusal is a conflict: the request was
    // fine, the state was not.
    case 'PRODUCT_CHANGED':
    case 'IDEMPOTENCY_CONFLICT':
    case 'IDEMPOTENCY_IN_PROGRESS':
    // The reviewed analysis is no longer current. Same family as PRODUCT_CHANGED:
    // the request was well-formed, the world moved.
    case 'RECOMMENDATION_CHANGED':
    // Another operation owns this candidate's push, or it is already pushed.
    case 'RESEARCH_PUSH_IN_PROGRESS':
    case 'RESEARCH_ALREADY_PUSHED':
    // A concurrent operation took the claim over mid-push. Nothing was created.
    case 'PUSH_CLAIM_LOST':
    // The supplier sourceability gate refused the push. The request was fine; the product
    // cannot be sourced (or that is unverified) right now.
    case 'RESEARCH_SUPPLIER_UNAVAILABLE':
    case 'RESEARCH_SUPPLIER_UNVERIFIED':
    case 'RESEARCH_SUPPLIER_STALE':
    case 'RESEARCH_SUPPLIER_VARIANTS':
    case 'INVENTORY_DELTA_TOO_LARGE':
    // Refusing to price is a state conflict, not a bad request: the caller asked
    // for something reasonable and the data is not good enough to do it safely.
    case 'COST_UNKNOWN':
    case 'CURRENCY_MISMATCH':
      return 409;
    // A failed HMAC or state check is an authentication failure, not a 400:
    // the request was well-formed but could not be proven to come from Shopify.
    case 'OAUTH_INVALID_HMAC':
    case 'OAUTH_STATE_INVALID':
      return 401;
    case 'NOT_FOUND':
    case 'SHOPIFY_NOT_FOUND':
      return 404;
    case 'SHOPIFY_THROTTLED':
    case 'RATE_LIMITED':
      return 429;
    case 'SHOPIFY_NOT_CONFIGURED':
    case 'WEBHOOK_NOT_CONFIGURED':
    case 'OAUTH_NOT_CONFIGURED':
    case 'ENCRYPTION_NOT_CONFIGURED':
    // No operator credentials configured at all. 503, not 401: nobody can sign
    // in, so this is a server configuration fault rather than a bad attempt.
    case 'OPERATOR_NOT_CONFIGURED':
      return 503;
    case 'DATABASE_UNAVAILABLE':
    // A verified delivery that could not be stored. 503 so the sender retries
    // into a healthy process rather than the event being lost behind a 2xx.
    case 'WEBHOOK_NOT_PERSISTED':
    // The dependency is unhealthy; come back later. Honest 503 semantics.
    case 'SHOPIFY_DEGRADED':
    case 'SUPPLIER_UNAVAILABLE':
      return 503;
    // 504: we gave up waiting on an upstream, which is not the same as it
    // refusing us or being unreachable.
    case 'SHOPIFY_TIMEOUT':
      return 504;
    case 'SHOPIFY_NETWORK_ERROR':
      return 502;
    case 'SHOPIFY_HTTP_ERROR':
    case 'SHOPIFY_GRAPHQL_ERROR':
    case 'SHOPIFY_USER_ERROR':
    case 'WEBHOOK_REGISTRATION_FAILED':
    // Created but not published. Upstream-caused, and the product is left DRAFT
    // so the resulting state is safe.
    case 'PUBLICATION_FAILED':
      return 502;
    // A Shopify product exists and Trademart could not verify it is hidden. Listed
    // explicitly rather than left to the `default` below, because this switch
    // silently turns an unlisted code into a 500 and a safety incident is exactly
    // the case that must not depend on a fallthrough nobody noticed.
    case 'RESEARCH_PUSH_SAFETY':
      return 500;
    case 'INTERNAL_ERROR':
    default:
      return 500;
  }
}

/**
 * Permission problems are NEVER retryable - retrying a missing scope forever
 * is exactly the behaviour the brief forbids.
 *
 * The same reasoning applies to every OAuth failure: a rejected HMAC, a replayed
 * state and a missing APP_URL are all deterministic. Retrying an unverifiable
 * callback would turn a rejected handshake into a retry loop against Shopify.
 */
export function defaultRetryableForCode(code: ErrorCode): boolean {
  switch (code) {
    case 'SHOPIFY_THROTTLED':
    case 'SHOPIFY_NETWORK_ERROR':
    case 'SHOPIFY_TIMEOUT':
    case 'SHOPIFY_DEGRADED':
    // Publication is an ordinary Shopify write, so a transient failure can
    // genuinely succeed on a later, operator-initiated attempt.
    case 'PUBLICATION_FAILED':
    // Mongo being briefly unreachable is the textbook transient failure: the
    // same request, sent again once storage is back, is expected to succeed.
    // Marking it non-retryable would tell a webhook sender and a client alike to
    // give up on a problem that fixes itself.
    case 'DATABASE_UNAVAILABLE':
    case 'WEBHOOK_NOT_PERSISTED':
      return true;
    case 'OAUTH_NOT_CONFIGURED':
    case 'OAUTH_INVALID_REQUEST':
    case 'OAUTH_INVALID_HMAC':
    case 'OAUTH_STATE_INVALID':
    case 'ENCRYPTION_NOT_CONFIGURED':
    case 'WEBHOOK_REGISTRATION_FAILED':
    // Retrying a write that was refused on purpose would be a way to defeat
    // the guardrail, so these are never retryable.
    case 'AUTOMATION_DISABLED':
    case 'AUTOMATION_RULES_INVALID':
    case 'AUTOMATION_PRECONDITION_FAILED':
    // Retrying an auth failure with the same credentials cannot succeed, and
    // automatic retries on a login route are indistinguishable from an attack.
    case 'UNAUTHORIZED':
    case 'CSRF_INVALID':
    case 'LOGIN_FAILED':
    case 'OPERATOR_NOT_CONFIGURED':
    case 'THEME_PROTECTED':
    // A stale recommendation needs a HUMAN to review the new one. An automatic
    // retry would resubmit the same rejected decision hash forever, and a client
    // that "helpfully" retried until it worked would defeat the review gate.
    case 'RECOMMENDATION_CHANGED':
    // The product already exists. Retrying cannot improve the outcome and the
    // point of the refusal is to stop a second one being created.
    case 'RESEARCH_ALREADY_PUSHED':
    // A claim is held. Recovery is by lease expiry, not by a client retry loop.
    case 'RESEARCH_PUSH_IN_PROGRESS':
    // Ownership was lost mid-push. The operator must refresh to see who won before
    // retrying; an automatic retry would race the operation that took over.
    case 'PUSH_CLAIM_LOST':
    // Each needs a human to verify the supplier or resolve variant selection. An
    // automatic retry would resubmit the same unsourceable decision.
    case 'RESEARCH_SUPPLIER_UNAVAILABLE':
    case 'RESEARCH_SUPPLIER_UNVERIFIED':
    case 'RESEARCH_SUPPLIER_STALE':
    case 'RESEARCH_SUPPLIER_VARIANTS':
    // A product exists in an unverified state. This needs a person, not a retry.
    case 'RESEARCH_PUSH_SAFETY':
      return false;
    default:
      return false;
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

/** Normalises anything thrown into an AppError without leaking internals. */
export function toAppError(value: unknown): AppError {
  if (isAppError(value)) return value;
  if (value instanceof Error) {
    return new AppError('INTERNAL_ERROR', value.message);
  }
  return new AppError('INTERNAL_ERROR', 'An unexpected error occurred.');
}
