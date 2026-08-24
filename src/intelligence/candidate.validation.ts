/**
 * Validating candidate input.
 *
 * PURE, and separate from intelligence.service.ts for the usual reason in this
 * codebase: that module imports the config singleton, which calls process.exit(1) at
 * import time, so nothing in it can be unit tested. These rules decide whether an
 * unlabelled supplier cost can ever reach the database, which makes them exactly the
 * rules that need tests.
 *
 * intelligence.service re-exports this surface, so callers see no change.
 */

import { isExplicitCurrencyCode } from '../common/money';
import {
  SUPPORTED_HORIZONS,
  type CandidateSource,
  type ManualResearchEntry,
  type ProductCandidate,
  type TargetMarket,
} from './candidate.types';

export interface CreateCandidateInput {
  title: string;
  source?: CandidateSource;
  sourceProductId?: string | null;
  sourceUrl?: string | null;
  category?: string | null;
  imageUrl?: string | null;
  keywords?: string[];
  market?: Partial<TargetMarket>;
  commercials?: Partial<ProductCandidate['commercials']>;
  manualResearch?: Partial<ManualResearchEntry>;
  notes?: string | null;
}

/**
 * Every money field, paired with the currency field that must accompany it.
 *
 * A table rather than three copies of the same block, so adding a fourth money field
 * cannot accidentally ship without its currency rule.
 */
const MONEY_FIELDS: readonly {
  amount: keyof ProductCandidate['commercials'];
  currency: keyof ProductCandidate['commercials'];
}[] = Object.freeze([
  { amount: 'supplierCost', currency: 'supplierCurrency' },
  { amount: 'shippingCost', currency: 'shippingCurrency' },
  { amount: 'expectedSellingPrice', currency: 'expectedSellingCurrency' },
]);

/**
 * Validates a candidate, reporting every problem at once.
 *
 * Matches how automation rules and pricing policies are validated: a form should show
 * all of its errors, not the first one and then another after each retry.
 */
export function validateCandidateInput(input: CreateCandidateInput): string[] {
  const problems: string[] = [];

  if (typeof input.title !== 'string' || input.title.trim() === '') {
    problems.push('A title is required - it is how the candidate is identified.');
  }

  const horizon = input.market?.horizonDays;
  if (horizon !== undefined && !SUPPORTED_HORIZONS.includes(horizon)) {
    problems.push(
      `Horizon must be one of ${SUPPORTED_HORIZONS.join(', ')} days. Other windows are not supported because the trend bands are calibrated for these.`,
    );
  }

  const country = input.market?.countryCode;
  if (country !== undefined && (typeof country !== 'string' || country.trim().length !== 2)) {
    problems.push(
      'Target market country must be a two-letter ISO country code. Region isolation depends on it being exact.',
    );
  }

  /*
   * Every money field is checked for BOTH a usable amount and an explicit currency.
   *
   * The currency half is validated at the WRITE, not only at the price calculation,
   * because an amount stored without its unit is a landmine: it looks complete in the
   * database, it survives every later read, and the first thing tempted to "fix" it is
   * a `?? sellingCurrency` fallback that silently relabels a supplier cost. Refusing it
   * at the door means the bad state never exists to be papered over.
   *
   * An ABSENT amount needs no currency - `shippingCost: null` is UNKNOWN SHIPPING, a
   * legitimate state the pricing engine handles by excluding it and labelling the margin
   * an upper bound.
   */
  const commercials = input.commercials;
  if (commercials !== undefined) {
    for (const field of MONEY_FIELDS) {
      const amount = commercials[field.amount];
      if (amount === undefined || amount === null) continue;

      if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
        problems.push(
          `${field.amount} must be a number of at least 0, or omitted when unknown.`,
        );
        // Falls through to the currency check on purpose: reporting both problems at
        // once beats one per submit.
      }

      if (!isExplicitCurrencyCode(commercials[field.currency])) {
        problems.push(
          `${field.currency} is required whenever ${field.amount} is set, and must be a 3-letter code such as GBP or INR. Trademart will not infer it from another field - an amount read as the wrong currency produces a margin that is completely wrong and looks completely normal. Clear ${field.amount} if the value is genuinely unknown.`,
        );
      }
    }
  }

  const months = input.manualResearch?.peakMonths;
  if (months != null && months.some((month) => month < 1 || month > 12)) {
    problems.push('Peak months must be between 1 and 12.');
  }

  const geographyCountry = input.manualResearch?.geography?.countryCode;
  if (
    geographyCountry !== undefined &&
    geographyCountry !== null &&
    geographyCountry.trim().length !== 2
  ) {
    // The country the operator's figures describe. Region isolation discards a figure
    // from the wrong country entirely, so a malformed code here would quietly turn a
    // usable observation into a discarded one.
    problems.push(
      'The country your research figures describe must be a two-letter ISO code, or left blank if you did not record it.',
    );
  }

  return problems;
}
