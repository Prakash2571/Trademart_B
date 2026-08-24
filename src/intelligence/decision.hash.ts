/**
 * Binding an operator's reviewed decision to the data that produced it.
 *
 * THE PROBLEM
 * -----------
 * The operator reads a screen saying GOOD_CANDIDATE, 82/100, list at 22.99. They click
 * Push. Push re-analyses internally, because pushing on a stale price is worse. But if
 * the supplier cost, the store's fulfillment record or the pricing settings moved in
 * between, the re-analysis produces a DIFFERENT decision - and the old flow silently
 * created a product on a recommendation nobody had approved.
 *
 * Neither substituting the new decision nor using the stale one is acceptable. The
 * answer is to refuse: 409 RECOMMENDATION_CHANGED, zero Shopify writes, and the operator
 * reviews the new analysis before trying again.
 *
 * WHAT IS HASHED, AND WHY THAT SET
 * --------------------------------
 * Everything that materially determines the decision, and nothing that merely describes
 * it. Concretely INCLUDED:
 *
 *   - the candidate's scoring inputs (shared with candidate.revision.ts, so the two
 *     mechanisms cannot disagree about what an input is)
 *   - the scores, the recommendation, and each factor's value and confidence
 *   - each evidence item's VALUE, confidence, observation date and freshness. This is
 *     what makes live Shopify store history part of the decision: when the store's
 *     category sales or delivery record change, the store-derived evidence values change
 *     and the hash moves. Nothing else in the candidate row would have noticed.
 *   - the effective pricing policy, so a change to the minimum margin invalidates a
 *     reviewed price even though the candidate did not change
 *   - every scenario's price, margin, contribution, viability and guard breaches
 *
 * Deliberately EXCLUDED:
 *
 *   - `fetchedAt` on evidence. profitability stamps it with `now`, so including it would
 *     change the hash on every single call and make every push fail. This is the one
 *     exclusion that is load-bearing rather than tidy.
 *   - reasons, risks, warnings, notes, labels, sources, scenario `intent` strings. All
 *     prose. Rewording a sentence must not invalidate an approved decision.
 *   - `updatedAt`, `analyzedAt`, `scoreHistory`. Bookkeeping.
 *
 * FRESHNESS IS INCLUDED ON PURPOSE
 * --------------------------------
 * A figure crossing a freshness boundary between review and push genuinely lowers the
 * confidence score, so the decision really did change and a 409 is correct. It is rare -
 * the boundaries are days wide - and the alternative is a push that proceeds on
 * confidence the operator never saw.
 *
 * Pure: no config, no database, no clock read internally.
 */

import { createHash } from 'node:crypto';

import { stableStringify } from '../common/stableStringify';
import type { PriceRecommendation, PricingPolicy } from '../pricing/recommendation';
import type { EvidenceItem } from '../common/dataQuality';
import { scoreInputsOf, type ScoreInputs } from './candidate.revision';
import type { FactorScore, ProductCandidate } from './candidate.types';
import type { CandidateScore } from './scoring/scoring.service';

/**
 * Bumped if the hashed SET changes.
 *
 * Without it, adding a field to the hash would silently invalidate every decision hash
 * a client is holding, and the operator would see RECOMMENDATION_CHANGED on a candidate
 * nothing had touched. With it, the version is part of the hash input, so the change is
 * deliberate and traceable to a release rather than mysterious.
 */
export const DECISION_HASH_VERSION = 1;

export interface DecisionHashInput {
  candidate: Pick<ProductCandidate, keyof ScoreInputs>;
  score: CandidateScore;
  pricing: PriceRecommendation;
  /** The policy actually applied, after store settings and any override. */
  policy: PricingPolicy;
}

/**
 * Money as a fixed-precision string.
 *
 * The discipline hashPlan already uses: 22.99 and 22.990000000000002 are the same price,
 * and a hash that disagreed would produce a 409 nobody could explain.
 */
function money(value: number | null): string | null {
  return value === null || !Number.isFinite(value) ? null : value.toFixed(2);
}

/** A percentage, to one decimal. Finer than that is not a different decision. */
function percent(value: number | null): string | null {
  return value === null || !Number.isFinite(value) ? null : value.toFixed(1);
}

/**
 * One factor, reduced to what decides anything.
 *
 * `value` and `confidence` only. The reasons and risks are prose generated FROM those,
 * so hashing them as well would add nothing except sensitivity to rewording.
 */
function factorDigest(factor: FactorScore): Record<string, unknown> {
  return { k: factor.factor, v: factor.value, c: factor.confidence };
}

/**
 * One evidence item, reduced to the observation itself.
 *
 * `fetchedAt` is absent on purpose - see the module header. `label` and `source` are
 * absent because they are presentation; a provider genuinely changing would change the
 * value or the confidence too.
 */
function evidenceDigest(item: EvidenceItem): Record<string, unknown> {
  return {
    k: item.code,
    v: item.value,
    c: item.confidence,
    o: item.observedAt,
    f: item.freshness,
  };
}

/** Sorts by a stable key so provider or pagination order cannot change the hash. */
function sortByKey(entries: Record<string, unknown>[]): Record<string, unknown>[] {
  return [...entries].sort((a, b) => String(a['k']).localeCompare(String(b['k'])));
}

/**
 * The canonical, hashable form of a decision.
 *
 * Exported for tests and for diagnostics: when a hash mismatch is surprising, being able
 * to diff two of these is the difference between a five-minute answer and an afternoon.
 */
export function decisionMaterial(input: DecisionHashInput): Record<string, unknown> {
  const { score, pricing, policy } = input;

  return {
    v: DECISION_HASH_VERSION,

    // Shared with the staleness mechanism, so "an input" means one thing in this
    // codebase rather than two similar things.
    inputs: scoreInputsOf(input.candidate),

    score: {
      o: score.overallScore,
      c: score.confidenceScore,
      r: score.recommendation,
      // A downgraded recommendation is a different decision from the same band reached
      // directly: it tells the operator the score was held back.
      d: score.recommendationDowngraded,
      s: score.seasonState,
      // Worst-confidence and worst-freshness rollups, which the UI shows as badges.
      cf: score.confidence,
      fr: score.freshness,
      f: sortByKey(score.factors.map(factorDigest)),
      u: [...score.unscoredFactors].sort(),
      // The renormalised weights actually applied. A settings change that alters which
      // factors count is a change of decision even at an identical overall score.
      w: sortByKey(
        score.weights.map((weight) => ({
          k: weight.factor,
          c: weight.configured,
          e: weight.effective,
          i: weight.included,
        })),
      ),
    },

    ev: sortByKey(score.evidence.map(evidenceDigest)),

    // The full effective policy. Cheap to include, and it is precisely the thing that
    // can move without the candidate changing at all.
    policy: {
      st: policy.strategy,
      tm: percent(policy.targetMarginPercentage),
      mm: money(policy.markupMultiplier),
      fu: money(policy.fixedUplift),
      pf: percent(policy.paymentFeePercentage),
      sf: percent(policy.shopifyFeePercentage),
      af: percent(policy.advertisingAllowancePercentage),
      oc: money(policy.otherCostPerOrder),
      // The two floors. A tightened floor must invalidate an approved price.
      fm: percent(policy.minimumMarginPercentage),
      fp: money(policy.minimumProfitAmount),
      rd: policy.rounding,
    },

    pricing: {
      b: pricing.blockedReason,
      lc: money(pricing.landedCost),
      si: pricing.shippingIncluded,
      cc: pricing.currencyCode,
      rec: pricing.recommended,
      sc: sortByKey(
        pricing.scenarios.map((scenario) => ({
          k: scenario.name,
          p: money(scenario.price),
          m: percent(scenario.marginPercentage),
          ct: money(scenario.contribution),
          ok: scenario.viable,
          // Sorted: the breach list is a set, and its order is an implementation detail.
          gb: [...scenario.guardBreaches].sort(),
          mv: money(scenario.minimumViablePrice),
        })),
      ),
    },
  };
}

/**
 * The decision hash.
 *
 * sha256 over stableStringify, matching computeRulesHash in automation/preview.store.ts.
 * stableStringify rather than JSON.stringify because property order is not a difference,
 * and an unstable serialisation would produce spurious mismatches depending on how the
 * objects happened to be built.
 */
export function computeDecisionHash(input: DecisionHashInput): string {
  return createHash('sha256').update(stableStringify(decisionMaterial(input))).digest('hex');
}
