/**
 * Writing and reading the operator audit trail.
 *
 * TWO RULES THAT SHAPE EVERYTHING HERE
 * ------------------------------------
 * 1. Recording an audit entry must NEVER fail the operation it describes. A
 *    price change that succeeded and then threw because Mongo was briefly down
 *    would be worse than a missing audit row - the store would have changed and
 *    the caller would have been told it had not. So `recordAudit` swallows its
 *    own failures and logs them at error level, because an unaudited write IS a
 *    real problem, just not one worth undoing a successful change over.
 *
 * 2. Nothing secret is ever written. `before`/`after` come from request bodies
 *    and Shopify responses, which is exactly the kind of place a token or a
 *    password hash ends up by accident. Everything is passed through a redactor
 *    on the way in, keyed on field NAME as well as value shape, so a new field
 *    called `apiKey` is redacted without anyone remembering to add it here.
 */

import { AppError, toAppError } from '../common/errors';
import { logger, redact } from '../common/logger';
import { getContext, getRequestId } from '../common/requestContext';
import { config } from '../config';
import { AuditLogModel } from '../database/models/AuditLog';
import { getDatabaseStatus } from '../database/mongo';

/**
 * Every audited action.
 *
 * A closed union rather than a free string so a typo cannot create a new action
 * name that the UI filter will never show.
 */
export type AuditAction =
  // Session
  | 'LOGIN'
  | 'LOGIN_FAILED'
  | 'LOGOUT'
  // Products
  | 'PRODUCT_CREATE'
  | 'PRODUCT_UPDATE'
  | 'PRICE_UPDATE'
  | 'PRODUCT_PUBLISH'
  | 'PRODUCT_UNPUBLISH'
  | 'PRODUCT_APPROVE'
  // Costs
  | 'COST_UPDATE'
  | 'COST_DELETE'
  // Inventory
  | 'INVENTORY_UPDATE'
  // Automation
  | 'AUTOMATION_RULE_UPDATE'
  | 'AUTOMATION_PREVIEW'
  | 'AUTOMATION_APPLY'
  // Webhooks
  | 'WEBHOOK_RETRY'
  | 'WEBHOOK_REGISTER';

export type AuditResourceType =
  | 'PRODUCT'
  | 'VARIANT'
  | 'INVENTORY'
  | 'COST'
  | 'AUTOMATION'
  | 'SESSION'
  | 'WEBHOOK';

export interface AuditEntryInput {
  action: AuditAction;
  resourceType: AuditResourceType;
  resourceId?: string | null;
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown> | null;
  result?: 'SUCCESS' | 'FAILURE';
  error?: unknown;
  /**
   * Overrides the actor from the request context. Used by the login handler,
   * which knows who was ATTEMPTING to sign in before authentication has run.
   */
  actor?: string | null;
  authMethod?: string | null;
}

/**
 * Field names whose values are never stored, whatever they contain.
 *
 * Matched on the key, not the value, so a secret that does not look like one is
 * still caught.
 */
const SECRET_KEY = /(token|secret|password|passwordhash|authorization|apikey|api_key|credential|cookie|sessionsecret)/i;

/** Caps on stored size, so one enormous payload cannot bloat the collection. */
const MAX_DEPTH = 6;
const MAX_ARRAY = 50;
const MAX_STRING = 2000;

/**
 * Deep-copies a value, dropping secrets and bounding size.
 *
 * Returns a plain structure safe to hand to Mongo: no class instances, no
 * functions, no cycles.
 */
function sanitise(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return null;
  if (depth > MAX_DEPTH) return '[truncated: too deep]';

  if (typeof value === 'string') {
    // Pattern-based redaction as well as key-based: catches a token pasted into
    // an otherwise innocent field such as `note`.
    const cleaned = redact(value);
    return cleaned.length > MAX_STRING ? `${cleaned.slice(0, MAX_STRING)}…[truncated]` : cleaned;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();

  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY).map((item) => sanitise(item, depth + 1));
    if (value.length > MAX_ARRAY) items.push(`[${value.length - MAX_ARRAY} more omitted]`);
    return items;
  }

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY.test(key)) {
        out[key] = '[REDACTED]';
        continue;
      }
      if (member === undefined) continue;
      out[key] = sanitise(member, depth + 1);
    }
    return out;
  }

  // Functions, symbols, bigints - nothing an audit entry should carry.
  return null;
}

/**
 * Writes one audit entry. Never throws.
 *
 * Deliberately not awaited by most callers' critical paths - but it IS awaited,
 * because a fire-and-forget write can be lost when the process exits, and an
 * audit entry that only sometimes arrives is not an audit trail.
 */
export async function recordAudit(input: AuditEntryInput): Promise<void> {
  const context = getContext();
  const appError = input.error === undefined ? null : toAppError(input.error);
  const result = input.result ?? (appError === null ? 'SUCCESS' : 'FAILURE');

  const entry = {
    shopDomain: config.shopify.storeDomain,
    actor: input.actor ?? context?.actor ?? 'system',
    authMethod: input.authMethod ?? context?.authMethod ?? (context === undefined ? 'SYSTEM' : null),
    at: new Date(),
    action: input.action,
    resourceType: input.resourceType,
    resourceId: input.resourceId ?? null,
    before: sanitise(input.before),
    after: sanitise(input.after),
    requestId: getRequestId(),
    result,
    errorCode: appError?.code ?? null,
    errorMessage: appError === null ? null : redact(appError.message),
    metadata: input.metadata === undefined ? null : sanitise(input.metadata),
    expiresAt: new Date(Date.now() + config.retention.auditLogDays * 86_400_000),
  };

  if (getDatabaseStatus().status !== 'connected') {
    // Still emit it to the log so the information is not lost entirely. Logs are
    // rotated and harder to query, but they are better than nothing.
    logger.warn('No database available - audit entry written to the log only.', {
      action: entry.action,
      resourceType: entry.resourceType,
      resourceId: entry.resourceId,
      actor: entry.actor,
      result: entry.result,
    });
    return;
  }

  try {
    await AuditLogModel.create(entry);
  } catch (error) {
    logger.error('Failed to write an audit entry. The operation itself was unaffected.', {
      action: entry.action,
      resourceId: entry.resourceId,
      reason: error instanceof Error ? error.message : 'unknown',
    });
  }
}

/**
 * Convenience wrapper: runs `work`, and audits the outcome either way.
 *
 * The failure path matters as much as the success path - a refused write is often
 * the entry an operator most needs to find.
 */
export async function auditing<T>(
  describe: Omit<AuditEntryInput, 'result' | 'error' | 'after'> & {
    /** Built from the result, so `after` can reflect what actually happened. */
    after?: (result: T) => unknown;
  },
  work: () => Promise<T>,
): Promise<T> {
  try {
    const result = await work();
    await recordAudit({
      action: describe.action,
      resourceType: describe.resourceType,
      resourceId: describe.resourceId ?? null,
      before: describe.before,
      after: describe.after === undefined ? null : describe.after(result),
      metadata: describe.metadata ?? null,
      result: 'SUCCESS',
    });
    return result;
  } catch (error) {
    await recordAudit({
      action: describe.action,
      resourceType: describe.resourceType,
      resourceId: describe.resourceId ?? null,
      before: describe.before,
      metadata: describe.metadata ?? null,
      result: 'FAILURE',
      error,
    });
    throw error;
  }
}

export interface AuditQuery {
  action?: string | undefined;
  resourceType?: string | undefined;
  resourceId?: string | undefined;
  actor?: string | undefined;
  result?: 'SUCCESS' | 'FAILURE' | undefined;
  requestId?: string | undefined;
  since?: Date | undefined;
  until?: Date | undefined;
  limit: number;
  /**
   * Keyset cursor from a previous page's `nextCursor`.
   *
   * Keyset rather than skip/offset: the audit log only grows, so an offset would
   * both get slower as history accumulates and silently shift rows between pages
   * whenever a new entry is written mid-browse.
   */
  cursor?: string | undefined;
}

export interface AuditPage {
  entries: unknown[];
  count: number;
  /** True when more entries match than were returned. */
  hasMore: boolean;
  /** Pass back as `cursor` to fetch the next page. Null when this is the last. */
  nextCursor: string | null;
}

/**
 * Cursor format: "<at ISO>|<_id>".
 *
 * The id is part of it because `at` is not unique - several entries can share a
 * millisecond, and a cursor on time alone would either skip or repeat them.
 */
function encodeCursor(row: Record<string, unknown>): string | null {
  const at = row['at'];
  const id = row['_id'];
  if (at === undefined || id === undefined) return null;
  const iso = at instanceof Date ? at.toISOString() : String(at);
  return `${iso}|${String(id)}`;
}

function decodeCursor(cursor: string): { at: Date; id: string } | null {
  const separator = cursor.lastIndexOf('|');
  if (separator <= 0) return null;
  const at = new Date(cursor.slice(0, separator));
  const id = cursor.slice(separator + 1);
  if (Number.isNaN(at.getTime()) || id.length === 0) return null;
  return { at, id };
}

/** Reads audit entries, newest first. */
export async function listAuditEntries(query: AuditQuery): Promise<AuditPage> {
  if (getDatabaseStatus().status !== 'connected') {
    throw new AppError(
      'DATABASE_UNAVAILABLE',
      'The audit trail requires MongoDB. Set MONGODB_URI to keep a record of who changed what.',
    );
  }

  const filter: Record<string, unknown> = { shopDomain: config.shopify.storeDomain };
  if (query.action !== undefined) filter['action'] = query.action;
  if (query.resourceType !== undefined) filter['resourceType'] = query.resourceType;
  if (query.resourceId !== undefined) filter['resourceId'] = query.resourceId;
  if (query.actor !== undefined) filter['actor'] = query.actor;
  if (query.result !== undefined) filter['result'] = query.result;
  if (query.requestId !== undefined) filter['requestId'] = query.requestId;
  if (query.since !== undefined || query.until !== undefined) {
    const range: Record<string, Date> = {};
    if (query.since !== undefined) range['$gte'] = query.since;
    if (query.until !== undefined) range['$lte'] = query.until;
    filter['at'] = range;
  }

  // Keyset predicate: strictly "older than the last row we returned", with the id
  // breaking ties inside the same millisecond.
  if (query.cursor !== undefined) {
    const decoded = decodeCursor(query.cursor);
    if (decoded === null) {
      throw new AppError(
        'VALIDATION_ERROR',
        'cursor is malformed. Use the nextCursor value from a previous response.',
      );
    }
    filter['$or'] = [
      { at: { $lt: decoded.at } },
      { at: decoded.at, _id: { $lt: decoded.id } },
    ];
  }

  // One extra row is fetched to answer hasMore without a second count query.
  // Sorted by (at, _id) to match the cursor predicate exactly - sorting by `at`
  // alone would make paging non-deterministic across tied timestamps.
  const rows = (await AuditLogModel.find(filter)
    .sort({ at: -1, _id: -1 })
    .limit(query.limit + 1)
    .lean()) as Record<string, unknown>[];

  const hasMore = rows.length > query.limit;
  const entries = hasMore ? rows.slice(0, query.limit) : rows;
  const last = entries.length > 0 ? entries[entries.length - 1] : undefined;

  return {
    entries,
    count: entries.length,
    hasMore,
    nextCursor: hasMore && last !== undefined ? encodeCursor(last) : null,
  };
}

/** Distinct action names present, so the UI filter offers only real options. */
export async function listAuditActions(): Promise<string[]> {
  if (getDatabaseStatus().status !== 'connected') return [];
  try {
    const actions = await AuditLogModel.distinct('action', {
      shopDomain: config.shopify.storeDomain,
    });
    return (actions as string[]).sort();
  } catch {
    return [];
  }
}
