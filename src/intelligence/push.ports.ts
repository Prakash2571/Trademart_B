/**
 * The outside world, as the push orchestration sees it.
 *
 * Every Mongo write, every Shopify call and the clock, behind one explicit interface.
 * Two reasons, and the second is the important one:
 *
 *   1. push.service imports the config singleton, which calls process.exit(1) at import,
 *      so nothing that imports it can be unit tested at all.
 *   2. The invariants that matter here are about CALL COUNTS - "createProduct was called
 *      exactly once across two concurrent pushes" - and you cannot assert a call count
 *      against a module you cannot substitute.
 *
 * Deliberately narrow. The orchestration is handed the specific operations it needs, not
 * a Shopify client, so it cannot grow the ability to publish just because a client
 * happened to expose it.
 */

import type { PricingPolicy, PricingScenarioName } from '../pricing/recommendation';
import type { PricingResult } from '../pricing/pricing.service';
import type { CandidateAnalysis } from './candidate.analysis';
import type { ProductCandidate } from './candidate.types';
import type {
  SourceabilityResult,
  SupplierAvailability,
  SupplierAvailabilitySource,
  SupplierProvider,
  SupplierVariantAvailability,
} from './sourceability';
import type {
  ExistingCandidateRef,
  ExistingProductRef,
} from './duplicate.detection';
import type { ProductCreateRequest } from '../products/product.create';
import type {
  PushedVariantMapping,
  ShopifyCreatedVariantIdentity,
} from './variant.mapping';

/**
 * The verified state of a Shopify product.
 *
 * `visibleToCustomers` is the ONLY field that means customers can see it: an ACTIVE
 * product with no sales-channel publication is invisible, and a DRAFT that is somehow
 * published is not. Both halves are reported so a caller cannot infer one from the other.
 */
export interface ShopifyProductState {
  /**
   * DRAFT | ACTIVE | ARCHIVED, or null when Shopify withheld it.
   *
   * Nullable because ProductVisibility is nullable here, and coercing a withheld status to
   * a plausible string would be inventing data about the one thing this check exists to
   * verify. The visibility decision never reads it - it reads the two booleans below - so
   * a withheld status degrades the report without weakening the guard.
   */
  status: string | null;
  published: boolean;
  visibleToCustomers: boolean;
}

/** A product already carrying a candidate's research identity tag. */
export interface ExistingResearchProduct {
  shopifyProductId: string;
  /**
   * The first variant's id, when Shopify returned one.
   *
   * Carried so a reconciliation can restore the supplier cost against the right variant.
   * Null when the product has no readable variant, in which case the cost cannot be
   * re-attached and that is reported rather than guessed.
   */
  shopifyVariantId: string | null;
  /** All readable variants, used to reconstruct mappings after a crash. */
  variants?: readonly ShopifyCreatedVariantIdentity[];
  state: ShopifyProductState;
}

/** What createProduct gives back, narrowed to what the orchestration uses. */
export interface CreatedProduct extends ShopifyProductState {
  shopifyProductId: string;
  variants: readonly ShopifyCreatedVariantIdentity[];
  warnings: string[];
}

/**
 * A complete analysis that has not been written anywhere.
 *
 * Structurally mirrors intelligence.service's PreparedAnalysis. Declared here rather than
 * imported from there so this module - and therefore the orchestration and its tests -
 * does not depend on a module that imports config.
 */
export interface PreparedAnalysis {
  storedCandidate: ProductCandidate;
  /** The candidate as it stands AFTER this analysis. Everything downstream uses this. */
  freshCandidate: ProductCandidate;
  analysis: CandidateAnalysis;
  policy: PricingPolicy;
  /** The supplier sourceability verdict the push gate acts on. */
  sourceability: SourceabilityResult;
  decisionHash: string;
  /**
   * Prices an arbitrary amount against the same cost model.
   *
   * Needed so an operator's hand-typed price faces the same commercial floors as a
   * scenario price. Optional because a blocked analysis has no cost model to price
   * against, and a caller must handle that rather than assume a guard ran.
   */
  evaluatePrice?: (amount: number) => PricingResult | null;
}

export interface ClaimRequest {
  candidateId: string;
  operationId: string;
  now: Date;
  leaseMs: number;
}

/**
 * The exact decision that is about to create a Shopify draft, frozen in the candidate row
 * BEFORE the first Shopify write.
 *
 * Its whole purpose is crash recovery. If the process dies after Shopify creates the
 * product but before the bookkeeping is written, a later attempt finds the product by its
 * identity tag and reads THIS snapshot to restore the listed price, the decision hash, the
 * score and - most importantly - the supplier cost, instead of returning a pile of nulls
 * and marking the candidate "succeeded" with no record of what it was priced at.
 *
 * It is written once, attributable to one operationId, and NOT overwritten during recovery
 * (recovery reads it; it does not recompute a new decision and pretend that was the one).
 */
export interface PushIntent {
  operationId: string;
  expectedDecisionHash: string | null;
  actualDecisionHash: string;
  scenario: string | null;
  listedPrice: number;
  sellingCurrency: string | null;
  supplierCost: number | null;
  supplierCurrency: string | null;
  shippingCost: number | null;
  shippingCurrency: string | null;
  overallScore: number | null;
  confidenceScore: number | null;
  recommendation: string | null;
  analyzedInputRevision: number | null;
  /**
   * Why Trademart believed this product was sourceable when the draft was created.
   *
   * Frozen with the rest of the intent so crash recovery has a truthful record of the
   * supplier decision, rather than recomputing sourceability later and pretending that was
   * the original basis.
   */
  supplierProvider: SupplierProvider;
  supplierProductId: string | null;
  supplierAvailability: SupplierAvailability;
  supplierAvailabilitySource: SupplierAvailabilitySource;
  supplierAvailabilityCheckedAt: string | null;
  supplierVariantSnapshot: SupplierVariantAvailability[];
  createdAt: string;
}

/**
 * Persist the push intent AND renew/assert claim ownership, in one conditional write.
 *
 * Doubles as the ownership renewal the critical section needs: the Mongo filter requires
 * this operation still owns the IN_PROGRESS claim and no product exists yet, so a single
 * write both proves ownership and freezes the intent. Returns false when ownership has been
 * lost (an expired lease was taken over by another operation), and the caller must then
 * create nothing.
 */
export interface RecordIntentRequest {
  candidateId: string;
  operationId: string;
  now: Date;
  leaseMs: number;
  intent: PushIntent;
}

export interface CompletionRequest {
  candidateId: string;
  operationId: string;
  shopifyProductId: string;
  variantMappings: readonly PushedVariantMapping[];
  now: Date;
}

export interface IncidentRequest extends CompletionRequest {
  reason: string;
}

export interface CostRequest {
  shopifyProductId: string;
  shopifyVariantId: string;
  supplierProductCost: number;
  supplierShippingCost: number | null;
  currencyCode: string;
  provider: 'TRADELLE' | 'OTHER' | 'UNKNOWN';
  note: string;
}

/** Everything worth knowing about a push attempt, successful or not. */
export interface PushAuditFacts {
  candidateId: string;
  operationId: string;
  /** What the operator approved. Null when they pushed without a hash. */
  expectedDecisionHash: string | null;
  /** What the fresh analysis actually produced. Null when it never got that far. */
  actualDecisionHash: string | null;
  shopifyProductId: string | null;
  outcome: 'CREATED' | 'RECONCILED' | null;
  analyzedAt?: string | null;
  overallScore?: number | null;
  confidenceScore?: number | null;
  recommendation?: string | null;
  selectedScenario: PricingScenarioName | null;
  listedPrice?: number | null;
  priceSource?: string | null;
  currencyCode?: string | null;
  supplierCost?: number | null;
  supplierCurrency?: string | null;
  shippingCost?: number | null;
  shippingCurrency?: string | null;
  duplicateMatches?: number;
  /** Whether the operator explicitly accepted a duplicate. */
  duplicateOverridden: boolean;
  /** Whether the operator explicitly accepted a price below their own floors. */
  guardBreachOverridden: boolean;
  /** Whether the operator explicitly accepted partial supplier variant coverage. */
  partialVariantsOverridden: boolean;
  // Supplier sourceability, so the audit trail records WHY the product was believed
  // sourceable when the draft was created (or reconciled).
  supplierProvider?: SupplierProvider | null;
  supplierProductId?: string | null;
  supplierAvailability?: SupplierAvailability | null;
  supplierAvailabilitySource?: SupplierAvailabilitySource | null;
  supplierCheckedAt?: string | null;
  supplierFreshness?: string | null;
  supplierVariantCoverage?: string | null;
  productState?: ShopifyProductState | null;
  costRecorded?: boolean;
  safetyIncident?: string | null;
  error?: unknown;
}

export interface PushPorts {
  now(): Date;

  candidates: {
    load(candidateId: string): Promise<ProductCandidate>;
    /**
     * Takes the push claim ATOMICALLY, or returns null.
     *
     * Must be a single conditional write - a read followed by a write would let two
     * operations both observe IDLE and both proceed. Returns the claimed candidate so the
     * caller works from the state the claim actually saw.
     */
    claim(request: ClaimRequest): Promise<ProductCandidate | null>;
    /** Releases a claim this operation owns. Never releases another operation's claim. */
    release(request: { candidateId: string; operationId: string }): Promise<void>;
    /**
     * Freezes the push intent and renews/asserts ownership in one conditional write.
     *
     * Returns false when this operation no longer owns the claim (its lease expired and
     * another operation took over). A false result MUST stop the caller before any Shopify
     * creation - this is the gate that closes the lease-expiry duplicate race.
     */
    recordIntent(request: RecordIntentRequest): Promise<boolean>;
    /** Reads the frozen push intent, for recovery. Null when none was recorded. */
    loadIntent(candidateId: string): Promise<PushIntent | null>;
    /**
     * Marks the push succeeded, ONLY if this operation still owns the IN_PROGRESS claim.
     *
     * Returns false when ownership has been lost, so a stale operation cannot finalize a
     * candidate another operation is (or has finished) handling. A false result is an
     * ownership/integrity failure, not a success.
     */
    markSucceeded(request: CompletionRequest): Promise<boolean>;
    markSafetyIncident(request: IncidentRequest): Promise<void>;
    listForDuplicates(): Promise<ExistingCandidateRef[]>;
  };

  analysis: {
    /** Computes the current analysis WITHOUT persisting it. */
    prepare(
      candidateId: string,
      options: { pricingScenario?: PricingScenarioName; now: Date },
    ): Promise<PreparedAnalysis>;
    persist(prepared: PreparedAnalysis): Promise<void>;
  };

  shopify: {
    /**
     * Finds a product carrying this candidate's research identity tag.
     *
     * An EXACT lookup. The whole crash-recovery guarantee rests on this being exact: a
     * fuzzy title match would either miss the product and duplicate it, or adopt the
     * wrong one.
     */
    findByResearchTag(candidateId: string): Promise<ExistingResearchProduct | null>;
    /** The catalogue, for the advisory human-facing duplicate check. */
    listCatalogue(): Promise<ExistingProductRef[]>;
    createProduct(request: ProductCreateRequest): Promise<CreatedProduct>;
    /**
     * Forces a product to a hidden draft and returns its verified state.
     *
     * The emergency repair path. Composed from the existing hide primitives - set status
     * DRAFT, remove sales-channel publications - and there is deliberately no matching
     * "publish" port, so the orchestration cannot make a product visible even by mistake.
     */
    forceHidden(shopifyProductId: string): Promise<ShopifyProductState>;
  };

  costs: {
    record(request: CostRequest): Promise<void>;
  };

  audit(facts: PushAuditFacts): Promise<void>;
}
