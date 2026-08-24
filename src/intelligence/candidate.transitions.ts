/**
 * Which research decisions are legal from which state.
 *
 * WHAT WAS WRONG
 * --------------
 * setCandidateStatus accepted a transition because the TARGET status was a valid value.
 * It never looked at where the candidate currently was. So a candidate that already had a
 * Shopify draft could be set back to WATCHING and would then look, to every list and
 * every button, like an ordinary pre-product candidate - one Push click away from a
 * second product. A REJECTED candidate could silently become WATCHING again with no
 * record of anyone reopening it.
 *
 * A target-only check cannot express "this is terminal", because terminality is a
 * property of the CURRENT state. So the table below is keyed on both.
 *
 * FAIL CLOSED
 * -----------
 * Where a workflow does not exist, the transition is refused rather than allowed with a
 * shrug. REJECTED -> WATCHING would need a deliberate "reopen candidate" action so the
 * reopening is visible in the audit trail; there is no such action today, so it is
 * refused and the message says what is missing. Inventing a permissive default would mean
 * the first person to need it discovers the feature already half-works, undocumented.
 *
 * Pure: no config, no database, no clock.
 */

import type { CandidateStatus, ProductCandidate, PushState } from './candidate.types';

/** An operator-facing action, as the UI would label it. */
export type ResearchAction = 'WATCH' | 'SELECT' | 'REJECT' | 'PUSH' | 'ANALYZE';

export interface ActionDecision {
  allowed: boolean;
  /** Why not. Null when allowed. Written for an operator, not a developer. */
  reason: string | null;
}

const ALLOW: ActionDecision = Object.freeze({ allowed: true, reason: null });

function refuse(reason: string): ActionDecision {
  return { allowed: false, reason };
}

/**
 * Statuses from which no research decision may be taken.
 *
 * PUSHED_TO_SHOPIFY is terminal because the candidate is no longer a candidate: a real
 * product exists, and every further decision about it belongs to the product workflow
 * (edit it, publish it through the existing review path, archive it) rather than to
 * research. Treating it as a candidate again is what lets a duplicate be created.
 *
 * REJECTED is terminal because reopening should be a deliberate, recorded act and there
 * is no such action.
 */
export const TERMINAL_STATUSES: readonly CandidateStatus[] = Object.freeze([
  'PUSHED_TO_SHOPIFY',
  'REJECTED',
]);

/**
 * The transition table, keyed on the CURRENT status.
 *
 * A status may transition to itself only where repeating the decision means something:
 * WATCHING -> WATCHING extends a watch date, which is a real operation. ANALYZED ->
 * ANALYZED is not, and is refused so a no-op cannot fill the audit trail.
 */
const ALLOWED_TRANSITIONS: Readonly<Record<CandidateStatus, readonly CandidateStatus[]>> =
  Object.freeze({
    NEW: Object.freeze<CandidateStatus[]>(['ANALYZED', 'WATCHING', 'SELECTED', 'REJECTED']),
    ANALYZED: Object.freeze<CandidateStatus[]>(['WATCHING', 'SELECTED', 'REJECTED']),
    // Re-watching extends the date; selecting promotes it; rejecting closes it.
    WATCHING: Object.freeze<CandidateStatus[]>(['WATCHING', 'SELECTED', 'REJECTED']),
    // Deselecting back to WATCHING is legitimate: an operator can change their mind
    // before anything exists in Shopify.
    SELECTED: Object.freeze<CandidateStatus[]>(['WATCHING', 'REJECTED']),
    // Terminal. See TERMINAL_STATUSES.
    PUSHED_TO_SHOPIFY: Object.freeze<CandidateStatus[]>([]),
    REJECTED: Object.freeze<CandidateStatus[]>([]),
  });

/**
 * Whether a status change is legal.
 *
 * Checks BOTH ends. The message names the current status, because "cannot set WATCHING"
 * without saying what it currently is sends the reader looking in the wrong place.
 */
export function canTransition(
  from: CandidateStatus,
  to: CandidateStatus,
  context: { pushedShopifyProductId?: string | null } = {},
): ActionDecision {
  if (from === 'PUSHED_TO_SHOPIFY') {
    const reference =
      context.pushedShopifyProductId == null
        ? 'a Shopify draft'
        : `Shopify draft ${context.pushedShopifyProductId}`;
    return refuse(
      `This candidate has already been pushed and ${reference} exists, so research decisions no longer apply to it. Manage the product in Shopify or through the normal product workflow - treating it as a candidate again is how a duplicate gets created.`,
    );
  }

  if (from === 'REJECTED') {
    return refuse(
      'This candidate was rejected. Reopening it is not a supported action, so that the decision to revisit something is deliberate and recorded rather than an accidental click. Create a new candidate if you want to research it again.',
    );
  }

  if (!ALLOWED_TRANSITIONS[from].includes(to)) {
    return refuse(
      `A candidate with status ${from} cannot become ${to}. Allowed from ${from}: ${
        ALLOWED_TRANSITIONS[from].length === 0
          ? 'nothing'
          : ALLOWED_TRANSITIONS[from].join(', ')
      }.`,
    );
  }

  return ALLOW;
}

/* ===========================================================================
 * Push eligibility
 * ======================================================================== */

/**
 * Statuses from which a push may be attempted.
 *
 * ANALYZED is included because analyse-then-push is the sequence the module is designed
 * around. NEW is included so an operator who already knows the product can push without
 * a ceremonial analysis - the push re-analyses internally anyway.
 */
export const PUSHABLE_STATUSES: readonly CandidateStatus[] = Object.freeze([
  'NEW',
  'ANALYZED',
  'WATCHING',
  'SELECTED',
]);

/**
 * Whether a push may begin.
 *
 * Order matters: the checks run cheapest-and-most-specific first, so the operator gets
 * the most useful message rather than the most general one. An already-pushed candidate
 * is told which product exists; a candidate mid-push is told to wait.
 */
export function canPushCandidate(
  candidate: Pick<
    ProductCandidate,
    'status' | 'pushState' | 'pushedShopifyProductId' | 'pushOperationId'
  >,
): ActionDecision {
  // A known product id is the strongest signal and is checked first, ahead of status,
  // because it is true even if the status write failed halfway through a previous push.
  if (candidate.pushedShopifyProductId !== null) {
    return refuse(
      `This candidate has already been pushed to Shopify as ${candidate.pushedShopifyProductId}. Pushing again would create a duplicate product; edit the existing draft instead.`,
    );
  }

  if (candidate.pushState === 'IN_PROGRESS') {
    return refuse(
      'A push for this candidate is already running. Wait for it to finish rather than starting a second one - if it has genuinely stalled, the claim expires on its own and can then be retried.',
    );
  }

  if (candidate.pushState === 'SAFETY_INCIDENT') {
    return refuse(
      'The last push for this candidate left a Shopify product in a state Trademart could not verify as hidden. That needs a human to check in Shopify before anything else is created.',
    );
  }

  if (!PUSHABLE_STATUSES.includes(candidate.status)) {
    // Reuses the transition wording so the same situation reads the same way whichever
    // route the operator hit.
    return canTransition(candidate.status, 'PUSHED_TO_SHOPIFY', {
      pushedShopifyProductId: candidate.pushedShopifyProductId,
    });
  }

  return ALLOW;
}

/* ===========================================================================
 * What the UI may offer
 * ======================================================================== */

export interface AllowedActions {
  watch: ActionDecision;
  select: ActionDecision;
  reject: ActionDecision;
  push: ActionDecision;
  analyze: ActionDecision;
}

/**
 * The actions currently available, computed from backend rules.
 *
 * Exposed so the UI does not need a second, inevitably divergent copy of the transition
 * table. The backend remains authoritative - every route re-checks - but a button that is
 * enabled and then refused is a bug report, so the two must agree.
 */
export function allowedActions(
  candidate: Pick<
    ProductCandidate,
    'status' | 'pushState' | 'pushedShopifyProductId' | 'pushOperationId'
  >,
): AllowedActions {
  const context = { pushedShopifyProductId: candidate.pushedShopifyProductId };

  return {
    watch: canTransition(candidate.status, 'WATCHING', context),
    select: canTransition(candidate.status, 'SELECTED', context),
    reject: canTransition(candidate.status, 'REJECTED', context),
    push: canPushCandidate(candidate),
    analyze: analyzeDecision(candidate),
  };
}

/**
 * Whether re-analysing is worth offering.
 *
 * Analysis is read-only with respect to the operator's DECISION - it never moves a status
 * beyond NEW -> ANALYZED - so it stays available in every state where a decision is still
 * open. It is withdrawn in exactly two places.
 *
 * Once the status is terminal: analysis still WRITES score, recommendation and analyzedAt
 * to the candidate, so offering it on a terminal candidate would let the stored numbers
 * move after the decision that closed it. A rejected candidate whose score has since been
 * recomputed reads as though the rejection was made on figures nobody ever saw. Keyed on
 * isTerminal rather than on PUSHED_TO_SHOPIFY alone so the two never diverge.
 *
 * And while a push holds the claim: the push computes a fresher analysis itself, and a
 * concurrent one would race it.
 */
function analyzeDecision(
  candidate: Pick<ProductCandidate, 'status' | 'pushState'>,
): ActionDecision {
  if (candidate.status === 'PUSHED_TO_SHOPIFY') {
    return refuse(
      'This candidate is already a Shopify product, so re-scoring it would not change anything you can act on.',
    );
  }
  if (isTerminal(candidate.status)) {
    return refuse(
      'This candidate is closed, and re-scoring it would change the numbers the closing decision was made on. Create a new candidate if you want a current view of this product.',
    );
  }
  if (candidate.pushState === 'IN_PROGRESS') {
    return refuse('A push is running, and it computes a fresh analysis itself.');
  }
  return ALLOW;
}

/** True when nothing about this candidate may change through research any more. */
export function isTerminal(status: CandidateStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/**
 * Whether a stale push claim may be taken over.
 *
 * A claim whose lease has expired belonged to a process that died. Recovering it is safe
 * ONLY because the Shopify-side identity tag makes a second product impossible: the
 * recovering operation looks the candidate up in Shopify by its research tag before
 * creating anything. Without that lookup this would be a licence to duplicate.
 */
export function claimIsRecoverable(
  candidate: Pick<ProductCandidate, 'pushState' | 'pushClaimedAt'>,
  now: Date,
  leaseMs: number,
): boolean {
  if (candidate.pushState !== 'IN_PROGRESS') return false;
  if (candidate.pushClaimedAt === null) {
    // IN_PROGRESS with no claim time is corrupt. Treated as recoverable so a bad row
    // cannot wedge a candidate permanently.
    return true;
  }
  const claimedAt = new Date(candidate.pushClaimedAt).getTime();
  if (!Number.isFinite(claimedAt)) return true;
  return now.getTime() - claimedAt >= leaseMs;
}

/** Push states from which a fresh claim may be taken. */
export function pushStateAllowsClaim(state: PushState): boolean {
  return state === 'IDLE';
}
