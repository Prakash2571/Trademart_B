/**
 * Store-level automation apply lock.
 *
 * Two automation applies must never run concurrently: an operator double-click,
 * or a manual apply racing a webhook-triggered run, could rewrite overlapping
 * products and interleave price/visibility changes unpredictably. This is a
 * single-store deployment, so a process-local mutex is sufficient and correct
 * (Node is single-threaded; the acquire below is synchronous, so the check and
 * set cannot interleave). No Redis/distributed lock is warranted at this scale.
 *
 * Preview never acquires the lock - only a real apply does.
 */

import { AppError } from '../common/errors';

export interface ActiveAutomationRun {
  startedAt: string;
  trigger: string;
  requestId: string | null;
}

let active: ActiveAutomationRun | null = null;

/**
 * Acquires the apply lock or throws AUTOMATION_ALREADY_RUNNING (409). Synchronous
 * on purpose: called before the first await in executePreparedPlan so a second
 * apply arriving mid-run is rejected immediately rather than queued.
 */
export function acquireAutomationLock(info: {
  trigger: string;
  requestId?: string | null;
}): void {
  if (active !== null) {
    throw new AppError(
      'AUTOMATION_ALREADY_RUNNING',
      `An automation apply is already running (started ${active.startedAt}, trigger ${active.trigger}). Wait for it to finish, then preview and apply again.`,
      { details: { activeRun: active } },
    );
  }
  active = {
    startedAt: new Date().toISOString(),
    trigger: info.trigger,
    requestId: info.requestId ?? null,
  };
}

/** Releases the lock. Safe to call even if not held. */
export function releaseAutomationLock(): void {
  active = null;
}

/** The currently running apply, or null. For diagnostics/status. */
export function currentAutomationRun(): ActiveAutomationRun | null {
  return active;
}

/** Test-only: force-clears the lock. */
export function _resetAutomationLockForTest(): void {
  active = null;
}
