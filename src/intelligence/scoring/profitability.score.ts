/**
 * Profitability: will the economics work?
 *
 * This factor never computes money itself. It reads figures the pricing module already
 * produced, so Research and the order view cannot disagree about what a margin is -
 * a second pricing implementation is exactly what the brief forbids.
 *
 * The most important behaviour here is the refusal: when the supplier cost is unknown,
 * profitability is NOT scored. A guessed cost produces a flattering margin and a
 * confident, wrong purchase.
 */

import type { FactorScore } from '../candidate.types';
import { bandScore, clampScore, signalEvidence, unscored } from './score.helpers';
import type { ScoringInput } from './scoring.types';

/**
 * Contribution-margin bands.
 *
 * Calibrated for dropshipping, where 40%+ is the usual target because acquisition
 * cost has to come out of contribution. Below 15% scores very low: technically
 * profitable and commercially not worth the operational load of fulfilling it.
 */
const MARGIN_BANDS = Object.freeze([
  { atLeast: 60, score: 97, label: 'excellent margin' },
  { atLeast: 45, score: 90, label: 'strong margin' },
  { atLeast: 35, score: 78, label: 'healthy margin' },
  { atLeast: 25, score: 62, label: 'workable margin' },
  { atLeast: 15, score: 40, label: 'thin margin' },
  { atLeast: 5, score: 18, label: 'very thin margin' },
  { atLeast: 0, score: 8, label: 'negligible margin' },
]);

export function scoreProfitability(input: ScoringInput): FactorScore {
  const economics = input.economics;

  if (economics === null) {
    return unscored(
      'profitability',
      'No cost or price information has been recorded, so profitability cannot be scored.',
      [
        'Profitability is unknown. Enter the supplier cost and an expected selling price to judge whether this product can make money.',
      ],
    );
  }

  // A blocked calculation is reported verbatim - most often a currency mismatch, which
  // has a specific fix the operator needs to see rather than a generic "unknown".
  if (economics.blockedReason !== null) {
    return unscored(
      'profitability',
      `Profitability could not be calculated: ${economics.blockedReason}`,
      [economics.blockedReason],
    );
  }

  const margin = economics.marginPercentage;
  if (margin === null) {
    return unscored(
      'profitability',
      'The supplier cost or selling price is unknown, so no margin can be calculated. It is left unscored rather than assumed.',
      [
        'Margin is unknown. An unknown cost is not a zero cost - nothing here should be read as "this product is cheap".',
      ],
    );
  }

  const band = bandScore(margin, MARGIN_BANDS, { score: 2, label: 'loss-making' });

  const reasons = [
    `Estimated contribution margin ${margin.toFixed(1)}% (${band.label}).`,
  ];
  const risks: string[] = [];

  if (economics.contribution !== null && economics.currencyCode !== null) {
    reasons.push(
      `Estimated contribution ${economics.contribution.toFixed(2)} ${economics.currencyCode} per unit.`,
    );
  }

  if (margin < 0) {
    risks.push(
      'This product loses money at the price and costs entered. It should not be pushed without changing one of them.',
    );
  } else if (margin < 15) {
    risks.push(
      'The margin is too thin to absorb a refund, a support contact or a shipping surprise. One returned order would wipe out several sales.',
    );
  }

  // Confidence, not score, carries data quality. A 45% margin computed from a
  // hand-typed cost is still a 45% margin IF the cost is right - the uncertainty is
  // about the input, so it belongs in confidence rather than being deducted twice.
  let confidence: FactorScore['confidence'] = 'KNOWN';
  if (economics.costIsManual) {
    confidence = 'ESTIMATED';
    risks.push(
      'The supplier cost was entered by hand rather than observed, so the margin is only as accurate as that number.',
    );
  }
  if (economics.shippingUnknown) {
    confidence = 'ESTIMATED';
    risks.push(
      'Supplier shipping is not recorded, so it is excluded. The real margin is LOWER than shown by whatever shipping costs.',
    );
  }

  return {
    factor: 'profitability',
    value: clampScore(band.score),
    confidence,
    reasons,
    risks,
    evidence: [
      signalEvidence({
        code: 'CONTRIBUTION_MARGIN',
        label: 'Estimated contribution margin',
        source: 'Trademart pricing engine',
        // Ages from when the COST was observed, not from when the arithmetic ran.
        // Recomputing a margin from a six-month-old cost does not make it current.
        observedAt: economics.costObservedAt,
        fetchedAt: input.now.toISOString(),
        value: `${margin.toFixed(1)}%`,
        confidence,
        kind: 'SUPPLIER_COST',
        now: input.now,
      }),
    ],
  };
}
