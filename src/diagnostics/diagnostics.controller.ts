/**
 * GET /api/diagnostics/integrity   - Shopify state consistency findings
 * GET /api/diagnostics/store-mode  - development vs live store, verified
 * GET /api/shopify/rate-limit      - Shopify throttle + circuit breaker state
 * GET /api/version                 - app version / git SHA / build time
 *
 * Read-only. The integrity endpoint deliberately has no "fix" counterpart: every
 * finding it reports has more than one valid explanation, so repairing them
 * automatically would mean guessing about what customers can see.
 */

import { Router } from 'express';

import { asyncHandler, sendSuccess } from '../common/http';
import { getVersionInfo } from '../common/version';
import { getRateLimitReport } from '../shopify/rateLimit.service';
import { getStoreSafety } from '../shopify/storeMode';
import { runIntegrityChecks } from './integrity.service';

export const diagnosticsRouter = Router();

diagnosticsRouter.get(
  '/diagnostics/integrity',
  asyncHandler(async (_req, res) => {
    const report = await runIntegrityChecks();
    sendSuccess(res, report, {
      findingCount: report.findings.length,
      skippedChecks: report.skipped.length,
    });
  }),
);

diagnosticsRouter.get(
  '/diagnostics/store-mode',
  asyncHandler(async (_req, res) => {
    // Uncached: this endpoint exists to answer "what am I actually connected
    // to?", and a cached answer is the wrong answer right after a credential
    // swap - which is exactly when the question gets asked.
    const safety = await getStoreSafety({ useCache: false });
    sendSuccess(res, safety);
  }),
);

/**
 * Shopify API capacity, from the last real response.
 *
 * Mounted under /shopify because that is where the frontend's Settings page
 * looks, and because it describes Shopify rather than Trademart.
 */
diagnosticsRouter.get(
  '/shopify/rate-limit',
  asyncHandler(async (_req, res) => {
    sendSuccess(res, getRateLimitReport());
  }),
);

diagnosticsRouter.get(
  '/version',
  asyncHandler(async (_req, res) => {
    sendSuccess(res, getVersionInfo());
  }),
);
