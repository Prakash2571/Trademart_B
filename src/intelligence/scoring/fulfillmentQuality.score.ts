/**
 * Fulfillment quality: how did products like this ACTUALLY deliver?
 *
 * This is the feedback loop (PART 11), and the only factor built entirely from the
 * store's own measured outcomes rather than from market data. Search volume and trend
 * describe the world; this describes what happened when this store sold something
 * comparable.
 *
 * It is the most valuable factor and the one most likely to be missing, because a new
 * store has no history. Missing history returns null - a store with no data has not
 * demonstrated bad fulfillment, and scoring it zero would penalise every candidate on
 * day one.
 *
 * DEFAULT WEIGHT IS ZERO, deliberately. This factor is REPORTED for visibility while
 * storeFit.score.ts is what actually applies the penalty, so the same evidence is not
 * counted twice. See DEFAULT_SCORE_WEIGHTS.
 */

import type { FactorScore } from '../candidate.types';
import { clampScore, inverseBandScore, signalEvidence, unscored } from './score.helpers';
import type { ScoringInput } from './scoring.types';

/**
 * Below this many comparable orders, rates are noise.
 *
 * Three late deliveries out of four orders is a 75% delay rate and means almost
 * nothing. Acting on it would be worse than having no data, so a small sample is
 * reported as context but does not produce a score.
 */
export const MINIMUM_FULFILLMENT_SAMPLE = 10;

/** Delay-rate bands. Lower is better. */
const DELAY_BANDS = Object.freeze([
  { atMost: 2, score: 97, label: 'almost never late' },
  { atMost: 5, score: 88, label: 'rarely late' },
  { atMost: 10, score: 72, label: 'occasionally late' },
  { atMost: 20, score: 48, label: 'often late' },
  { atMost: 30, score: 25, label: 'frequently late' },
]);

/** Refund-rate bands. Lower is better. */
const REFUND_BANDS = Object.freeze([
  { atMost: 1, score: 97, label: 'very few refunds' },
  { atMost: 3, score: 88, label: 'few refunds' },
  { atMost: 6, score: 70, label: 'some refunds' },
  { atMost: 10, score: 45, label: 'many refunds' },
  { atMost: 15, score: 25, label: 'high refund rate' },
]);

export function scoreFulfillmentQuality(input: ScoringInput): FactorScore {
  const signal = input.fulfillmentHistory;

  if (signal === null) {
    return unscored(
      'fulfillmentQuality',
      'No fulfillment history is available for comparable products, so delivery quality has not been scored.',
      [
        'There is no measured delivery performance to learn from yet. The supplier\u2019s quoted transit time is a promise, not a result.',
      ],
    );
  }

  const sample = signal.sampleSize ?? 0;
  if (sample < MINIMUM_FULFILLMENT_SAMPLE) {
    return unscored(
      'fulfillmentQuality',
      `Only ${sample} comparable order(s) have been fulfilled - below the ${MINIMUM_FULFILLMENT_SAMPLE} needed for a meaningful rate, so this is left unscored.`,
      [
        `Delivery performance is based on too few orders to trust. Three late deliveries out of four is a 75% delay rate and means almost nothing.`,
      ],
    );
  }

  const delayRate = signal.delayRatePercentage;
  const refundRate = signal.refundRatePercentage;

  if (delayRate === null && refundRate === null) {
    return unscored(
      'fulfillmentQuality',
      `${sample} comparable orders exist but neither a delay rate nor a refund rate was computed.`,
    );
  }

  const parts: number[] = [];
  const reasons: string[] = [];
  const risks: string[] = [];

  if (delayRate !== null) {
    const band = inverseBandScore(delayRate, DELAY_BANDS, {
      score: 10,
      label: 'late most of the time',
    });
    parts.push(band.score);
    reasons.push(
      `${delayRate.toFixed(1)}% of comparable orders were late (${band.label}), from ${sample} order(s).`,
    );
    if (delayRate > 10) {
      risks.push(
        `A ${delayRate.toFixed(0)}% delay rate on similar products means roughly one customer in ${Math.max(2, Math.round(100 / delayRate))} will be chasing their order. That is a support cost, not just a statistic.`,
      );
    }
  }

  if (refundRate !== null) {
    const band = inverseBandScore(refundRate, REFUND_BANDS, {
      score: 10,
      label: 'very high refund rate',
    });
    parts.push(band.score);
    reasons.push(`${refundRate.toFixed(1)}% of comparable orders were refunded (${band.label}).`);
    if (refundRate > 6) {
      risks.push(
        `A ${refundRate.toFixed(0)}% refund rate eats the contribution from several successful sales for every failure. Check the margin can absorb it.`,
      );
    }
  }

  if (signal.averageDeliveryDays !== null) {
    reasons.push(
      `Comparable orders actually delivered in ${signal.averageDeliveryDays.toFixed(1)} days on average.`,
    );
    // The measured-versus-promised gap is the single most useful line here.
    if (input.shippingDays !== null && signal.averageDeliveryDays > input.shippingDays * 1.5) {
      risks.push(
        `The supplier quotes ${input.shippingDays} days but comparable orders took ${signal.averageDeliveryDays.toFixed(0)} on average. Plan on the measured figure, not the quote.`,
      );
    }
  }

  if (signal.noTrackingRatePercentage !== null && signal.noTrackingRatePercentage > 10) {
    risks.push(
      `${signal.noTrackingRatePercentage.toFixed(0)}% of comparable orders never got a tracking number, so the customer could see nothing at all.`,
    );
  }

  const value = clampScore(parts.reduce((total, part) => total + part, 0) / parts.length);

  return {
    factor: 'fulfillmentQuality',
    value,
    // Measured from real orders, so genuinely KNOWN - the strongest evidence available.
    confidence: 'KNOWN',
    reasons,
    risks,
    evidence: [
      signalEvidence({
        code: 'FULFILLMENT_HISTORY',
        label: `Measured outcomes across ${sample} comparable order(s)`,
        source: signal.source,
        observedAt: signal.observedAt,
        fetchedAt: signal.fetchedAt,
        value: [
          delayRate === null ? null : `${delayRate.toFixed(1)}% late`,
          refundRate === null ? null : `${refundRate.toFixed(1)}% refunded`,
        ]
          .filter((part) => part !== null)
          .join(', '),
        confidence: 'KNOWN',
        kind: 'FULFILLMENT_HISTORY',
        now: input.now,
      }),
    ],
  };
}
