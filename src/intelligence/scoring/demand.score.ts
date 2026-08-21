/**
 * Demand: is anyone looking for this?
 *
 * Scored from average monthly search volume, because that is the one demand signal
 * available from a legitimate, documented API (Google Ads keyword planning). It is a
 * proxy - searches are not purchases - and the reasons say so rather than presenting
 * it as measured sales.
 */

import type { FactorScore } from '../candidate.types';
import { assessGeography, bandScore, clampScore, signalEvidence, unscored } from './score.helpers';
import type { ScoringInput } from './scoring.types';

/**
 * Volume bands.
 *
 * Deliberately generous at the bottom: a genuinely niche product with 800 searches a
 * month can be an excellent dropshipping item at a high margin, so low volume scores
 * poorly rather than fatally. The top band is capped because past a point more
 * searches mostly means more competitors, which the competition factor handles.
 */
const VOLUME_BANDS = Object.freeze([
  { atLeast: 100_000, score: 95, label: 'very high search volume' },
  { atLeast: 25_000, score: 88, label: 'high search volume' },
  { atLeast: 8_000, score: 75, label: 'solid search volume' },
  { atLeast: 2_000, score: 60, label: 'moderate search volume' },
  { atLeast: 500, score: 42, label: 'low search volume' },
  { atLeast: 100, score: 25, label: 'very low search volume' },
]);

export function scoreDemand(input: ScoringInput): FactorScore {
  const signal = input.demand;

  if (signal === null) {
    return unscored(
      'demand',
      'No search-demand source is available, so demand has not been scored. It is excluded from the total rather than counted as zero.',
      [
        'Demand is unmeasured. A product can look good on margin and shipping and still have nobody looking for it.',
      ],
    );
  }

  const geography = assessGeography(signal.geography, input.market);
  if (!geography.usable) {
    return unscored('demand', 'The only demand figure available is for a different market.', [
      geography.risk ?? 'The demand figure does not apply to this market.',
    ]);
  }

  const volume = signal.averageMonthlySearches;
  if (volume === null) {
    return unscored(
      'demand',
      `A demand source (${signal.source}) responded but reported no search volume for these keywords.`,
      [
        'No search volume was returned. That can mean a genuinely obscure product, or keywords that do not match how people search for it.',
      ],
    );
  }

  const band = bandScore(volume, VOLUME_BANDS, {
    score: 10,
    label: 'negligible search volume',
  });

  const reasons = [
    `${volume.toLocaleString()} average monthly searches (${band.label}), ${geography.coverageNote}.`,
    'Search volume is a proxy for demand, not measured sales - people search for far more than they buy.',
  ];
  const risks: string[] = [];
  if (geography.risk !== null) risks.push(geography.risk);
  if (volume < 2_000) {
    risks.push(
      'Low search volume means slow organic discovery. This product would depend on paid acquisition, which the advertising allowance in the pricing settings should cover.',
    );
  }

  return {
    factor: 'demand',
    value: clampScore(band.score),
    confidence: geography.confidence,
    reasons,
    risks,
    evidence: [
      signalEvidence({
        code: 'SEARCH_VOLUME',
        label: 'Average monthly searches',
        source: signal.source,
        observedAt: signal.observedAt,
        fetchedAt: signal.fetchedAt,
        value: volume.toLocaleString(),
        confidence: geography.confidence,
        kind: 'KEYWORD_METRICS',
        now: input.now,
      }),
    ],
  };
}
