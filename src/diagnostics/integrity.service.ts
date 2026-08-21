/**
 * Shopify state consistency checks.
 *
 * REPORTS, NEVER REPAIRS. Every finding here has more than one valid
 * explanation - an "ACTIVE but unpublished" product might be a failed publish, or
 * a merchant who deliberately sells that item through a different channel.
 * Auto-fixing would mean guessing, and guessing about what customers can see is
 * exactly the class of bug this whole exercise is about. So each finding carries a
 * recommended action for a human to take.
 *
 * The checks are the states that the app's own workflows can leave behind, which
 * is what makes them worth checking:
 *
 *   ACTIVE + not published      the product looks live in the admin but is not
 *   DRAFT  + published          published to a channel yet hidden by status
 *   review tag + ACTIVE         approved but the tag never came off
 *   auto-hidden tag + ACTIVE    automation hid it and something un-hid it
 *   manual cost + missing variant   a cost override attached to nothing
 */

import { AppError } from '../common/errors';
import { logger } from '../common/logger';
import { config } from '../config';
import { getDatabaseStatus } from '../database/mongo';
import { CostRecordModel } from '../database/models/CostRecord';
import {
  AUTOMATION_HIDDEN_TAG,
  AUTOMATION_REVIEW_TAG,
  NO_AUTOMATION_TAG,
} from '../automation/rules.types';
import { findOnlineStorePublication } from '../shopify/publications/publications.service';
import { PRODUCTS_PUBLICATION_AUDIT_QUERY } from '../shopify/publications/publication.queries';
import { shopifyGraphql, type GraphqlResult } from '../shopify/shopify.client';

/** Products inspected per page. */
const PAGE_SIZE = 50;
/** Ceiling on a single integrity sweep, so it cannot become an expensive scan. */
const MAX_PRODUCTS = 250;

export type FindingSeverity = 'warning' | 'info';

export interface IntegrityFinding {
  /** Stable machine code, so the frontend can group and link findings. */
  code: string;
  severity: FindingSeverity;
  shopifyProductId: string;
  shopifyVariantId: string | null;
  title: string;
  /** What is inconsistent, in plain language. */
  detail: string;
  /** What a human should do about it. Never performed automatically. */
  recommendedAction: string;
}

export interface IntegrityReport {
  shopDomain: string;
  checkedAt: string;
  productsInspected: boolean;
  productsScanned: number;
  truncated: boolean;
  publicationChecked: boolean;
  findings: IntegrityFinding[];
  counts: Record<string, number>;
  /** Checks that could not run, and why. Never silently skipped. */
  skipped: { check: string; reason: string }[];
}

interface AuditProductNode {
  id: string;
  title: string;
  status: string;
  tags: string[] | null;
  publishedOnPublication: boolean;
}

interface AuditResponse {
  products: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    edges: { node: AuditProductNode }[];
  } | null;
}

/** Inspects products for status/publication/tag disagreements. */
async function checkProducts(publicationId: string): Promise<{
  findings: IntegrityFinding[];
  scanned: number;
  truncated: boolean;
  /** EVERY product id seen, not just the ones with findings. */
  productIds: Set<string>;
}> {
  const findings: IntegrityFinding[] = [];
  const productIds = new Set<string>();
  let scanned = 0;
  let truncated = false;
  let after: string | null = null;

  while (scanned < MAX_PRODUCTS) {
    // Both locals are annotated explicitly. `after` is assigned from a value
    // derived from `result`, so leaving these to inference makes the cursor a
    // self-referential type (TS7022) - the same reason webhooks.service.ts
    // annotates its pagination locals.
    const result: GraphqlResult<AuditResponse> = await shopifyGraphql<AuditResponse>(
      PRODUCTS_PUBLICATION_AUDIT_QUERY,
      {
        first: Math.min(PAGE_SIZE, MAX_PRODUCTS - scanned),
        after,
        publicationId,
      },
      { operation: 'integrityProductAudit' },
    );

    const connection: AuditResponse['products'] = result.data.products;
    if (connection === null || connection === undefined) break;

    for (const edge of connection.edges) {
      const product = edge.node;
      scanned += 1;
      // Recorded for the orphaned-cost check, which needs the full set of ids
      // that exist - not merely the ones that produced a finding.
      productIds.add(product.id);
      const tags = product.tags ?? [];
      const published = product.publishedOnPublication === true;
      const hasReviewTag = tags.includes(AUTOMATION_REVIEW_TAG);
      const hasHiddenTag = tags.includes(AUTOMATION_HIDDEN_TAG);

      if (product.status === 'ACTIVE' && !published) {
        findings.push({
          code: 'ACTIVE_NOT_PUBLISHED',
          severity: 'warning',
          shopifyProductId: product.id,
          shopifyVariantId: null,
          title: product.title,
          detail:
            'Status is ACTIVE but the product is not published to the Online Store, so customers cannot see it. It looks live in the Shopify admin.',
          recommendedAction:
            'Publish it to the Online Store if it should be on sale, or set it to DRAFT so its status matches reality.',
        });
      }

      if (product.status === 'DRAFT' && published) {
        findings.push({
          code: 'DRAFT_BUT_PUBLISHED',
          severity: 'info',
          shopifyProductId: product.id,
          shopifyVariantId: null,
          title: product.title,
          detail:
            'The product is published to the Online Store but its status is DRAFT, so it is still hidden. Setting it ACTIVE would make it visible immediately.',
          recommendedAction:
            'Confirm this is intended. If the product is ready, set it ACTIVE; if not, unpublish it so an accidental status change cannot expose it.',
        });
      }

      if (hasReviewTag && product.status === 'ACTIVE') {
        findings.push({
          code: 'REVIEW_TAG_ON_ACTIVE',
          severity: 'info',
          shopifyProductId: product.id,
          shopifyVariantId: null,
          title: product.title,
          detail: `The product is ACTIVE but still carries ${AUTOMATION_REVIEW_TAG}, so it keeps appearing in the review queue.`,
          recommendedAction:
            'Approve it again from the review queue - approving is idempotent and will clear the tag - or remove the tag from the product page.',
        });
      }

      if (hasHiddenTag && product.status === 'ACTIVE') {
        findings.push({
          code: 'AUTO_HIDDEN_TAG_ON_ACTIVE',
          severity: 'info',
          shopifyProductId: product.id,
          shopifyVariantId: null,
          title: product.title,
          detail: `Automation hid this product at some point (${AUTOMATION_HIDDEN_TAG}) but it is ACTIVE again. Automation may hide it once more on the next run if the original reason still applies.`,
          recommendedAction: `Remove ${AUTOMATION_HIDDEN_TAG} if it is deliberately on sale, or add ${NO_AUTOMATION_TAG} to keep automation away from it entirely.`,
        });
      }
    }

    if (!connection.pageInfo.hasNextPage) break;
    after = connection.pageInfo.endCursor;
    if (after === null) break;
    if (scanned >= MAX_PRODUCTS) {
      truncated = true;
      break;
    }
  }

  return { findings, scanned, truncated, productIds };
}

/**
 * Finds manual cost overrides whose product no longer appears in the catalogue.
 *
 * These matter because a stale override silently applies to nothing, while the
 * operator believes a cost is recorded - and "why is this product UNKNOWN cost?"
 * is then very hard to answer.
 */
async function checkOrphanedCosts(
  knownProductIds: Set<string>,
  catalogueComplete: boolean,
): Promise<IntegrityFinding[]> {
  if (!catalogueComplete) return [];

  // Only the ids are needed to decide whether an override points at nothing, and
  // a cost record holds a dozen money fields - so nothing else is selected. That
  // also keeps the cost amounts themselves out of a diagnostics response.
  //
  // A record with a null shopifyProductId is a STORE-WIDE default, not an orphan,
  // and is filtered out here rather than being skipped later by a length check.
  const records = (await CostRecordModel.find({
    shopDomain: config.shopify.storeDomain,
    shopifyProductId: { $ne: null },
  })
    .select('shopifyProductId shopifyVariantId')
    .lean()) as Record<string, unknown>[];

  const findings: IntegrityFinding[] = [];
  for (const record of records) {
    const productId = String(record['shopifyProductId'] ?? '');
    if (productId.length === 0 || knownProductIds.has(productId)) continue;

    findings.push({
      code: 'ORPHANED_MANUAL_COST',
      severity: 'warning',
      shopifyProductId: productId,
      shopifyVariantId: (record['shopifyVariantId'] as string | null) ?? null,
      title: '(product not found in the catalogue)',
      detail:
        'A manual cost override refers to a product that is not in the current catalogue - it was probably deleted in Shopify. The override applies to nothing.',
      recommendedAction:
        'Delete the manual cost if the product is gone, or confirm the product id if it should still exist.',
    });
  }
  return findings;
}

/**
 * Runs every check that can run, and reports the ones that cannot.
 *
 * A partial report is far more useful than a failure, so one broken check does
 * not abort the rest - but a check that was skipped is listed explicitly rather
 * than quietly producing "no findings", which would read as "everything is fine".
 */
export async function runIntegrityChecks(): Promise<IntegrityReport> {
  const findings: IntegrityFinding[] = [];
  const skipped: { check: string; reason: string }[] = [];
  let productsInspected = false;
  let productsScanned = 0;
  let truncated = false;
  let publicationChecked = false;
  let knownProductIds = new Set<string>();

  try {
    // Null when the app cannot see an Online Store publication - either the scope
    // is missing or the store genuinely has no online storefront. Either way the
    // status-vs-publication comparison is impossible, and saying so is much better
    // than comparing against a guessed id and reporting fictional findings.
    const publication = await findOnlineStorePublication();
    if (publication === null) {
      throw new AppError(
        'SHOPIFY_NOT_FOUND',
        'No Online Store publication is visible to the app, so product status cannot be compared against customer-facing visibility.',
      );
    }
    publicationChecked = true;
    const result = await checkProducts(publication.id);
    findings.push(...result.findings);
    productsScanned = result.scanned;
    truncated = result.truncated;
    productsInspected = true;
    knownProductIds = result.productIds;
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown';
    logger.warn('Integrity product/publication checks could not run.', { reason });
    skipped.push({
      check: 'product status vs publication',
      reason: `${reason} (read_publications is required to compare status against Online Store publication).`,
    });
  }

  if (getDatabaseStatus().status !== 'connected') {
    skipped.push({
      check: 'orphaned manual costs',
      reason: 'No database is connected, so stored cost overrides cannot be inspected.',
    });
  } else {
    try {
      // Only meaningful against a COMPLETE catalogue: with a truncated scan, a
      // product beyond the limit would be wrongly reported as deleted.
      if (truncated || !productsInspected) {
        skipped.push({
          check: 'orphaned manual costs',
          reason: truncated
            ? `Only the first ${MAX_PRODUCTS} products were scanned, so a cost override for a product beyond that would be misreported as orphaned.`
            : 'The product scan did not run, so there is nothing to compare cost overrides against.',
        });
      } else {
        findings.push(...(await checkOrphanedCosts(knownProductIds, true)));
      }
    } catch (error) {
      skipped.push({
        check: 'orphaned manual costs',
        reason: error instanceof Error ? error.message : 'unknown',
      });
    }
  }

  const counts: Record<string, number> = {};
  for (const finding of findings) {
    counts[finding.code] = (counts[finding.code] ?? 0) + 1;
  }

  return {
    shopDomain: config.shopify.storeDomain,
    checkedAt: new Date().toISOString(),
    productsInspected,
    productsScanned,
    truncated,
    publicationChecked,
    findings,
    counts,
    skipped,
  };
}
