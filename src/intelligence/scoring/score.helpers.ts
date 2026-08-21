/**
 * Shared plumbing for the factor scorers.
 *
 * Exists so eight scorers cannot drift on the mechanics - how a missing signal is
 * reported, how a geography caveat is worded, how a band is chosen. Each scorer then
 * contains only its own judgement, which is the part worth reading.
 */

import { makeEvidence, type DataConfidence, type EvidenceItem, type FreshnessKind } from '../../common/dataQuality';
import type { FactorScore, ScoreFactor } from '../candidate.types';
import {
  confidenceForGeography,
  matchGeography,
  type GeographyMatch,
  type SignalGeography,
} from './scoring.types';
import type { TargetMarket } from '../candidate.types';

/**
 * A factor with no usable data.
 *
 * value is null, NOT zero. Zero would assert the product scores badly on this
 * factor; null says we do not know, which is a different claim and the true one.
 */
export function unscored(
  factor: ScoreFactor,
  reason: string,
  risks: string[] = [],
): FactorScore {
  return {
    factor,
    value: null,
    confidence: 'UNKNOWN',
    reasons: [reason],
    risks,
    evidence: [],
  };
}

/** Clamps to the 0-100 range every factor reports in. */
export function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

/**
 * Maps a measurement onto 0-100 through explicit bands.
 *
 * Bands rather than a formula because a band is explainable: "12,000 searches a month
 * is in the 8,000-25,000 band, which scores 75" is something an operator can check
 * and disagree with. A continuous curve is harder to argue with, and arguing with it
 * is the point.
 *
 * `bands` must be ordered from best to worst; the first whose threshold is met wins.
 */
export function bandScore(
  value: number,
  bands: readonly { atLeast: number; score: number; label: string }[],
  fallback: { score: number; label: string },
): { score: number; label: string } {
  for (const band of bands) {
    if (value >= band.atLeast) return { score: band.score, label: band.label };
  }
  return fallback;
}

/** Same, for measurements where LOWER is better (competition, delay rate). */
export function inverseBandScore(
  value: number,
  bands: readonly { atMost: number; score: number; label: string }[],
  fallback: { score: number; label: string },
): { score: number; label: string } {
  for (const band of bands) {
    if (value <= band.atMost) return { score: band.score, label: band.label };
  }
  return fallback;
}

export interface GeographyVerdict {
  /** False when the signal describes a different country and must be discarded. */
  usable: boolean;
  match: GeographyMatch;
  /** Ceiling on this signal's confidence. */
  confidence: DataConfidence;
  /** A risk to surface, when the signal is broader than the question asked. */
  risk: string | null;
  /** Wording for a reason line, so scorers describe coverage identically. */
  coverageNote: string;
}

/**
 * Decides whether a signal may be used for this market, and how strongly.
 *
 * The MISMATCH case is why this exists: US search volume is not weak evidence about
 * demand in India, it is no evidence at all, and down-weighting it rather than
 * discarding it would let a foreign number influence the score.
 */
export function assessGeography(
  geography: SignalGeography,
  market: TargetMarket,
): GeographyVerdict {
  const match = matchGeography(geography, market);
  const confidence = confidenceForGeography(match);

  switch (match) {
    case 'REGION_EXACT':
      return {
        usable: true,
        match,
        confidence,
        risk: null,
        coverageNote: `measured for ${market.region}, ${market.countryCode}`,
      };
    case 'COUNTRY_EXACT':
      return {
        usable: true,
        match,
        confidence,
        risk: null,
        coverageNote: `measured for ${market.countryCode}`,
      };
    case 'COUNTRY_ONLY':
      return {
        usable: true,
        match,
        confidence,
        risk: `This figure covers ${market.countryCode} as a whole, not ${market.region ?? 'the requested region'}. Regional demand can differ substantially, so treat it as an indication rather than a regional measurement.`,
        coverageNote: `measured for ${market.countryCode} as a whole, not specifically ${market.region ?? 'the region'}`,
      };
    case 'GLOBAL':
      return {
        usable: true,
        match,
        confidence,
        risk: `This figure is global, not specific to ${market.countryCode}. It shows general interest only.`,
        coverageNote: 'measured globally',
      };
    default:
      return {
        usable: false,
        match,
        confidence: 'UNKNOWN',
        risk: `The available figure describes ${geography.countryCode ?? 'another market'}, not ${market.countryCode}. It has been discarded rather than used, because data about a different country is not weak evidence - it is no evidence.`,
        coverageNote: 'not applicable to this market',
      };
  }
}

/** Builds an evidence item from a signal, with consistent provenance handling. */
export function signalEvidence(input: {
  code: string;
  label: string;
  source: string;
  observedAt: string | null;
  fetchedAt: string | null;
  value: string | null;
  confidence: DataConfidence;
  kind: FreshnessKind;
  now: Date;
}): EvidenceItem {
  return makeEvidence({
    code: input.code,
    label: input.label,
    source: input.source,
    observedAt: input.observedAt,
    fetchedAt: input.fetchedAt,
    value: input.value,
    confidence: input.confidence,
    kind: input.kind,
    now: input.now,
  });
}
