/**
 * Age of the oldest still-pending item in a queue.
 *
 * The single most useful queue number, and the one that was missing: DEPTH cannot
 * distinguish "busy" from "stuck". A queue of 400 that drains in a second is
 * healthy; a queue of 1 that has been sitting for an hour is an incident, and both
 * look identical if all you report is a count.
 *
 * Its own import-free module so it is testable without booting the configuration
 * layer, which diagnostics/operations.ts pulls in through the queue and database
 * modules.
 */
export function oldestPendingAgeSeconds(
  oldestPendingIso: string | null,
  now: Date,
): number | null {
  if (oldestPendingIso === null) return null;
  const then = new Date(oldestPendingIso).getTime();
  if (Number.isNaN(then)) return null;
  // Never negative: clock skew between this process and Mongo is normal, and a
  // nonsensical negative age would undermine trust in the whole report.
  return Math.max(0, Math.round((now.getTime() - then) / 1000));
}
