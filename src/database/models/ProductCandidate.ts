/**
 * A product being considered, before it is anything in Shopify.
 *
 * The one collection in Trademart that is a SYSTEM OF RECORD rather than a view.
 * Everywhere else Shopify owns the truth and Trademart derives from it; a research
 * candidate does not exist in Shopify yet, so if this collection loses a row the
 * operator's research is gone. That is why the score, its inputs and its history are
 * all persisted rather than recomputed on read.
 *
 * WHY THE SCORE IS STORED AND NOT DERIVED
 * ---------------------------------------
 * Scoring is deterministic, so it could be recomputed. It is stored anyway, because the
 * INPUTS change underneath it: search volumes move, the store's fulfillment record
 * changes, the supplier's cost changes. A stored score with its evidence is what the
 * decision was actually made on, and scoreHistory is what lets an operator see that a
 * candidate scored 82 in March and 54 today. Recomputing on read would silently rewrite
 * the past.
 *
 * NULL IS NOT ZERO, ENFORCED AT THE SCHEMA
 * ----------------------------------------
 * Every optional number defaults to null, never 0. A candidate whose supplier cost
 * nobody has looked up must not persist as costing nothing - that is the mistake the
 * whole module is built to avoid, and defaulting a Mongoose Number to 0 would
 * reintroduce it below the level any TypeScript check could see.
 *
 * Statuses and recommendations are stored as strings rather than being recomputed from
 * the score on read, because an operator's decision (WATCHING, REJECTED) is theirs and
 * must survive a change to the band thresholds.
 */

import { Schema, model, type InferSchemaType } from 'mongoose';

/** Provenance of one figure behind a score. Mirrors EvidenceItem. */
const evidenceItemSchema = new Schema(
  {
    code: { type: String, required: true },
    label: { type: String, required: true },
    source: { type: String, required: true },
    observedAt: { type: String, default: null },
    fetchedAt: { type: String, default: null },
    freshness: {
      type: String,
      enum: ['FRESH', 'AGING', 'STALE', 'UNKNOWN'],
      default: 'UNKNOWN',
    },
    value: { type: String, default: null },
    confidence: {
      type: String,
      enum: ['KNOWN', 'ESTIMATED', 'UNKNOWN'],
      default: 'UNKNOWN',
    },
  },
  { _id: false },
);

/** One factor's contribution. `value` null means the factor was NOT scored. */
const factorScoreSchema = new Schema(
  {
    factor: {
      type: String,
      required: true,
      enum: [
        'demand',
        'trend',
        'profitability',
        'storeFit',
        'competition',
        'shipping',
        'seasonality',
        'fulfillmentQuality',
      ],
    },
    // Null, never 0: 0 asserts the product is bad at this factor, null says unknown.
    value: { type: Number, default: null },
    confidence: {
      type: String,
      enum: ['KNOWN', 'ESTIMATED', 'UNKNOWN'],
      default: 'UNKNOWN',
    },
    reasons: { type: [String], default: [] },
    risks: { type: [String], default: [] },
    evidence: { type: [evidenceItemSchema], default: [] },
  },
  { _id: false },
);

const scoreHistoryEntrySchema = new Schema(
  {
    at: { type: String, required: true },
    overallScore: { type: Number, required: true },
    confidenceScore: { type: Number, required: true },
    recommendation: {
      type: String,
      required: true,
      enum: ['STRONG_CANDIDATE', 'GOOD_CANDIDATE', 'WATCH', 'WEAK', 'REJECT'],
    },
    note: { type: String, default: null },
  },
  { _id: false },
);

/**
 * Market figures an operator read elsewhere and typed in.
 *
 * `observedAt` is when they READ it, which is what freshness ages from. Storing only a
 * createdAt would make a figure copied from a March screenshot look current forever.
 */
const manualResearchSchema = new Schema(
  {
    averageMonthlySearches: { type: Number, default: null },
    momentumPercentage: { type: Number, default: null },
    competitionIndex: { type: Number, default: null },
    competitorCount: { type: Number, default: null },
    seasonState: {
      type: String,
      enum: ['EARLY', 'RISING', 'PEAK', 'FALLING', 'OFF_SEASON', 'UNKNOWN'],
      default: 'UNKNOWN',
    },
    peakMonths: { type: [Number], default: null },
    /** What the figures describe. Null country means unstated, NOT the target market. */
    geographyCountryCode: { type: String, default: null },
    geographyRegion: { type: String, default: null },
    observedAt: { type: String, default: null },
    sourceNote: { type: String, default: null },
  },
  { _id: false },
);

/**
 * What the candidate is expected to cost and sell for.
 *
 * Currencies are stored PER FIELD because a hand-entered shipping cost genuinely can be
 * in a different currency from a supplier cost, and a single currencyCode column would
 * make that impossible to represent - so the two would be added together and the
 * mismatch would never be detected.
 */
const commercialsSchema = new Schema(
  {
    supplierCost: { type: Number, default: null },
    supplierCurrency: { type: String, default: null },
    shippingCost: { type: Number, default: null },
    shippingCurrency: { type: String, default: null },
    shippingDays: { type: Number, default: null },
    expectedSellingPrice: { type: Number, default: null },
    expectedSellingCurrency: { type: String, default: null },
    costObservedAt: { type: String, default: null },
  },
  { _id: false },
);

const productCandidateSchema = new Schema(
  {
    shopDomain: { type: String, required: true, index: true },
    /**
     * Trademart's own identifier, generated rather than taken from a supplier.
     *
     * A candidate may have no supplier reference at all - an operator can type in a
     * product they saw anywhere - so the primary key cannot depend on one.
     */
    candidateId: { type: String, required: true },

    source: {
      type: String,
      required: true,
      enum: ['MANUAL', 'TRADELLE', 'SHOPIFY_PERFORMANCE', 'GOOGLE_ADS', 'GOOGLE_TRENDS'],
      default: 'MANUAL',
    },
    sourceProductId: { type: String, default: null },
    sourceUrl: { type: String, default: null },

    title: { type: String, required: true },
    category: { type: String, default: null },
    imageUrl: { type: String, default: null },
    keywords: { type: [String], default: [] },

    /** The market being judged. Region null means country-wide. */
    marketCountryCode: { type: String, required: true },
    marketRegion: { type: String, default: null },
    marketHorizonDays: { type: Number, required: true, default: 30 },

    commercials: { type: commercialsSchema, default: () => ({}) },
    manualResearch: { type: manualResearchSchema, default: () => ({}) },

    factors: { type: [factorScoreSchema], default: [] },
    // Null until analysed, and null rather than 0 afterwards when nothing could be
    // scored. A stored 0 would render as a terrible product.
    overallScore: { type: Number, default: null },
    confidenceScore: { type: Number, default: null },
    recommendation: {
      type: String,
      enum: ['STRONG_CANDIDATE', 'GOOD_CANDIDATE', 'WATCH', 'WEAK', 'REJECT', null],
      default: null,
    },
    seasonState: {
      type: String,
      enum: ['EARLY', 'RISING', 'PEAK', 'FALLING', 'OFF_SEASON', 'UNKNOWN'],
      default: 'UNKNOWN',
    },

    reasons: { type: [String], default: [] },
    risks: { type: [String], default: [] },
    evidence: { type: [evidenceItemSchema], default: [] },
    freshness: {
      type: String,
      enum: ['FRESH', 'AGING', 'STALE', 'UNKNOWN'],
      default: 'UNKNOWN',
    },

    status: {
      type: String,
      required: true,
      enum: ['NEW', 'ANALYZED', 'WATCHING', 'SELECTED', 'REJECTED', 'PUSHED_TO_SHOPIFY'],
      default: 'NEW',
    },
    /**
     * Set once a DRAFT exists in Shopify.
     *
     * Its presence means "a draft was created", never "this is published". Nothing in
     * this module publishes, and the field name deliberately does not say "published".
     */
    pushedShopifyProductId: { type: String, default: null },
    pushedAt: { type: String, default: null },
    watchUntil: { type: String, default: null },

    scoreHistory: { type: [scoreHistoryEntrySchema], default: [] },

    notes: { type: String, default: null },
    analyzedAt: { type: String, default: null },
  },
  { timestamps: true, collection: 'product_candidates' },
);

/**
 * One candidate id per store.
 *
 * Unique so a retried create cannot produce two rows for the same candidate, which
 * would then be pushed to Shopify twice.
 */
productCandidateSchema.index({ shopDomain: 1, candidateId: 1 }, { unique: true });

/** The research dashboard's main query: this store's candidates, best first. */
productCandidateSchema.index({ shopDomain: 1, status: 1, overallScore: -1 });

/**
 * Supports duplicate detection against a supplier reference.
 *
 * Sparse, not unique: two candidates CAN legitimately share a source product id - an
 * operator may re-research something they rejected six months ago - so this index makes
 * the check fast without forbidding the case. The decision about what to do belongs in
 * the service, where it can be explained to the operator.
 */
productCandidateSchema.index({ shopDomain: 1, sourceProductId: 1 }, { sparse: true });

export type ProductCandidateDocument = InferSchemaType<typeof productCandidateSchema>;
export const ProductCandidateModel = model('ProductCandidate', productCandidateSchema);
