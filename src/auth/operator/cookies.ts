/**
 * Minimal cookie parsing and serialisation.
 *
 * Hand-rolled rather than adding `cookie`/`cookie-parser`: this needs one parse
 * and one serialise, both small and well-specified, and the project's six-
 * dependency footprint is worth keeping. Pure, so the attribute logic is unit
 * testable.
 */

/** Name of the HttpOnly session cookie. */
export const SESSION_COOKIE = 'trademart_session';
/**
 * Name of the CSRF cookie. Deliberately NOT HttpOnly - the frontend has to read
 * it to echo it back in the X-CSRF-Token header.
 */
export const CSRF_COOKIE = 'trademart_csrf';
/** Header the CSRF token is echoed in. */
export const CSRF_HEADER = 'x-csrf-token';

export interface CookieOptions {
  /** Omit for a session cookie that dies with the browser. */
  maxAgeSeconds?: number;
  httpOnly?: boolean;
  /** Set false only for local http development. */
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
  path?: string;
}

/**
 * Parses a Cookie header into a map.
 *
 * Tolerant by design: a malformed pair is skipped rather than throwing, because
 * browsers and proxies do occasionally send junk and one bad cookie must not
 * fail an otherwise valid request.
 */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (header === undefined || header.length === 0) return out;

  for (const segment of header.split(';')) {
    const separator = segment.indexOf('=');
    if (separator <= 0) continue;
    const name = segment.slice(0, separator).trim();
    if (name.length === 0) continue;
    const raw = segment.slice(separator + 1).trim();
    // Quoted values are legal per RFC 6265.
    const unquoted =
      raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')
        ? raw.slice(1, -1)
        : raw;
    try {
      out[name] = decodeURIComponent(unquoted);
    } catch {
      // A stray '%' makes decodeURIComponent throw; keep the raw text.
      out[name] = unquoted;
    }
  }
  return out;
}

/** Serialises one Set-Cookie value. */
export function serialiseCookie(
  name: string,
  value: string,
  options: CookieOptions = {},
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];

  parts.push(`Path=${options.path ?? '/'}`);
  if (options.maxAgeSeconds !== undefined) {
    parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`);
  }
  if (options.httpOnly !== false) parts.push('HttpOnly');
  if (options.secure !== false) parts.push('Secure');
  parts.push(`SameSite=${options.sameSite ?? 'Lax'}`);

  return parts.join('; ');
}

/**
 * Serialises a cookie that clears an existing one.
 *
 * Max-Age=0 AND an empty value: some proxies ignore one or the other, and the
 * attributes must otherwise match the original or the browser treats it as a
 * different cookie and leaves the real one in place.
 */
export function clearCookie(name: string, options: CookieOptions = {}): string {
  return serialiseCookie(name, '', { ...options, maxAgeSeconds: 0 });
}
