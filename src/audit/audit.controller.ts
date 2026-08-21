/**
 * GET /api/audit         - operator audit trail, newest first, filterable
 * GET /api/audit/actions - action names actually present, for the UI filter
 *
 * Read-only. There is deliberately no delete or edit route: an audit trail that
 * can be altered through the same API it audits is not evidence of anything.
 * Entries age out only via the TTL index (RETENTION_AUDIT_DAYS).
 */

import { Router } from 'express';

import { AppError } from '../common/errors';
import { asyncHandler, sendSuccess } from '../common/http';
import { parseIntParam, parseStringParam } from '../common/validate';
import { listAuditActions, listAuditEntries } from './audit.service';

export const auditRouter = Router();

const RESULTS = ['SUCCESS', 'PARTIAL', 'FAILURE'] as const;

/** Parses an ISO date filter, rejecting nonsense rather than ignoring it. */
function parseDate(raw: unknown, field: string): Date | undefined {
  const value = parseStringParam(raw, field, { maxLength: 40 });
  if (value === undefined) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new AppError(
      'VALIDATION_ERROR',
      `${field} must be an ISO 8601 timestamp, e.g. 2026-08-01T00:00:00Z.`,
    );
  }
  return parsed;
}

auditRouter.get(
  '/audit',
  asyncHandler(async (req, res) => {
    const rawResult = parseStringParam(req.query['result'], 'result', { maxLength: 10 });
    if (rawResult !== undefined && !(RESULTS as readonly string[]).includes(rawResult)) {
      throw new AppError(
        'VALIDATION_ERROR',
        `result must be one of ${RESULTS.join(', ')}.`,
      );
    }

    const page = await listAuditEntries({
      action: parseStringParam(req.query['action'], 'action', { maxLength: 64 }),
      resourceType: parseStringParam(req.query['resourceType'], 'resourceType', {
        maxLength: 32,
      }),
      resourceId: parseStringParam(req.query['resourceId'], 'resourceId', { maxLength: 255 }),
      actor: parseStringParam(req.query['actor'], 'actor', { maxLength: 128 }),
      result: rawResult as 'SUCCESS' | 'PARTIAL' | 'FAILURE' | undefined,
      // Filtering by requestId is how "this one operation failed" becomes a
      // complete picture: every entry written during that request, in order.
      requestId: parseStringParam(req.query['requestId'], 'requestId', { maxLength: 128 }),
      since: parseDate(req.query['since'], 'since'),
      until: parseDate(req.query['until'], 'until'),
      cursor: parseStringParam(req.query['cursor'], 'cursor', { maxLength: 120 }),
      limit: parseIntParam(req.query['limit'], 'limit', {
        min: 1,
        max: 200,
        fallback: 50,
      }),
    });

    sendSuccess(res, { entries: page.entries }, {
      count: page.count,
      hasMore: page.hasMore,
      nextCursor: page.nextCursor,
    });
  }),
);

auditRouter.get(
  '/audit/actions',
  asyncHandler(async (_req, res) => {
    const actions = await listAuditActions();
    sendSuccess(res, { actions }, { count: actions.length });
  }),
);
