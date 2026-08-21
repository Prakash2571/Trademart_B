/**
 * Competition: how crowded is this?
 *
 * Lower competition scores HIGHER, so the index is inverted. Competition is treated
 * as a moderating factor rather than a veto: a competitive market is also a PROVEN
 * market, and the products with no competition at all are frequently the ones nobody
 * wants. That is why its default weight is 10% rather than something larger.
 */

import type { FactorScore } from '../candidate.types';
import {
  assessGeography,
  clampScore,
  inverseBandScore,
  signalEvidence,
  unscored,
} from './score.helpers';
import type { ScoringInput } from './scoring.types';

/**
 * Competition index bands, 0-100 where 100 is most competitive.
 *
 * The floor is 25 rather than 0: even the most crowded market is worth entering with
 * a genuine advantage, and a factor that can zero an otherwise strong candidate would
 * make the overall score behave like a veto it was never meant to be.
 */
const COMPETITION_BANDS = Object.freeze([
  { atMost: 20, score: 95, label: 'very little competition' },
  { atMost: 35, score: 85, label: 'light competition' },
  { atMost: 50, score: 70, label: 'moderate competition' },
  { atMost: 65, score: 55, label: 'competitive' },
  { atMost: 80, score: 40, label: 'highly competitive' },
]);

export function scoreCompetition(input: ScoringInput): FactorScore {
  const signal = input.competition;

  if (signal === null) {
    return unscored(
      'competition',
      'No competition source is available, so this has not been scored. It is excluded from the total rather than assumed favourable.',
      [
        'Competition is unmeasured. A crowded market would not show up here, so check manually before committing to paid acquisition.',
      ],
    );
  }

  const geography = assessGeography(signal.geography, input.market);
  if (!geography.usable) {
    return unscored(
      'competition',
      'The only competition figure available is for a different market.',
      [geography.risk ?? 'The competition figure does not apply to this market.'],
    );
  }

  const index = signal.competitionIndex;
  if (index === null) {
    return unscored(
      'competition',
      `A competition source (${signal.source}) responded but returned no competition index.`,
      ['Competition level is unknown for this product.'],
    );
  }

  const band = inverseBandScore(index, COMPETITION_BANDS, {
    score: 25,
    label: 'saturated',
  });

  const reasons = [
    `Competition index ${Math.round(index)}/100 (${band.label}), ${geography.coverageNote}.`,
    'A competitive market is also a proven one - this factor moderates the score rather than vetoing it.',
  ];
  const risks: string[] = [];
  if (geography.risk !== null) risks.push(geography.risk);

  if (signal.competitorCount !== null) {
    reasons.push(`${signal.competitorCount} competing offers observed.`);
  }
  if (index >= 65) {
    risks.push(
      'Competition is high, which usually means higher advertising costs. Check that the advertising allowance in the pricing settings reflects that.',
    );
  }

  return {
    factor: 'competition',
    value: clampScore(band.score),
    confidence: geography.confidence,
    reasons,
    risks,
    evidence: [
      signalEvidence({
        code: 'COMPETITION_INDEX',
        label: 'Competition index',
        source: signal.source,
        observedAt: signal.observedAt,
        fetchedAt: signal.fetchedAt,
        value: `${Math.round(index)}/100`,
        confidence: geography.confidence,
        kind: 'KEYWORD_METRICS',
        now: input.now,
      }),
    ],
  };
}
