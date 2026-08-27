/**
 * Minimal structured logger with secret redaction.
 *
 * Access tokens must never reach stdout, so every message and metadata value
 * is passed through a redactor before printing.
 */

import { getContext } from './requestContext';

const SECRET_PATTERNS: RegExp[] = [
  /shpat_[A-Za-z0-9]+/g, // Admin API access token
  /shpss_[A-Za-z0-9]+/g, // app secret
  /shpca_[A-Za-z0-9]+/g, // custom app token
  /shppa_[A-Za-z0-9]+/g, // private app token
  /mongodb(\+srv)?:\/\/[^\s"']*/g, // connection strings embed credentials
  // Razorpay live/test API keys. The id alone is not a credential, but it appears
  // next to the secret often enough that logging the pair is a real risk, and a
  // redacted id costs nothing to diagnose with (the payment id is the useful one).
  /rzp_(test|live)_[A-Za-z0-9]+/g,
];

/**
 * Field names whose values are never printed.
 *
 * Matched on the KEY, so a newly-added field called `clientSecret` or
 * `razorpay_signature` is redacted without anyone remembering to update this list.
 *
 * Three groups, for three different reasons:
 *
 *   CREDENTIALS  - a token, secret, cookie or signature in a log is a credential in
 *                  a log. `signature` was missing until now, which meant a debug
 *                  line carrying a Razorpay webhook's `razorpay_signature` would
 *                  have printed it verbatim.
 *   PERSONAL     - a customer's email, phone or address is not needed to diagnose a
 *                  failed checkout; the checkout's public id is. Logs are copied to
 *                  places with weaker access control than the database, so PII in
 *                  them is a liability with no operational upside.
 *   BULK         - a webhook `payload` or a full `customer`/`address` object drags
 *                  both of the above in by accident.
 */
const SECRET_KEY =
  /(token|secret|password|passwordhash|authorization|apikey|api_key|credential|cookie|session|encryptionkey|signature|hmac)/i;

/** Personal data and bulk objects that tend to contain it. */
const PERSONAL_KEY =
  /^(email|phone|contact|fullname|full_name|firstname|lastname|address|shippingaddress|shipping_address|billingaddress|line1|line2|postalcode|postal_code|zip|customer|payload|body|rawbody)$/i;

export function redact(value: string): string {
  return SECRET_PATTERNS.reduce(
    (acc, pattern) => acc.replace(pattern, '[REDACTED]'),
    value,
  );
}

/** True when this field name must never have its value printed. */
export function isRedactedKey(key: string): boolean {
  return SECRET_KEY.test(key) || PERSONAL_KEY.test(key);
}

/**
 * Depth cap.
 *
 * A cycle would recurse forever and a deeply nested Shopify payload would produce a
 * log line nobody reads. Both are better truncated than either crashing the process
 * inside the logger or filling a disk.
 */
const MAX_DEPTH = 8;

function redactValue(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return '[truncated: too deep]';
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) {
    // Arrays were previously passed through UNTOUCHED, so an array of strings
    // containing a token - `{ scopes: [...] }`, `{ errors: [...] }` - was printed
    // verbatim while the same string in an object field was redacted.
    return value.map((item) => redactValue(item, depth + 1));
  }
  if (value !== null && typeof value === 'object') {
    return redactMeta(value as Record<string, unknown>, depth + 1);
  }
  return value;
}

function redactMeta(
  meta: Record<string, unknown>,
  depth = 0,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (isRedactedKey(key)) {
      out[key] = '[REDACTED]';
      continue;
    }
    out[key] = redactValue(value, depth);
  }
  return out;
}

type Level = 'debug' | 'info' | 'warn' | 'error';

function emit(level: Level, message: string, meta?: Record<string, unknown>): void {
  const context = getContext();
  const line: Record<string, unknown> = {
    level,
    // Always UTC. A server whose local timezone leaked into timestamps makes
    // correlating with Shopify's own timestamps needlessly hard.
    time: new Date().toISOString(),
    message: redact(message),
  };
  // Correlation fields land on every line without any caller passing them, which
  // is what makes one X-Request-ID span nginx -> backend -> Shopify -> audit.
  if (context !== undefined) {
    line['requestId'] = context.requestId;
    if (context.source !== 'http') line['source'] = context.source;
    if (context.actor !== null) line['actor'] = context.actor;
  }
  if (meta && Object.keys(meta).length > 0) {
    Object.assign(line, redactMeta(meta));
  }
  const serialised = JSON.stringify(line);
  if (level === 'error') console.error(serialised);
  else if (level === 'warn') console.warn(serialised);
  else console.log(serialised);
}

export const logger = {
  debug: (message: string, meta?: Record<string, unknown>) => {
    if (process.env.NODE_ENV !== 'production') emit('debug', message, meta);
  },
  info: (message: string, meta?: Record<string, unknown>) => emit('info', message, meta),
  warn: (message: string, meta?: Record<string, unknown>) => emit('warn', message, meta),
  error: (message: string, meta?: Record<string, unknown>) => emit('error', message, meta),
};
