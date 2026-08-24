/**
 * How much a number can be trusted, and how old it is.
 *
 * WHY THIS IS A SHARED MODULE
 * ---------------------------
 * These types began in src/dropshipping/ because that is where the first honest
 * cost calculation was built. Product research needs exactly the same vocabulary:
 * a manually-typed supplier cost is no more observed in Research than it is in the
 * order view, and a trend figure fetched three weeks ago is no fresher than a
 * supplier cost entered three weeks ago.
 *
 * Two independent definitions of "estimated" would drift, and a system that
 * disagrees with itself about whether a number is trustworthy is worse than one
 * that never tracked trust at all. So there is one definition, here.
 *
 * CONFIDENCE AND FRESHNESS ARE DIFFERENT QUESTIONS
 * ------------------------------------------------
 *   confidence  HOW the value was obtained - observed, derived, or absent
 *   freshness   WHEN it was obtained - and therefore whether it still holds
 *
 * A supplier cost can be KNOWN (a human typed a real number) and STALE (they typed
 * it four months ago). Collapsing those into one score would hide which of the two
 * problems an operator needs to fix.
 *
 * Pure: no config, no clock read internally, no I/O.
 */

/**
 * How a value was obtained.
 *
 *   KNOWN      observed. Shopify told us, or an operator recorded it.
 *   ESTIMATED  derived from a rule or a configured percentage, not observed.
 *   UNKNOWN    genuinely absent. NEVER rendered as 0, and never silently
 *              excluded from a total without saying so.
 *
 * The distinction exists because "supplier cost: 0" and "supplier cost: unknown"
 * lead to opposite decisions, and a dashboard that cannot tell them apart will
 * confidently report a profit on an order whose cost nobody has entered.
 */
export type DataConfidence = 'KNOWN' | 'ESTIMATED' | 'UNKNOWN';

/** A monetary figure that always states how much it can be trusted. */
export interface Figure {
  /** Null if and only if confidence is UNKNOWN. */
  amount: number | null;
  currencyCode: string | null;
  confidence: DataConfidence;
  /** Where the number came from, in plain language. Always populated. */
  source: string;
}

const CONFIDENCE_ORDER: Record<DataConfidence, number> = {
  KNOWN: 0,
  ESTIMATED: 1,
  UNKNOWN: 2,
};

/**
 * The weakest confidence wins: a total is only as trustworthy as its worst input.
 *
 * With no inputs the answer is KNOWN, which is correct rather than lenient - a sum
 * of nothing is exactly zero and nothing about it is uncertain.
 */
export function worstConfidence(...values: DataConfidence[]): DataConfidence {
  let worst: DataConfidence = 'KNOWN';
  for (const value of values) {
    if (CONFIDENCE_ORDER[value] > CONFIDENCE_ORDER[worst]) worst = value;
  }
  return worst;
}

/* ===========================================================================
 * Freshness
 * ======================================================================== */

/**
 * How old a value is, relative to how long its kind stays useful.
 *
 *   FRESH    recent enough to act on
 *   AGING    usable, but worth re-checking before a big decision
 *   STALE    old enough that acting on it is a risk
 *   UNKNOWN  no observation timestamp at all
 *
 * UNKNOWN is deliberately NOT the same as STALE. "We have never recorded when this
 * was measured" and "we measured this four months ago" call for different actions:
 * the first is a plumbing gap, the second is a refresh.
 */
export type Freshness = 'FRESH' | 'AGING' | 'STALE' | 'UNKNOWN';

/**
 * Age thresholds in hours.
 *
 * Per-kind because the useful life of a value varies enormously. A search-trend
 * reading is worthless within days; a hand-entered supplier cost is usually good
 * for weeks. One global threshold would either nag about supplier costs or quietly
 * trust month-old trend data.
 */
export interface FreshnessPolicy {
  freshWithinHours: number;
  agingWithinHours: number;
}

/**
 * Default policies by data kind.
 *
 * These are judgements, not facts, and are the numbers to argue about when an
 * operator says a warning is noisy.
 */
export const FRESHNESS_POLICIES = Object.freeze({
  /** Search interest moves fast; a week-old reading is not evidence of "now". */
  TREND: Object.freeze({ freshWithinHours: 24, agingWithinHours: 24 * 7 }),
  /** Keyword volumes are monthly aggregates and change slowly. */
  KEYWORD_METRICS: Object.freeze({ freshWithinHours: 24 * 7, agingWithinHours: 24 * 30 }),
  /**
   * A hand-entered supplier cost. Generous, because suppliers do not reprice
   * weekly and nagging about a 10-day-old cost trains people to ignore warnings.
   */
  SUPPLIER_COST: Object.freeze({ freshWithinHours: 24 * 14, agingWithinHours: 24 * 45 }),
  /** Store performance is refreshed by webhooks, so anything old is suspicious. */
  STORE_PERFORMANCE: Object.freeze({ freshWithinHours: 24, agingWithinHours: 24 * 7 }),
  /** Fulfillment outcomes accumulate slowly but do not really expire. */
  FULFILLMENT_HISTORY: Object.freeze({ freshWithinHours: 24 * 7, agingWithinHours: 24 * 60 }),
} satisfies Record<string, FreshnessPolicy>);

export type FreshnessKind = keyof typeof FRESHNESS_POLICIES;

const HOUR_MS = 3_600_000;

/**
 * Classifies an observation's age.
 *
 * `now` is a parameter, never read from the clock inside, so freshness logic is
 * testable without waiting and a report can be regenerated "as at" a past time.
 *
 * A timestamp in the FUTURE is treated as FRESH rather than rejected: clock skew
 * between Shopify, a provider and this process is normal, and refusing to trust a
 * value because it is two seconds ahead would be pedantic. It is still reported so
 * a wildly wrong clock is visible.
 */
export function resolveFreshness(
  observedAt: string | Date | null | undefined,
  now: Date,
  policy: FreshnessPolicy,
): { freshness: Freshness; ageHours: number | null; note: string } {
  if (observedAt === null || observedAt === undefined) {
    return {
      freshness: 'UNKNOWN',
      ageHours: null,
      note: 'No observation time was recorded, so this value cannot be aged. That is a gap in how it was captured, not evidence that it is old.',
    };
  }

  const observed = observedAt instanceof Date ? observedAt : new Date(observedAt);
  const time = observed.getTime();
  if (!Number.isFinite(time)) {
    return {
      freshness: 'UNKNOWN',
      ageHours: null,
      note: `The recorded observation time (${String(observedAt)}) is not a valid date.`,
    };
  }

  const ageHours = (now.getTime() - time) / HOUR_MS;

  if (ageHours < 0) {
    return {
      freshness: 'FRESH',
      ageHours: 0,
      note: 'The observation time is in the future, which usually means clock skew between systems. Treated as current.',
    };
  }
  if (ageHours <= policy.freshWithinHours) {
    return { freshness: 'FRESH', ageHours, note: describeAge(ageHours, 'Current.') };
  }
  if (ageHours <= policy.agingWithinHours) {
    return {
      freshness: 'AGING',
      ageHours,
      note: describeAge(ageHours, 'Still usable, but worth re-checking before a significant decision.'),
    };
  }
  return {
    freshness: 'STALE',
    ageHours,
    note: describeAge(ageHours, 'Old enough that acting on it is a risk. Refresh before relying on it.'),
  };
}

function describeAge(ageHours: number, advice: string): string {
  const rounded = Math.floor(ageHours);
  const label =
    rounded < 1
      ? 'Less than an hour old'
      : rounded < 48
        ? `${rounded} hour(s) old`
        : `${Math.floor(rounded / 24)} day(s) old`;
  return `${label}. ${advice}`;
}

/** The weakest freshness wins, for the same reason the weakest confidence does. */
const FRESHNESS_ORDER: Record<Freshness, number> = {
  FRESH: 0,
  AGING: 1,
  STALE: 2,
  UNKNOWN: 3,
};

export function worstFreshness(...values: Freshness[]): Freshness {
  let worst: Freshness = 'FRESH';
  for (const value of values) {
    if (FRESHNESS_ORDER[value] > FRESHNESS_ORDER[worst]) worst = value;
  }
  return worst;
}

/* ===========================================================================
 * Evidence
 * ======================================================================== */

/**
 * One traceable observation behind a score or a figure.
 *
 * Every claim Trademart makes about a product must be reducible to a list of these,
 * because "the model says 87" is not a reason to spend money. The fields are
 * mandatory rather than optional so a provider cannot contribute an unattributable
 * number.
 *
 * observedAt vs fetchedAt is a real distinction: a monthly search volume may have
 * been MEASURED in March and FETCHED by us today. Reporting only the fetch time
 * would make three-month-old data look current.
 */
export interface EvidenceItem {
  /** Machine code, so the UI can group and link. */
  code: string;
  /** What this observation says, in plain language. */
  label: string;
  /** The provider or system that produced it. */
  source: string;
  /** When the underlying fact was true. Null when the source does not say. */
  observedAt: string | null;
  /** When Trademart retrieved it. Null for values entered by hand in-session. */
  fetchedAt: string | null;
  freshness: Freshness;
  /** The value, as displayed. Kept as a string so units travel with it. */
  value: string | null;
  confidence: DataConfidence;
}

/**
 * Builds an evidence item, deriving freshness from the observation time.
 *
 * Prefers observedAt over fetchedAt when both exist, because the age that matters
 * is the age of the FACT, not of our copy of it.
 */
export function makeEvidence(input: {
  code: string;
  label: string;
  source: string;
  observedAt?: string | null;
  fetchedAt?: string | null;
  value?: string | null;
  confidence?: DataConfidence;
  now: Date;
  kind: FreshnessKind;
}): EvidenceItem {
  const observedAt = input.observedAt ?? null;
  const fetchedAt = input.fetchedAt ?? null;
  const { freshness } = resolveFreshness(
    observedAt ?? fetchedAt,
    input.now,
    FRESHNESS_POLICIES[input.kind],
  );

  return {
    code: input.code,
    label: input.label,
    source: input.source,
    observedAt,
    fetchedAt,
    freshness,
    value: input.value ?? null,
    confidence: input.confidence ?? 'KNOWN',
  };
}
