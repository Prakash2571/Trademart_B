/**
 * Score staleness.
 *
 * The replaced logic was `candidate.updatedAt > candidate.analyzedAt`, which was wrong
 * in both directions at once:
 *
 *   FALSE POSITIVE  Mongoose bumps updatedAt during the analysis write itself, so a
 *                   candidate analysed one second ago reported "score out of date". A
 *                   warning that always fires is a warning nobody reads.
 *   FALSE POSITIVE  watching, rejecting or adding a note bumps updatedAt without
 *                   touching a single scoring input.
 *
 * These tests are the specification of what actually invalidates a score.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  EMPTY_MANUAL_RESEARCH,
  type ProductCandidate,
} from './candidate.types';
import {
  SCORE_AFFECTING_FIELDS,
  changedScoreInputs,
  scoreInputsChanged,
  scoreInputsOf,
  scoreIsStale,
} from './candidate.revision';

const NOW = '2026-06-15T12:00:00.000Z';

function candidate(overrides: Partial<ProductCandidate> = {}): ProductCandidate {
  return {
    id: 'cand-1',
    source: 'MANUAL',
    sourceProductId: 'TRD-1',
    sourceUrl: null,
    title: 'Portable neck fan',
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
      costObservedAt: NOW,
    },
    supplier: null,
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
    pushState: 'IDLE',
    pushOperationId: null,
    pushClaimedAt: null,
    pushSafetyReason: null,
    pushedShopifyProductId: null,
    watchUntil: null,
    scoreHistory: [],
    notes: null,
    createdAt: NOW,
    analyzedAt: NOW,
    updatedAt: NOW,
    inputRevision: 4,
    analyzedInputRevision: 4,
    ...overrides,
  };
}

/* ===========================================================================
 * scoreIsStale - the required cases from the brief
 * ======================================================================== */

describe('scoreIsStale', () => {
  it('a freshly analysed candidate is NOT stale', () => {
    // The headline regression. The old timestamp comparison failed this, because the
    // write that stored the score also bumped updatedAt.
    assert.equal(scoreIsStale(candidate()), false);
  });

  it('is not stale even when updatedAt is LATER than analyzedAt', () => {
    // Precisely the situation the old logic mis-read. A later updatedAt proves only that
    // a write happened, not that a scoring input moved.
    assert.equal(
      scoreIsStale(
        candidate({ analyzedAt: NOW, updatedAt: '2026-06-20T00:00:00.000Z' }),
      ),
      false,
    );
  });

  it('IS stale when the analysed revision is behind the current one', () => {
    assert.equal(
      scoreIsStale(candidate({ inputRevision: 5, analyzedInputRevision: 4 })),
      true,
    );
  });

  it('a never-analysed candidate is NOT stale - it has no score to be stale', () => {
    // "Never analysed" invites an analysis. "Out of date" implies a number on screen
    // that should not be trusted. Conflating them makes both messages useless.
    assert.equal(
      scoreIsStale(candidate({ analyzedAt: null, analyzedInputRevision: null })),
      false,
    );
  });

  it('treats a score with no recorded revision as stale', () => {
    // A row written before this mechanism existed. "We cannot tell" must not read as
    // "it is fine".
    assert.equal(
      scoreIsStale(candidate({ analyzedAt: NOW, analyzedInputRevision: null })),
      true,
    );
  });

  it('returns false again after a re-analysis catches up', () => {
    const edited = candidate({ inputRevision: 5, analyzedInputRevision: 4 });
    assert.equal(scoreIsStale(edited), true);
    assert.equal(scoreIsStale({ ...edited, analyzedInputRevision: 5 }), false);
  });
});

/* ===========================================================================
 * What counts as a scoring input
 * ======================================================================== */

describe('changes that DO affect the score', () => {
  const base = candidate();

  it('a supplier cost change', () => {
    const after = {
      ...base,
      commercials: { ...base.commercials, supplierCost: 12 },
    };
    assert.equal(scoreInputsChanged(base, after), true);
    assert.deepEqual(changedScoreInputs(base, after), ['commercials']);
  });

  it('a supplier CURRENCY change', () => {
    // Same number, different unit. It changes the price and therefore the score.
    const after = {
      ...base,
      commercials: { ...base.commercials, supplierCurrency: 'USD' },
    };
    assert.equal(scoreInputsChanged(base, after), true);
  });

  it('a manual demand figure change', () => {
    const after = {
      ...base,
      manualResearch: { ...base.manualResearch, averageMonthlySearches: 12_000 },
    };
    assert.equal(scoreInputsChanged(base, after), true);
    assert.deepEqual(changedScoreInputs(base, after), ['manualResearch']);
  });

  it('a manual trend figure change', () => {
    const after = {
      ...base,
      manualResearch: { ...base.manualResearch, momentumPercentage: -20 },
    };
    assert.equal(scoreInputsChanged(base, after), true);
  });

  it('the research geography the figures describe', () => {
    // Region isolation can discard a figure entirely based on this, so it is as
    // score-affecting as the figure itself.
    const after = {
      ...base,
      manualResearch: {
        ...base.manualResearch,
        geography: { countryCode: 'US', region: null },
      },
    };
    assert.equal(scoreInputsChanged(base, after), true);
  });

  it('a category change', () => {
    const after = { ...base, category: 'Garden' };
    assert.equal(scoreInputsChanged(base, after), true);
    assert.deepEqual(changedScoreInputs(base, after), ['category']);
  });

  it('a target market change', () => {
    const after = {
      ...base,
      market: { ...base.market, countryCode: 'IN' },
    };
    assert.equal(scoreInputsChanged(base, after), true);
    assert.deepEqual(changedScoreInputs(base, after), ['market']);
  });

  it('a horizon change, because the trend bands are read over it', () => {
    const after = { ...base, market: { ...base.market, horizonDays: 90 } };
    assert.equal(scoreInputsChanged(base, after), true);
  });

  it('a keyword ADDED', () => {
    const after = { ...base, keywords: ['neck fan', 'portable fan'] };
    assert.equal(scoreInputsChanged(base, after), true);
  });

  it('a title change, because providers receive it', () => {
    const after = { ...base, title: 'Neck cooling fan' };
    assert.equal(scoreInputsChanged(base, after), true);
  });

  it('reports several changed fields at once', () => {
    const after = {
      ...base,
      category: 'Garden',
      commercials: { ...base.commercials, supplierCost: 99 },
    };
    assert.deepEqual(changedScoreInputs(base, after).sort(), ['category', 'commercials']);
  });
});

describe('changes that do NOT affect the score', () => {
  const base = candidate();

  it('a note-only edit', () => {
    const after = { ...base, notes: 'Ask the supplier about MOQ' };
    assert.equal(scoreInputsChanged(base, after), false);
    assert.deepEqual(changedScoreInputs(base, after), []);
  });

  it('a WATCHING status change with a watch date', () => {
    const after = {
      ...base,
      status: 'WATCHING' as const,
      watchUntil: '2026-09-01T00:00:00.000Z',
    };
    assert.equal(scoreInputsChanged(base, after), false);
  });

  it('a rejection', () => {
    const after = { ...base, status: 'REJECTED' as const, notes: 'Margin too thin' };
    assert.equal(scoreInputsChanged(base, after), false);
  });

  it('being pushed to Shopify', () => {
    const after = {
      ...base,
      status: 'PUSHED_TO_SHOPIFY' as const,
      pushedShopifyProductId: 'gid://shopify/Product/1',
    };
    assert.equal(scoreInputsChanged(base, after), false);
  });

  it('the score OUTPUT changing', () => {
    // Critical: if the output counted as an input, every analysis would invalidate its
    // own result and nothing would ever be current.
    const after = {
      ...base,
      overallScore: 42,
      confidenceScore: 12,
      recommendation: 'WEAK' as const,
      factors: [],
      reasons: ['different'],
      risks: ['different'],
      evidence: [],
      freshness: 'STALE' as const,
      seasonState: 'FALLING' as const,
      analyzedAt: '2026-07-01T00:00:00.000Z',
    };
    assert.equal(scoreInputsChanged(base, after), false);
  });

  it('an image or source URL change', () => {
    const after = {
      ...base,
      imageUrl: 'https://example.test/a.jpg',
      sourceUrl: 'https://example.test/p',
      sourceProductId: 'TRD-999',
    };
    assert.equal(scoreInputsChanged(base, after), false);
  });

  it('timestamps moving', () => {
    const after = { ...base, updatedAt: '2027-01-01T00:00:00.000Z' };
    assert.equal(scoreInputsChanged(base, after), false);
  });
});

/* ===========================================================================
 * Normalisation - cosmetic edits must not invalidate a score
 * ======================================================================== */

describe('cosmetically identical input is the same input', () => {
  const base = candidate();

  it('ignores surrounding whitespace in the title', () => {
    assert.equal(scoreInputsChanged(base, { ...base, title: '  Portable neck fan  ' }), false);
  });

  it('ignores keyword ORDER - keywords are a set to the providers', () => {
    const before = { ...base, keywords: ['neck fan', 'portable'] };
    const after = { ...base, keywords: ['portable', 'neck fan'] };
    assert.equal(scoreInputsChanged(before, after), false);
  });

  it('ignores duplicate keywords', () => {
    const after = { ...base, keywords: ['neck fan', 'neck fan'] };
    assert.equal(scoreInputsChanged(base, after), false);
  });

  it('ignores keyword case', () => {
    assert.equal(scoreInputsChanged(base, { ...base, keywords: ['Neck Fan'] }), false);
  });

  it('ignores currency case', () => {
    const after = {
      ...base,
      commercials: { ...base.commercials, supplierCurrency: 'gbp' },
    };
    assert.equal(scoreInputsChanged(base, after), false);
  });

  it('treats an empty-string category as the same as null', () => {
    const before = { ...base, category: null };
    assert.equal(scoreInputsChanged(before, { ...base, category: '   ' }), false);
  });

  it('ignores peak-month ordering', () => {
    const before = { ...base, manualResearch: { ...base.manualResearch, peakMonths: [6, 7] } };
    const after = { ...base, manualResearch: { ...base.manualResearch, peakMonths: [7, 6] } };
    assert.equal(scoreInputsChanged(before, after), false);
  });
});

describe('scoreInputsOf', () => {
  it('projects exactly the score-affecting fields and nothing else', () => {
    // Guards against a future field being added to the projection without a decision
    // about whether it truly affects a score.
    assert.deepEqual(Object.keys(scoreInputsOf(candidate())).sort(), [
      ...SCORE_AFFECTING_FIELDS,
    ].sort());
  });
});
