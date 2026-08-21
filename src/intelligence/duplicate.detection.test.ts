/**
 * Duplicate detection.
 *
 * Two opposite failures are both expensive, and the tests are split between them:
 *
 *   a MISSED duplicate  -> two competing listings, two inventory positions, and a
 *                          customer asking why the same item has two prices
 *   a FALSE duplicate   -> a blocked push on legitimate work, and an operator who
 *                          learns to click through the block without reading it
 *
 * The second is the one that quietly destroys the feature, so most of these tests are
 * about NOT matching things that merely look similar.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  detectDuplicates,
  normaliseTitle,
  type DetectDuplicatesInput,
  type ExistingCandidateRef,
  type ExistingProductRef,
} from './duplicate.detection';

function product(
  title: string,
  overrides: Partial<ExistingProductRef> = {},
): ExistingProductRef {
  return {
    shopifyProductId: `gid://shopify/Product/${title.length}`,
    title,
    status: 'ACTIVE',
    tags: [],
    ...overrides,
  };
}

function otherCandidate(
  title: string,
  overrides: Partial<ExistingCandidateRef> = {},
): ExistingCandidateRef {
  return {
    candidateId: `cand-${title.length}`,
    title,
    status: 'ANALYZED',
    sourceProductId: null,
    pushedShopifyProductId: null,
    ...overrides,
  };
}

function detect(overrides: Partial<DetectDuplicatesInput> = {}) {
  return detectDuplicates({
    subject: {
      candidateId: 'subject-1',
      title: 'Portable Neck Fan',
      keywords: ['neck fan'],
      sourceProductId: null,
    },
    products: [],
    candidates: [],
    ...overrides,
  });
}

/* ===========================================================================
 * Normalisation
 * ======================================================================== */

describe('normaliseTitle', () => {
  it('lowercases, strips punctuation and collapses whitespace', () => {
    assert.equal(normaliseTitle('  Portable  Neck-Fan (USB)! '), 'portable neck fan usb');
  });

  it('does NOT de-pluralise or stem', () => {
    // "Fan" and "Fans" staying distinct costs a detection. An over-eager stemmer merging
    // "Fan" with "Fanny pack" costs a blocked push, which is the worse mistake.
    assert.notEqual(normaliseTitle('Fan'), normaliseTitle('Fans'));
  });
});

/* ===========================================================================
 * Nothing found
 * ======================================================================== */

describe('when there is nothing to match', () => {
  it('reports no matches and no summary', () => {
    const report = detect();
    assert.deepEqual(report.matches, []);
    assert.deepEqual(report.blocking, []);
    assert.equal(report.summary, null);
  });

  it('does not match an unrelated product', () => {
    const report = detect({ products: [product('Stainless Steel Water Bottle')] });
    assert.deepEqual(report.matches, []);
  });

  it('does not match a different product in the same range', () => {
    // "Portable Neck Fan" vs "Portable Desk Fan": 3 shared of 5 union = 0.6, which is
    // POSSIBLE but must never block.
    const report = detect({ products: [product('Portable Desk Fan')] });
    assert.equal(report.matches.length, 1);
    assert.equal(report.matches[0]?.strength, 'POSSIBLE');
    assert.deepEqual(report.blocking, []);
  });

  it('never blocks on a merely similar title', () => {
    const report = detect({
      products: [product('Portable Neck Fan Pro Max Rechargeable')],
    });
    for (const match of report.matches) {
      assert.equal(match.blocking, false);
    }
  });

  it('does not treat two missing supplier references as a match', () => {
    // Otherwise every candidate without a supplier id would be a duplicate of every
    // other one.
    const report = detect({
      subject: {
        candidateId: 'subject-1',
        title: 'Portable Neck Fan',
        keywords: [],
        sourceProductId: '',
      },
      candidates: [otherCandidate('Something Else', { sourceProductId: '   ' })],
    });
    assert.deepEqual(report.matches, []);
  });
});

/* ===========================================================================
 * Exact matches against Shopify
 * ======================================================================== */

describe('exact matches against the catalogue', () => {
  it('blocks on an identical active product title', () => {
    const report = detect({ products: [product('portable neck fan')] });
    assert.equal(report.matches.length, 1);
    assert.equal(report.matches[0]?.strength, 'EXACT');
    assert.equal(report.matches[0]?.blocking, true);
    assert.equal(report.blocking.length, 1);
    assert.ok(report.summary?.includes('blocked'));
  });

  it('matches through punctuation and case differences', () => {
    const report = detect({ products: [product('PORTABLE NECK-FAN!')] });
    assert.equal(report.matches[0]?.strength, 'EXACT');
  });

  it('does NOT block on an archived product, because relisting is a real intent', () => {
    const report = detect({
      products: [product('Portable Neck Fan', { status: 'ARCHIVED' })],
    });
    assert.equal(report.matches[0]?.strength, 'EXACT');
    assert.equal(report.matches[0]?.blocking, false);
    assert.ok(report.matches[0]?.reason.includes('does not block'));
    assert.deepEqual(report.blocking, []);
  });

  it('blocks on an identical DRAFT product, which is still a duplicate', () => {
    const report = detect({ products: [product('Portable Neck Fan', { status: 'DRAFT' })] });
    assert.equal(report.matches[0]?.blocking, true);
  });

  it('reports a likely match with a checkable reason rather than a score', () => {
    const report = detect({ products: [product('Neck Fan Portable USB')] });
    const match = report.matches[0];
    if (match === undefined) throw new Error('expected a match');
    // "3 of 4 title words (fan, neck, portable)" is arguable. A cosine distance is not.
    assert.ok(/\d+ of \d+ title words/.test(match.reason));
    assert.ok(match.reason.includes('fan'));
  });
});

/* ===========================================================================
 * Against other candidates
 * ======================================================================== */

describe('against other research candidates', () => {
  it('matches on the same supplier reference even when titles differ', () => {
    const report = detect({
      subject: {
        candidateId: 'subject-1',
        title: 'Portable Neck Fan',
        keywords: [],
        sourceProductId: 'TRD-9931',
      },
      candidates: [
        otherCandidate('Hands Free Cooling Fan', { sourceProductId: 'trd-9931' }),
      ],
    });
    assert.equal(report.matches.length, 1);
    assert.equal(report.matches[0]?.strength, 'EXACT');
    assert.ok(report.matches[0]?.reason.includes('same supplier product'));
  });

  it('does not block when the twin was never pushed, only warns', () => {
    const report = detect({
      subject: {
        candidateId: 'subject-1',
        title: 'Portable Neck Fan',
        keywords: [],
        sourceProductId: 'TRD-9931',
      },
      candidates: [otherCandidate('Cooling Fan', { sourceProductId: 'TRD-9931' })],
    });
    // Duplicated research is untidy; duplicated Shopify products are harmful.
    assert.equal(report.matches[0]?.blocking, false);
    assert.ok(report.matches[0]?.reason.includes('researching the same item twice'));
  });

  it('BLOCKS when the twin was already pushed to Shopify', () => {
    const report = detect({
      subject: {
        candidateId: 'subject-1',
        title: 'Portable Neck Fan',
        keywords: [],
        sourceProductId: 'TRD-9931',
      },
      candidates: [
        otherCandidate('Cooling Fan', {
          sourceProductId: 'TRD-9931',
          pushedShopifyProductId: 'gid://shopify/Product/55',
          status: 'PUSHED_TO_SHOPIFY',
        }),
      ],
    });
    assert.equal(report.matches[0]?.blocking, true);
    assert.ok(report.matches[0]?.reason.includes('ALREADY been pushed'));
  });

  it('never compares a candidate with itself', () => {
    const report = detect({
      candidates: [
        otherCandidate('Portable Neck Fan', {
          candidateId: 'subject-1',
          sourceProductId: 'TRD-1',
        }),
      ],
      subject: {
        candidateId: 'subject-1',
        title: 'Portable Neck Fan',
        keywords: [],
        sourceProductId: 'TRD-1',
      },
    });
    assert.deepEqual(report.matches, []);
  });

  it('matches a brand-new candidate that has no id yet', () => {
    const report = detect({
      subject: {
        candidateId: null,
        title: 'Portable Neck Fan',
        keywords: [],
        sourceProductId: null,
      },
      candidates: [otherCandidate('Portable Neck Fan')],
    });
    assert.equal(report.matches.length, 1);
    assert.equal(report.matches[0]?.strength, 'EXACT');
  });

  it('mentions the other candidate\u2019s status, so the operator knows what to do', () => {
    const report = detect({
      candidates: [otherCandidate('Portable Neck Fan', { status: 'REJECTED' })],
    });
    assert.ok(report.matches[0]?.reason.includes('REJECTED'));
  });
});

/* ===========================================================================
 * Ordering and reporting
 * ======================================================================== */

describe('reporting', () => {
  it('puts the strongest match first', () => {
    const report = detect({
      products: [
        product('Portable Desk Fan'),
        product('Portable Neck Fan'),
        product('Neck Fan Portable USB'),
      ],
    });
    assert.equal(report.matches[0]?.strength, 'EXACT');
    assert.equal(report.matches[report.matches.length - 1]?.strength, 'POSSIBLE');
  });

  it('says the push is allowed when nothing is exact', () => {
    const report = detect({ products: [product('Neck Fan Portable USB')] });
    assert.ok(report.summary?.includes('push is allowed'));
    assert.deepEqual(report.blocking, []);
  });

  it('offers a deliberate override in the blocking message', () => {
    const report = detect({ products: [product('Portable Neck Fan')] });
    assert.ok(report.summary?.includes('override it deliberately'));
  });

  it('identifies each match by id so the UI can link to it', () => {
    const report = detect({
      products: [product('Portable Neck Fan')],
      candidates: [otherCandidate('Portable Neck Fan')],
    });
    assert.equal(report.matches.length, 2);
    for (const match of report.matches) {
      assert.ok(match.id.length > 0);
      assert.ok(match.target === 'SHOPIFY_PRODUCT' || match.target === 'CANDIDATE');
    }
  });

  it('is deterministic', () => {
    const input: Partial<DetectDuplicatesInput> = {
      products: [product('Portable Desk Fan'), product('Portable Neck Fan')],
      candidates: [otherCandidate('Neck Fan Portable USB')],
    };
    assert.deepEqual(detect(input), detect(input));
  });

  it('handles an empty title without matching everything', () => {
    const report = detect({
      subject: { candidateId: 'x', title: '   ', keywords: [], sourceProductId: null },
      products: [product('Portable Neck Fan'), product('   ')],
    });
    // An empty normalised title must not be treated as equal to another empty one.
    assert.deepEqual(report.matches, []);
  });
});
