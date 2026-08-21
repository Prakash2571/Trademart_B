/**
 * Seasonality: is now the right time?
 *
 * Separate from trend, and the difference matters commercially. A product at PEAK is
 * a good thing to sell TODAY but a bad thing to build a catalogue around; a product
 * that is EARLY is the better long-term bet even though it is currently quieter.
 *
 * Its default weight is only 5% because timing is the easiest factor to act on - an
 * operator can simply wait - whereas a bad margin or a slow supplier cannot be waited
 * out.
 */

import type { FactorScore, SeasonState } from '../candidate.types';
import { assessGeography, clampScore, signalEvidence, unscored } from './score.helpers';
import type { ScoringInput } from './scoring.types';

/**
 * Scores by season state.
 *
 * EARLY scores highest, above PEAK, on purpose. Arriving at the start of a season
 * means the full run ahead; arriving at the peak means listing a product just as
 * demand begins to fall, which is a classic dropshipping mistake.
 */
const STATE_SCORES: Readonly<Record<SeasonState, { score: number; note: string } | null>> =
  Object.freeze({
    EARLY: {
      score: 95,
      note: 'Season is beginning - the whole run is still ahead, which is the best time to list.',
    },
    RISING: { score: 88, note: 'Demand is climbing into season.' },
    PEAK: {
      score: 70,
      note: 'At peak. Good for selling now, but demand starts falling from here, so expect a short window.',
    },
    FALLING: {
      score: 30,
      note: 'Season is ending. Listing now means catching only the tail.',
    },
    OFF_SEASON: {
      score: 15,
      note: 'Out of season. Worth watching for the next cycle rather than listing today.',
    },
    // Not a score of zero: unknown seasonality is not evidence of bad timing.
    UNKNOWN: null,
  });

export function scoreSeasonality(input: ScoringInput): FactorScore {
  const signal = input.seasonality;

  if (signal === null) {
    return unscored(
      'seasonality',
      'No seasonality source is available, so timing has not been scored. It is excluded rather than assumed neutral.',
    );
  }

  const geography = assessGeography(signal.geography, input.market);
  if (!geography.usable) {
    return unscored(
      'seasonality',
      'The only seasonality figure available is for a different market.',
      [
        // Worth stating plainly: this is the factor where hemispheres bite.
        `${geography.risk ?? 'The seasonality figure does not apply to this market.'} Seasons also invert between hemispheres, so borrowing another country's pattern can be exactly backwards.`,
      ],
    );
  }

  const mapped = STATE_SCORES[signal.state];
  if (mapped === null) {
    return unscored(
      'seasonality',
      `The seasonality source (${signal.source}) reports the season state as unknown.`,
      ['Whether this product is seasonal at all is unknown.'],
    );
  }

  const reasons = [`Season state: ${signal.state}. ${mapped.note}`];
  const risks: string[] = [];
  if (geography.risk !== null) risks.push(geography.risk);

  if (signal.peakMonths !== null && signal.peakMonths.length > 0) {
    const names = signal.peakMonths
      .filter((month) => month >= 1 && month <= 12)
      .map((month) => MONTH_NAMES[month - 1])
      .filter((name): name is string => name !== undefined);
    if (names.length > 0) {
      reasons.push(`Typically peaks in ${names.join(', ')}.`);
    }
  }

  if (signal.state === 'PEAK') {
    risks.push(
      'Listing at peak leaves a short selling window before demand falls. Stock and advertising commitments should reflect that.',
    );
  }
  if (signal.state === 'OFF_SEASON' || signal.state === 'FALLING') {
    risks.push(
      'Timing is poor right now. Watching this for the next cycle is usually better than listing it today.',
    );
  }

  return {
    factor: 'seasonality',
    value: clampScore(mapped.score),
    confidence: geography.confidence,
    reasons,
    risks,
    evidence: [
      signalEvidence({
        code: 'SEASON_STATE',
        label: 'Season state',
        source: signal.source,
        observedAt: signal.observedAt,
        fetchedAt: signal.fetchedAt,
        value: signal.state,
        confidence: geography.confidence,
        kind: 'TREND',
        now: input.now,
      }),
    ],
  };
}

const MONTH_NAMES: readonly string[] = Object.freeze([
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]);
