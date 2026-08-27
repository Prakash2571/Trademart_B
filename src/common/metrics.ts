/**
 * In-process operational counters.
 *
 * WHY NOT PROMETHEUS
 * ------------------
 * This is one container serving one Shopify store. A metrics endpoint, a scrape
 * target, a time-series database and a dashboard is four new things to run and keep
 * alive in order to answer questions an operator asks a handful of times a week.
 * The questions themselves are worth answering, though: "are Shopify writes
 * failing?", "are payments failing verification?", "is the webhook queue backing
 * up?" - and before this there was no way to see any of them without reading logs.
 *
 * So: a fixed set of named counters, exposed through the operator-only diagnostics
 * endpoint alongside the queue depths that come from Mongo. If this deployment ever
 * grows to several instances, these become the natural /metrics output - the shape
 * is deliberately a flat name -> number map for that reason.
 *
 * DELIBERATE CONSTRAINTS
 * ----------------------
 * * The counter names are a CLOSED union. High-cardinality labels (an order id, a
 *   customer id, a product gid) are how a metrics system turns into an unbounded
 *   memory leak and an accidental PII export, so a counter cannot carry one.
 * * Counters are process-local and reset on restart, and say so. Anyone reading
 *   them as a billing-grade total would be wrong; they are for "is it happening
 *   now, and roughly how much".
 * * Incrementing must never throw or allocate meaningfully - it happens on failure
 *   paths, which are exactly where a second failure is most expensive.
 */

/** Every counter. Closed on purpose: see above. */
export const COUNTER_NAMES = [
  /** Shopify Admin API call failed after retries (any classified failure). */
  'shopify.request.failed',
  /** Shopify circuit breaker opened, so bulk writes are being refused. */
  'shopify.breaker.opened',
  /** A verified webhook could not be made durable, so it was refused with a 503. */
  'webhook.delivery.not_persisted',
  /** A webhook delivery was rejected: bad HMAC or unexpected shop domain. */
  'webhook.delivery.rejected',
  /** A webhook event exhausted its retries and is now FAILED. */
  'webhook.event.failed',
  /** Automation apply finished with at least one failed change. */
  'automation.apply.failed',
  /** A storefront checkout could not be created. */
  'storefront.checkout.failed',
  /** A Razorpay payment signature did not verify. */
  'storefront.payment.signature_invalid',
  /** A Razorpay payment verification failed for any other reason. */
  'storefront.payment.verify_failed',
  /** A paid order could not be created in Shopify (money captured, order pending). */
  'storefront.order.creation_failed',
  /** A dangerous write was refused because durable safety was unavailable. */
  'write.refused_no_durable_safety',
] as const;

export type CounterName = (typeof COUNTER_NAMES)[number];

const counters = new Map<CounterName, number>();
let since = new Date();

export function incrementCounter(name: CounterName, by = 1): void {
  counters.set(name, (counters.get(name) ?? 0) + by);
}

export interface CounterSnapshot {
  /** When this process last reset its counters (i.e. when it started). */
  since: string;
  /** Every counter, including the ones still at zero - absence is not information. */
  counters: Record<CounterName, number>;
}

/**
 * Reads all counters.
 *
 * Zeroes are included deliberately: a dashboard that shows nothing for
 * `storefront.payment.signature_invalid` cannot be distinguished from one that is
 * not wired up, and "definitely zero" is the answer an operator wants.
 */
export function snapshotCounters(): CounterSnapshot {
  const out = {} as Record<CounterName, number>;
  for (const name of COUNTER_NAMES) out[name] = counters.get(name) ?? 0;
  return { since: since.toISOString(), counters: out };
}

/** Test-only reset. Not called by the application. */
export function resetCounters(): void {
  counters.clear();
  since = new Date();
}
