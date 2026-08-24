/**
 * Deciding whether a stored score is stale.
 *
 * WHY `updatedAt > analyzedAt` HAD TO GO
 * -------------------------------------
 * That comparison was wrong three separate ways, and each way fails in a different
 * direction:
 *
 *   1. Mongoose bumps `updatedAt` during the analysis write ITSELF. The write that
 *      stores a fresh score therefore also makes it look stale, so a candidate analysed
 *      one second ago reported "the score is out of date". A warning that fires every
 *      time is a warning nobody reads.
 *   2. Watching, rejecting or adding a note bumps `updatedAt` too. None of those change
 *      a single scoring input, so the score was reported stale for edits that could not
 *      possibly have affected it.
 *   3. It is a timestamp comparison across two clocks and two write paths, so its answer
 *      depended on write ordering rather than on whether anything relevant changed.
 *
 * The replacement is a revision counter over the inputs that actually feed the score.
 * `inputRevision` moves only when a scoring input moves; `analyzedInputRevision` records
 * which revision the stored score was computed from. Equal means current. That is a
 * statement about DATA, not about clocks.
 *
 * WHAT THIS DELIBERATELY DOES NOT COVER
 * ------------------------------------
 * Pricing settings and live Shopify store history live outside the candidate, so they
 * cannot move `inputRevision`. They are caught at push time by the decision hash, which
 * is computed from the analysis OUTPUT rather than from the candidate row. The two
 * mechanisms answer different questions on purpose:
 *
 *   inputRevision  "has the operator edited this candidate since it was scored?"  (list view)
 *   decisionHash   "is the exact decision I reviewed still the current one?"      (push gate)
 *
 * Pure: no config, no database, no clock.
 */

import { stableStringify } from '../common/stableStringify';
import type { ProductCandidate } from './candidate.types';

/**
 * The candidate fields that materially determine a score.
 *
 * Derived from what the analysis actually reads, not from intuition:
 *   - `title`, `category`, `keywords`, `market`, `manualResearch` are the ResearchRequest
 *     handed to every provider (see researchRequestFor).
 *   - `commercials` drives the price recommendation, which drives profitability, and the
 *     expected price drives store fit.
 *
 * Deliberately EXCLUDED, because changing them cannot change a score:
 *   - `notes`            free text for humans
 *   - `watchUntil`       a reminder date
 *   - `status`           an operator decision ABOUT the score, not an input to it
 *   - `pushedShopifyProductId`, `pushedAt`, `pushState`  push bookkeeping
 *   - `factors`, `overallScore`, `confidenceScore`, `recommendation`, `reasons`,
 *     `risks`, `evidence`, `freshness`, `seasonState`, `scoreHistory`  these are the
 *     OUTPUT. Including them would make every analysis invalidate its own result.
 *   - `imageUrl`, `sourceUrl`, `sourceProductId`  provenance and presentation
 *   - all timestamps
 */
export interface ScoreInputs {
  title: string;
  category: string | null;
  keywords: string[];
  market: ProductCandidate['market'];
  commercials: ProductCandidate['commercials'];
  manualResearch: ProductCandidate['manualResearch'];
}

/** The names of the score-affecting fields, for error messages and tests. */
export const SCORE_AFFECTING_FIELDS: readonly (keyof ScoreInputs)[] = Object.freeze([
  'title',
  'category',
  'keywords',
  'market',
  'commercials',
  'manualResearch',
]);

/**
 * Extracts the scoring inputs from a candidate.
 *
 * Normalises as it goes so cosmetically different values compare equal: a title with
 * trailing space, keywords in a different order, or a currency in lower case are the
 * same INPUT and must not bump the revision. Otherwise an operator who retyped a field
 * identically would be told their score went stale.
 */
export function scoreInputsOf(
  candidate: Pick<ProductCandidate, keyof ScoreInputs>,
): ScoreInputs {
  return {
    title: candidate.title.trim(),
    category: normaliseText(candidate.category),
    // Sorted and de-duplicated: keywords are a SET as far as the providers are
    // concerned, so reordering them changes nothing.
    keywords: [...new Set(candidate.keywords.map((keyword) => keyword.trim().toLowerCase()))]
      .filter((keyword) => keyword !== '')
      .sort(),
    market: {
      countryCode: candidate.market.countryCode.trim().toUpperCase(),
      region: normaliseText(candidate.market.region),
      horizonDays: candidate.market.horizonDays,
    },
    commercials: {
      ...candidate.commercials,
      supplierCurrency: normaliseCode(candidate.commercials.supplierCurrency),
      shippingCurrency: normaliseCode(candidate.commercials.shippingCurrency),
      expectedSellingCurrency: normaliseCode(candidate.commercials.expectedSellingCurrency),
    },
    manualResearch: {
      ...candidate.manualResearch,
      geography: {
        countryCode: normaliseCode(candidate.manualResearch.geography.countryCode),
        region: normaliseText(candidate.manualResearch.geography.region),
      },
      peakMonths:
        candidate.manualResearch.peakMonths === null
          ? null
          : [...candidate.manualResearch.peakMonths].sort((a, b) => a - b),
    },
  };
}

function normaliseText(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function normaliseCode(value: string | null): string | null {
  const trimmed = normaliseText(value);
  return trimmed === null ? null : trimmed.toUpperCase();
}

/**
 * True when the scoring inputs differ.
 *
 * Compares VALUES rather than which keys a patch happened to mention. A client that
 * resends the whole commercials object on every save - which is the normal shape of a
 * form submit - must not bump the revision when nothing in it actually moved.
 *
 * stableStringify rather than JSON.stringify: property order is not a difference, and
 * an unstable serialisation would report spurious changes depending on how the object
 * was built.
 */
export function scoreInputsChanged(
  before: Pick<ProductCandidate, keyof ScoreInputs>,
  after: Pick<ProductCandidate, keyof ScoreInputs>,
): boolean {
  return stableStringify(scoreInputsOf(before)) !== stableStringify(scoreInputsOf(after));
}

/** Which score-affecting fields moved. For the audit trail and for tests. */
export function changedScoreInputs(
  before: Pick<ProductCandidate, keyof ScoreInputs>,
  after: Pick<ProductCandidate, keyof ScoreInputs>,
): (keyof ScoreInputs)[] {
  const from = scoreInputsOf(before);
  const to = scoreInputsOf(after);
  return SCORE_AFFECTING_FIELDS.filter(
    (field) => stableStringify(from[field]) !== stableStringify(to[field]),
  );
}

/**
 * Whether the stored score was computed from the candidate's current inputs.
 *
 * A candidate that has never been analysed is NOT stale - it has no score to be stale.
 * That distinction matters in the UI: "never analysed" invites an analysis, whereas
 * "out of date" implies a number is on screen that should not be trusted.
 */
export function scoreIsStale(
  candidate: Pick<ProductCandidate, 'analyzedAt' | 'inputRevision' | 'analyzedInputRevision'>,
): boolean {
  if (candidate.analyzedAt === null) return false;
  // A stored score with no recorded revision predates this mechanism. Treated as stale,
  // because "we cannot tell" must not read as "it is fine".
  if (candidate.analyzedInputRevision === null) return true;
  return candidate.analyzedInputRevision !== candidate.inputRevision;
}
