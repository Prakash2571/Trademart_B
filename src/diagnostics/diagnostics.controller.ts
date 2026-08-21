/**
 * GET /api/diagnostics/integrity  - Shopify state consistency findings
 * GET /api/shopify/rate-limit     - Shopify throttle + circuit breaker state
 * GET /api/version                - app version / git SHA / build time
 *
 * Read-only, all three.
 *
 * The integrity endpoint deliberately has NO "fix" counterpart. Every finding it
 * reports has more than one valid explanation - an ACTIVE-but-unpublished product
 * might be a failed publish, or a merchant deliberately selling that item through
 * another channel. Repairing them automatically would mean guessing about what
 * customers can see, which is the exact class of bug this endpoint exists to
 * surface. So each finding carries a recommended action for a human instead.
 *
 * There is no /diagnostics/store-mode here on purpose: GET /api/shopify/status
 * already reports storeSafety, refined with Shopify's real isDevelopmentStore
 * flag. A second endpoint answering "is this a live store?" is a second place for
 * that answer to be wrong.
 */

import { Router } from 'express';

import { asyncHandler, sendSuccess } from '../common/http';
import { getVersionInfo } from '../common/version';
import { getRateLimitReport } from '../shopify/rateLimit.service';
import { runIntegrityChecks } from './integrity.service';

/**
 * Store-data diagnostics. Mounted behind the operator READ guard, because the
 * integrity report names products and their visibility.
 */
export const diagnosticsRouter = Router();

/**
 * Build identity only. Mounted PUBLIC, next to health.
 *
 * Separate router rather than a carve-out inside the guarded one, mirroring
 * webhooksRouter/webhookAdminRouter: which routes are public is then visible in
 * app.ts at the mount point instead of being buried in middleware conditions.
 */
export const publicDiagnosticsRouter = Router();

diagnosticsRouter.get(
  '/diagnostics/integrity',
  asyncHandler(async (_req, res) => {
    const report = await runIntegrityChecks();
    sendSuccess(res, report, {
      findingCount: report.findings.length,
      // Surfaced in the metadata so the UI can say "3 findings, 1 check could not
      // run" rather than presenting a partial sweep as a clean bill of health.
      skippedChecks: report.skipped.length,
    });
  }),
);

/**
 * Shopify API capacity, from the last real response.
 *
 * Mounted under /shopify rather than /diagnostics because it describes Shopify,
 * not Trademart, and that is where the Settings page looks for it.
 */
diagnosticsRouter.get(
  '/shopify/rate-limit',
  asyncHandler(async (_req, res) => {
    sendSuccess(res, getRateLimitReport());
  }),
);

/**
 * Answers "is the container running the code I think it is?".
 *
 * Unauthenticated by design: it exposes no store data, only build identity, and a
 * deploy check has to be able to read it before anybody signs in. It reports a
 * version, a commit and a build time - all of which are in the public repository
 * anyway.
 */
publicDiagnosticsRouter.get(
  '/version',
  asyncHandler(async (_req, res) => {
    sendSuccess(res, getVersionInfo());
  }),
);
