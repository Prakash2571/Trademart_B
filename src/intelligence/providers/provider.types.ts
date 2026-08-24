/**
 * Research data providers.
 *
 * Deliberately modelled on src/suppliers/supplier.types.ts rather than on the thinner
 * src/integrations/integration.types.ts, because that module already learned the
 * lesson this one needs: capability must be DECLARED, never inferred from whether a
 * method exists. The comment there records the bug - Tradelle implements
 * getSupplierCost(), that method always returns null, and
 * `typeof provider.getSupplierCost === 'function'` made the UI promise a cost feed
 * that does not exist.
 *
 * The same trap is waiting here in a more dangerous form. A research module whose UI
 * implies it has live demand data, when in truth an operator typed one number in
 * three weeks ago, would produce confident purchasing decisions on nothing. So:
 *
 *   capabilities   what this provider can ACTUALLY supply, stated by the provider
 *   limitations    why a capability is false, in words an operator can act on
 *   methods        may exist and return null; null means "no data", never zero
 *
 * A provider that is unavailable is not an error and not an empty result. It is a
 * stated absence, and the absence propagates all the way to the score, where the
 * factor is excluded rather than zeroed.
 *
 * Pure: types plus pure helpers. No config, no network, no clock read internally.
 */

import type { CandidateSource, ManualResearchEntry, TargetMarket } from '../candidate.types';
import type {
  CompetitionSignal,
  DemandSignal,
  FulfillmentHistorySignal,
  SeasonalitySignal,
  StorePerformanceSignal,
  TrendSignal,
} from '../scoring/scoring.types';

/* ===========================================================================
 * Capabilities
 * ======================================================================== */

/**
 * What a research provider can supply.
 *
 * One flag per signal the scorers consume, so a provider's declaration lines up
 * exactly with what the score is built from and a gap is visible rather than implied.
 */
export interface ResearchCapabilities {
  /** Search volume. Drives the demand factor. */
  demand: boolean;
  /** Direction and speed of change. Drives the trend factor. */
  trend: boolean;
  /** How crowded the market is. */
  competition: boolean;
  /** Where in its season the product is. */
  seasonality: boolean;
  /** The store's own trading history for comparable products. */
  storePerformance: boolean;
  /** Measured delivery outcomes for comparable products. */
  fulfillmentHistory: boolean;
  /** Supplier cost, shipping cost and transit time. */
  supplierCommercials: boolean;
}

/** Every capability off. Providers spread this and enable only what they support. */
export const NO_RESEARCH_CAPABILITIES: Readonly<ResearchCapabilities> = Object.freeze({
  demand: false,
  trend: false,
  competition: false,
  seasonality: false,
  storePerformance: false,
  fulfillmentHistory: false,
  supplierCommercials: false,
});

export type ResearchCapability = keyof ResearchCapabilities;

/** Fixed order, so availability reporting is stable rather than key-order dependent. */
export const RESEARCH_CAPABILITIES: readonly ResearchCapability[] = Object.freeze([
  'demand',
  'trend',
  'competition',
  'seasonality',
  'storePerformance',
  'fulfillmentHistory',
  'supplierCommercials',
]);

/**
 * The capabilities that correspond to a SIGNAL a provider can hand over.
 *
 * `supplierCommercials` is deliberately absent. It is worth REPORTING - an operator
 * should be told plainly that no integration can look up a supplier cost for them - but
 * there is nothing to gather, because the cost is recorded on the candidate itself
 * rather than fetched. Including it in the gather loop would add a permanent entry to
 * `unavailable` that no provider could ever satisfy, which would read as a fault rather
 * than as the design.
 *
 * So the two lists differ on purpose: seven capabilities are described, six are
 * collected.
 */
export const GATHERABLE_CAPABILITIES: readonly ResearchCapability[] = Object.freeze([
  'demand',
  'trend',
  'competition',
  'seasonality',
  'storePerformance',
  'fulfillmentHistory',
]);

/* ===========================================================================
 * Request
 * ======================================================================== */

/**
 * What a provider is allowed to see.
 *
 * Deliberately narrow, for the same reason ProductIdentitySignals is narrow in the
 * supplier module: given the whole candidate, a provider would start depending on
 * incidental fields, and a provider that reads `overallScore` could feed a score back
 * into itself.
 */
export interface ResearchRequest {
  market: TargetMarket;
  /** Search terms the candidate is judged on. */
  keywords: readonly string[];
  title: string;
  category: string | null;
  /**
   * Figures the operator typed in.
   *
   * Passed to every provider rather than only the manual one so a real provider could
   * later reconcile its own reading against the operator's - but only the manual
   * provider reads it today.
   */
  manualResearch: ManualResearchEntry;
  now: Date;
}

/* ===========================================================================
 * Provider
 * ======================================================================== */

/**
 * A source of research signals.
 *
 * Every method is optional and returns null when there is nothing to report. Null is
 * the load-bearing value in this interface: it means "no data", it is what the scorers
 * turn into an EXCLUDED factor, and it must never be replaced by a zero or a
 * plausible-looking default.
 */
export interface ResearchProvider {
  providerName: string;
  /** Which provenance value signals from this provider carry. */
  source: CandidateSource;
  /** The provider's own honest statement of what it supplies. */
  capabilities: ResearchCapabilities;
  /** Why a capability is false, shown in the UI. Keyed by capability name. */
  limitations?: Partial<Record<ResearchCapability, string>>;

  fetchDemand?(request: ResearchRequest): DemandSignal | null;
  fetchTrend?(request: ResearchRequest): TrendSignal | null;
  fetchCompetition?(request: ResearchRequest): CompetitionSignal | null;
  fetchSeasonality?(request: ResearchRequest): SeasonalitySignal | null;
  fetchStorePerformance?(request: ResearchRequest): StorePerformanceSignal | null;
  fetchFulfillmentHistory?(request: ResearchRequest): FulfillmentHistorySignal | null;
}

/* ===========================================================================
 * Availability reporting
 * ======================================================================== */

export interface CapabilityAvailability {
  capability: ResearchCapability;
  /** True when at least one provider declares it. */
  available: boolean;
  /** Providers that declare it, by name. Empty when none do. */
  providers: string[];
  /**
   * Why it is unavailable, in the providers' own words.
   *
   * Several reasons are kept rather than one, because "Tradelle has no API" and
   * "Google Ads is not configured" are different problems with different fixes, and
   * collapsing them would tell the operator to fix the wrong one.
   */
  limitations: string[];
}

/**
 * What the research module can and cannot currently measure.
 *
 * This is the function the UI uses to avoid implying capabilities that do not exist.
 * It exists because the honest answer today is "two of seven", and an interface that
 * did not say so would be lying by omission.
 */
export function describeResearchCapabilities(
  providers: readonly ResearchProvider[],
): CapabilityAvailability[] {
  return RESEARCH_CAPABILITIES.map((capability) => {
    const supporting = providers.filter((provider) => provider.capabilities[capability]);
    const limitations = providers
      .filter((provider) => !provider.capabilities[capability])
      .map((provider) => {
        const stated = provider.limitations?.[capability];
        return stated === undefined
          ? `${provider.providerName} does not supply ${capability}.`
          : `${provider.providerName}: ${stated}`;
      });

    return {
      capability,
      available: supporting.length > 0,
      providers: supporting.map((provider) => provider.providerName),
      // Reported even when the capability IS available elsewhere, so an operator can
      // see that demand comes from a hand-typed figure rather than from Google Ads.
      limitations,
    };
  });
}

/* ===========================================================================
 * Gathering
 * ======================================================================== */

/** One provider's answer for one capability, kept for the audit trail. */
export interface SignalProvenance {
  capability: ResearchCapability;
  providerName: string;
  /** True when the provider returned a signal. False when it declined or had none. */
  supplied: boolean;
  /** Why nothing was supplied. Null when something was. */
  reason: string | null;
}

export interface ResearchSignals {
  demand: DemandSignal | null;
  trend: TrendSignal | null;
  competition: CompetitionSignal | null;
  seasonality: SeasonalitySignal | null;
  storePerformance: StorePerformanceSignal | null;
  fulfillmentHistory: FulfillmentHistorySignal | null;
  /** Which provider answered for what, and who declined. */
  provenance: SignalProvenance[];
  /** Capabilities nothing could supply. Surfaced so the UI can say what is missing. */
  unavailable: ResearchCapability[];
}

/**
 * Collects signals from every provider that declares the capability.
 *
 * FIRST DECLARED PROVIDER WINS, and the order of `providers` is therefore meaningful.
 * Not merged: blending two sources' search volumes would produce a number neither
 * source stands behind and that nobody can reproduce. When a second provider also has
 * data it is recorded in provenance as unused, so the choice is visible.
 *
 * A provider that declares a capability but returns null is recorded as having no
 * data, and the next provider is tried - a declared capability is a statement about
 * the integration, not a guarantee for every product.
 */
export function gatherSignals(
  providers: readonly ResearchProvider[],
  request: ResearchRequest,
): ResearchSignals {
  const provenance: SignalProvenance[] = [];
  const unavailable: ResearchCapability[] = [];

  function collect<T>(
    capability: ResearchCapability,
    call: (provider: ResearchProvider) => T | null | undefined,
  ): T | null {
    let chosen: T | null = null;

    for (const provider of providers) {
      if (!provider.capabilities[capability]) {
        // Not asked. Declaring false means asking is pointless, and calling anyway
        // would let an undeclared method quietly become a data source.
        provenance.push({
          capability,
          providerName: provider.providerName,
          supplied: false,
          reason:
            provider.limitations?.[capability] ??
            `${provider.providerName} does not supply ${capability}.`,
        });
        continue;
      }

      const result = call(provider) ?? null;

      if (result === null) {
        provenance.push({
          capability,
          providerName: provider.providerName,
          supplied: false,
          reason: `${provider.providerName} supports ${capability} but returned no data for this candidate.`,
        });
        continue;
      }

      if (chosen === null) {
        chosen = result;
        provenance.push({
          capability,
          providerName: provider.providerName,
          supplied: true,
          reason: null,
        });
      } else {
        provenance.push({
          capability,
          providerName: provider.providerName,
          supplied: false,
          reason: `${provider.providerName} also has ${capability} data, which was not used - the first provider that answered was preferred rather than the two being blended.`,
        });
      }
    }

    if (chosen === null) unavailable.push(capability);
    return chosen;
  }

  return {
    demand: collect('demand', (provider) => provider.fetchDemand?.(request)),
    trend: collect('trend', (provider) => provider.fetchTrend?.(request)),
    competition: collect('competition', (provider) => provider.fetchCompetition?.(request)),
    seasonality: collect('seasonality', (provider) => provider.fetchSeasonality?.(request)),
    storePerformance: collect('storePerformance', (provider) =>
      provider.fetchStorePerformance?.(request),
    ),
    fulfillmentHistory: collect('fulfillmentHistory', (provider) =>
      provider.fetchFulfillmentHistory?.(request),
    ),
    provenance,
    unavailable,
  };
}
