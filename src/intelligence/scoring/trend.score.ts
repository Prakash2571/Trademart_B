/**
 * Trend: is interest rising or falling?
 *
 * Deliberately separate from seasonality. "Rising" and "in season" are different
 * claims: a Christmas product rises every November without being a growing market,
 * and a genuinely growing product can be scored while off-season. Merging them would
 * make both unreadable.
 *
 * A missing trend source is extremely common - Google Trends has no supported public
 * API - so this factor must degrade gracefully. It returns null, never "flat".
 * Reporting no-data as flat would quietly assert stability nobody observed.
 */

import type { FactorScore } from '../candidate.types';
import { assessGeography, bandScore, clampScore, signalEvidence, unscored } from './score.helpers';
import type { ScoringInput } from './scoring.types';

/**
 * Momentum bands, as percentage change over the market's horizon.
 *
 * The midpoint is 50 at zero change, so a flat product is neutral rather than
 * penalised - plenty of steady sellers are excellent products. Decline is punished
 * harder than growth is rewarded, because entering a shrinking market is a
 * substantially worse mistake than missing a fast-growing one.
 */
const MOMENTUM_BANDS = Object.freeze([
  { atLeast: 75, score: 96, label: 'growing very fast' },
  { atLeast: 40, score: 90, label: 'growing strongly' },
  { atLeast: 15, score: 78, label: 'growing' },
  { atLeast: 5, score: 64, label: 'edging up' },
  { atLeast: -5, score: 50, label: 'flat' },
  { atLeast: -15, score: 32, label: 'edging down' },
  { atLeast: -40, score: 18, label: 'declining' },
]);

export function scoreTrend(input: ScoringInput): FactorScore {
  const signal = input.trend;

  if (signal === null) {
    return unscored(
      'trend',
      'No trend source is available, so momentum has not been scored. It is excluded from the total rather than treated as flat.',
      [
        'Trend direction is unknown. This product could be growing or fading and nothing here would show it.',
      ],
    );
  }

  const geography = assessGeography(signal.geography, input.market);
  if (!geography.usable) {
    return unscored('trend', 'The only trend figure available is for a different market.', [
      geography.risk ?? 'The trend figure does not apply to this market.',
    ]);
  }

  const momentum = signal.momentumPercentage;
  if (momentum === null) {
    return unscored(
      'trend',
      `A trend source (${signal.source}) is configured but returned no momentum figure.`,
      ['Trend direction is unknown for this product.'],
    );
  }

  const band = bandScore(momentum, MOMENTUM_BANDS, {
    score: 8,
    label: 'falling sharply',
  });

  const sign = momentum > 0 ? '+' : '';
  const reasons = [
    `Search interest is ${band.label} (${sign}${momentum.toFixed(1)}% over ${input.market.horizonDays} days), ${geography.coverageNote}.`,
  ];
  const risks: string[] = [];
  if (geography.risk !== null) risks.push(geography.risk);

  // Acceleration is reported only when the source supplies it. It refines the story
  // without changing the score: a product growing but decelerating is worth flagging,
  // and folding it into the number would make the number harder to explain.
  const acceleration = signal.accelerationPercentage;
  if (acceleration !== null) {
    if (momentum > 0 && acceleration < 0) {
      risks.push(
        `Growth is slowing (acceleration ${acceleration.toFixed(1)}%). The rise may already be near its peak.`,
      );
    } else if (acceleration > 0) {
      reasons.push(`Growth is accelerating (${acceleration.toFixed(1)}%).`);
    }
  }

  if (momentum < -5) {
    risks.push(
      'Interest is declining. Entering a shrinking market is a worse mistake than missing a growing one, so this needs a specific reason to proceed.',
    );
  }

  return {
    factor: 'trend',
    value: clampScore(band.score),
    confidence: geography.confidence,
    reasons,
    risks,
    evidence: [
      signalEvidence({
        code: 'TREND_MOMENTUM',
        label: `Momentum over ${input.market.horizonDays} days`,
        source: signal.source,
        observedAt: signal.observedAt,
        fetchedAt: signal.fetchedAt,
        value: `${sign}${momentum.toFixed(1)}%`,
        confidence: geography.confidence,
        kind: 'TREND',
        now: input.now,
      }),
    ],
  };
}
