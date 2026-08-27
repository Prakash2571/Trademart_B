/**
 * Masking credentials that live in a URL PATH before it reaches a log.
 *
 * `/api/storefront/orders/track/<token>` carries the customer's tracking token:
 * whoever holds it can read that order's status, name and address. The access log
 * was recording the full path, which put a working credential into a stream that is
 * shipped to aggregation, retained for months, and readable by people with no
 * business reading a customer's address.
 *
 * Masked rather than dropped: "is tracking being hammered?" is a real question an
 * operator asks, and the token contributes nothing to answering it.
 *
 * Kept in its own import-free module so it can be tested without booting the
 * configuration layer (httpLogger imports config, which exits the process when the
 * environment is not a real deployment).
 */

/** Route prefixes whose next path segment is a bearer credential. */
const TOKEN_PATH_PREFIXES = ['/api/storefront/orders/track/'] as const;

export function sanitiseLogPath(path: string): string {
  for (const prefix of TOKEN_PATH_PREFIXES) {
    if (path.startsWith(prefix) && path.length > prefix.length) {
      return `${prefix}:token`;
    }
  }
  return path;
}
