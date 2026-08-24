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
  ExistingCandidateRef,
  ExistingProductRef,
} from './duplicate.detection';
import type { ProductCreateRequest } from '../products/product.create';

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
  state: ShopifyProductState;
}

/** What createProduct gives back, narrowed to what the orchestration uses. */
export interface CreatedProduct extends ShopifyProductState {
  shopifyProductId: string;
  variants: readonly { shopifyVariantId: string }[];
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

export interface CompletionRequest {
  candidateId: string;
  operationId: string;
  shopifyProductId: string;
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
    markSucceeded(request: CompletionRequest): Promise<void>;
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
