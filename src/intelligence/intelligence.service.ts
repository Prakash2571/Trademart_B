/**
 * Research candidates: persistence and analysis.
 *
 * The IMPURE half of the intelligence module - config, Mongo and Shopify. Every piece of
 * judgement lives in a pure module this one calls:
 *
 *   candidate.analysis.ts   wires pricing into scoring
 *   scoring/                the eight factors and the two scores
 *   pricing/recommendation  the three price scenarios
 *   providers/              where signals come from, and what is unavailable
 *
 * Split that way because src/config/index.ts calls process.exit(1) at import time, so
 * anything importing it cannot be unit tested. The pure surface is re-exported here so
 * callers still have one import.
 *
 * A SYSTEM OF RECORD, UNUSUALLY
 * -----------------------------
 * Everywhere else Trademart derives from Shopify and stores nothing. A candidate does
 * not exist in Shopify yet, so this collection genuinely owns its data - which is why
 * writes require a database rather than degrading, and why the score is persisted with
 * its evidence instead of being recomputed on read.
 */

import { randomUUID } from 'node:crypto';

import { AppError } from '../common/errors';
import { logger } from '../common/logger';
import { config } from '../config';
import { getDatabaseStatus } from '../database/mongo';
import {
  ProductCandidateModel,
  type ProductCandidateDocument,
} from '../database/models/ProductCandidate';
import { pricingPolicyFrom } from '../dropshipping/dropshipping.pricing';
import { resolveSettings } from '../dropshipping/dropshipping.service';
import type { PricingPolicy, PricingScenarioName } from '../pricing/recommendation';
import { listOrders, listProducts } from '../shopify/shopify.service';
import type { OrderDto, ProductDto } from '../shopify/shopify.types';
import { analyseCandidate, researchRequestFor } from './candidate.analysis';
import {
  EMPTY_MANUAL_RESEARCH,
  SUPPORTED_HORIZONS,
  type CandidateSource,
  type CandidateStatus,
  type ManualResearchEntry,
  type ProductCandidate,
  type TargetMarket,
} from './candidate.types';
import { gatherSignals } from './providers/provider.types';
import { describeResearchSupport, researchProvidersFor } from './providers/registry';
import {
  createShopifyPerformanceProvider,
  summariseStoreHistory,
  type StoreHistorySummary,
} from './providers/shopifyPerformance.provider';

// Re-exported so callers have one import for the research surface while the logic stays
// in modules that do not drag in the config singleton.
export { analyseCandidate, economicsForScoring } from './candidate.analysis';
export type { CandidateAnalysis } from './candidate.analysis';
export { describeResearchSupport } from './providers/registry';

/**
 * How many orders and products are read to build the store's history.
 *
 * 250 is Shopify's hard page limit. One page rather than exhaustive paging because this
 * runs while an operator waits, and the honest response to "there was more" is to say
 * the sample is a lower bound - which summariseStoreHistory does - rather than to spend
 * a minute paging a large store.
 */
const HISTORY_PAGE_SIZE = 250;

function requireDatabase(): void {
  if (getDatabaseStatus().status !== 'connected') {
    throw new AppError(
      'DATABASE_UNAVAILABLE',
      'Research candidates are stored in MongoDB, which is not connected. Set MONGODB_URI and retry - unlike the Shopify views, research data has nowhere else to live.',
    );
  }
}

function shopDomain(): string {
  return config.shopify.storeDomain;
}

/* ===========================================================================
 * Mapping
 * ======================================================================== */

/**
 * Lean rows type optional fields as `T | null | undefined`, so comparisons use loose
 * `== null` and absent values collapse to null. Documented in manualCost.service.ts;
 * repeated here because getting it wrong turns a missing field into `undefined` in an
 * API response, which serialises as an absent key rather than an explicit null.
 */
function orNull<T>(value: T | null | undefined): T | null {
  return value == null ? null : value;
}

function toManualResearch(row: ProductCandidateDocument['manualResearch']): ManualResearchEntry {
  if (row == null) return { ...EMPTY_MANUAL_RESEARCH };
  return {
    averageMonthlySearches: orNull(row.averageMonthlySearches),
    momentumPercentage: orNull(row.momentumPercentage),
    competitionIndex: orNull(row.competitionIndex),
    competitorCount: orNull(row.competitorCount),
    seasonState: (orNull(row.seasonState) ?? 'UNKNOWN') as ManualResearchEntry['seasonState'],
    peakMonths: row.peakMonths == null || row.peakMonths.length === 0 ? null : [...row.peakMonths],
    geography: {
      countryCode: orNull(row.geographyCountryCode),
      region: orNull(row.geographyRegion),
    },
    observedAt: orNull(row.observedAt),
    sourceNote: orNull(row.sourceNote),
  };
}

/** Maps a stored row to the API shape. Dates always leave as ISO strings. */
function toCandidate(row: ProductCandidateDocument): ProductCandidate {
  const commercials = row.commercials ?? {};

  return {
    id: row.candidateId,
    source: row.source as CandidateSource,
    sourceProductId: orNull(row.sourceProductId),
    sourceUrl: orNull(row.sourceUrl),

    title: row.title,
    category: orNull(row.category),
    imageUrl: orNull(row.imageUrl),
    keywords: [...(row.keywords ?? [])],

    market: {
      countryCode: row.marketCountryCode,
      region: orNull(row.marketRegion),
      horizonDays: row.marketHorizonDays,
    },
    commercials: {
      supplierCost: orNull(commercials.supplierCost),
      supplierCurrency: orNull(commercials.supplierCurrency),
      shippingCost: orNull(commercials.shippingCost),
      shippingCurrency: orNull(commercials.shippingCurrency),
      shippingDays: orNull(commercials.shippingDays),
      expectedSellingPrice: orNull(commercials.expectedSellingPrice),
      expectedSellingCurrency: orNull(commercials.expectedSellingCurrency),
      costObservedAt: orNull(commercials.costObservedAt),
    },
    manualResearch: toManualResearch(row.manualResearch),

    // Cast rather than re-validated: the schema's enums already constrain these, and
    // re-deriving them here would be a second source of truth for the same union.
    factors: (row.factors ?? []) as unknown as ProductCandidate['factors'],
    overallScore: orNull(row.overallScore),
    confidenceScore: orNull(row.confidenceScore),
    recommendation: orNull(row.recommendation) as ProductCandidate['recommendation'],
    seasonState: (orNull(row.seasonState) ?? 'UNKNOWN') as ProductCandidate['seasonState'],

    reasons: [...(row.reasons ?? [])],
    risks: [...(row.risks ?? [])],
    evidence: (row.evidence ?? []) as unknown as ProductCandidate['evidence'],
    freshness: (orNull(row.freshness) ?? 'UNKNOWN') as ProductCandidate['freshness'],

    status: row.status as CandidateStatus,
    pushedShopifyProductId: orNull(row.pushedShopifyProductId),
    watchUntil: orNull(row.watchUntil),

    scoreHistory: (row.scoreHistory ?? []) as unknown as ProductCandidate['scoreHistory'],

    notes: orNull(row.notes),
    createdAt: toIso(row.createdAt),
    analyzedAt: orNull(row.analyzedAt),
    updatedAt: toIso(row.updatedAt),
  };
}

function toIso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(0).toISOString();
}

/* ===========================================================================
 * Validation
 * ======================================================================== */

export interface CreateCandidateInput {
  title: string;
  source?: CandidateSource;
  sourceProductId?: string | null;
  sourceUrl?: string | null;
  category?: string | null;
  imageUrl?: string | null;
  keywords?: string[];
  market?: Partial<TargetMarket>;
  commercials?: Partial<ProductCandidate['commercials']>;
  manualResearch?: Partial<ManualResearchEntry>;
  notes?: string | null;
}

/**
 * Validates a candidate, reporting every problem at once.
 *
 * Matches how automation rules and pricing policies are validated: a form should show
 * all of its errors, not the first one and then another after each retry.
 */
export function validateCandidateInput(input: CreateCandidateInput): string[] {
  const problems: string[] = [];

  if (typeof input.title !== 'string' || input.title.trim() === '') {
    problems.push('A title is required - it is how the candidate is identified.');
  }

  const horizon = input.market?.horizonDays;
  if (horizon !== undefined && !SUPPORTED_HORIZONS.includes(horizon)) {
    problems.push(
      `Horizon must be one of ${SUPPORTED_HORIZONS.join(', ')} days. Other windows are not supported because the trend bands are calibrated for these.`,
    );
  }

  const country = input.market?.countryCode;
  if (country !== undefined && (typeof country !== 'string' || country.trim().length !== 2)) {
    problems.push(
      'Target market country must be a two-letter ISO country code. Region isolation depends on it being exact.',
    );
  }

  for (const [field, value] of [
    ['supplierCost', input.commercials?.supplierCost],
    ['shippingCost', input.commercials?.shippingCost],
    ['expectedSellingPrice', input.commercials?.expectedSellingPrice],
  ] as const) {
    if (value === undefined || value === null) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      problems.push(`${field} must be a number of at least 0, or omitted when unknown.`);
    }
  }

  const months = input.manualResearch?.peakMonths;
  if (months != null && months.some((month) => month < 1 || month > 12)) {
    problems.push('Peak months must be between 1 and 12.');
  }

  return problems;
}

/* ===========================================================================
 * Writes
 * ======================================================================== */

/** Creates a candidate. Never analyses it - that is a separate, explicit action. */
export async function createCandidate(
  input: CreateCandidateInput,
): Promise<ProductCandidate> {
  requireDatabase();

  const problems = validateCandidateInput(input);
  if (problems.length > 0) {
    throw new AppError('VALIDATION_ERROR', 'This candidate cannot be saved.', {
      details: { problems },
    });
  }

  const candidateId = randomUUID();
  const manual = { ...EMPTY_MANUAL_RESEARCH, ...(input.manualResearch ?? {}) };

  await ProductCandidateModel.updateOne(
    { shopDomain: shopDomain(), candidateId },
    {
      $set: {
        shopDomain: shopDomain(),
        candidateId,
        source: input.source ?? 'MANUAL',
        sourceProductId: input.sourceProductId ?? null,
        sourceUrl: input.sourceUrl ?? null,
        title: input.title.trim(),
        category: input.category ?? null,
        imageUrl: input.imageUrl ?? null,
        keywords: input.keywords ?? [],
        marketCountryCode: (input.market?.countryCode ?? 'GB').trim().toUpperCase(),
        marketRegion: input.market?.region ?? null,
        marketHorizonDays: input.market?.horizonDays ?? 30,
        commercials: input.commercials ?? {},
        manualResearch: flattenManualResearch(manual),
        status: 'NEW',
        notes: input.notes ?? null,
      },
    },
    { upsert: true },
  );

  // Re-read through the same path every other caller uses, so the returned shape comes
  // from one place rather than being assembled twice.
  return getCandidate(candidateId);
}

/** The schema stores geography flattened, because Mongoose sub-documents of two
 * nullable strings are more trouble than they are worth. */
function flattenManualResearch(entry: ManualResearchEntry): Record<string, unknown> {
  return {
    averageMonthlySearches: entry.averageMonthlySearches,
    momentumPercentage: entry.momentumPercentage,
    competitionIndex: entry.competitionIndex,
    competitorCount: entry.competitorCount,
    seasonState: entry.seasonState,
    peakMonths: entry.peakMonths,
    geographyCountryCode: entry.geography.countryCode,
    geographyRegion: entry.geography.region,
    observedAt: entry.observedAt,
    sourceNote: entry.sourceNote,
  };
}

export interface UpdateCandidateInput {
  title?: string;
  category?: string | null;
  imageUrl?: string | null;
  sourceUrl?: string | null;
  keywords?: string[];
  market?: Partial<TargetMarket>;
  commercials?: Partial<ProductCandidate['commercials']>;
  manualResearch?: Partial<ManualResearchEntry>;
  notes?: string | null;
}

/**
 * Updates a candidate's inputs.
 *
 * Does NOT re-analyse. Changing a cost invalidates the stored score, but recomputing it
 * silently would mean an operator's saved figures and the score they are looking at
 * could diverge without anyone asking for a new analysis. The controller reports that
 * the score is stale instead.
 */
export async function updateCandidate(
  candidateId: string,
  patch: UpdateCandidateInput,
): Promise<ProductCandidate> {
  requireDatabase();
  const existing = await getCandidate(candidateId);

  const problems = validateCandidateInput({
    title: patch.title ?? existing.title,
    market: { ...existing.market, ...(patch.market ?? {}) },
    commercials: { ...existing.commercials, ...(patch.commercials ?? {}) },
    manualResearch: { ...existing.manualResearch, ...(patch.manualResearch ?? {}) },
  });
  if (problems.length > 0) {
    throw new AppError('VALIDATION_ERROR', 'This candidate cannot be saved.', {
      details: { problems },
    });
  }

  const merged = { ...existing.manualResearch, ...(patch.manualResearch ?? {}) };
  const $set: Record<string, unknown> = {
    commercials: { ...existing.commercials, ...(patch.commercials ?? {}) },
    manualResearch: flattenManualResearch(merged),
  };

  if (patch.title !== undefined) $set.title = patch.title.trim();
  if (patch.category !== undefined) $set.category = patch.category;
  if (patch.imageUrl !== undefined) $set.imageUrl = patch.imageUrl;
  if (patch.sourceUrl !== undefined) $set.sourceUrl = patch.sourceUrl;
  if (patch.keywords !== undefined) $set.keywords = patch.keywords;
  if (patch.notes !== undefined) $set.notes = patch.notes;
  if (patch.market?.countryCode !== undefined) {
    $set.marketCountryCode = patch.market.countryCode.trim().toUpperCase();
  }
  if (patch.market?.region !== undefined) $set.marketRegion = patch.market.region;
  if (patch.market?.horizonDays !== undefined) {
    $set.marketHorizonDays = patch.market.horizonDays;
  }

  await ProductCandidateModel.updateOne(
    { shopDomain: shopDomain(), candidateId },
    { $set },
  );

  return getCandidate(candidateId);
}

/* ===========================================================================
 * Reads
 * ======================================================================== */

export interface ListCandidatesParams {
  status?: CandidateStatus;
  /** Highest scoring first by default, because that is what a shortlist is for. */
  sort?: 'score' | 'recent';
  limit?: number;
}

export async function listCandidates(
  params: ListCandidatesParams = {},
): Promise<ProductCandidate[]> {
  // A read, so it degrades rather than throwing: an empty research list on a
  // Shopify-only deployment is more useful than a 503 on the dashboard.
  if (getDatabaseStatus().status !== 'connected') return [];

  const filter: Record<string, unknown> = { shopDomain: shopDomain() };
  if (params.status !== undefined) filter.status = params.status;

  try {
    const rows = await ProductCandidateModel.find(filter)
      .sort(params.sort === 'recent' ? { updatedAt: -1 } : { overallScore: -1, updatedAt: -1 })
      .limit(Math.min(Math.max(params.limit ?? 50, 1), 200))
      .lean();

    // Explicitly typed because lean() widens to a shape TypeScript cannot narrow, and
    // an implicit any here would silently accept a schema change.
    return rows.map((row: unknown) => toCandidate(row as ProductCandidateDocument));
  } catch (error) {
    logger.warn('Could not list research candidates.', {
      reason: error instanceof Error ? error.message : 'unknown',
    });
    return [];
  }
}

export async function getCandidate(candidateId: string): Promise<ProductCandidate> {
  requireDatabase();

  const row = await ProductCandidateModel.findOne({
    shopDomain: shopDomain(),
    candidateId,
  }).lean();

  if (row === null) {
    throw new AppError('NOT_FOUND', `No research candidate with id ${candidateId}.`);
  }
  return toCandidate(row as unknown as ProductCandidateDocument);
}

/* ===========================================================================
 * Store history
 * ======================================================================== */

/**
 * Reads the store's own history from Shopify.
 *
 * Degrades to null on any failure. A Shopify outage must not stop a candidate being
 * scored on the factors that do not need Shopify - the analysis reports store fit as
 * unscored and warns that it says nothing about this store, which is honest, whereas
 * failing the whole request would lose the demand and profitability judgement too.
 */
async function loadStoreHistory(
  category: string | null,
  market: TargetMarket,
  now: Date,
): Promise<StoreHistorySummary | null> {
  if (category === null || category.trim() === '') return null;

  let orders: OrderDto[];
  let products: ProductDto[];
  let truncated: boolean;

  try {
    const [orderPage, productPage] = await Promise.all([
      listOrders({ first: HISTORY_PAGE_SIZE }),
      listProducts({ first: HISTORY_PAGE_SIZE }),
    ]);
    orders = orderPage.items;
    products = productPage.items;
    truncated = orderPage.meta.hasNextPage || productPage.meta.hasNextPage;
  } catch (error) {
    logger.warn('Could not read store history for research analysis.', {
      reason: error instanceof Error ? error.message : 'unknown',
    });
    return null;
  }

  return summariseStoreHistory({
    orders,
    products,
    category,
    market,
    truncated,
    sla: resolveSettings().sla,
    now,
  });
}

/* ===========================================================================
 * Analysis
 * ======================================================================== */

export interface AnalyzeOptions {
  policyOverride?: Partial<PricingPolicy> | null;
  pricingScenario?: PricingScenarioName;
  now?: Date;
}

export interface AnalyzeResult {
  candidate: ProductCandidate;
  /** The three price scenarios, so the UI need not ask again. */
  pricing: ReturnType<typeof analyseCandidate>['pricing'];
  /** Which provider answered for what, and who declined. */
  provenance: ReturnType<typeof gatherSignals>['provenance'];
  /** What could not be measured at all. */
  unavailable: ReturnType<typeof gatherSignals>['unavailable'];
  warnings: string[];
  /** Honest statement of what the module can and cannot measure. */
  capabilities: ReturnType<typeof describeResearchSupport>;
}

/**
 * Scores a candidate and persists the result.
 *
 * Appends to scoreHistory rather than replacing it, so a candidate that scored 82 in
 * March and 54 today shows both - which is the signal that the market moved, and is
 * invisible if each analysis overwrites the last.
 */
export async function analyzeCandidate(
  candidateId: string,
  options: AnalyzeOptions = {},
): Promise<AnalyzeResult> {
  requireDatabase();

  const now = options.now ?? new Date();
  const candidate = await getCandidate(candidateId);

  const history = await loadStoreHistory(candidate.category, candidate.market, now);
  const providers = researchProvidersFor(
    history === null ? null : createShopifyPerformanceProvider(history),
  );

  const request = researchRequestFor(candidate, candidate.manualResearch, now);
  const signals = gatherSignals(providers, request);

  const analysis = analyseCandidate({
    candidate,
    signals,
    // Store settings drive the price, so Research and the dashboard cannot disagree
    // about what a thin margin is.
    policy: pricingPolicyFrom(resolveSettings().cost),
    policyOverride: options.policyOverride ?? null,
    ...(options.pricingScenario === undefined
      ? {}
      : { pricingScenario: options.pricingScenario }),
    now,
  });

  const { score } = analysis;

  // Only a real score joins the history. A null overall score is "not enough data", and
  // writing it as a history point would draw a line through the middle of the chart.
  const historyEntry =
    score.overallScore === null || score.recommendation === null
      ? null
      : {
          at: now.toISOString(),
          overallScore: score.overallScore,
          confidenceScore: score.confidenceScore,
          recommendation: score.recommendation,
          note: score.recommendationDowngraded
            ? 'Held below its score because data confidence was low.'
            : null,
        };

  await ProductCandidateModel.updateOne(
    { shopDomain: shopDomain(), candidateId },
    {
      $set: {
        factors: score.factors,
        overallScore: score.overallScore,
        confidenceScore: score.confidenceScore,
        recommendation: score.recommendation,
        seasonState: score.seasonState,
        reasons: score.reasons,
        risks: score.risks,
        evidence: score.evidence,
        freshness: score.freshness,
        analyzedAt: now.toISOString(),
        // NEW -> ANALYZED. A deliberate operator decision (WATCHING, SELECTED,
        // REJECTED) is never overwritten by re-running an analysis.
        ...(candidate.status === 'NEW' ? { status: 'ANALYZED' } : {}),
      },
      ...(historyEntry === null ? {} : { $push: { scoreHistory: historyEntry } }),
    },
  );

  return {
    candidate: await getCandidate(candidateId),
    pricing: analysis.pricing,
    provenance: signals.provenance,
    unavailable: signals.unavailable,
    warnings: [...analysis.warnings, ...(history?.notes ?? [])],
    capabilities: describeResearchSupport(
      history === null ? null : createShopifyPerformanceProvider(history),
    ),
  };
}

/* ===========================================================================
 * Status transitions
 * ======================================================================== */

/**
 * Records an operator's decision about a candidate.
 *
 * PUSHED_TO_SHOPIFY is deliberately NOT settable here: that status means a draft
 * actually exists in Shopify, and letting it be set directly would allow a candidate to
 * claim a product that was never created.
 */
export async function setCandidateStatus(
  candidateId: string,
  status: Exclude<CandidateStatus, 'PUSHED_TO_SHOPIFY'>,
  options: { watchUntil?: string | null; note?: string | null } = {},
): Promise<ProductCandidate> {
  requireDatabase();
  await getCandidate(candidateId);

  const $set: Record<string, unknown> = { status };
  if (options.watchUntil !== undefined) $set.watchUntil = options.watchUntil;
  if (options.note !== undefined) $set.notes = options.note;
  // Leaving a stale watch date on a candidate no longer being watched would make a
  // watchlist query return things nobody is watching.
  if (status !== 'WATCHING' && options.watchUntil === undefined) $set.watchUntil = null;

  await ProductCandidateModel.updateOne(
    { shopDomain: shopDomain(), candidateId },
    { $set },
  );

  return getCandidate(candidateId);
}
