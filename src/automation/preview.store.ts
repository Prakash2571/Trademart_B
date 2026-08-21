/**
 * Issuing and consuming automation preview tokens.
 *
 * The contract an apply must satisfy, all of which is enforced here:
 *
 *   1. a preview must exist                        -> PREVIEW_REQUIRED
 *   2. it must not have expired                    -> PREVIEW_EXPIRED
 *   3. it must not already have been used          -> PREVIEW_ALREADY_APPLIED
 *   4. it must be for THIS store                   -> PREVIEW_STALE
 *   5. its scope must match the apply request      -> PREVIEW_STALE
 *   6. its rulesHash must match                    -> PREVIEW_STALE
 *   7. its planHash must match the freshly built plan -> PREVIEW_STALE
 *
 * Mongo is used when available because `findOneAndUpdate` gives a genuinely
 * atomic single-use claim - two concurrent applies with the same previewId cannot
 * both win. Without a database an in-process Map is used instead, which is still
 * atomic within the single Node process this app runs as. The fallback is noted
 * loudly rather than silently: if the deployment is ever scaled to more than one
 * replica without Mongo, previews stop being reliably single-use, and that is
 * worth knowing.
 */

import { randomUUID } from 'node:crypto';

import { AppError } from '../common/errors';
import { logger } from '../common/logger';
import { getContext, getRequestId } from '../common/requestContext';
import { config } from '../config';
import { AutomationPreviewModel } from '../database/models/AutomationPreview';
import { getDatabaseStatus } from '../database/mongo';
import { hashScope, shortHash, type PlanScope } from './plan.hash';

export interface PreviewRecord {
  previewId: string;
  storeDomain: string;
  rulesHash: string;
  planHash: string;
  scope: PlanScope;
  generatedAt: string;
  expiresAt: string;
  /** Present only for a preview that has been consumed. */
  appliedAt: string | null;
}

/** What a preview must be checked against at apply time. */
export interface PreviewExpectation {
  previewId: string;
  storeDomain: string;
  rulesHash: string;
  planHash: string;
  scope: PlanScope;
}

interface StoredPreview {
  previewId: string;
  shopDomain: string;
  rulesHash: string;
  planHash: string;
  scope: PlanScope;
  summary: unknown;
  generatedAt: Date;
  expiresAt: Date;
  appliedAt: Date | null;
  createdRequestId: string | null;
  createdBy: string | null;
}

/**
 * In-process fallback store, used only when Mongo is unavailable.
 * Keyed by previewId.
 */
const memoryStore = new Map<string, StoredPreview>();

function usingDatabase(): boolean {
  return getDatabaseStatus().status === 'connected';
}

/** Drops expired entries from the memory store; Mongo has a TTL index instead. */
function sweepMemory(now: number): void {
  for (const [key, value] of memoryStore) {
    if (value.expiresAt.getTime() <= now) memoryStore.delete(key);
  }
}

function toRecord(stored: StoredPreview): PreviewRecord {
  return {
    previewId: stored.previewId,
    storeDomain: stored.shopDomain,
    rulesHash: stored.rulesHash,
    planHash: stored.planHash,
    scope: stored.scope,
    generatedAt: stored.generatedAt.toISOString(),
    expiresAt: stored.expiresAt.toISOString(),
    appliedAt: stored.appliedAt === null ? null : stored.appliedAt.toISOString(),
  };
}

/**
 * Issues a preview token for a plan that has just been built.
 *
 * Never throws. A preview that cannot be recorded would make apply impossible,
 * but a preview is still useful on its own as a report - so a storage failure
 * degrades to "you can look but not apply" rather than failing the preview.
 * Returns null when no token could be issued.
 */
export async function issuePreview(input: {
  rulesHash: string;
  planHash: string;
  scope: PlanScope;
  summary: unknown;
}): Promise<PreviewRecord | null> {
  const now = new Date();
  const stored: StoredPreview = {
    previewId: randomUUID(),
    shopDomain: config.shopify.storeDomain,
    rulesHash: input.rulesHash,
    planHash: input.planHash,
    scope: input.scope,
    summary: input.summary,
    generatedAt: now,
    expiresAt: new Date(now.getTime() + config.retention.previewMinutes * 60_000),
    appliedAt: null,
    createdRequestId: getRequestId(),
    createdBy: getContext()?.actor ?? null,
  };

  try {
    if (usingDatabase()) {
      await AutomationPreviewModel.create(stored);
    } else {
      sweepMemory(now.getTime());
      memoryStore.set(stored.previewId, stored);
    }
  } catch (error) {
    logger.error('Could not record the automation preview; apply will be unavailable.', {
      reason: error instanceof Error ? error.message : 'unknown',
    });
    return null;
  }

  logger.info('Issued automation preview.', {
    previewId: stored.previewId,
    rulesHash: shortHash(stored.rulesHash),
    planHash: shortHash(stored.planHash),
    expiresAt: stored.expiresAt.toISOString(),
    persistence: usingDatabase() ? 'mongo' : 'memory',
  });

  return toRecord(stored);
}

async function loadPreview(previewId: string): Promise<StoredPreview | null> {
  if (usingDatabase()) {
    const doc = await AutomationPreviewModel.findOne({ previewId }).lean();
    if (doc === null || doc === undefined) return null;
    const raw = doc as Record<string, unknown>;
    const scope = (raw['scope'] ?? {}) as Record<string, unknown>;
    return {
      previewId: String(raw['previewId']),
      shopDomain: String(raw['shopDomain']),
      rulesHash: String(raw['rulesHash']),
      planHash: String(raw['planHash']),
      scope: {
        query: (scope['query'] as string | null) ?? null,
        maxProducts: Number(scope['maxProducts'] ?? 0),
        productIds: (scope['productIds'] as string[] | null) ?? null,
      },
      summary: raw['summary'] ?? null,
      generatedAt: new Date(String(raw['generatedAt'])),
      expiresAt: new Date(String(raw['expiresAt'])),
      appliedAt: raw['appliedAt'] === null || raw['appliedAt'] === undefined
        ? null
        : new Date(String(raw['appliedAt'])),
      createdRequestId: (raw['createdRequestId'] as string | null) ?? null,
      createdBy: (raw['createdBy'] as string | null) ?? null,
    };
  }

  sweepMemory(Date.now());
  return memoryStore.get(previewId) ?? null;
}

/**
 * Explains a scope difference in the operator's terms.
 *
 * A generic "stale preview" for what is really "you previewed 50 products and
 * asked to apply to 250" wastes the operator's time, so the specific difference
 * is named.
 */
function describeScopeMismatch(expected: PlanScope, actual: PlanScope): string | null {
  if (expected.query !== actual.query) {
    return `the preview was taken for query ${expected.query === null ? '(entire catalogue)' : `"${expected.query}"`} but the apply asked for ${actual.query === null ? '(entire catalogue)' : `"${actual.query}"`}`;
  }
  if (expected.maxProducts !== actual.maxProducts) {
    return `the preview covered up to ${expected.maxProducts} products but the apply asked for up to ${actual.maxProducts}`;
  }
  const expectedIds = expected.productIds ?? [];
  const actualIds = actual.productIds ?? [];
  if (
    expectedIds.length !== actualIds.length ||
    expectedIds.some((id, index) => id !== actualIds[index])
  ) {
    return 'the preview and the apply target different products';
  }
  return null;
}

/**
 * Validates a preview against the freshly prepared plan and consumes it.
 *
 * Ordering here matters. Every reason to REFUSE is checked before the token is
 * claimed, so a stale or mis-scoped apply does not burn the preview - the
 * operator can look at the error, re-preview, and try again. The token is only
 * spent on an apply that is actually going to proceed.
 */
export async function consumePreview(
  expectation: PreviewExpectation,
): Promise<PreviewRecord> {
  const stored = await loadPreview(expectation.previewId);

  if (stored === null) {
    // Unknown id and expired-and-swept id are indistinguishable after a TTL
    // deletion, so this deliberately points at both possibilities.
    throw new AppError(
      'PREVIEW_REQUIRED',
      'No matching automation preview was found. It may have expired, or the backend may have restarted. Run a preview again and apply from its result.',
      { details: { previewId: expectation.previewId } },
    );
  }

  if (stored.appliedAt !== null) {
    throw new AppError(
      'PREVIEW_ALREADY_APPLIED',
      `This preview was already applied at ${stored.appliedAt.toISOString()}. A preview is single-use, so a repeated or replayed apply cannot make the same changes twice. Run a new preview.`,
      { details: { previewId: stored.previewId, appliedAt: stored.appliedAt.toISOString() } },
    );
  }

  if (stored.expiresAt.getTime() <= Date.now()) {
    throw new AppError(
      'PREVIEW_EXPIRED',
      `This preview expired at ${stored.expiresAt.toISOString()}. Store data moves, so a preview is only valid for ${config.retention.previewMinutes} minutes. Run a new preview.`,
      { details: { previewId: stored.previewId, expiresAt: stored.expiresAt.toISOString() } },
    );
  }

  if (stored.shopDomain !== expectation.storeDomain) {
    throw new AppError(
      'PREVIEW_STALE',
      `This preview was taken against ${stored.shopDomain} but the backend is now connected to ${expectation.storeDomain}. Refusing to apply a plan built for a different store.`,
      {
        details: {
          previewStoreDomain: stored.shopDomain,
          currentStoreDomain: expectation.storeDomain,
        },
      },
    );
  }

  const scopeProblem = describeScopeMismatch(stored.scope, expectation.scope);
  if (scopeProblem !== null) {
    throw new AppError(
      'PREVIEW_STALE',
      `The apply does not match the preview: ${scopeProblem}. Preview the exact scope you want to apply.`,
      {
        details: {
          previewScope: stored.scope,
          requestedScope: expectation.scope,
          previewScopeHash: hashScope(stored.scope),
          requestedScopeHash: hashScope(expectation.scope),
        },
      },
    );
  }

  if (stored.rulesHash !== expectation.rulesHash) {
    throw new AppError(
      'PREVIEW_STALE',
      'The automation rules changed after this preview was taken, so the preview no longer describes what would happen. Preview again with the current rules.',
      {
        details: {
          previewRulesHash: shortHash(stored.rulesHash),
          currentRulesHash: shortHash(expectation.rulesHash),
        },
      },
    );
  }

  // THE CENTRAL CHECK. Same rules, same scope, same store - but the plan built
  // from current Shopify/supplier data differs from the one that was reviewed.
  if (stored.planHash !== expectation.planHash) {
    throw new AppError(
      'PREVIEW_STALE',
      'Product or cost data changed in Shopify after this preview was taken, so applying it now would write different values than the ones you reviewed. Nothing has been changed. Preview again to see the current plan.',
      {
        details: {
          previewPlanHash: shortHash(stored.planHash),
          currentPlanHash: shortHash(expectation.planHash),
          previewSummary: stored.summary,
        },
      },
    );
  }

  // ---- Everything checks out: claim it, atomically ------------------------
  const appliedAt = new Date();
  const appliedRequestId = getRequestId();

  if (usingDatabase()) {
    // The `appliedAt: null` filter is what makes this a compare-and-swap. Two
    // concurrent applies race here and exactly one matches.
    const claimed = await AutomationPreviewModel.findOneAndUpdate(
      { previewId: expectation.previewId, appliedAt: null },
      { $set: { appliedAt, appliedRequestId } },
      { new: true },
    ).lean();

    if (claimed === null || claimed === undefined) {
      throw new AppError(
        'PREVIEW_ALREADY_APPLIED',
        'This preview was applied by another request a moment ago. A preview is single-use, so the duplicate was refused rather than applying the same changes twice.',
        { details: { previewId: expectation.previewId } },
      );
    }
  } else {
    // Single-process fallback. The re-read closes the same race as above: `await`
    // points above this line could have let another apply through.
    const current = memoryStore.get(expectation.previewId);
    if (current === undefined || current.appliedAt !== null) {
      throw new AppError(
        'PREVIEW_ALREADY_APPLIED',
        'This preview was applied by another request a moment ago. A preview is single-use.',
        { details: { previewId: expectation.previewId } },
      );
    }
    current.appliedAt = appliedAt;
  }

  logger.info('Consumed automation preview.', {
    previewId: expectation.previewId,
    planHash: shortHash(expectation.planHash),
    previewTakenBy: stored.createdBy,
    previewRequestId: stored.createdRequestId,
  });

  return toRecord({ ...stored, appliedAt });
}

/** Recent previews for diagnostics. Empty when no database is configured. */
export async function listRecentPreviews(limit: number): Promise<PreviewRecord[]> {
  if (!usingDatabase()) {
    sweepMemory(Date.now());
    return [...memoryStore.values()]
      .sort((left, right) => right.generatedAt.getTime() - left.generatedAt.getTime())
      .slice(0, limit)
      .map(toRecord);
  }

  const docs = await AutomationPreviewModel.find({
    shopDomain: config.shopify.storeDomain,
  })
    .sort({ generatedAt: -1 })
    .limit(limit)
    .lean();

  return (docs as Record<string, unknown>[]).map((raw) => {
    const scope = (raw['scope'] ?? {}) as Record<string, unknown>;
    return {
      previewId: String(raw['previewId']),
      storeDomain: String(raw['shopDomain']),
      rulesHash: String(raw['rulesHash']),
      planHash: String(raw['planHash']),
      scope: {
        query: (scope['query'] as string | null) ?? null,
        maxProducts: Number(scope['maxProducts'] ?? 0),
        productIds: (scope['productIds'] as string[] | null) ?? null,
      },
      generatedAt: new Date(String(raw['generatedAt'])).toISOString(),
      expiresAt: new Date(String(raw['expiresAt'])).toISOString(),
      appliedAt:
        raw['appliedAt'] === null || raw['appliedAt'] === undefined
          ? null
          : new Date(String(raw['appliedAt'])).toISOString(),
    };
  });
}

/** Test hook: empties the in-memory fallback store. */
export function clearPreviewMemoryStore(): void {
  memoryStore.clear();
}
