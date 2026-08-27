/**
 * ONE place that builds a failure body.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every JSON failure leaving this service is supposed to look like:
 *
 *   { success: false, code, message, details?, requestId?,
 *     error: { code, message, requestId?, details? } }
 *
 * Both shapes at once, on purpose: the flat keys are what existing clients read,
 * and the nested `error` object is the standardised taxonomy shape that carries
 * the correlation id. They must never disagree about what went wrong.
 *
 * There were THREE hand-written copies of that construction: AppError.toBody for
 * the operator API, and one each in the storefront checkout and orders routers -
 * plus two more bodies that skipped it entirely (the storefront origin rejection
 * and the rate-limit responses), which answered with the flat keys only and NO
 * requestId. A customer hitting a rate limit therefore got a failure with nothing
 * to quote, and the frontend's "prefer the nested error, fall back to flat" branch
 * silently took the fallback path.
 *
 * Divergence between copies of an error contract is not cosmetic: the admin
 * console keys its retry decisions and its explanations off `code`, and an
 * operator diagnosing a failure has nothing but `requestId` to search the logs
 * with. So the construction lives here, once, and callers pass values in.
 */

/**
 * Generic over the code type so a caller with a narrow union (AppError's
 * ErrorCode, StorefrontError's StorefrontErrorCode) keeps its own type on the way
 * out instead of widening to string and needing a cast at every call site.
 */
export interface ApiErrorBody<Code extends string = string> {
  success: false;
  code: Code;
  message: string;
  details?: unknown;
  requestId?: string;
  error: {
    code: Code;
    message: string;
    requestId?: string;
    details?: unknown;
  };
}

export interface ErrorBodyInput<Code extends string = string> {
  code: Code;
  message: string;
  details?: unknown;
  requestId?: string | null | undefined;
}

/**
 * Builds the canonical failure body.
 *
 * `details` is omitted rather than set to undefined so JSON.stringify does not
 * produce a key with no value, and `requestId` is omitted when the request-id
 * middleware has not run (a unit test, a worker) rather than reported as null -
 * a client checking `if (body.requestId)` must not be handed a falsy string.
 */
export function buildErrorBody<Code extends string>(
  input: ErrorBodyInput<Code>,
): ApiErrorBody<Code> {
  const nested: ApiErrorBody<Code>['error'] = { code: input.code, message: input.message };
  if (input.requestId !== undefined && input.requestId !== null) {
    nested.requestId = input.requestId;
  }
  if (input.details !== undefined) nested.details = input.details;

  const body: ApiErrorBody<Code> = {
    success: false,
    code: input.code,
    message: input.message,
    error: nested,
  };
  if (input.details !== undefined) body.details = input.details;
  if (input.requestId !== undefined && input.requestId !== null) {
    body.requestId = input.requestId;
  }
  return body;
}
