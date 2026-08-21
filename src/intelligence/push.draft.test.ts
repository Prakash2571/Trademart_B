/**
 * Building a DRAFT product from a candidate.
 *
 * The first describe block is the one that matters: a research push must NEVER produce a
 * publishable product. The brief forbids [Auto Publish] outright, and the failure mode is
 * not subtle - a scored guess reaching customers without a human reading the listing.
 *
 * The rest is about the second-worst outcome: a draft listed at a price nobody chose.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AppError } from '../common/errors';
import {
  DEFAULT_PRICING_POLICY,
  recommendPrice,
  type PriceRecommendation,
} from '../pricing/recommendation';
import type { ProductCreateRequest } from '../products/product.create';
import type { ProductCandidate } from './candidate.types';
import { EMPTY_MANUAL_RESEARCH } from './candidate.types';
import {
  RESEARCH_PUSH_TAG,
  assertDraftOnly,
  buildDraftRequest,
  describeCandidate,
  resolveListingPrice,
} from './push.draft';

const NOW_ISO = '2026-06-15T12:00:00.000Z';

function candidate(overrides: Partial<ProductCandidate> = {}): ProductCandidate {
  return {
    id: 'cand-1',
    source: 'MANUAL',
    sourceProductId: 'TRD-9931',
    sourceUrl: null,
    title: 'Portable Neck Fan',
    category: 'Home',
    imageUrl: null,
    keywords: ['neck fan'],
    market: { countryCode: 'GB', region: null, horizonDays: 30 },
    commercials: {
      supplierCost: 10,
      supplierCurrency: 'GBP',
      shippingCost: 2,
      shippingCurrency: 'GBP',
      shippingDays: 8,
      expectedSellingPrice: null,
      expectedSellingCurrency: 'GBP',
      costObservedAt: NOW_ISO,
    },
    manualResearch: { ...EMPTY_MANUAL_RESEARCH },
    factors: [],
    overallScore: 79,
    confidenceScore: 61,
    recommendation: 'GOOD_CANDIDATE',
    seasonState: 'RISING',
    reasons: [],
    risks: [],
    evidence: [],
    freshness: 'FRESH',
    status: 'ANALYZED',
    pushedShopifyProductId: null,
    watchUntil: null,
    scoreHistory: [],
    notes: null,
    createdAt: NOW_ISO,
    analyzedAt: NOW_ISO,
    updatedAt: NOW_ISO,
    ...overrides,
  };
}

/** A real recommendation, from the real engine, so the prices are the real ones. */
function pricing(overrides: Parameters<typeof recommendPrice>[0] | null = null): PriceRecommendation {
  return recommendPrice(
    overrides ?? {
      supplierCost: 10,
      supplierCurrency: 'GBP',
      shippingCost: 2,
      shippingCurrency: 'GBP',
      sellingCurrency: 'GBP',
      policy: { ...DEFAULT_PRICING_POLICY },
    },
  );
}

/* ===========================================================================
 * It never publishes
 * ======================================================================== */

describe('a research push can never publish', () => {
  it('always builds a DRAFT with publish false', () => {
    const request = buildDraftRequest(candidate(), 22.99);
    assert.equal(request.status, 'DRAFT');
    assert.equal(request.publish, false);
  });

  it('is DRAFT regardless of how good the candidate scored', () => {
    // A 98-scoring STRONG_CANDIDATE is exactly the case where someone would be tempted
    // to auto-publish. It must not change the outcome.
    const request = buildDraftRequest(
      candidate({ overallScore: 98, confidenceScore: 95, recommendation: 'STRONG_CANDIDATE' }),
      22.99,
    );
    assert.equal(request.status, 'DRAFT');
    assert.equal(request.publish, false);
  });

  it('exposes no parameter that could request a publish', () => {
    // buildDraftRequest takes a candidate and a price. There is deliberately no third
    // argument, so a caller cannot ask for ACTIVE even by mistake.
    assert.equal(buildDraftRequest.length, 2);
  });

  it('assertDraftOnly refuses an ACTIVE request', () => {
    const bad: ProductCreateRequest = { ...buildDraftRequest(candidate(), 22.99), status: 'ACTIVE' };
    assert.throws(
      () => assertDraftOnly(bad),
      (error: unknown) => error instanceof AppError && error.code === 'INTERNAL_ERROR',
    );
  });

  it('assertDraftOnly refuses publish true even when the status is DRAFT', () => {
    const bad: ProductCreateRequest = { ...buildDraftRequest(candidate(), 22.99), publish: true };
    assert.throws(() => assertDraftOnly(bad), AppError);
  });

  it('assertDraftOnly accepts what buildDraftRequest produces', () => {
    assert.doesNotThrow(() => assertDraftOnly(buildDraftRequest(candidate(), 22.99)));
  });
});

/* ===========================================================================
 * The request
 * ======================================================================== */

describe('buildDraftRequest', () => {
  it('carries the price onto the single default variant', () => {
    const request = buildDraftRequest(candidate(), 22.99);
    assert.equal(request.variants.length, 1);
    assert.equal(request.variants[0]?.price, '22.99');
  });

  it('formats the price to two decimals, as Shopify expects', () => {
    assert.equal(buildDraftRequest(candidate(), 23).variants[0]?.price, '23.00');
    assert.equal(buildDraftRequest(candidate(), 8.5).variants[0]?.price, '8.50');
  });

  it('invents no options, sizes or colours', () => {
    // A research candidate has no variant structure. Fabricating one would be inventing
    // product data.
    assert.deepEqual(buildDraftRequest(candidate(), 22.99).options, []);
    assert.deepEqual(buildDraftRequest(candidate(), 22.99).variants[0]?.optionValues, []);
  });

  it('tags the draft so every pushed product is findable', () => {
    const request = buildDraftRequest(candidate(), 22.99);
    assert.ok(request.tags.includes(RESEARCH_PUSH_TAG));
    assert.ok(request.tags.includes('research-good-candidate'));
  });

  it('omits the recommendation tag when there is no recommendation', () => {
    const request = buildDraftRequest(candidate({ recommendation: null }), 22.99);
    assert.deepEqual(request.tags, [RESEARCH_PUSH_TAG]);
  });

  it('maps the category to productType, and omits it when absent', () => {
    assert.equal(buildDraftRequest(candidate(), 22.99).productType, 'Home');
    assert.equal(buildDraftRequest(candidate({ category: null }), 22.99).productType, undefined);
  });

  it('attaches the image only when there is one', () => {
    assert.deepEqual(buildDraftRequest(candidate(), 22.99).mediaUrls, []);
    assert.deepEqual(
      buildDraftRequest(candidate({ imageUrl: 'https://example.test/fan.jpg' }), 22.99).mediaUrls,
      ['https://example.test/fan.jpg'],
    );
  });
});

/* ===========================================================================
 * The description
 * ======================================================================== */

describe('describeCandidate', () => {
  it('says plainly that it is not published', () => {
    const html = describeCandidate(candidate());
    assert.ok(html.includes('NOT published'));
    assert.ok(html.includes('review it before making it visible'));
  });

  it('shows both scores, never a single blended one', () => {
    const html = describeCandidate(candidate());
    assert.ok(html.includes('79/100'));
    assert.ok(html.includes('61/100'));
  });

  it('says so when the candidate was never scored', () => {
    const html = describeCandidate(
      candidate({ overallScore: null, confidenceScore: null, recommendation: null }),
    );
    assert.ok(html.includes('never scored'));
    // And must not imply a verdict it does not have.
    assert.ok(!html.includes('Research score'));
  });

  it('warns that the figures are estimates rather than verified product data', () => {
    assert.ok(describeCandidate(candidate()).includes('estimates, not verified product data'));
  });

  it('lists the risks so the draft is self-explanatory weeks later', () => {
    const html = describeCandidate(
      candidate({ risks: ['Supplier shipping is unknown.', 'Interest is declining.'] }),
    );
    assert.ok(html.includes('Supplier shipping is unknown.'));
    assert.ok(html.includes('Interest is declining.'));
  });

  it('caps the risk list so a product page does not become a report', () => {
    const html = describeCandidate(
      candidate({ risks: ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7'] }),
    );
    assert.ok(html.includes('<li>r5</li>'));
    assert.ok(!html.includes('<li>r6</li>'));
  });

  it('escapes HTML in a risk, so a stray angle bracket cannot break the page', () => {
    const html = describeCandidate(candidate({ risks: ['<script>alert("x")</script>'] }));
    assert.ok(!html.includes('<script>'));
    assert.ok(html.includes('&lt;script&gt;'));
  });
});

/* ===========================================================================
 * Price resolution
 * ======================================================================== */

describe('resolveListingPrice', () => {
  it('uses the recommended scenario by default', () => {
    const resolved = resolveListingPrice(candidate(), pricing());
    // BALANCED at 22.99, per the pricing engine's own tests.
    assert.equal(resolved.amount, 22.99);
    assert.equal(resolved.source, 'Balanced pricing scenario');
    assert.equal(resolved.currencyCode, 'GBP');
  });

  it('honours an explicitly requested scenario', () => {
    const resolved = resolveListingPrice(candidate(), pricing(), { scenario: 'PREMIUM' });
    assert.equal(resolved.amount, 28.99);
    assert.ok(resolved.source.includes('Premium'));
  });

  it('lets an explicit price beat the scenario entirely', () => {
    const resolved = resolveListingPrice(candidate(), pricing(), {
      scenario: 'PREMIUM',
      price: 19.5,
    });
    assert.equal(resolved.amount, 19.5);
    assert.ok(resolved.source.includes('Explicit price'));
  });

  it('rejects a zero or negative explicit price', () => {
    assert.throws(() => resolveListingPrice(candidate(), pricing(), { price: 0 }), AppError);
    assert.throws(() => resolveListingPrice(candidate(), pricing(), { price: -5 }), AppError);
  });

  it('falls back to the operator\u2019s own expected price when nothing could be priced', () => {
    const blocked = pricing({
      supplierCost: null,
      supplierCurrency: null,
      shippingCost: null,
      shippingCurrency: null,
      sellingCurrency: 'GBP',
    });
    assert.equal(blocked.scenarios.length, 0);

    const resolved = resolveListingPrice(
      candidate({
        commercials: { ...candidate().commercials, expectedSellingPrice: 24.99 },
      }),
      blocked,
    );
    assert.equal(resolved.amount, 24.99);
    assert.ok(resolved.source.includes('recorded on the candidate'));
  });

  it('REFUSES rather than guessing when there is no price anywhere', () => {
    const blocked = pricing({
      supplierCost: null,
      supplierCurrency: null,
      shippingCost: null,
      shippingCurrency: null,
      sellingCurrency: 'GBP',
    });

    assert.throws(
      () => resolveListingPrice(candidate(), blocked),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'VALIDATION_ERROR' &&
        error.message.includes('worse than one not listed at all'),
    );
  });

  it('includes the pricing engine\u2019s own reason in the refusal', () => {
    const blocked = pricing({
      supplierCost: 10,
      supplierCurrency: 'USD',
      shippingCost: 2,
      shippingCurrency: 'USD',
      sellingCurrency: 'GBP',
    });
    assert.throws(
      () => resolveListingPrice(candidate(), blocked),
      // The operator needs the actual fix, not a generic "no price".
      (error: unknown) => error instanceof AppError && error.message.includes('CURRENCY_MISMATCH'),
    );
  });
});
