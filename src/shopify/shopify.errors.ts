/**
 * Translates Shopify failures into Trademart AppErrors.
 *
 * Pure (only imports the pure error model) so it is fully unit testable with
 * recorded/mocked Shopify payloads and no network access.
 *
 * Reference: https://shopify.dev/docs/api/admin-graphql
 *            https://shopify.dev/docs/api/usage/response-codes
 */

import { AppError } from '../common/errors';
import { redact } from '../common/logger';

/** Shape of an entry in the top-level GraphQL `errors` array. */
export interface ShopifyGraphqlError {
  message?: string;
  extensions?: {
    code?: string;
    documentation?: string;
    requestId?: string;
    [key: string]: unknown;
  } | null;
  path?: (string | number)[];
  [key: string]: unknown;
}

/** Shape of a mutation `userErrors` entry. */
export interface ShopifyUserError {
  field?: string[] | null;
  message?: string;
  code?: string | null;
}

/**
 * Shopify signals a missing scope with extensions.code = ACCESS_DENIED and a
 * message naming the required scope. Protected customer data rejections use
 * wording about app approval instead.
 */
const SCOPE_HINTS = [
  'access denied',
  'required access',
  'not approved',
  'protected customer data',
  'app is not approved',
];

function looksLikeScopeProblem(message: string): boolean {
  const lower = message.toLowerCase();
  return SCOPE_HINTS.some((hint) => lower.includes(hint));
}

function friendlyScopeMessage(message: string): string {
  const scope = /`?(read|write)_[a-z_]+`?/i.exec(message)?.[0]?.replace(/`/g, '');
  if (scope) {
    return `The Trademart Shopify app is missing the "${scope}" access scope. Add it to the app configuration, release a new app version, then reinstall/update the app on the store.`;
  }
  return `Shopify denied access to this data: ${message}`;
}

/**
 * Maps a non-2xx HTTP response from the Admin API.
 * `bodyText` is used only for classification; it is never echoed verbatim for
 * auth failures, to avoid reflecting credentials.
 */
export function mapHttpFailure(status: number, bodyText: string): AppError {
  const snippet = bodyText.slice(0, 300);

  if (status === 401) {
    return new AppError(
      'SHOPIFY_UNAUTHORIZED',
      'Shopify rejected the Admin API access token (401). Check SHOPIFY_ACCESS_TOKEN and that the app is installed on this store.',
    );
  }

  if (status === 403) {
    return new AppError(
      'SHOPIFY_SCOPE_MISSING',
      'Shopify returned 403 Forbidden. The app is likely missing a required access scope, or the store is not approved for this data.',
    );
  }

  if (status === 404) {
    return new AppError(
      'SHOPIFY_NOT_FOUND',
      'Shopify returned 404 for the GraphQL endpoint. Verify SHOPIFY_STORE_DOMAIN is the .myshopify.com domain and SHOPIFY_API_VERSION exists.',
    );
  }

  if (status === 402) {
    return new AppError(
      'SHOPIFY_HTTP_ERROR',
      'Shopify returned 402 Payment Required - the store is frozen or unavailable for API access.',
      { retryable: false },
    );
  }

  if (status === 423) {
    return new AppError('SHOPIFY_HTTP_ERROR', 'The Shopify store is locked (423).', {
      retryable: false,
    });
  }

  if (status === 429) {
    return new AppError(
      'SHOPIFY_THROTTLED',
      'Shopify rate limit reached (429). The request was retried and still throttled - please slow down and try again.',
      { retryable: true },
    );
  }

  if (status >= 500) {
    return new AppError(
      'SHOPIFY_HTTP_ERROR',
      `Shopify returned a server error (${status}). This is usually temporary.`,
      { retryable: true, details: { status, body: snippet } },
    );
  }

  return new AppError(
    'SHOPIFY_HTTP_ERROR',
    `Unexpected Shopify HTTP response (${status}).`,
    { details: { status, body: snippet } },
  );
}

/**
 * Maps the top-level GraphQL `errors` array. Returns null when the array is
 * absent/empty so callers can proceed to read `data`.
 */
export function mapGraphqlErrors(
  errors: ShopifyGraphqlError[] | null | undefined,
): AppError | null {
  if (!errors || errors.length === 0) return null;

  const first = errors[0];
  const message = first?.message ?? 'Unknown GraphQL error.';
  const code = first?.extensions?.code ?? undefined;
  const requestId = first?.extensions?.requestId;
  const details = {
    shopifyCode: code,
    requestId,
    errors: errors.map((e) => ({ message: e.message, code: e.extensions?.code })),
  };

  // Throttling is reported inside a 200 response with extensions.code THROTTLED.
  if (code === 'THROTTLED') {
    return new AppError(
      'SHOPIFY_THROTTLED',
      'Shopify throttled this GraphQL query (query cost exceeded the available points).',
      { retryable: true, details },
    );
  }

  if (code === 'ACCESS_DENIED' || looksLikeScopeProblem(message)) {
    return new AppError('SHOPIFY_SCOPE_MISSING', friendlyScopeMessage(message), {
      details,
    });
  }

  if (code === 'UNAUTHENTICATED') {
    return new AppError(
      'SHOPIFY_UNAUTHORIZED',
      'Shopify could not authenticate the request. The access token may be invalid or revoked.',
      { details },
    );
  }

  if (code === 'MAX_COST_EXCEEDED') {
    return new AppError(
      'SHOPIFY_GRAPHQL_ERROR',
      'The GraphQL query is too expensive for Shopify to run. Request fewer fields or a smaller page size.',
      { details },
    );
  }

  return new AppError('SHOPIFY_GRAPHQL_ERROR', `Shopify GraphQL error: ${message}`, {
    details,
  });
}

/**
 * Maps a mutation's `userErrors`. Returns null when there are none.
 * Kept available for future write operations - reads never populate it.
 */
export function mapUserErrors(
  userErrors: ShopifyUserError[] | null | undefined,
): AppError | null {
  if (!userErrors || userErrors.length === 0) return null;
  const summary = userErrors
    .map((e) => {
      const field = e.field?.filter(Boolean).join('.');
      return field ? `${field}: ${e.message ?? 'invalid'}` : (e.message ?? 'invalid');
    })
    .join('; ');
  return new AppError('SHOPIFY_USER_ERROR', `Shopify rejected the operation: ${summary}`, {
    status: 422,
    details: { userErrors },
  });
}

/**
 * Maps a failed POST /admin/oauth/access_token (client credentials grant).
 *
 * Shopify returns OAuth-style bodies: `{ error, error_description }`. The two
 * failures that actually happen in practice are wrong client credentials and
 * the app not being installed on the shop, which need very different fixes -
 * so they are distinguished rather than collapsed into "unauthorized".
 *
 * None of these are retryable: retrying a bad secret forever is pointless.
 */
export function mapTokenFailure(
  status: number,
  body: { error?: unknown; error_description?: unknown },
): AppError {
  const error = typeof body.error === 'string' ? body.error : '';
  const rawDescription =
    typeof body.error_description === 'string' ? body.error_description : '';

  // Anything echoed back to the client is redacted first. Shopify does not
  // normally include credentials in an error, but a message that is surfaced
  // over HTTP must never be capable of leaking one.
  const description = redact(rawDescription);

  const combined = `${error} ${rawDescription}`.toLowerCase();
  // Matched separately: joining `error` and the description can create
  // accidental substrings (e.g. "invalid_client" + "secret").
  const descriptionText = rawDescription.toLowerCase();
  const details = { status, error: error || undefined, description: description || undefined };

  // Documented responses when the app has not been installed on the store.
  // Shopify uses several wordings: "Client credentials cannot be performed on
  // this shop.", "The application is not installed on this shop." and the
  // machine code "app_not_installed".
  if (
    combined.includes('cannot be performed on this shop') ||
    combined.includes('not installed') ||
    combined.includes('not_installed')
  ) {
    return new AppError(
      'SHOPIFY_APP_NOT_INSTALLED',
      'Shopify refused the client credentials grant: the app is not installed on this store. Install it on the store, then retry. For an app with no OAuth endpoint, declare [access_scopes] in shopify.app.toml and run "shopify app deploy" so Shopify can perform a managed installation. Note the grant also requires the app and the store to belong to the same Shopify organization.',
      { details },
    );
  }

  // Shopify names the offending field, e.g. "Missing or invalid client secret".
  // Pass that through with the specific remedy attached.
  if (descriptionText.includes('client secret')) {
    // Shopify named the secret, which means it matched client_id to an app
    // first - so the client id is fine and only the secret is wrong.
    return new AppError(
      'SHOPIFY_AUTH_FAILED',
      `Shopify rejected the client secret (HTTP ${status}: "${description}"). The client ID was accepted, so only SHOPIFY_CLIENT_SECRET is wrong. Regenerate or re-copy the client secret from the SAME app that owns this client ID, then restart the backend.`,
      { details },
    );
  }

  if (descriptionText.includes('client id') || descriptionText.includes('client_id')) {
    return new AppError(
      'SHOPIFY_AUTH_FAILED',
      'Shopify rejected the client ID. Copy SHOPIFY_CLIENT_ID again from Dev Dashboard -> your app -> Settings and restart the backend.',
      { details },
    );
  }

  if (status === 401 || status === 403 || combined.includes('invalid_client')) {
    return new AppError(
      'SHOPIFY_AUTH_FAILED',
      'Shopify rejected the app credentials. Check SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET match the app in the Dev Dashboard.',
      { details },
    );
  }

  if (combined.includes('unsupported_grant_type') || combined.includes('invalid_grant')) {
    return new AppError(
      'SHOPIFY_AUTH_FAILED',
      'Shopify rejected the client credentials grant for this app. Confirm the app supports the client credentials grant in the Dev Dashboard.',
      { details },
    );
  }

  if (status === 404) {
    return new AppError(
      'SHOPIFY_AUTH_FAILED',
      'The token endpoint returned 404. Verify SHOPIFY_STORE_DOMAIN is the .myshopify.com domain.',
      { details },
    );
  }

  if (status === 429) {
    return new AppError(
      'SHOPIFY_THROTTLED',
      'Shopify throttled the access token request. Retrying shortly.',
      { retryable: true, details },
    );
  }

  if (status >= 500) {
    return new AppError(
      'SHOPIFY_AUTH_FAILED',
      `Shopify returned ${status} while issuing an access token. This is usually temporary.`,
      { retryable: true, details },
    );
  }

  return new AppError(
    'SHOPIFY_AUTH_FAILED',
    description.length > 0
      ? `Could not obtain a Shopify access token: ${description}`
      : `Could not obtain a Shopify access token (HTTP ${status}).`,
    { details },
  );
}

/**
 * Maps fetch/DNS/timeout failures.
 *
 * A timeout gets its own code rather than sharing SHOPIFY_NETWORK_ERROR, because
 * the two mean different things operationally and lead to different fixes. A
 * network error is usually DNS or egress - the request never landed, so nothing
 * happened on Shopify's side. A TIMEOUT is genuinely ambiguous: the request may
 * well have been applied and we simply stopped waiting for the answer. That
 * distinction matters for a write: after a timeout the safe move is to re-read
 * the resource, not to blindly resend the mutation.
 */
export function mapNetworkFailure(error: unknown): AppError {
  const reason = error instanceof Error ? error.message : 'Unknown network error.';
  if (/abort|timeout|timed out/i.test(reason)) {
    return new AppError(
      'SHOPIFY_TIMEOUT',
      'The request to Shopify timed out. If this was a write it may still have been applied, so the resource is re-read rather than the write being repeated.',
      { retryable: true, details: { reason } },
    );
  }
  return new AppError(
    'SHOPIFY_NETWORK_ERROR',
    `Could not reach the Shopify Admin API: ${reason}`,
    { retryable: true, details: { reason } },
  );
}
