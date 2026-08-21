/**
 * Per-request correlation context.
 *
 * The problem this solves: when an operator says "publishing that product
 * failed", the evidence is spread across nginx, this backend, a Shopify GraphQL
 * call, an audit row and a webhook worker. Without a shared id those are five
 * unrelated log streams.
 *
 * `AsyncLocalStorage` carries the id implicitly through every await in a
 * request, so nothing has to thread a `requestId` parameter through every
 * function signature just to be able to log it. Deep code (the Shopify client,
 * the audit writer, the logger) reads it directly.
 *
 * Kept free of Express imports so it also works in the webhook worker and in
 * scripts, neither of which has a `req`.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export interface RequestContext {
  /** Correlation id. Echoed to the client as the X-Request-ID response header. */
  requestId: string;
  method: string | null;
  path: string | null;
  /** Operator username once authentication has run. Never a credential. */
  actor: string | null;
  /** How the caller authenticated: 'session' | 'apiKey' | 'shopifyHmac' | null. */
  authMethod: string | null;
  /**
   * Set for work that is not an HTTP request at all (the webhook worker,
   * scheduled jobs), so its logs are still attributable.
   */
  source: 'http' | 'webhook' | 'job' | 'script';
}

const storage = new AsyncLocalStorage<RequestContext>();

/**
 * Accepted shape for a client-supplied correlation id.
 *
 * Deliberately narrow. The value is echoed back in a response header and
 * written into logs, so allowing arbitrary text would let a caller inject
 * newlines into the log stream or control characters into a header.
 */
const VALID_REQUEST_ID = /^[A-Za-z0-9._~-]{8,128}$/;

export function isValidRequestId(value: unknown): value is string {
  return typeof value === 'string' && VALID_REQUEST_ID.test(value);
}

export function newRequestId(): string {
  return randomUUID();
}

/**
 * Reuses a caller-supplied id when it is well-formed, otherwise mints one.
 *
 * Reuse matters for tracing: nginx (or a frontend fetch) can stamp the id once
 * and the whole chain will agree on it.
 */
export function resolveRequestId(supplied: unknown): string {
  return isValidRequestId(supplied) ? supplied : newRequestId();
}

export function createContext(
  requestId: string,
  overrides: Partial<Omit<RequestContext, 'requestId'>> = {},
): RequestContext {
  return {
    requestId,
    method: overrides.method ?? null,
    path: overrides.path ?? null,
    actor: overrides.actor ?? null,
    authMethod: overrides.authMethod ?? null,
    source: overrides.source ?? 'http',
  };
}

/** Runs `fn` with `context` visible to everything it awaits. */
export function runWithContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function getContext(): RequestContext | undefined {
  return storage.getStore();
}

/**
 * The current correlation id, or null outside any context.
 *
 * Returns null rather than minting one: a fresh id per log line would be worse
 * than no id at all, because it would look like correlation while correlating
 * nothing.
 */
export function getRequestId(): string | null {
  return storage.getStore()?.requestId ?? null;
}

/**
 * Records who the caller is, once authentication has established it.
 *
 * Mutates the existing store rather than creating a new one so the identity is
 * visible to code that already captured the context.
 */
export function setActor(actor: string | null, authMethod: string | null): void {
  const store = storage.getStore();
  if (store === undefined) return;
  store.actor = actor;
  store.authMethod = authMethod;
}
