/**
 * Shipping: how long will the customer wait?
 *
 * Transit time is a customer-experience factor, not a cost factor - the COST of
 * shipping is already in profitability via landed cost. Counting it twice would
 * double-penalise slow-and-expensive products.
 *
 * Unknown transit time is left unscored. Dropshipping delivery times range from three
 * days to five weeks, so a default guess would be meaningless and a zero would say
 * "terrible" about a product nobody has checked.
 */

import type { FactorScore } from '../candidate.types';
import { clampScore, inverseBandScore, signalEvidence, unscored } from './score.helpers';
import type { ScoringInput } from './scoring.types';

/**
 * Transit-time bands in days.
 *
 * Calibrated against customer patience rather than logistics: past about two weeks
 * "where is my order?" contacts and chargebacks rise sharply regardless of whether
 * the estimate was honest at checkout.
 */
const TRANSIT_BANDS = Object.freeze([
  { atMost: 3, score: 98, label: 'near-domestic speed' },
  { atMost: 6, score: 90, label: 'fast for dropshipping' },
  { atMost: 10, score: 74, label: 'acceptable' },
  { atMost: 14, score: 58, label: 'slow but tolerable' },
  { atMost: 21, score: 34, label: 'slow' },
  { atMost: 30, score: 18, label: 'very slow' },
]);

export function scoreShipping(input: ScoringInput): FactorScore {
  const days = input.shippingDays;

  if (days === null) {
    return unscored(
      'shipping',
      'No supplier transit time is recorded, so shipping has not been scored. It is excluded rather than guessed.',
      [
        'Delivery time is unknown. Dropshipping transit ranges from days to over a month, and it is one of the strongest drivers of refunds and complaints - record the supplier estimate before committing.',
      ],
    );
  }

  if (!Number.isFinite(days) || days < 0) {
    return unscored('shipping', `The recorded transit time (${String(days)}) is not a valid number of days.`);
  }

  const band = inverseBandScore(days, TRANSIT_BANDS, {
    score: 8,
    label: 'unacceptably slow',
  });

  const reasons = [`Supplier quotes ${days} day(s) transit (${band.label}).`];
  const risks: string[] = [];

  if (days > 14) {
    risks.push(
      `A ${days}-day delivery will generate "where is my order?" contacts and refund requests. Set the storefront expectation honestly at checkout rather than hoping it goes unnoticed.`,
    );
  }
  if (days > 21) {
    risks.push(
      'Transit beyond three weeks is a frequent chargeback trigger, because customers forget they ordered and dispute the charge.',
    );
  }

  return {
    factor: 'shipping',
    value: clampScore(band.score),
    // The supplier's own quote, recorded by an operator. Real, but a quote rather than
    // a measured delivery - measured times come from fulfillment history.
    confidence: 'ESTIMATED',
    reasons: [
      ...reasons,
      'This is the supplier\u2019s quoted estimate, not a measured delivery time. Fulfillment history is the factor that reports what actually happened.',
    ],
    risks,
    evidence: [
      signalEvidence({
        code: 'SUPPLIER_TRANSIT_DAYS',
        label: 'Quoted transit time',
        source: 'Supplier quote, recorded by operator',
        observedAt: input.shippingDaysObservedAt,
        fetchedAt: null,
        value: `${days} day(s)`,
        confidence: 'ESTIMATED',
        kind: 'SUPPLIER_COST',
        now: input.now,
      }),
    ],
  };
}
