/**
 * The operator as a data source.
 *
 * This is the only provider that supplies demand, trend, competition or seasonality
 * today, and it does so from figures a human read off a Tradelle page or a keyword
 * tool and typed in. That is not an elegant integration and it is not pretending to
 * be one - it is the honest shape of the problem, because Tradelle publishes no API
 * and Google Trends publishes no supported one.
 *
 * WHAT THIS PROVIDER IS CAREFUL ABOUT
 * -----------------------------------
 *   - it names itself as an operator entry in every signal's `source`, so the
 *     evidence trail never implies Trademart measured anything.
 *   - it ages from the operator's `observedAt`, not from when they typed it. A figure
 *     copied from a screenshot taken in March is three months old, and the freshness
 *     policies will call it STALE.
 *   - it passes the operator's stated geography through untouched. If they read US
 *     figures and the store sells in India, the scorers DISCARD the signal. This
 *     provider does not get to decide that a US number is close enough.
 *   - it returns null for anything not filled in. An operator who entered a search
 *     volume but no competition index has given us one figure, not two.
 *
 * Pure: the clock arrives on the request, nothing is read from config or a database.
 */

import { hasManualResearch, type ManualResearchEntry } from '../candidate.types';
import type {
  CompetitionSignal,
  DemandSignal,
  SeasonalitySignal,
  TrendSignal,
} from '../scoring/scoring.types';
import {
  NO_RESEARCH_CAPABILITIES,
  type ResearchProvider,
  type ResearchRequest,
} from './provider.types';

/**
 * How this provider identifies itself in evidence.
 *
 * Worded so it reads correctly in the UI beside a figure: "12,000 average monthly
 * searches - Operator entry (read from an external tool)". The point is that nobody
 * skimming an evidence list mistakes it for a measurement.
 */
const SOURCE = 'Operator entry (read from an external tool)';

/** Describes the source including the operator's own note, when they left one. */
function describeSource(entry: ManualResearchEntry): string {
  return entry.sourceNote === null || entry.sourceNote.trim() === ''
    ? SOURCE
    : `${SOURCE}: ${entry.sourceNote.trim()}`;
}

/**
 * The provenance every manual signal shares.
 *
 * fetchedAt is null on purpose. Trademart did not fetch anything - a human typed it -
 * and recording "now" as a fetch time would suggest the figure was refreshed at the
 * moment of scoring, which is exactly the false impression this module must avoid.
 */
function meta(entry: ManualResearchEntry) {
  return {
    source: describeSource(entry),
    geography: entry.geography,
    observedAt: entry.observedAt,
    fetchedAt: null,
  };
}

export const manualResearchProvider: ResearchProvider = {
  providerName: 'Operator entry',
  source: 'MANUAL',

  capabilities: {
    ...NO_RESEARCH_CAPABILITIES,
    // Genuinely supplied, because a human genuinely supplies them. Declaring these
    // true is not a claim that the data is good - the confidence score handles that -
    // it is a statement that asking this provider is not pointless.
    demand: true,
    trend: true,
    competition: true,
    seasonality: true,
  },

  limitations: {
    storePerformance:
      'An operator cannot hand-enter the store\u2019s own trading history; it is read from Shopify.',
    fulfillmentHistory:
      'Measured delivery outcomes come from the store\u2019s own orders, not from a person typing them in.',
    supplierCommercials:
      'Costs are recorded on the candidate itself rather than fetched, because no supplier API is available.',
  },

  fetchDemand(request: ResearchRequest): DemandSignal | null {
    const entry = request.manualResearch;
    if (!hasManualResearch(entry) || entry.averageMonthlySearches === null) return null;

    return {
      ...meta(entry),
      averageMonthlySearches: entry.averageMonthlySearches,
    };
  },

  fetchTrend(request: ResearchRequest): TrendSignal | null {
    const entry = request.manualResearch;
    if (!hasManualResearch(entry) || entry.momentumPercentage === null) return null;

    return {
      ...meta(entry),
      momentumPercentage: entry.momentumPercentage,
      // Acceleration is not offered for manual entry. Reading a first derivative off a
      // chart is already approximate; a hand-estimated second derivative would be
      // noise presented as a measurement.
      accelerationPercentage: null,
    };
  },

  fetchCompetition(request: ResearchRequest): CompetitionSignal | null {
    const entry = request.manualResearch;
    if (!hasManualResearch(entry)) return null;
    if (entry.competitionIndex === null && entry.competitorCount === null) return null;

    return {
      ...meta(entry),
      competitionIndex: entry.competitionIndex,
      competitorCount: entry.competitorCount,
    };
  },

  fetchSeasonality(request: ResearchRequest): SeasonalitySignal | null {
    const entry = request.manualResearch;
    if (!hasManualResearch(entry)) return null;
    // UNKNOWN with no peak months is not an observation, so no signal is produced.
    // Returning one would let the seasonality scorer report "the source says unknown",
    // implying a source was consulted.
    if (entry.seasonState === 'UNKNOWN' && (entry.peakMonths ?? []).length === 0) {
      return null;
    }

    return {
      ...meta(entry),
      state: entry.seasonState,
      peakMonths: entry.peakMonths,
    };
  },
};
