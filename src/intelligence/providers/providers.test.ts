/**
 * Research providers.
 *
 * The behaviour worth testing here is not that a provider returns data - it is that the
 * module tells the truth about what it CANNOT do. Every capability is declared, and a
 * false declaration must produce a stated reason rather than an empty result that reads
 * as "no demand for this product".
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EMPTY_MANUAL_RESEARCH, type ManualResearchEntry } from '../candidate.types';
import { manualResearchProvider } from './manual.provider';
import {
  GATHERABLE_CAPABILITIES,
  NO_RESEARCH_CAPABILITIES,
  RESEARCH_CAPABILITIES,
  describeResearchCapabilities,
  gatherSignals,
  type ResearchProvider,
  type ResearchRequest,
} from './provider.types';
import { describeResearchSupport, staticResearchProviders } from './registry';
import { TRADELLE_MODES, tradelleResearchMode, tradelleResearchProvider } from './tradelle.provider';
import {
  GOOGLE_ADS_RESEARCH_DESCRIPTOR,
  GOOGLE_TRENDS_RESEARCH_DESCRIPTOR,
  googleAdsResearchProvider,
  googleTrendsResearchProvider,
} from './unavailable.providers';

const NOW = new Date('2026-06-15T12:00:00.000Z');
const OBSERVED = '2026-06-10T00:00:00.000Z';

function request(manualResearch: ManualResearchEntry): ResearchRequest {
  return {
    market: { countryCode: 'GB', region: null, horizonDays: 30 },
    keywords: ['neck fan'],
    title: 'Portable neck fan',
    category: 'Home',
    manualResearch,
    now: NOW,
  };
}

function manual(overrides: Partial<ManualResearchEntry> = {}): ManualResearchEntry {
  return { ...EMPTY_MANUAL_RESEARCH, ...overrides };
}

/* ===========================================================================
 * Manual provider
 * ======================================================================== */

describe('manualResearchProvider', () => {
  it('supplies nothing from an empty entry', () => {
    const empty = request(manual());
    assert.equal(manualResearchProvider.fetchDemand?.(empty), null);
    assert.equal(manualResearchProvider.fetchTrend?.(empty), null);
    assert.equal(manualResearchProvider.fetchCompetition?.(empty), null);
    assert.equal(manualResearchProvider.fetchSeasonality?.(empty), null);
  });

  it('reports the operator as the source, never Trademart', () => {
    const signal = manualResearchProvider.fetchDemand?.(
      request(manual({ averageMonthlySearches: 12_000, observedAt: OBSERVED })),
    );
    assert.ok(signal?.source.includes('Operator entry'));
    // fetchedAt null: nothing was fetched. Recording "now" would imply the figure was
    // refreshed at the moment of scoring.
    assert.equal(signal?.fetchedAt, null);
  });

  it('ages from when the operator READ the figure, not when they typed it', () => {
    const signal = manualResearchProvider.fetchDemand?.(
      request(manual({ averageMonthlySearches: 500, observedAt: OBSERVED })),
    );
    assert.equal(signal?.observedAt, OBSERVED);
  });

  it('passes the operator\u2019s stated geography through untouched', () => {
    // A US figure stays a US figure. The scorers discard it for a GB market; this
    // provider does not get to decide it is close enough.
    const signal = manualResearchProvider.fetchDemand?.(
      request(
        manual({
          averageMonthlySearches: 900_000,
          geography: { countryCode: 'US', region: null },
        }),
      ),
    );
    assert.deepEqual(signal?.geography, { countryCode: 'US', region: null });
  });

  it('includes the operator\u2019s own note in the source', () => {
    const signal = manualResearchProvider.fetchDemand?.(
      request(manual({ averageMonthlySearches: 100, sourceNote: 'Tradelle product page' })),
    );
    assert.ok(signal?.source.includes('Tradelle product page'));
  });

  it('supplies only the fields that were filled in', () => {
    // A volume but no competition index is one figure, not two.
    const partial = request(manual({ averageMonthlySearches: 3_000 }));
    assert.ok(manualResearchProvider.fetchDemand?.(partial) !== null);
    assert.equal(manualResearchProvider.fetchTrend?.(partial), null);
    assert.equal(manualResearchProvider.fetchCompetition?.(partial), null);
  });

  it('never offers a hand-estimated acceleration', () => {
    const signal = manualResearchProvider.fetchTrend?.(
      request(manual({ momentumPercentage: 25 })),
    );
    assert.equal(signal?.momentumPercentage, 25);
    // Reading a second derivative off a chart would be noise presented as measurement.
    assert.equal(signal?.accelerationPercentage, null);
  });

  it('treats an UNKNOWN season with no peak months as no observation at all', () => {
    const signal = manualResearchProvider.fetchSeasonality?.(
      request(manual({ averageMonthlySearches: 100, seasonState: 'UNKNOWN' })),
    );
    assert.equal(signal, null);
  });

  it('supplies seasonality from peak months alone', () => {
    const signal = manualResearchProvider.fetchSeasonality?.(
      request(manual({ seasonState: 'UNKNOWN', peakMonths: [6, 7, 8] })),
    );
    assert.deepEqual(signal?.peakMonths, [6, 7, 8]);
  });

  it('does not claim capabilities it cannot have', () => {
    assert.equal(manualResearchProvider.capabilities.storePerformance, false);
    assert.equal(manualResearchProvider.capabilities.fulfillmentHistory, false);
    assert.ok(manualResearchProvider.limitations?.storePerformance !== undefined);
  });
});

/* ===========================================================================
 * Tradelle: an integration that does not exist
 * ======================================================================== */

describe('tradelleResearchProvider', () => {
  it('declares every capability false', () => {
    for (const capability of RESEARCH_CAPABILITIES) {
      assert.equal(
        tradelleResearchProvider.capabilities[capability],
        false,
        `${capability} must be false - there is no Tradelle API`,
      );
    }
  });

  it('has no fetch methods, so it cannot be mistaken for a source that found nothing', () => {
    assert.equal(tradelleResearchProvider.fetchDemand, undefined);
    assert.equal(tradelleResearchProvider.fetchTrend, undefined);
    assert.equal(tradelleResearchProvider.fetchCompetition, undefined);
    assert.equal(tradelleResearchProvider.fetchSeasonality, undefined);
  });

  it('explains every absence, so the UI never shows an unexplained blank', () => {
    for (const capability of RESEARCH_CAPABILITIES) {
      const limitation = tradelleResearchProvider.limitations?.[capability];
      assert.ok(
        limitation !== undefined && limitation.length > 0,
        `${capability} needs a stated reason`,
      );
    }
  });

  it('reports DIRECT_API_UNAVAILABLE and offers no DIRECT_API mode', () => {
    assert.equal(tradelleResearchMode(), 'DIRECT_API_UNAVAILABLE');
    // The absence of a DIRECT_API value is the safeguard: nothing can start assuming a
    // capability that does not exist.
    assert.deepEqual(Object.keys(TRADELLE_MODES).sort(), [
      'DIRECT_API_UNAVAILABLE',
      'MANUAL',
      'SHOPIFY_BRIDGE',
    ]);
  });

  it('describes the Shopify bridge as the real route, and says it does not scrape', () => {
    assert.ok(TRADELLE_MODES.SHOPIFY_BRIDGE.includes('Shopify'));
    assert.ok(TRADELLE_MODES.DIRECT_API_UNAVAILABLE.includes('does not scrape'));
  });
});

/* ===========================================================================
 * Unbuilt integrations
 * ======================================================================== */

describe('unavailable providers', () => {
  it('declare nothing available, because they are not implemented', () => {
    assert.deepEqual(googleAdsResearchProvider.capabilities, NO_RESEARCH_CAPABILITIES);
    assert.deepEqual(googleTrendsResearchProvider.capabilities, NO_RESEARCH_CAPABILITIES);
  });

  it('say "not implemented" rather than "not configured"', () => {
    // Those send an operator to two different places. Supplying credentials today would
    // change nothing, so claiming a configuration problem would waste their time.
    assert.ok(googleAdsResearchProvider.limitations?.demand?.includes('not implemented'));
    assert.ok(
      googleAdsResearchProvider.limitations?.demand?.includes(
        'supplying credentials would not enable it',
      ),
    );
  });

  it('lists the Google Ads env it would need, so the gap is actionable', () => {
    assert.equal(GOOGLE_ADS_RESEARCH_DESCRIPTOR.status, 'PLACEHOLDER');
    assert.ok(GOOGLE_ADS_RESEARCH_DESCRIPTOR.requiredEnv.includes('GOOGLE_ADS_DEVELOPER_TOKEN'));
  });

  it('lists no env for Google Trends, because there is no API to hold a key for', () => {
    assert.deepEqual(GOOGLE_TRENDS_RESEARCH_DESCRIPTOR.requiredEnv, []);
    assert.ok(googleTrendsResearchProvider.limitations?.trend?.includes('no official public API'));
  });

  it('refuses trends as a demand source, because relative interest is not volume', () => {
    assert.ok(googleTrendsResearchProvider.limitations?.demand?.includes('0-100'));
  });
});

/* ===========================================================================
 * Capability reporting
 * ======================================================================== */

describe('describeResearchCapabilities', () => {
  it('reports every capability, in a stable order', () => {
    const described = describeResearchCapabilities(staticResearchProviders);
    assert.deepEqual(
      described.map((entry) => entry.capability),
      [...RESEARCH_CAPABILITIES],
    );
  });

  it('reports what the operator entry does cover', () => {
    const described = describeResearchSupport();
    const demand = described.find((entry) => entry.capability === 'demand');
    assert.equal(demand?.available, true);
    assert.deepEqual(demand?.providers, ['Operator entry']);
  });

  it('reports store performance as unavailable with no Shopify history', () => {
    const described = describeResearchSupport(null);
    const store = described.find((entry) => entry.capability === 'storePerformance');
    assert.equal(store?.available, false);
    assert.ok((store?.limitations.length ?? 0) > 0);
  });

  it('keeps several reasons rather than collapsing them to one', () => {
    const described = describeResearchSupport();
    const store = described.find((entry) => entry.capability === 'storePerformance');
    // "Tradelle has no API" and "Google Ads is not built" are different problems with
    // different fixes; collapsing them would send the operator to fix the wrong one.
    assert.ok((store?.limitations.length ?? 0) >= 2);
  });

  it('still lists limitations for a capability that IS available elsewhere', () => {
    const described = describeResearchSupport();
    const demand = described.find((entry) => entry.capability === 'demand');
    // So an operator can see demand comes from a typed figure, not from Google Ads.
    assert.ok(demand?.limitations.some((reason) => reason.includes('Google Ads')));
  });
});

/* ===========================================================================
 * Gathering
 * ======================================================================== */

describe('gatherSignals', () => {
  const demandProvider = (name: string, volume: number | null): ResearchProvider => ({
    providerName: name,
    source: 'MANUAL',
    capabilities: { ...NO_RESEARCH_CAPABILITIES, demand: true },
    fetchDemand: () =>
      volume === null
        ? null
        : {
            source: name,
            geography: { countryCode: 'GB', region: null },
            observedAt: OBSERVED,
            fetchedAt: null,
            averageMonthlySearches: volume,
          },
  });

  it('takes the first provider that answers and does not blend', () => {
    const signals = gatherSignals(
      [demandProvider('First', 100), demandProvider('Second', 900)],
      request(manual()),
    );
    // Blending would produce a number neither source stands behind.
    assert.equal(signals.demand?.averageMonthlySearches, 100);
    assert.equal(signals.demand?.source, 'First');
  });

  it('records the unused second source rather than hiding the choice', () => {
    const signals = gatherSignals(
      [demandProvider('First', 100), demandProvider('Second', 900)],
      request(manual()),
    );
    const unused = signals.provenance.find(
      (entry) => entry.providerName === 'Second' && entry.capability === 'demand',
    );
    assert.equal(unused?.supplied, false);
    assert.ok(unused?.reason?.includes('not used'));
  });

  it('falls through to the next provider when the first has no data', () => {
    const signals = gatherSignals(
      [demandProvider('First', null), demandProvider('Second', 900)],
      request(manual()),
    );
    assert.equal(signals.demand?.averageMonthlySearches, 900);
  });

  it('does not call a method the provider did not declare', () => {
    let called = false;
    const undeclared: ResearchProvider = {
      providerName: 'Sneaky',
      source: 'MANUAL',
      // demand false, but the method exists.
      capabilities: { ...NO_RESEARCH_CAPABILITIES },
      fetchDemand: () => {
        called = true;
        return null;
      },
    };

    const signals = gatherSignals([undeclared], request(manual()));
    assert.equal(called, false, 'an undeclared method must not become a data source');
    assert.equal(signals.demand, null);
    assert.ok(signals.unavailable.includes('demand'));
  });

  it('lists every gatherable capability nothing could supply', () => {
    const signals = gatherSignals(staticResearchProviders, request(manual()));
    // With an empty manual entry, nothing at all can be measured. supplierCommercials
    // is absent because it is reported rather than gathered - the cost lives on the
    // candidate, so no provider could ever satisfy it.
    assert.deepEqual(signals.unavailable, [...GATHERABLE_CAPABILITIES]);
    assert.ok(!signals.unavailable.includes('supplierCommercials'));
  });

  it('records a stated reason for each provider that declined', () => {
    const signals = gatherSignals([tradelleResearchProvider], request(manual()));
    const declined = signals.provenance.filter((entry) => !entry.supplied);
    assert.equal(declined.length, GATHERABLE_CAPABILITIES.length);
    for (const entry of declined) {
      assert.ok(entry.reason !== null && entry.reason.length > 0);
    }
  });

  it('gathers real signals from the operator entry end to end', () => {
    const signals = gatherSignals(
      staticResearchProviders,
      request(
        manual({
          averageMonthlySearches: 12_000,
          momentumPercentage: 20,
          competitionIndex: 40,
          seasonState: 'RISING',
          observedAt: OBSERVED,
          geography: { countryCode: 'GB', region: null },
        }),
      ),
    );

    assert.equal(signals.demand?.averageMonthlySearches, 12_000);
    assert.equal(signals.trend?.momentumPercentage, 20);
    assert.equal(signals.competition?.competitionIndex, 40);
    assert.equal(signals.seasonality?.state, 'RISING');
    // Still unmeasurable: they need Shopify data or an unbuilt integration.
    assert.deepEqual(signals.unavailable, ['storePerformance', 'fulfillmentHistory']);
  });
});
