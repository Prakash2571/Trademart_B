/**
 * The transition policy, tested as a table rather than as a handful of happy paths.
 *
 * This file replaces the old canPush tests in candidate.types.test.ts. Those covered the
 * refusals that were already implemented; they could not cover the one that mattered most,
 * because the function they tested could not see `pushState` and therefore approved a push
 * for a candidate whose push was already in flight.
 *
 * The suite is deliberately exhaustive over CandidateStatus x CandidateStatus. A
 * target-only check passes any spot test you write for it - it only fails on the pair
 * nobody thought of - so the pairs are enumerated rather than sampled.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { CandidateStatus, ProductCandidate, PushState } from './candidate.types';
import {
  PUSHABLE_STATUSES,
  TERMINAL_STATUSES,
  allowedActions,
  canPushCandidate,
  canTransition,
  claimIsRecoverable,
  isTerminal,
  pushStateAllowsClaim,
} from './candidate.transitions';

const ALL_STATUSES: readonly CandidateStatus[] = [
  'NEW',
  'ANALYZED',
  'WATCHING',
  'SELECTED',
  'PUSHED_TO_SHOPIFY',
  'REJECTED',
];

const ALL_PUSH_STATES: readonly PushState[] = [
  'IDLE',
  'IN_PROGRESS',
  'SUCCEEDED',
  'SAFETY_INCIDENT',
];

/** The subset of a candidate the policy reads. Nothing else is relevant to it. */
type PolicyInput = Pick<
  ProductCandidate,
  'status' | 'pushState' | 'pushedShopifyProductId' | 'pushOperationId'
>;

function subject(overrides: Partial<PolicyInput> = {}): PolicyInput {
  return {
    status: 'ANALYZED',
    pushState: 'IDLE',
    pushedShopifyProductId: null,
    pushOperationId: null,
    ...overrides,
  };
}

/**
 * The transitions the policy is SUPPOSED to permit, written out independently of the
 * implementation's table so that a change to the table has to be a change here too.
 */
const EXPECTED_ALLOWED: readonly `${CandidateStatus}->${CandidateStatus}`[] = [
  'NEW->ANALYZED',
  'NEW->WATCHING',
  'NEW->SELECTED',
  'NEW->REJECTED',
  'ANALYZED->WATCHING',
  'ANALYZED->SELECTED',
  'ANALYZED->REJECTED',
  'WATCHING->WATCHING',
  'WATCHING->SELECTED',
  'WATCHING->REJECTED',
  'SELECTED->WATCHING',
  'SELECTED->REJECTED',
];

/* ===========================================================================
 * The full matrix
 * ======================================================================== */

describe('canTransition validates BOTH ends, over every pair', () => {
  it('permits exactly the transitions the workflow defines, and no others', () => {
    const permitted: string[] = [];
    for (const from of ALL_STATUSES) {
      for (const to of ALL_STATUSES) {
        if (canTransition(from, to).allowed) permitted.push(`${from}->${to}`);
      }
    }
    // Set comparison rather than pair-by-pair asserts: the failure message then names
    // exactly which transition appeared or disappeared.
    assert.deepEqual(new Set(permitted), new Set(EXPECTED_ALLOWED));
  });

  it('refuses every transition OUT of a terminal status', () => {
    // 12 pairs. This is the property a target-only check cannot express, because
    // terminality is a property of where you are, not where you are going.
    for (const from of TERMINAL_STATUSES) {
      for (const to of ALL_STATUSES) {
        const decision = canTransition(from, to);
        assert.equal(
          decision.allowed,
          false,
          `${from} -> ${to} must be refused: ${from} is terminal.`,
        );
        assert.notEqual(decision.reason, null, `${from} -> ${to} must explain itself.`);
      }
    }
  });

  it('refuses a no-op that means nothing, and allows the one that means something', () => {
    // Re-watching extends a watch date - a real operation with a real effect.
    assert.equal(canTransition('WATCHING', 'WATCHING').allowed, true);
    // Re-analysing is not a status change, so a self-transition here would only add a
    // meaningless audit entry.
    assert.equal(canTransition('ANALYZED', 'ANALYZED').allowed, false);
    assert.equal(canTransition('NEW', 'NEW').allowed, false);
    assert.equal(canTransition('SELECTED', 'SELECTED').allowed, false);
  });

  it('never returns allowed with a reason, or refused without one', () => {
    for (const from of ALL_STATUSES) {
      for (const to of ALL_STATUSES) {
        const decision = canTransition(from, to);
        if (decision.allowed) {
          assert.equal(decision.reason, null, `${from}->${to} was allowed but gave a reason`);
        } else {
          assert.ok(
            typeof decision.reason === 'string' && decision.reason.length > 0,
            `${from}->${to} was refused with no reason - the operator sees this text`,
          );
        }
      }
    }
  });
});

describe('the refusal messages tell the operator what to do instead', () => {
  it('an already-pushed candidate is told which product exists', () => {
    const decision = canTransition('PUSHED_TO_SHOPIFY', 'WATCHING', {
      pushedShopifyProductId: 'gid://shopify/Product/9',
    });
    assert.equal(decision.allowed, false);
    assert.match(decision.reason ?? '', /gid:\/\/shopify\/Product\/9/);
    assert.match(decision.reason ?? '', /duplicate/i);
  });

  it('says "a Shopify draft" when the id is unknown rather than printing null', () => {
    const decision = canTransition('PUSHED_TO_SHOPIFY', 'WATCHING');
    assert.match(decision.reason ?? '', /a Shopify draft exists/);
    assert.ok(!/null|undefined/.test(decision.reason ?? ''));
  });

  it('a rejected candidate is told to create a new one, not that it is impossible', () => {
    // Fail closed, but say what the way forward is - otherwise the next person
    // "fixes" it by relaxing the table.
    const decision = canTransition('REJECTED', 'SELECTED');
    assert.equal(decision.allowed, false);
    assert.match(decision.reason ?? '', /rejected/i);
    assert.match(decision.reason ?? '', /Create a new candidate/i);
  });

  it('an ordinary refusal names the current status and what is allowed from it', () => {
    const decision = canTransition('SELECTED', 'ANALYZED');
    assert.equal(decision.allowed, false);
    assert.match(decision.reason ?? '', /SELECTED/);
    assert.match(decision.reason ?? '', /Allowed from SELECTED: WATCHING, REJECTED/);
  });
});

describe('isTerminal', () => {
  it('is true for exactly PUSHED_TO_SHOPIFY and REJECTED', () => {
    for (const status of ALL_STATUSES) {
      assert.equal(
        isTerminal(status),
        status === 'PUSHED_TO_SHOPIFY' || status === 'REJECTED',
        status,
      );
    }
  });

  it('agrees with the transition table', () => {
    // Two representations of the same fact, so they cannot drift.
    for (const status of ALL_STATUSES) {
      const anyAllowed = ALL_STATUSES.some((to) => canTransition(status, to).allowed);
      assert.equal(isTerminal(status), !anyAllowed, status);
    }
  });
});

/* ===========================================================================
 * Push eligibility - including the case the old canPush could not see
 * ======================================================================== */

describe('canPushCandidate', () => {
  it('allows the four pre-product statuses', () => {
    for (const status of PUSHABLE_STATUSES) {
      const decision = canPushCandidate(subject({ status }));
      assert.equal(decision.allowed, true, `${status} should be pushable`);
      assert.equal(decision.reason, null);
    }
  });

  it('allows nothing outside PUSHABLE_STATUSES', () => {
    for (const status of ALL_STATUSES) {
      if (PUSHABLE_STATUSES.includes(status)) continue;
      assert.equal(canPushCandidate(subject({ status })).allowed, false, status);
    }
  });

  it('REFUSES a second push - it would duplicate the Shopify product', () => {
    const decision = canPushCandidate(
      subject({
        status: 'PUSHED_TO_SHOPIFY',
        pushState: 'SUCCEEDED',
        pushedShopifyProductId: 'gid://shopify/Product/1',
      }),
    );
    assert.equal(decision.allowed, false);
    assert.match(decision.reason ?? '', /already been pushed/);
    assert.match(decision.reason ?? '', /duplicate/);
    // The remedy is named, not just the refusal.
    assert.match(decision.reason ?? '', /edit the existing draft/);
  });

  it('checks the pushed id even when the status disagrees', () => {
    /*
     * The important ordering property. A push that created the product and then failed
     * before writing the status leaves exactly this row: NEW, with an id. If status were
     * checked first the candidate would look pushable and a duplicate would follow.
     */
    const decision = canPushCandidate(
      subject({ status: 'NEW', pushedShopifyProductId: 'gid://shopify/Product/1' }),
    );
    assert.equal(decision.allowed, false);
    assert.match(decision.reason ?? '', /already been pushed/);
  });

  it('refuses a candidate whose push is IN_PROGRESS - the case canPush() could not see', () => {
    /*
     * This is why the old helper was deleted rather than kept beside this one. It took
     * only { status, pushedShopifyProductId }, so during an in-flight push - status still
     * SELECTED, id still null, because the id is only written after Shopify replies - it
     * returned allowed: true.
     */
    for (const status of PUSHABLE_STATUSES) {
      const decision = canPushCandidate(
        subject({ status, pushState: 'IN_PROGRESS', pushOperationId: 'push-abc' }),
      );
      assert.equal(decision.allowed, false, `${status} + IN_PROGRESS must refuse`);
      assert.match(decision.reason ?? '', /already running/);
      // Tells the operator it will unwedge itself, so nobody goes looking for a reset.
      assert.match(decision.reason ?? '', /expires/);
    }
  });

  it('refuses a candidate left in SAFETY_INCIDENT until a human has looked', () => {
    const decision = canPushCandidate(subject({ status: 'SELECTED', pushState: 'SAFETY_INCIDENT' }));
    assert.equal(decision.allowed, false);
    assert.match(decision.reason ?? '', /could not verify as hidden/);
    assert.match(decision.reason ?? '', /human/);
  });

  it('the pushed id outranks even an IN_PROGRESS state', () => {
    // Both are true after a crash mid-retry. The duplicate warning is the useful one.
    const decision = canPushCandidate(
      subject({
        status: 'SELECTED',
        pushState: 'IN_PROGRESS',
        pushedShopifyProductId: 'gid://shopify/Product/4',
      }),
    );
    assert.equal(decision.allowed, false);
    assert.match(decision.reason ?? '', /already been pushed/);
  });

  it('blocks IN_PROGRESS and SAFETY_INCIDENT, and only those, on push state alone', () => {
    /*
     * IDLE is the normal case. SUCCEEDED reaches the status check instead, because a real
     * SUCCEEDED row carries a product id and is refused by the id check one line earlier -
     * see the corrupt-row case below for the pathological version.
     */
    for (const pushState of ALL_PUSH_STATES) {
      const decision = canPushCandidate(subject({ status: 'SELECTED', pushState }));
      const blockedByPushState = pushState === 'IN_PROGRESS' || pushState === 'SAFETY_INCIDENT';
      assert.equal(decision.allowed, !blockedByPushState, `pushState ${pushState}`);
    }
  });

  it('SUCCEEDED with no product id is a corrupt row, and status still governs', () => {
    /*
     * SUCCEEDED normally comes with an id, and the id check refuses first. With no id the
     * row is inconsistent; rather than inventing a rule for it, the status decides -
     * and a successful push leaves PUSHED_TO_SHOPIFY, which is terminal.
     */
    assert.equal(
      canPushCandidate(subject({ status: 'PUSHED_TO_SHOPIFY', pushState: 'SUCCEEDED' })).allowed,
      false,
    );
  });
});

/* ===========================================================================
 * What the UI is allowed to offer
 * ======================================================================== */

describe('allowedActions', () => {
  it('offers the full set for a fresh analysed candidate', () => {
    const actions = allowedActions(subject({ status: 'ANALYZED' }));
    assert.equal(actions.watch.allowed, true);
    assert.equal(actions.select.allowed, true);
    assert.equal(actions.reject.allowed, true);
    assert.equal(actions.push.allowed, true);
    assert.equal(actions.analyze.allowed, true);
  });

  it('offers nothing on a pushed candidate', () => {
    const actions = allowedActions(
      subject({
        status: 'PUSHED_TO_SHOPIFY',
        pushState: 'SUCCEEDED',
        pushedShopifyProductId: 'gid://shopify/Product/2',
      }),
    );
    for (const [name, decision] of Object.entries(actions)) {
      assert.equal(decision.allowed, false, `${name} must be refused on a pushed candidate`);
    }
  });

  it('offers nothing on a rejected candidate', () => {
    const actions = allowedActions(subject({ status: 'REJECTED' }));
    for (const [name, decision] of Object.entries(actions)) {
      assert.equal(decision.allowed, false, `${name} must be refused on a rejected candidate`);
    }
  });

  it('withdraws push and analyze while a push holds the claim, keeping the rest', () => {
    // Watching or rejecting mid-push is a decision about the candidate, not about the
    // product, so those stay open. Starting a second push does not.
    const actions = allowedActions(subject({ status: 'SELECTED', pushState: 'IN_PROGRESS' }));
    assert.equal(actions.push.allowed, false);
    assert.equal(actions.analyze.allowed, false);
    assert.match(actions.analyze.reason ?? '', /push is running/);
    assert.equal(actions.reject.allowed, true);
  });

  it('agrees with the underlying checks for every state combination', () => {
    /*
     * The point of exposing allowedActions is that the UI does not keep its own copy of
     * the table. That only holds if it is genuinely derived - a hand-written variant here
     * that drifted from canTransition would put an enabled button in front of an operator
     * that the route then refuses.
     */
    for (const status of ALL_STATUSES) {
      for (const pushState of ALL_PUSH_STATES) {
        for (const pushedId of [null, 'gid://shopify/Product/7']) {
          const input = subject({ status, pushState, pushedShopifyProductId: pushedId });
          const actions = allowedActions(input);
          const context = { pushedShopifyProductId: pushedId };
          assert.deepEqual(actions.watch, canTransition(status, 'WATCHING', context));
          assert.deepEqual(actions.select, canTransition(status, 'SELECTED', context));
          assert.deepEqual(actions.reject, canTransition(status, 'REJECTED', context));
          assert.deepEqual(actions.push, canPushCandidate(input));
        }
      }
    }
  });

  it('keeps analyze available on a plain NEW candidate', () => {
    // Analysis is the one action that does not commit the operator to anything, so it must
    // not be gated behind having already analysed.
    assert.equal(allowedActions(subject({ status: 'NEW' })).analyze.allowed, true);
    assert.equal(allowedActions(subject({ status: 'WATCHING' })).analyze.allowed, true);
  });
});

/* ===========================================================================
 * Claim recovery
 * ======================================================================== */

describe('claimIsRecoverable', () => {
  const LEASE = 120_000;
  const NOW = new Date('2026-06-15T12:00:00.000Z');

  function at(offsetMs: number): string {
    return new Date(NOW.getTime() + offsetMs).toISOString();
  }

  it('is false for anything that is not IN_PROGRESS', () => {
    for (const pushState of ALL_PUSH_STATES) {
      if (pushState === 'IN_PROGRESS') continue;
      assert.equal(
        claimIsRecoverable({ pushState, pushClaimedAt: at(-999_999) }, NOW, LEASE),
        false,
        pushState,
      );
    }
  });

  it('is false while the lease is still live', () => {
    assert.equal(
      claimIsRecoverable({ pushState: 'IN_PROGRESS', pushClaimedAt: at(0) }, NOW, LEASE),
      false,
    );
    assert.equal(
      claimIsRecoverable({ pushState: 'IN_PROGRESS', pushClaimedAt: at(-LEASE + 1) }, NOW, LEASE),
      false,
    );
  });

  it('becomes true exactly at the lease boundary', () => {
    // Stated explicitly because an off-by-one here is either a wedged candidate forever
    // or two live pushes.
    assert.equal(
      claimIsRecoverable({ pushState: 'IN_PROGRESS', pushClaimedAt: at(-LEASE) }, NOW, LEASE),
      true,
    );
  });

  it('treats a corrupt claim as recoverable so a bad row cannot wedge a candidate', () => {
    assert.equal(
      claimIsRecoverable({ pushState: 'IN_PROGRESS', pushClaimedAt: null }, NOW, LEASE),
      true,
    );
    assert.equal(
      claimIsRecoverable({ pushState: 'IN_PROGRESS', pushClaimedAt: 'not-a-date' }, NOW, LEASE),
      true,
    );
  });

  it('a clock that went backwards does not release a live claim', () => {
    // A claim stamped in the future yields a negative age, which must not read as expired.
    assert.equal(
      claimIsRecoverable({ pushState: 'IN_PROGRESS', pushClaimedAt: at(60_000) }, NOW, LEASE),
      false,
    );
  });
});

describe('pushStateAllowsClaim', () => {
  it('is true only for IDLE', () => {
    for (const pushState of ALL_PUSH_STATES) {
      assert.equal(pushStateAllowsClaim(pushState), pushState === 'IDLE', pushState);
    }
  });

  it('does not allow a claim on SAFETY_INCIDENT', () => {
    // Called out on its own: this is the state that must survive until a human clears it,
    // and a permissive claim here would quietly create a second product beside the one
    // nobody has verified is hidden.
    assert.equal(pushStateAllowsClaim('SAFETY_INCIDENT'), false);
  });
});
