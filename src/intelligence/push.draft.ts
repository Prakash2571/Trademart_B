/**
 * Building the DRAFT product request from a candidate.
 *
 * Pure, and split out from push.service.ts for one reason: "a research push can never
 * publish" is this module's single most important property, and a property that important
 * must be testable without a configured Shopify store. push.service.ts imports config, so
 * anything in it cannot be unit tested at all.
 *
 * Everything here is arithmetic and string building over an explicit candidate.
 */

import { AppError } from '../common/errors';
import type { PriceRecommendation, PricingScenarioName } from '../pricing/recommendation';
import type { ProductCreateRequest } from '../products/product.create';
import type { ProductCandidate } from './candidate.types';

/** Where a listed price came from, so the audit trail can say. */
export interface ResolvedListingPrice {
  amount: number;
  currencyCode: string | null;
  source: string;
}

export interface PriceSelection {
  /** Which scenario to list at. Ignored when `price` is supplied. */
  scenario?: PricingScenarioName;
  /** An explicit price, overriding the scenario entirely. */
  price?: number;
}

/**
 * Decides what to list the draft at.
 *
 * Preference order, and each fallback is a deliberate step DOWN in authority:
 *   1. an explicit price the operator typed with the push
 *   2. the requested (or recommended) pricing scenario
 *   3. the expected selling price recorded on the candidate
 *   4. refuse
 *
 * It refuses rather than defaulting. A product listed at a guessed price is worse than
 * one not listed at all: the draft looks finished, and the first person to publish it
 * sells at a number nobody chose.
 */
export function resolveListingPrice(
  candidate: ProductCandidate,
  pricing: PriceRecommendation,
  selection: PriceSelection = {},
): ResolvedListingPrice {
  const currencyCode = pricing.currencyCode ?? candidate.commercials.expectedSellingCurrency;

  if (selection.price !== undefined) {
    if (!Number.isFinite(selection.price) || selection.price <= 0) {
      throw new AppError('VALIDATION_ERROR', 'The price to list at must be greater than 0.');
    }
    return {
      amount: selection.price,
      currencyCode,
      source: 'Explicit price supplied with the push',
    };
  }

  const wanted = selection.scenario ?? pricing.recommended;
  const scenario =
    wanted === null || wanted === undefined
      ? undefined
      : pricing.scenarios.find((entry) => entry.name === wanted);

  if (scenario !== undefined) {
    return {
      amount: scenario.price,
      currencyCode,
      source: `${scenario.label} pricing scenario`,
    };
  }

  if (candidate.commercials.expectedSellingPrice !== null) {
    return {
      amount: candidate.commercials.expectedSellingPrice,
      currencyCode,
      source: 'The expected selling price recorded on the candidate',
    };
  }

  throw new AppError(
    'VALIDATION_ERROR',
    `No price could be determined for this candidate, so no draft was created. ${pricing.blockedReason ?? 'Record a supplier cost so a price can be recommended, or supply a price with the push.'} A product listed at a guessed price is worse than one not listed at all.`,
  );
}

/**
 * The tag every pushed draft carries.
 *
 * Exported because the frontend and any future cleanup script both need the exact
 * string, and a second copy of it would drift.
 */
export const RESEARCH_PUSH_TAG = 'trademart-research';

/**
 * Builds the create request.
 *
 * status DRAFT and publish false are HARD-CODED, not defaulted. There is no parameter
 * that can change them, which is the point: a caller cannot ask this function to publish
 * even by mistake.
 */
export function buildDraftRequest(
  candidate: ProductCandidate,
  price: number,
): ProductCreateRequest {
  const tags = [RESEARCH_PUSH_TAG];
  if (candidate.recommendation !== null) {
    // So an operator can find everything research pushed AND see what it thought at the
    // time, without opening each one.
    tags.push(`research-${candidate.recommendation.toLowerCase().replace(/_/g, '-')}`);
  }

  return {
    title: candidate.title,
    ...(candidate.category === null ? {} : { productType: candidate.category }),
    descriptionHtml: describeCandidate(candidate),
    status: 'DRAFT',
    publish: false,
    tags,
    // No options and no explicit variants: createProduct's single default variant carries
    // the price. A research candidate has no variant structure worth preserving, and
    // inventing sizes or colours nobody specified would be fabrication.
    options: [],
    variants: [
      {
        price: price.toFixed(2),
        optionValues: [],
      },
    ],
    mediaUrls: candidate.imageUrl === null ? [] : [candidate.imageUrl],
  };
}

/**
 * A description that explains itself in Shopify's own admin.
 *
 * An operator may find this draft weeks later with no memory of the research, so it says
 * where it came from, what the score was, and - importantly - that the figures are
 * research estimates rather than verified product data.
 */
export function describeCandidate(candidate: ProductCandidate): string {
  const lines = [
    '<p><em>Draft created by Trademart product research. It is NOT published - review it before making it visible to customers.</em></p>',
  ];

  if (candidate.overallScore !== null) {
    lines.push(
      `<p>Research score ${candidate.overallScore}/100, data confidence ${candidate.confidenceScore ?? 0}/100 (${candidate.recommendation ?? 'no recommendation'}).</p>`,
    );
  } else {
    lines.push(
      '<p>This candidate was never scored, so nothing here indicates whether it is a good product.</p>',
    );
  }

  if (candidate.risks.length > 0) {
    lines.push(
      `<p><strong>Risks noted during research:</strong></p><ul>${candidate.risks
        .slice(0, MAX_DESCRIBED_RISKS)
        .map((risk) => `<li>${escapeHtml(risk)}</li>`)
        .join('')}</ul>`,
    );
  }

  lines.push(
    '<p>Replace this description before publishing. Research figures are estimates, not verified product data.</p>',
  );

  return lines.join('');
}

/** Enough to convey the problem without turning a product page into a report. */
const MAX_DESCRIBED_RISKS = 5;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Refuses a request that would create anything other than a draft.
 *
 * Belt and braces over buildDraftRequest, which already hard-codes both fields. It exists
 * because a property enforced by a check survives a refactor, and a property enforced by
 * everyone remembering does not. If a future change threads a publish flag through here,
 * this throws instead of quietly putting a scored guess in front of customers.
 */
export function assertDraftOnly(request: ProductCreateRequest): void {
  if (request.status !== 'DRAFT' || request.publish) {
    throw new AppError(
      'INTERNAL_ERROR',
      'A research push attempted to create a non-draft product. Refused: pushing from research must never publish.',
    );
  }
}
