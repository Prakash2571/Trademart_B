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
];

const SECRET_KEY = /(token|secret|password|authorization|apikey|api_key|credential)/i;

export function redact(value: string): string {
  return SECRET_PATTERNS.reduce(
    (acc, pattern) => acc.replace(pattern, '[REDACTED]'),
    value,
  );
}

function redactMeta(meta: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (SECRET_KEY.test(key)) {
      out[key] = '[REDACTED]';
    } else if (typeof value === 'string') {
      out[key] = redact(value);
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = redactMeta(value as Record<string, unknown>);
    } else {
      out[key] = value;
    }
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
  // Correlation fields go on every line without any caller having to pass them.
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
