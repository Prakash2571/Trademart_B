/**
 * Server-side preview -> apply enforcement.
 *
 * The frontend gates Apply behind a successful preview, but a client gate is
 * advisory only: a direct API caller could POST /automation/apply and skip it
 * entirely, changing live prices with nothing reviewed. This makes the rule
 * authoritative on the server.
 *
 * A preview issues a signed-by-existence token bound to:
 *   - the effective rules it was computed against (rulesHash)
 *   - the connected store (storeDomain)
 *   - a generation time and a short expiry
 *
 * Apply must present that previewId. The token is rejected when it is unknown,
 * expired, already used, from a different store, or when the effective rules
 * have changed since the preview (rulesHash mismatch). It is single-use.
 *
 * In-memory by design. The backend runs as a single instance in the Compose
 * deployment, and previews are ephemeral, so this needs no database or shared
 * cache (and the project explicitly avoids Redis/etc.). A process restart
 * simply invalidates outstanding previews, which fails safe: apply refuses and
 * the operator previews again.
 */

import { createHash, randomUUID } from 'node:crypto';

import { AppError } from '../common/errors';
import type { AutomationRules } from './rules.types';

/** How long a preview can be applied before it must be regenerated. */
export const PREVIEW_TTL_MS = 10 * 60_000;

interface PreviewRecord {
  previewId: string;
  rulesHash: string;
  storeDomain: string;
  /** Replayed verbatim on apply so the applied scope matches the preview. */
  query: string | undefined;
  maxProducts: number | undefined;
  /** Rule overrides used at preview time, replayed on apply. */
  overrides: Partial<AutomationRules> | undefined;
  generatedAt: number;
  expiresAt: number;
  applied: boolean;
}

export interface PreviewToken {
  previewId: string;
  rulesHash: string;
  storeDomain: string;
  generatedAt: string;
  expiresAt: string;
}

const previews = new Map<string, PreviewRecord>();

/**
 * Order-independent hash of the effective rules a run will use.
 *
 * Stable-stringified (keys sorted) so a rules object that round-trips through
 * JSON cannot hash differently for a purely cosmetic key-order change.
 */
export function computeRulesHash(rules: AutomationRules): string {
  return createHash('sha256').update(stableStringify(rules)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Drops expired records so the map cannot grow without bound. */
function prune(now: number): void {
  for (const [id, record] of previews) {
    if (record.expiresAt <= now || record.applied) previews.delete(id);
  }
}

/** Records a preview and returns its token. */
export function recordPreview(input: {
  rulesHash: string;
  storeDomain: string;
  query: string | undefined;
  maxProducts: number | undefined;
  overrides: Partial<AutomationRules> | undefined;
}): PreviewToken {
  const now = Date.now();
  prune(now);

  const record: PreviewRecord = {
    previewId: randomUUID(),
    rulesHash: input.rulesHash,
    storeDomain: input.storeDomain,
    query: input.query,
    maxProducts: input.maxProducts,
    overrides: input.overrides,
    generatedAt: now,
    expiresAt: now + PREVIEW_TTL_MS,
    applied: false,
  };
  previews.set(record.previewId, record);

  return {
    previewId: record.previewId,
    rulesHash: record.rulesHash,
    storeDomain: record.storeDomain,
    generatedAt: new Date(record.generatedAt).toISOString(),
    expiresAt: new Date(record.expiresAt).toISOString(),
  };
}

/**
 * Finds a preview eligible for apply, WITHOUT consuming it.
 *
 * Checks the reasons that do not depend on the rules content: missing id,
 * unknown/expired/already-applied id, wrong store. Returns the unmarked record
 * so the caller can compute the current effective-rules hash (which needs the
 * record's overrides) and compare it before consuming. Throws a specific
 * AppError for each failure.
 */
export function findApplicablePreview(
  previewId: string | undefined,
  currentStoreDomain: string,
): PreviewRecord {
  if (previewId === undefined || previewId.trim().length === 0) {
    throw new AppError(
      'PREVIEW_REQUIRED',
      'Apply requires a previewId. POST /api/automation/preview first, then apply that preview - a direct apply cannot bypass review.',
    );
  }

  const now = Date.now();
  const record = previews.get(previewId);
  if (record === undefined) {
    throw new AppError(
      'PREVIEW_NOT_FOUND',
      'That previewId is unknown. It may have expired or the server restarted. Preview again and apply the new preview.',
    );
  }
  if (record.applied) {
    throw new AppError(
      'PREVIEW_ALREADY_APPLIED',
      'That preview was already applied. Preview again before applying, so you are acting on current data.',
    );
  }
  if (record.expiresAt <= now) {
    previews.delete(previewId);
    throw new AppError(
      'PREVIEW_EXPIRED',
      `That preview has expired (previews are valid for ${Math.round(PREVIEW_TTL_MS / 60_000)} minutes). Preview again.`,
    );
  }
  if (record.storeDomain !== currentStoreDomain) {
    throw new AppError(
      'PREVIEW_STALE',
      `The preview was generated for ${record.storeDomain}, but the backend is now connected to ${currentStoreDomain}. Preview again.`,
    );
  }
  return record;
}

/**
 * Confirms the current effective-rules hash still matches the preview and marks
 * it used (single-use). Call after findApplicablePreview and after computing the
 * hash from the record's overrides. A rules change since the preview is
 * reported as PREVIEW_STALE and the preview is NOT consumed.
 */
export function consumePreview(previewId: string, currentRulesHash: string): PreviewRecord {
  const record = previews.get(previewId);
  if (record === undefined || record.applied) {
    // Re-checked to close the read-then-write gap; the earlier find already
    // reported the friendly message for the common cases.
    throw new AppError('PREVIEW_NOT_FOUND', 'That preview is no longer applicable. Preview again.');
  }
  if (record.rulesHash !== currentRulesHash) {
    throw new AppError(
      'PREVIEW_STALE',
      'The automation rules changed after this preview was generated, so it no longer describes what would happen. Preview again, then apply.',
    );
  }
  record.applied = true;
  previews.set(previewId, record);
  return record;
}

/** Test-only: clears all outstanding previews. */
export function _resetPreviewsForTest(): void {
  previews.clear();
}

/** Test-only: forces a preview to be expired, so the expiry path is testable. */
export function _expirePreviewForTest(previewId: string): void {
  const record = previews.get(previewId);
  if (record !== undefined) record.expiresAt = Date.now() - 1;
}
