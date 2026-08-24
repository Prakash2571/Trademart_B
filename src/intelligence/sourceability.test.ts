/**
 * The sourceability gate: can this product actually be sourced, and how does that gate the
 * recommendation - kept strictly apart from the opportunity score.
 *
 * These tests encode the core invariant of the phase: no market opportunity overrides a
 * confirmed inability to source, an unverified supplier caps a strong opportunity at WATCH,
 * and a stale check is not a current one.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  applySourceabilityGate,
  computeSourceability,
  DEFAULT_SOURCEABILITY_CONFIG,
  variantCoverageOf,
  type SupplierInfo,
  type SupplierVariantAvailability,
} from './sourceability';

const NOW = new Date('2026-08-24T12:00:00.000Z');

function supplier(overrides: Partial<SupplierInfo> = {}): SupplierInfo {
  return {
    provider: 'TRADELLE',
    supplierProductId: 'TRD-1',
    sourceUrl: 'https://tradelle.example/p/1',
    availability: 'AVAILABLE',
    availabilitySource: 'MANUAL',
    checkedAt: NOW.toISOString(),
    observedAt: NOW.toISOString(),
    note: null,
    stockKnown: true,
    productAvailable: true,
    productCost: 8,
    productCurrency: 'USD',
    shippingCost: 3,
    shippingCurrency: 'USD',
    shippingDays: 8,
    variants: [],
    evidence: [],
    ...overrides,
  };
}

function variant(overrides: Partial<SupplierVariantAvailability> = {}): SupplierVariantAvailability {
  return {
    supplierVariantId: 'v1',
    sku: 'SKU-1',
    title: 'Black / M',
    optionValues: { Color: 'Black', Size: 'M' },
    availability: 'AVAILABLE',
    stockKnown: true,
    cost: null,
    currencyCode: null,
    checkedAt: NOW.toISOString(),
    ...overrides,
  };
}

/* ===========================================================================
 * computeSourceability
 * ======================================================================== */

describe('computeSourceability', () => {
  it('treats a null supplier as UNKNOWN, distinct from UNAVAILABLE', () => {
    const result = computeSourceability(null, NOW);
    assert.equal(result.availability, 'UNKNOWN');
    assert.equal(result.current, 'UNVERIFIED');
    assert.equal(result.pushEligible, false);
    assert.equal(result.block, 'SUPPLIER_AVAILABILITY_UNKNOWN');
    assert.ok(result.reasons.includes('SUPPLIER_AVAILABILITY_UNKNOWN'));
    assert.ok(result.reasons.includes('SUPPLIER_CHECK_REQUIRED'));
  });

  it('marks a fresh AVAILABLE product SOURCEABLE and push-eligible', () => {
    const result = computeSourceability(supplier(), NOW);
    assert.equal(result.current, 'SOURCEABLE');
    assert.equal(result.pushEligible, true);
    assert.equal(result.block, null);
    assert.ok(result.reasons.includes('SUPPLIER_AVAILABLE'));
  });

  it('marks UNAVAILABLE as NOT_SOURCEABLE and never push-eligible', () => {
    const result = computeSourceability(supplier({ availability: 'UNAVAILABLE' }), NOW);
    assert.equal(result.current, 'NOT_SOURCEABLE');
    assert.equal(result.pushEligible, false);
    assert.equal(result.block, 'SUPPLIER_UNAVAILABLE');
  });

  it('ages an AVAILABLE check into NEEDS_RECHECK once it passes the stale threshold', () => {
    // Default fresh window is 72h; stale after 2x that (144h). 200h later is STALE.
    const later = new Date(NOW.getTime() + 200 * 3_600_000);
    const result = computeSourceability(supplier(), later);
    assert.equal(result.availability, 'AVAILABLE'); // historically AVAILABLE...
    assert.equal(result.freshness, 'STALE');
    assert.equal(result.current, 'NEEDS_RECHECK'); // ...but not CURRENTLY sourceable
    assert.equal(result.pushEligible, false);
    assert.equal(result.block, 'SUPPLIER_AVAILABILITY_STALE');
    assert.ok(result.reasons.includes('SUPPLIER_AVAILABILITY_STALE'));
  });

  it('does not silently convert a stale AVAILABLE into a current one', () => {
    const later = new Date(NOW.getTime() + 200 * 3_600_000);
    const stale = computeSourceability(supplier(), later);
    const fresh = computeSourceability(supplier(), NOW);
    assert.notEqual(stale.current, fresh.current);
  });

  it('an AVAILABLE product with an UNKNOWN cost is still sourceable - availability != cost', () => {
    const result = computeSourceability(
      supplier({ productCost: null, productCurrency: null }),
      NOW,
    );
    assert.equal(result.current, 'SOURCEABLE');
    assert.equal(result.pushEligible, true);
    // ...but the missing cost is reported, so profitability reads as unknown, not zero.
    assert.ok(result.reasons.includes('SUPPLIER_COST_UNKNOWN'));
  });

  it('a known cost with UNKNOWN availability is NOT sourceable - cost != availability', () => {
    const result = computeSourceability(
      supplier({ availability: 'UNKNOWN', productCost: 8, productCurrency: 'USD' }),
      NOW,
    );
    assert.equal(result.current, 'UNVERIFIED');
    assert.equal(result.pushEligible, false);
  });
});

/* ===========================================================================
 * Variants
 * ======================================================================== */

describe('variant coverage', () => {
  it('FULL when every variant is available', () => {
    assert.equal(variantCoverageOf([variant(), variant({ supplierVariantId: 'v2' })]), 'FULL');
  });

  it('NONE when every variant is unavailable', () => {
    assert.equal(
      variantCoverageOf([variant({ availability: 'UNAVAILABLE' })]),
      'NONE',
    );
  });

  it('PARTIAL when some are available and some are not', () => {
    assert.equal(
      variantCoverageOf([variant(), variant({ supplierVariantId: 'v2', availability: 'UNAVAILABLE' })]),
      'PARTIAL',
    );
  });

  it('PARTIAL when any variant availability is unknown', () => {
    assert.equal(
      variantCoverageOf([variant(), variant({ supplierVariantId: 'v2', availability: 'UNKNOWN' })]),
      'PARTIAL',
    );
  });

  it('a product AVAILABLE with all variants unavailable collapses to NOT_SOURCEABLE', () => {
    const result = computeSourceability(
      supplier({ variants: [variant({ availability: 'UNAVAILABLE' })] }),
      NOW,
    );
    assert.equal(result.variantCoverage, 'NONE');
    assert.equal(result.current, 'NOT_SOURCEABLE');
    assert.equal(result.pushEligible, false);
  });

  it('a product AVAILABLE with partial variants is PARTIALLY_SOURCEABLE but still eligible', () => {
    const result = computeSourceability(
      supplier({
        variants: [variant(), variant({ supplierVariantId: 'v2', availability: 'UNAVAILABLE' })],
      }),
      NOW,
    );
    assert.equal(result.current, 'PARTIALLY_SOURCEABLE');
    assert.equal(result.pushEligible, true);
    assert.ok(result.reasons.includes('SUPPLIER_VARIANTS_PARTIALLY_AVAILABLE'));
    assert.ok(result.confidencePenalty > 0);
  });
});

/* ===========================================================================
 * The gate on the recommendation
 * ======================================================================== */

describe('applySourceabilityGate', () => {
  const strong = { recommendation: 'STRONG_CANDIDATE' as const, confidenceScore: 80 };

  it('REJECTS a strong opportunity when the supplier is UNAVAILABLE', () => {
    const gate = applySourceabilityGate(
      strong,
      computeSourceability(supplier({ availability: 'UNAVAILABLE' }), NOW),
    );
    assert.equal(gate.recommendation, 'REJECT');
    assert.equal(gate.opportunityRecommendation, 'STRONG_CANDIDATE');
    assert.equal(gate.gated, true);
  });

  it('caps a strong opportunity at WATCH when the supplier is UNKNOWN', () => {
    const gate = applySourceabilityGate(strong, computeSourceability(null, NOW));
    assert.equal(gate.recommendation, 'WATCH');
    assert.ok((gate.reason ?? '').length > 0);
    // Opportunity is preserved for explainability - it is NOT overwritten.
    assert.equal(gate.opportunityRecommendation, 'STRONG_CANDIDATE');
    // Confidence takes a penalty for the unverified supplier.
    assert.ok(gate.confidenceScore < strong.confidenceScore);
  });

  it('caps at WATCH and requires recheck when the supplier check is STALE', () => {
    const later = new Date(NOW.getTime() + 200 * 3_600_000);
    const gate = applySourceabilityGate(strong, computeSourceability(supplier(), later));
    assert.equal(gate.recommendation, 'WATCH');
    assert.equal(gate.gated, true);
  });

  it('leaves the recommendation intact when the supplier is fresh and AVAILABLE', () => {
    const gate = applySourceabilityGate(strong, computeSourceability(supplier(), NOW));
    assert.equal(gate.recommendation, 'STRONG_CANDIDATE');
    assert.equal(gate.gated, false);
    assert.equal(gate.confidenceScore, 80); // no penalty
  });

  it('never RAISES a recommendation - a weak opportunity with a great supplier stays weak', () => {
    const gate = applySourceabilityGate(
      { recommendation: 'WEAK', confidenceScore: 70 },
      computeSourceability(supplier(), NOW),
    );
    assert.equal(gate.recommendation, 'WEAK');
  });

  it('does nothing when there is no opportunity verdict to gate', () => {
    const gate = applySourceabilityGate(
      { recommendation: null, confidenceScore: 0 },
      computeSourceability(null, NOW),
    );
    assert.equal(gate.recommendation, null);
    assert.equal(gate.gated, false);
  });

  it('keeps a partially-sourceable product recommendable but dents confidence', () => {
    const gate = applySourceabilityGate(
      { recommendation: 'GOOD_CANDIDATE', confidenceScore: 80 },
      computeSourceability(
        supplier({
          variants: [variant(), variant({ supplierVariantId: 'v2', availability: 'UNAVAILABLE' })],
        }),
        NOW,
      ),
    );
    assert.equal(gate.recommendation, 'GOOD_CANDIDATE');
    assert.ok(gate.confidenceScore < 80);
    assert.ok((gate.reason ?? '').includes('variant'));
  });

  it('uses the configurable freshness threshold', () => {
    // With a 1-hour fresh window, a 5-hour-old check is already stale.
    const later = new Date(NOW.getTime() + 5 * 3_600_000);
    const result = computeSourceability(supplier(), later, { manualAvailabilityFreshHours: 1 });
    assert.equal(result.current, 'NEEDS_RECHECK');
    // And with the generous default it is still fresh at 5 hours.
    assert.equal(computeSourceability(supplier(), later, DEFAULT_SOURCEABILITY_CONFIG).current, 'SOURCEABLE');
  });
});
