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
import { evaluatePriceAgainstPolicy } from '../pricing/recommendation';
import type { PricingResult } from '../pricing/pricing.service';
import type { ShippingSla } from '../dropshipping/dropshipping.types';
import { loadSettings } from '../dropshipping/dropshipping.service';
import type { PricingPolicy, PricingScenarioName } from '../pricing/recommendation';
import { listOrders, listProducts } from '../shopify/shopify.service';
import type { OrderDto, ProductDto } from '../shopify/shopify.types';
import {
  analyseCandidate,
  applyAnalysisToCandidate,
  researchRequestFor,
  type CandidateAnalysis,
} from './candidate.analysis';
import {
  EMPTY_MANUAL_RESEARCH,
  type CandidateSource,
  type CandidateStatus,
  type ManualResearchEntry,
  type ProductCandidate,
  type TargetMarket,
} from './candidate.types';
import { changedScoreInputs, scoreIsStale } from './candidate.revision';
import { allowedActions, canTransition, isTerminal } from './candidate.transitions';
import { computeDecisionHash } from './decision.hash';
import {
  validateCandidateInput as validateCandidateInputRules,
  type CreateCandidateInput as CreateCandidateInputShape,
} from './candidate.validation';
import { gatherSignals, type ResearchSignals } from './providers/provider.types';
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
    // Defaults matter for rows written before these fields existed. IDLE is the safe
    // reading: it lets a claim be taken, and the Shopify tag lookup inside the push is
    // what prevents a duplicate if one somehow already exists.
    pushState: (orNull(row.pushState) ?? 'IDLE') as ProductCandidate['pushState'],
    pushOperationId: orNull(row.pushOperationId),
    pushClaimedAt: orNull(row.pushClaimedAt),
    pushSafetyReason: orNull(row.pushSafetyReason),
    pushedShopifyProductId: orNull(row.pushedShopifyProductId),
    watchUntil: orNull(row.watchUntil),

    scoreHistory: (row.scoreHistory ?? []) as unknown as ProductCandidate['scoreHistory'],

    notes: orNull(row.notes),
    createdAt: toIso(row.createdAt),
    analyzedAt: orNull(row.analyzedAt),
    updatedAt: toIso(row.updatedAt),

    // Defaults matter for rows written before these fields existed: revision 1 with a
    // null analyzed revision reads as "analysed, but we cannot prove from what", which
    // scoreIsStale treats as stale rather than as fine.
    inputRevision: row.inputRevision ?? 1,
    analyzedInputRevision: orNull(row.analyzedInputRevision),
  };
}

function toIso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(0).toISOString();
}

/* ===========================================================================
 * Validation
 * ======================================================================== */

// Validation moved to candidate.validation.ts so the rules can be unit tested: this
// module imports the config singleton, which calls process.exit(1) at import time.
// Re-exported so every existing caller is unaffected.
export { validateCandidateInput } from './candidate.validation';
export type { CreateCandidateInput } from './candidate.validation';

/* ===========================================================================
 * Writes
 * ======================================================================== */

/** Creates a candidate. Never analyses it - that is a separate, explicit action. */
export async function createCandidate(
  input: CreateCandidateInputShape,
): Promise<ProductCandidate> {
  requireDatabase();

  const problems = validateCandidateInputRules(input);
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
        // No default. validateCandidateInput has already refused a missing/blank country,
        // so the non-null assertion here is safe - and there is deliberately no `?? 'GB'`
        // to fall back to, because Trademart must never invent a market.
        marketCountryCode: input.market!.countryCode!.trim().toUpperCase(),
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

  const problems = validateCandidateInputRules({
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

  /*
   * The revision moves only when a SCORING INPUT actually moved.
   *
   * Compared by VALUE against what is already stored, not by which keys the patch
   * mentioned: a form submit normally resends the whole commercials object, and bumping
   * on mere presence would mark the score stale every time somebody edited a note.
   *
   * The comparison runs against a projection of the candidate AFTER the patch, built
   * from the same $set that is about to be written, so the two cannot disagree.
   */
  const after: ProductCandidate = {
    ...existing,
    title: patch.title === undefined ? existing.title : patch.title.trim(),
    category: patch.category === undefined ? existing.category : patch.category,
    keywords: patch.keywords === undefined ? existing.keywords : patch.keywords,
    market: { ...existing.market, ...(patch.market ?? {}) },
    commercials: { ...existing.commercials, ...(patch.commercials ?? {}) },
    manualResearch: merged,
  };

  const changed = changedScoreInputs(existing, after);
  if (changed.length > 0) {
    // $inc rather than a computed value: two concurrent edits both bump it, so neither
    // can silently reuse the other's revision and leave a stale score looking current.
    await ProductCandidateModel.updateOne(
      { shopDomain: shopDomain(), candidateId },
      { $set, $inc: { inputRevision: 1 } },
    );
    logger.info('Research candidate scoring inputs changed.', { candidateId, changed });
  } else {
    await ProductCandidateModel.updateOne(
      { shopDomain: shopDomain(), candidateId },
      { $set },
    );
  }

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
  sla: ShippingSla,
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
    // The operator's STORED SLA, passed in rather than read from config here.
    //
    // resolveSettings() is config-only, so measuring "late" for research used thresholds
    // the settings screen could not change while the dropshipping order view used ones it
    // could. Two definitions of late in one product is worse than either definition.
    sla,
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

/**
 * A complete analysis that has NOT been written anywhere.
 *
 * The split exists because Push must know the current decision BEFORE it touches
 * Shopify, and must not have persisted anything if it then refuses. Persisting first and
 * rolling back on refusal would leave the score history full of analyses nobody asked
 * for; refusing first and persisting nothing leaves the candidate exactly as the operator
 * last saw it.
 */
export interface PreparedAnalysis {
  /** The row as loaded, BEFORE the fresh score is applied. */
  storedCandidate: ProductCandidate;
  /**
   * The candidate as it stands after this analysis.
   *
   * This is what every downstream consumer must use. See applyAnalysisToCandidate: the
   * old push path built its Shopify draft from the PRE-analysis object, so a fresh
   * GOOD_CANDIDATE / 82 could be listed with a description and tag reading WATCH / 61.
   */
  freshCandidate: ProductCandidate;
  analysis: CandidateAnalysis;
  signals: ResearchSignals;
  history: StoreHistorySummary | null;
  /** The policy actually applied, after store settings and any override. */
  policy: PricingPolicy;
  /** Binds this exact decision. See decision.hash.ts. */
  decisionHash: string;
  /**
   * Prices an arbitrary amount against the same cost model, so a hand-typed price faces
   * the same commercial floors as a scenario price. Null when nothing could be priced.
   */
  evaluatePrice: (amount: number) => PricingResult | null;
  now: Date;
}

export interface AnalyzeResult {
  candidate: ProductCandidate;
  /** The three price scenarios, so the UI need not ask again. */
  pricing: CandidateAnalysis['pricing'];
  /** Which provider answered for what, and who declined. */
  provenance: ResearchSignals['provenance'];
  /** What could not be measured at all. */
  unavailable: ResearchSignals['unavailable'];
  warnings: string[];
  /** Honest statement of what the module can and cannot measure. */
  capabilities: ReturnType<typeof describeResearchSupport>;
  /**
   * The hash the client must send back with a Push.
   *
   * Holding it is how an operator proves they are approving the decision they were
   * shown rather than whatever the numbers happen to be by the time they click.
   */
  decisionHash: string;
  /** Whether the stored score matches the candidate's current inputs. */
  scoreIsStale: boolean;
}

/**
 * Computes a candidate's current analysis WITHOUT persisting it.
 *
 * Everything expensive and everything external happens here - the Shopify history read,
 * the provider gather, the pricing, the scoring - and nothing is written. Both the
 * explicit Analyse action and Push call this; Analyse then persists, Push then compares
 * the hash and only proceeds to Shopify if it matches.
 */
export async function prepareCandidateAnalysis(
  candidateId: string,
  options: AnalyzeOptions = {},
): Promise<PreparedAnalysis> {
  requireDatabase();

  const now = options.now ?? new Date();
  const storedCandidate = await getCandidate(candidateId);

  // Settings first: the SLA feeds the fulfillment measurement inside the store-history
  // read, and the cost config feeds the pricing policy. One read, used for both.
  const settings = await loadSettings();

  const history = await loadStoreHistory(
    storedCandidate.category,
    storedCandidate.market,
    settings.sla,
    now,
  );
  const providers = researchProvidersFor(
    history === null ? null : createShopifyPerformanceProvider(history),
  );

  const request = researchRequestFor(
    storedCandidate,
    storedCandidate.manualResearch,
    now,
  );
  const signals = gatherSignals(providers, request);

  // Store settings drive the price, so Research and the dashboard cannot disagree about
  // what a thin margin is. Echoed on the result, because the policy is part of the
  // decision hash and a caller has to be able to see what was applied.
  const policy = pricingPolicyFrom(settings.cost, options.policyOverride ?? null);

  const analysis = analyseCandidate({
    candidate: storedCandidate,
    signals,
    policy,
    ...(options.pricingScenario === undefined
      ? {}
      : { pricingScenario: options.pricingScenario }),
    now,
  });

  const freshCandidate = applyAnalysisToCandidate(storedCandidate, analysis, now);

  return {
    storedCandidate,
    freshCandidate,
    analysis,
    signals,
    history,
    policy,
    /*
     * Prices an arbitrary amount against the same cost model the scenarios used.
     *
     * Exists so an operator's hand-typed price faces the SAME commercial floors as a
     * scenario price. Previously a custom price bypassed the guards completely, which made
     * them advisory for exactly the case most likely to breach them.
     *
     * Null when the analysis could not be priced at all, so a caller cannot mistake
     * "no cost model" for "no breaches".
     */
    evaluatePrice: (amount: number) =>
      evaluateCandidatePrice(storedCandidate.commercials, policy, amount),
    decisionHash: computeDecisionHash({
      candidate: freshCandidate,
      score: analysis.score,
      pricing: analysis.pricing,
      policy,
    }),
    now,
  };
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
  const prepared = await prepareCandidateAnalysis(candidateId, options);
  return persistAnalysis(prepared);
}

/**
 * Writes a prepared analysis.
 *
 * Separate from prepareCandidateAnalysis so Push can prepare without writing. Kept
 * internal-but-exported because the orchestration tests drive it directly.
 */
export async function persistAnalysis(prepared: PreparedAnalysis): Promise<AnalyzeResult> {
  const { storedCandidate, freshCandidate, analysis, signals, history, now } = prepared;
  const { score } = analysis;

  /*
   * A closed candidate's stored numbers must not move.
   *
   * Analysis is read-only with respect to the operator's decision, but it is emphatically
   * not read-only with respect to the row: it writes score, recommendation, factors and
   * analyzedAt. Re-scoring a REJECTED candidate would leave a rejection sitting next to
   * figures nobody saw when they rejected it, and re-scoring a PUSHED one would move the
   * numbers away from the draft that was created from them.
   *
   * Enforced here, at the write, rather than only in allowedActions - a disabled button is
   * a courtesy, not a control. A push is unaffected: it prepares and persists while the
   * candidate is still pushable, and only then moves the status to PUSHED_TO_SHOPIFY.
   */
  if (isTerminal(storedCandidate.status)) {
    throw new AppError(
      storedCandidate.status === 'PUSHED_TO_SHOPIFY'
        ? 'RESEARCH_ALREADY_PUSHED'
        : 'VALIDATION_ERROR',
      allowedActions(storedCandidate).analyze.reason ??
        `A candidate with status ${storedCandidate.status} cannot be re-analysed.`,
      { details: { candidateId: storedCandidate.id, status: storedCandidate.status } },
    );
  }

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
    { shopDomain: shopDomain(), candidateId: storedCandidate.id },
    {
      $set: {
        factors: freshCandidate.factors,
        overallScore: freshCandidate.overallScore,
        confidenceScore: freshCandidate.confidenceScore,
        recommendation: freshCandidate.recommendation,
        seasonState: freshCandidate.seasonState,
        reasons: freshCandidate.reasons,
        risks: freshCandidate.risks,
        evidence: freshCandidate.evidence,
        freshness: freshCandidate.freshness,
        analyzedAt: freshCandidate.analyzedAt,
        /*
         * Records WHICH revision of the inputs this score was computed from.
         *
         * Taken from the candidate that was actually scored, so if an operator edits an
         * input while the analysis is running, the stored revision is the one scored and
         * the score correctly reports itself stale afterwards. Writing the CURRENT
         * revision would claim the score covers an edit it never saw.
         */
        analyzedInputRevision: freshCandidate.analyzedInputRevision,
        // NEW -> ANALYZED. A deliberate operator decision (WATCHING, SELECTED,
        // REJECTED, PUSHED_TO_SHOPIFY) is never overwritten by re-running an analysis.
        ...(storedCandidate.status === 'NEW' ? { status: 'ANALYZED' } : {}),
      },
      ...(historyEntry === null ? {} : { $push: { scoreHistory: historyEntry } }),
    },
  );

  const persisted = await getCandidate(storedCandidate.id);

  return {
    candidate: persisted,
    pricing: analysis.pricing,
    provenance: signals.provenance,
    unavailable: signals.unavailable,
    warnings: [...analysis.warnings, ...(history?.notes ?? [])],
    capabilities: describeResearchSupport(
      history === null ? null : createShopifyPerformanceProvider(history),
    ),
    decisionHash: prepared.decisionHash,
    scoreIsStale: scoreIsStale(persisted),
  };
}

/**
 * Prices one amount against a candidate's costs and the effective policy.
 *
 * A thin adapter over the pricing engine so the orchestration can guard a hand-typed
 * price with the same rules a scenario price gets.
 */
function evaluateCandidatePrice(
  commercials: ProductCandidate['commercials'],
  policy: PricingPolicy,
  amount: number,
): ReturnType<typeof evaluatePriceAgainstPolicy> {
  return evaluatePriceAgainstPolicy(
    { supplierCost: commercials.supplierCost, shippingCost: commercials.shippingCost },
    policy,
    amount,
  );
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
  const existing = await getCandidate(candidateId);

  /*
   * BOTH ends of the transition are validated.
   *
   * This used to check nothing at all: the target status was a valid value, so the write
   * went through. A candidate that already had a Shopify draft could therefore be set back
   * to WATCHING, after which every list and every button treated it as an ordinary
   * pre-product candidate - one click from a second product. A REJECTED candidate could
   * quietly become WATCHING again with no record of anyone reopening it.
   *
   * Terminality is a property of the CURRENT state, which a target-only check cannot see.
   */
  const transition = canTransition(existing.status, status, {
    pushedShopifyProductId: existing.pushedShopifyProductId,
  });
  if (!transition.allowed) {
    throw new AppError(
      existing.status === 'PUSHED_TO_SHOPIFY' ? 'RESEARCH_ALREADY_PUSHED' : 'VALIDATION_ERROR',
      transition.reason ?? `A candidate with status ${existing.status} cannot become ${status}.`,
      {
        details: {
          candidateId,
          from: existing.status,
          to: status,
          pushedShopifyProductId: existing.pushedShopifyProductId,
        },
      },
    );
  }

  const $set: Record<string, unknown> = { status };
  if (options.watchUntil !== undefined) $set.watchUntil = options.watchUntil;
  if (options.note !== undefined) $set.notes = options.note;
  // Leaving a stale watch date on a candidate no longer being watched would make a
  // watchlist query return things nobody is watching.
  if (status !== 'WATCHING' && options.watchUntil === undefined) $set.watchUntil = null;

  /*
   * The current status is in the FILTER as well.
   *
   * The check above read the candidate; this makes the write conditional on it not having
   * moved since. Without it, a push completing between the read and the write would be
   * overwritten by a WATCHING that was legal when it was decided and is not any more.
   */
  const result = await ProductCandidateModel.updateOne(
    { shopDomain: shopDomain(), candidateId, status: existing.status },
    { $set },
  );

  if (result.matchedCount === 0) {
    const current = await getCandidate(candidateId);
    throw new AppError(
      'RESEARCH_ALREADY_PUSHED',
      `This candidate changed while the request was in flight - it is now ${current.status}. Nothing was written. Re-read it and decide again.`,
      { details: { candidateId, expected: existing.status, actual: current.status } },
    );
  }

  return getCandidate(candidateId);
}
