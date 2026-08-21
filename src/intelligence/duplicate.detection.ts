/**
 * Duplicate detection, before a candidate becomes a Shopify product.
 *
 * THE FAILURE THIS PREVENTS
 * ------------------------
 * An operator researches a neck fan in June, rejects it, researches it again in August,
 * and pushes it. Now the catalogue has two products competing with each other, two
 * inventory positions, and two sets of reviews. Nobody notices until a customer asks why
 * the same item has two prices.
 *
 * WHY IT IS DELIBERATELY UNCLEVER
 * -------------------------------
 * Exact identifiers first, then exact normalised titles, then token overlap. No stemming,
 * no fuzzy edit distance, no embedding similarity. Two reasons:
 *
 *   1. A false positive here BLOCKS a push. "Portable Neck Fan" and "Portable Desk Fan"
 *      share three of four tokens and are different products; a matcher confident enough
 *      to merge them would refuse legitimate work, and an operator who learns to click
 *      through a block stops reading it.
 *   2. Every verdict must be explainable in one sentence an operator can disagree with.
 *      "These share 4 of 5 title words" is arguable. A cosine distance is not.
 *
 * So the design errs toward WARNING rather than blocking, and only an exact identity
 * match blocks - and even that can be overridden deliberately.
 *
 * Pure: no Shopify, no database, no clock.
 */

import type { CandidateStatus } from './candidate.types';

/* ===========================================================================
 * Input
 * ======================================================================== */

/** The candidate being checked. `candidateId` is null when it does not exist yet. */
export interface DuplicateSubject {
  candidateId: string | null;
  title: string;
  keywords: readonly string[];
  /** The supplier's own product reference, when the operator recorded one. */
  sourceProductId: string | null;
}

/** A product already in the store's Shopify catalogue. */
export interface ExistingProductRef {
  shopifyProductId: string;
  title: string;
  /** ACTIVE, DRAFT or ARCHIVED. An archived clash is weaker evidence. */
  status: string;
  tags: readonly string[];
}

/** Another research candidate. */
export interface ExistingCandidateRef {
  candidateId: string;
  title: string;
  status: CandidateStatus;
  sourceProductId: string | null;
  pushedShopifyProductId: string | null;
}

export interface DetectDuplicatesInput {
  subject: DuplicateSubject;
  products: readonly ExistingProductRef[];
  candidates: readonly ExistingCandidateRef[];
}

/* ===========================================================================
 * Output
 * ======================================================================== */

export type DuplicateStrength =
  /** Same supplier reference, or an identical title. Blocks by default. */
  | 'EXACT'
  /** Substantially the same title. Warns. */
  | 'LIKELY'
  /** Enough overlap to be worth a look. Warns quietly. */
  | 'POSSIBLE';

export type DuplicateTarget = 'SHOPIFY_PRODUCT' | 'CANDIDATE';

export interface DuplicateMatch {
  target: DuplicateTarget;
  /** Shopify GID or candidate id. */
  id: string;
  title: string;
  strength: DuplicateStrength;
  /** One sentence, phrased so an operator can disagree with it. */
  reason: string;
  /**
   * True when this match should stop a push unless explicitly overridden.
   *
   * Only EXACT matches block, and an ARCHIVED Shopify product never does - it was
   * deliberately taken out of the catalogue, so relisting it is a plausible intent
   * rather than an accident.
   */
  blocking: boolean;
}

export interface DuplicateReport {
  matches: DuplicateMatch[];
  /** The subset that would stop a push. Empty means the push may proceed. */
  blocking: DuplicateMatch[];
  /** Null when nothing was found. */
  summary: string | null;
}

/* ===========================================================================
 * Normalisation
 * ======================================================================== */

/**
 * Lowercases, strips punctuation and collapses whitespace.
 *
 * Deliberately does NOT stem or de-pluralise. "Fan" and "Fans" staying distinct costs a
 * detection; "Fan" and "Fanny pack" being merged by an over-eager stemmer costs a
 * blocked push, and the second mistake is the expensive one.
 */
export function normaliseTitle(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Tokens worth comparing. Single characters are dropped as noise. */
function tokensOf(value: string): Set<string> {
  return new Set(
    normaliseTitle(value)
      .split(' ')
      .filter((token) => token.length > 1),
  );
}

/**
 * Jaccard similarity: shared tokens over total distinct tokens.
 *
 * Chosen over "shared / shortest" because that alternative reports 1.0 whenever one title
 * is a subset of the other, which would make "Fan" a perfect match for every fan in the
 * catalogue.
 */
function similarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) {
    if (b.has(token)) shared += 1;
  }
  const union = a.size + b.size - shared;
  return union === 0 ? 0 : shared / union;
}

/** Above this, two titles are substantially the same product. */
const LIKELY_THRESHOLD = 0.8;
/** Above this, worth a look. */
const POSSIBLE_THRESHOLD = 0.5;

function sharedTokenList(a: Set<string>, b: Set<string>): string[] {
  return [...a].filter((token) => b.has(token)).sort();
}

/* ===========================================================================
 * Detection
 * ======================================================================== */

export function detectDuplicates(input: DetectDuplicatesInput): DuplicateReport {
  const { subject } = input;
  const subjectTokens = tokensOf(subject.title);
  const subjectNormalised = normaliseTitle(subject.title);
  const subjectReference = normaliseReference(subject.sourceProductId);

  const matches: DuplicateMatch[] = [];

  // ---- against the Shopify catalogue --------------------------------------
  for (const product of input.products) {
    const archived = product.status.toUpperCase() === 'ARCHIVED';
    const productNormalised = normaliseTitle(product.title);

    if (productNormalised === subjectNormalised && subjectNormalised !== '') {
      matches.push({
        target: 'SHOPIFY_PRODUCT',
        id: product.shopifyProductId,
        title: product.title,
        strength: 'EXACT',
        reason: archived
          ? `An ARCHIVED product already has this exact title. Relisting something you archived is a plausible intent, so this does not block the push - but check it is what you meant.`
          : `A product with this exact title already exists in the catalogue (${product.status}). Pushing would create a second listing competing with it.`,
        // An archived product was deliberately removed, so recreating it is a decision
        // rather than an accident.
        blocking: !archived,
      });
      continue;
    }

    const score = similarity(subjectTokens, tokensOf(product.title));
    if (score >= LIKELY_THRESHOLD) {
      matches.push({
        target: 'SHOPIFY_PRODUCT',
        id: product.shopifyProductId,
        title: product.title,
        strength: 'LIKELY',
        reason: `"${product.title}" already exists and shares ${describeOverlap(subjectTokens, tokensOf(product.title))}. This looks like the same product under a different name.`,
        // Warns rather than blocks: an operator who learns to click through a block
        // stops reading it, so blocks are reserved for exact identity.
        blocking: false,
      });
      continue;
    }
    if (score >= POSSIBLE_THRESHOLD) {
      matches.push({
        target: 'SHOPIFY_PRODUCT',
        id: product.shopifyProductId,
        title: product.title,
        strength: 'POSSIBLE',
        reason: `"${product.title}" shares ${describeOverlap(subjectTokens, tokensOf(product.title))}. Possibly the same product, possibly a different one in the same range.`,
        blocking: false,
      });
    }
  }

  // ---- against other candidates -------------------------------------------
  for (const other of input.candidates) {
    // Never compare a candidate with itself.
    if (subject.candidateId !== null && other.candidateId === subject.candidateId) continue;

    const otherReference = normaliseReference(other.sourceProductId);
    if (
      subjectReference !== null &&
      otherReference !== null &&
      subjectReference === otherReference
    ) {
      matches.push({
        target: 'CANDIDATE',
        id: other.candidateId,
        title: other.title,
        strength: 'EXACT',
        reason:
          other.pushedShopifyProductId === null
            ? `Candidate "${other.title}" already refers to the same supplier product (${subject.sourceProductId}). You are researching the same item twice.`
            : `Candidate "${other.title}" refers to the same supplier product (${subject.sourceProductId}) and has ALREADY been pushed to Shopify as ${other.pushedShopifyProductId}. Pushing this one would duplicate that draft.`,
        // A pushed twin is a real duplicate in Shopify; an unpushed one is only
        // duplicated research, which is untidy rather than harmful.
        blocking: other.pushedShopifyProductId !== null,
      });
      continue;
    }

    const otherNormalised = normaliseTitle(other.title);
    if (otherNormalised === normaliseTitle(subject.title) && otherNormalised !== '') {
      matches.push({
        target: 'CANDIDATE',
        id: other.candidateId,
        title: other.title,
        strength: 'EXACT',
        reason:
          other.pushedShopifyProductId === null
            ? `Candidate "${other.title}" has the same title and status ${other.status}. Consider updating that one instead of creating a second.`
            : `Candidate "${other.title}" has the same title and was already pushed to Shopify as ${other.pushedShopifyProductId}.`,
        blocking: other.pushedShopifyProductId !== null,
      });
      continue;
    }

    const score = similarity(subjectTokens, tokensOf(other.title));
    if (score >= LIKELY_THRESHOLD) {
      matches.push({
        target: 'CANDIDATE',
        id: other.candidateId,
        title: other.title,
        strength: 'LIKELY',
        reason: `Candidate "${other.title}" (${other.status}) shares ${describeOverlap(subjectTokens, tokensOf(other.title))}.`,
        blocking: false,
      });
    }
  }

  // Strongest first, so the UI leads with the thing most likely to matter.
  const ordered = matches.sort(
    (a, b) => strengthRank(b.strength) - strengthRank(a.strength),
  );
  const blocking = ordered.filter((match) => match.blocking);

  return {
    matches: ordered,
    blocking,
    summary: summarise(ordered, blocking),
  };
}

/* ===========================================================================
 * Helpers
 * ======================================================================== */

/**
 * A supplier reference, comparable.
 *
 * Trimmed and lowercased, and empty strings collapse to null - an empty reference must
 * never match another empty one, which would make every candidate without a supplier id
 * a duplicate of every other.
 */
function normaliseReference(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed === '' ? null : trimmed;
}

function strengthRank(strength: DuplicateStrength): number {
  return strength === 'EXACT' ? 2 : strength === 'LIKELY' ? 1 : 0;
}

/** "4 of 5 title words (fan, neck, portable, usb)" - checkable, not a score. */
function describeOverlap(a: Set<string>, b: Set<string>): string {
  const shared = sharedTokenList(a, b);
  const union = a.size + b.size - shared.length;
  return `${shared.length} of ${union} title words (${shared.join(', ')})`;
}

function summarise(
  matches: readonly DuplicateMatch[],
  blocking: readonly DuplicateMatch[],
): string | null {
  if (matches.length === 0) return null;

  if (blocking.length > 0) {
    return `${blocking.length} exact ${blocking.length === 1 ? 'match' : 'matches'} found. The push is blocked to prevent a duplicate listing; override it deliberately if this really is a different product.`;
  }
  return `${matches.length} possible ${matches.length === 1 ? 'duplicate' : 'duplicates'} found. None is an exact match, so the push is allowed - check them first.`;
}
