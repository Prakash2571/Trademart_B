/**
 * The push orchestration, tested by CALL COUNT AND ORDER.
 *
 * This is the file the whole PushPorts seam exists for. The dangerous facts about a push
 * are not "did it return the right shape" - they are "how many times did it call
 * createProduct", "did any Shopify write happen before the refusal", "did forceHidden run
 * when the product came back visible". None of those can be asserted against a value; they
 * can only be asserted against a recorded log of the side effects, which is what a
 * substitutable port gives you and what testing push.service directly (it imports config,
 * which calls process.exit at import) never could.
 *
 * Every test drives the REAL pushCandidateAsDraft through a fake PushPorts whose claim is
 * genuinely atomic - it check-and-sets shared state with no await in between - so two
 * pushes racing through Promise.all exercise the same serialisation the Mongo claim
 * provides in production.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { AppError } from '../common/errors';
import {
  DEFAULT_PRICING_POLICY,
  evaluatePriceAgainstPolicy,
  recommendPrice,
  type PriceRecommendation,
} from '../pricing/recommendation';
import type { ProductCreateRequest } from '../products/product.create';
import { EMPTY_MANUAL_RESEARCH, type ProductCandidate } from './candidate.types';
import type { CandidateAnalysis } from './candidate.analysis';
import type { SourceabilityResult } from './sourceability';
import { researchIdentityTag } from './push.draft';
import {
  PUSH_CLAIM_LEASE_MS,
  pushCandidateAsDraft,
  type PushAsDraftInput,
} from './push.orchestrator';
import type {
  ClaimRequest,
  CompletionRequest,
  CostRequest,
  CreatedProduct,
  ExistingResearchProduct,
  IncidentRequest,
  PreparedAnalysis,
  PushAuditFacts,
  PushIntent,
  PushPorts,
  RecordIntentRequest,
  ShopifyProductState,
} from './push.ports';

const NOW = new Date('2026-06-15T12:00:00.000Z');
const NOW_ISO = NOW.toISOString();

/* ===========================================================================
 * Fixtures
 * ======================================================================== */

function candidate(overrides: Partial<ProductCandidate> = {}): ProductCandidate {
  return {
    id: 'cand-1',
    source: 'MANUAL',
    sourceProductId: 'TRD-9931',
    sourceUrl: null,
    title: 'Portable Neck Fan',
    category: 'Home',
    imageUrl: null,
    keywords: ['neck fan'],
    market: { countryCode: 'GB', region: null, horizonDays: 30 },
    commercials: {
      supplierCost: 10,
      supplierCurrency: 'GBP',
      shippingCost: 2,
      shippingCurrency: 'GBP',
      shippingDays: 8,
      expectedSellingPrice: null,
      expectedSellingCurrency: 'GBP',
      costObservedAt: NOW_ISO,
    },
    supplier: null,
    manualResearch: { ...EMPTY_MANUAL_RESEARCH },
    factors: [],
    overallScore: 79,
    confidenceScore: 61,
    recommendation: 'GOOD_CANDIDATE',
    seasonState: 'RISING',
    reasons: [],
    risks: [],
    evidence: [],
    freshness: 'FRESH',
    status: 'ANALYZED',
    pushState: 'IDLE',
    pushOperationId: null,
    pushClaimedAt: null,
    pushSafetyReason: null,
    pushedShopifyProductId: null,
    watchUntil: null,
    scoreHistory: [],
    notes: null,
    createdAt: NOW_ISO,
    analyzedAt: NOW_ISO,
    updatedAt: NOW_ISO,
    inputRevision: 1,
    analyzedInputRevision: 1,
    ...overrides,
  };
}

function pricingFor(candidateRow: ProductCandidate): PriceRecommendation {
  return recommendPrice({
    supplierCost: candidateRow.commercials.supplierCost,
    supplierCurrency: candidateRow.commercials.supplierCurrency,
    shippingCost: candidateRow.commercials.shippingCost,
    shippingCurrency: candidateRow.commercials.shippingCurrency,
    sellingCurrency: candidateRow.commercials.expectedSellingCurrency,
    policy: { ...DEFAULT_PRICING_POLICY },
  });
}

/**
 * A minimal but STRUCTURALLY REAL analysis.
 *
 * The pricing comes from the real engine so the scenarios, the recommended one and the
 * guard breaches are the ones the code would actually see. Only the score is stubbed,
 * because the orchestration never inspects the factor internals - it reads the price, the
 * decision hash and the fresh candidate.
 */
function preparedFor(
  candidateRow: ProductCandidate,
  overrides: Partial<PreparedAnalysis> = {},
): PreparedAnalysis {
  const pricing = pricingFor(candidateRow);
  const analysis = {
    score: {
      overallScore: candidateRow.overallScore,
      confidenceScore: candidateRow.confidenceScore,
      recommendation: candidateRow.recommendation,
    },
    pricing,
    warnings: [],
  } as unknown as CandidateAnalysis;

  return {
    storedCandidate: candidateRow,
    freshCandidate: candidateRow,
    analysis,
    policy: pricing.policy,
    // Default: a fresh, fully-available supplier so existing push tests exercise the happy
    // path. The supplier-gate tests override `sourceability` with UNAVAILABLE/UNKNOWN/STALE.
    sourceability: sourceableResult(),
    decisionHash: 'hash-current',
    // The real evaluator, so a hand-typed price faces the SAME floors a scenario does.
    // A stub returning null would make the guard-breach test pass vacuously - it would
    // report "nothing to check" for exactly the price most likely to breach.
    evaluatePrice: (amount: number) =>
      evaluatePriceAgainstPolicy(
        {
          supplierCost: candidateRow.commercials.supplierCost,
          shippingCost: candidateRow.commercials.shippingCost,
        },
        pricing.policy,
        amount,
      ),
    ...overrides,
  };
}

/** A clean, fully-sourceable verdict: AVAILABLE, fresh, full variant coverage. */
function sourceableResult(overrides: Partial<SourceabilityResult> = {}): SourceabilityResult {
  return {
    provider: 'TRADELLE',
    availability: 'AVAILABLE',
    availabilitySource: 'MANUAL',
    checkedAt: NOW.toISOString(),
    freshness: 'FRESH',
    current: 'SOURCEABLE',
    variantCoverage: 'FULL',
    stockKnown: true,
    supplierProductId: 'TRD-1',
    sourceUrl: 'https://tradelle.example/p/1',
    productCost: 8,
    productCurrency: 'GBP',
    shippingCost: 3,
    shippingCurrency: 'GBP',
    shippingDays: 8,
    variants: [],
    reasons: ['SUPPLIER_AVAILABLE'],
    pushEligible: true,
    block: null,
    confidencePenalty: 0,
    ...overrides,
  };
}

const hiddenState: ShopifyProductState = {
  status: 'DRAFT',
  published: false,
  visibleToCustomers: false,
};

const visibleState: ShopifyProductState = {
  status: 'ACTIVE',
  published: true,
  visibleToCustomers: true,
};

/* ===========================================================================
 * The fake world
 * ======================================================================== */

interface FakeConfig {
  /** The candidate row as Mongo would hold it. Mutated by claim/markSucceeded/etc. */
  row: ProductCandidate;
  /** Prepared analysis returned by analysis.prepare. */
  prepared?: PreparedAnalysis;
  /** A product already in Shopify carrying the identity tag (the reconcile case). */
  existingResearchProduct?: ExistingResearchProduct | null;
  /**
   * A push intent already frozen by a crashed earlier attempt, returned by loadIntent.
   * Recovery reads this to restore price/cost/hash. Left undefined for the "intent lost"
   * conservative-reconcile case.
   */
  pushIntent?: PushIntent | null;
  /** State createProduct reports back. Default hidden. */
  createdState?: ShopifyProductState;
  /** State forceHidden reports back. Default hidden (a successful repair). */
  forceHiddenState?: ShopifyProductState;
  /** Catalogue for the advisory duplicate check. */
  catalogue?: { shopifyProductId: string; title: string; status: string; tags: string[] }[];
  /** Other research candidates for the duplicate check. */
  otherCandidates?: ProductCandidate[];
  /** Injected failures, keyed by the port method that should throw once. */
  failOnce?: Partial<Record<string, () => never>>;
  /**
   * Side effects run (once) at the entry of a named port method, to simulate a CONCURRENT
   * operation interfering mid-push - e.g. taking the claim over while this push analyses.
   */
  interfereOnce?: Partial<Record<string, () => void>>;
  /**
   * Sequential return values for findByResearchTag, one per call. Used to model a product
   * appearing between the early (step-4) lookup and the final (step-8c) lookup. When
   * absent, findByResearchTag returns `existingResearchProduct` on every call.
   */
  findByResearchTagSequence?: (ExistingResearchProduct | null)[];
  now?: Date;
}

/**
 * Builds a PushPorts that records every call, in order, and keeps a shared candidate row
 * so the atomic claim actually serialises.
 */
function makePorts(config: FakeConfig): {
  ports: PushPorts;
  calls: string[];
  audits: PushAuditFacts[];
  costs: CostRequest[];
  createRequests: ProductCreateRequest[];
  intents: PushIntent[];
  recordIntentTimes: string[];
  advanceClock: (ms: number) => void;
  world: FakeConfig;
} {
  const calls: string[] = [];
  const audits: PushAuditFacts[] = [];
  const costs: CostRequest[] = [];
  const createRequests: ProductCreateRequest[] = [];
  const intents: PushIntent[] = [];
  // Timestamps recordIntent was called with, so a test can prove the lease renewal used a
  // FRESH clock read rather than the operation-start time.
  const recordIntentTimes: string[] = [];
  // The intent frozen this run; falls back to a preset (a crashed attempt's intent).
  let storedIntent: PushIntent | null = config.pushIntent ?? null;
  let createdCounter = 0;
  // A MUTABLE clock, so a test can advance time mid-operation (e.g. during analysis) and
  // check what timestamp the later steps captured.
  let clock = config.now ?? NOW;

  const failed = new Set<string>();
  function maybeFail(method: string): void {
    const thrower = config.failOnce?.[method];
    if (thrower !== undefined && !failed.has(method)) {
      failed.add(method);
      thrower();
    }
  }

  const interfered = new Set<string>();
  function maybeInterfere(method: string): void {
    const effect = config.interfereOnce?.[method];
    if (effect !== undefined && !interfered.has(method)) {
      interfered.add(method);
      effect();
    }
  }

  let findTagCall = 0;

  const ports: PushPorts = {
    now: () => clock,

    candidates: {
      async load(candidateId) {
        calls.push('load');
        maybeFail('load');
        return { ...config.row, id: candidateId };
      },

      /*
       * ATOMIC. The check and the mutation happen with NO await between them, so two
       * concurrent callers cannot both observe an IDLE row. This mirrors the Mongo
       * findOneAndUpdate $or filter: own operationId, expired lease, or genuinely idle,
       * AND no product id yet.
       */
      claim(request: ClaimRequest) {
        calls.push('claim');
        const row = config.row;
        const leaseCutoff = request.now.getTime() - request.leaseMs;
        const claimedAt =
          row.pushClaimedAt === null ? null : new Date(row.pushClaimedAt).getTime();
        const grantable =
          row.pushedShopifyProductId === null &&
          (row.pushState === 'IDLE' ||
            (row.pushState === 'IN_PROGRESS' && row.pushOperationId === request.operationId) ||
            (row.pushState === 'IN_PROGRESS' && claimedAt !== null && claimedAt <= leaseCutoff) ||
            (row.pushState === 'IN_PROGRESS' && row.pushClaimedAt === null));

        if (!grantable) return Promise.resolve(null);

        config.row = {
          ...row,
          pushState: 'IN_PROGRESS',
          pushOperationId: request.operationId,
          pushClaimedAt: request.now.toISOString(),
        };
        return Promise.resolve({ ...config.row });
      },

      async release(request) {
        calls.push('release');
        if (config.row.pushOperationId === request.operationId) {
          config.row = {
            ...config.row,
            pushState: 'IDLE',
            pushOperationId: null,
            pushClaimedAt: null,
          };
        }
      },

      /*
       * The intent freeze + ownership renewal, atomic. Mirrors the Mongo CAS: it succeeds
       * only if this operation still owns the IN_PROGRESS claim and no product exists yet.
       */
      recordIntent(request: RecordIntentRequest) {
        calls.push('recordIntent');
        maybeFail('recordIntent');
        const row = config.row;
        const owned =
          row.pushState === 'IN_PROGRESS' &&
          row.pushOperationId === request.operationId &&
          row.pushedShopifyProductId === null;
        if (!owned) return Promise.resolve(false);
        storedIntent = request.intent;
        intents.push(request.intent);
        recordIntentTimes.push(request.now.toISOString());
        config.row = { ...row, pushClaimedAt: request.now.toISOString() };
        return Promise.resolve(true);
      },

      async loadIntent(candidateId) {
        calls.push('loadIntent');
        void candidateId;
        return storedIntent;
      },

      /*
       * Ownership CAS: only the operation still holding the IN_PROGRESS claim may finalize.
       * A stale operation (whose lease was taken over) gets false and must not report
       * success. Returns boolean rather than mutating unconditionally.
       */
      async markSucceeded(request: CompletionRequest): Promise<boolean> {
        calls.push('markSucceeded');
        maybeFail('markSucceeded');
        const row = config.row;
        const owned =
          row.pushState === 'IN_PROGRESS' && row.pushOperationId === request.operationId;
        if (!owned) return false;
        config.row = {
          ...config.row,
          pushState: 'SUCCEEDED',
          status: 'PUSHED_TO_SHOPIFY',
          pushedShopifyProductId: request.shopifyProductId,
          pushClaimedAt: null,
        };
        return true;
      },

      async markSafetyIncident(request: IncidentRequest) {
        calls.push('markSafetyIncident');
        config.row = {
          ...config.row,
          pushState: 'SAFETY_INCIDENT',
          pushedShopifyProductId: request.shopifyProductId,
          pushSafetyReason: request.reason,
          pushClaimedAt: null,
        };
      },

      async listForDuplicates() {
        calls.push('listForDuplicates');
        return (config.otherCandidates ?? []).map((other) => ({
          candidateId: other.id,
          title: other.title,
          status: other.status,
          sourceProductId: other.sourceProductId,
          pushedShopifyProductId: other.pushedShopifyProductId,
        }));
      },
    },

    analysis: {
      async prepare(candidateId, options) {
        calls.push('prepare');
        maybeInterfere('prepare');
        maybeFail('prepare');
        void options;
        return config.prepared ?? preparedFor({ ...config.row, id: candidateId });
      },
      async persist() {
        calls.push('persist');
        maybeInterfere('persist');
        maybeFail('persist');
      },
    },

    shopify: {
      async findByResearchTag(candidateId) {
        calls.push('findByResearchTag');
        maybeFail('findByResearchTag');
        void candidateId;
        const sequence = config.findByResearchTagSequence;
        if (sequence !== undefined) {
          const value = sequence[Math.min(findTagCall, sequence.length - 1)] ?? null;
          findTagCall += 1;
          return value;
        }
        return config.existingResearchProduct ?? null;
      },

      async listCatalogue() {
        calls.push('listCatalogue');
        maybeFail('listCatalogue');
        return (config.catalogue ?? []).map((entry) => ({ ...entry }));
      },

      async createProduct(request) {
        calls.push('createProduct');
        createRequests.push(request);
        maybeFail('createProduct');
        createdCounter += 1;
        const state = config.createdState ?? hiddenState;
        const created: CreatedProduct = {
          shopifyProductId: `gid://shopify/Product/${createdCounter}`,
          variants: [{ shopifyVariantId: `gid://shopify/ProductVariant/${createdCounter}` }],
          warnings: [],
          ...state,
        };
        return created;
      },

      async forceHidden(shopifyProductId) {
        calls.push('forceHidden');
        maybeFail('forceHidden');
        void shopifyProductId;
        return config.forceHiddenState ?? hiddenState;
      },
    },

    costs: {
      async record(request) {
        calls.push('costs.record');
        maybeFail('costs.record');
        costs.push(request);
      },
    },

    async audit(facts) {
      calls.push('audit');
      audits.push(facts);
    },
  };

  return {
    ports,
    calls,
    audits,
    costs,
    createRequests,
    intents,
    recordIntentTimes,
    advanceClock: (ms: number) => {
      clock = new Date(clock.getTime() + ms);
    },
    world: config,
  };
}

function input(overrides: Partial<PushAsDraftInput> = {}): PushAsDraftInput {
  return {
    expectedDecisionHash: 'hash-current',
    operationId: 'op-1',
    ...overrides,
  };
}

async function expectAppError(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    return error;
  }
  throw new Error('expected the push to be refused, but it resolved');
}

function count(calls: string[], method: string): number {
  return calls.filter((call) => call === method).length;
}

/* ===========================================================================
 * The happy path - order is the assertion
 * ======================================================================== */

describe('a clean push', () => {
  let fx: ReturnType<typeof makePorts>;

  beforeEach(() => {
    fx = makePorts({ row: candidate() });
  });

  it('creates exactly one product, and only after every refusal gate has passed', async () => {
    const result = await pushCandidateAsDraft(fx.ports, 'cand-1', input());

    assert.equal(result.outcome, 'CREATED');
    assert.equal(count(fx.calls, 'createProduct'), 1);

    // The reconcile lookup and the fresh analysis and the hash check all precede the one
    // createProduct. This ordering IS the zero-writes-on-failure guarantee.
    const createAt = fx.calls.indexOf('createProduct');
    for (const gate of ['claim', 'findByResearchTag', 'prepare', 'listCatalogue']) {
      assert.ok(
        fx.calls.indexOf(gate) < createAt,
        `${gate} must run before createProduct, so a refusal there writes nothing to Shopify`,
      );
    }
  });

  it('records the cost, persists the analysis and marks success AFTER the create', async () => {
    await pushCandidateAsDraft(fx.ports, 'cand-1', input());
    const createAt = fx.calls.indexOf('createProduct');
    for (const after of ['costs.record', 'persist', 'markSucceeded', 'audit']) {
      assert.ok(fx.calls.indexOf(after) > createAt, `${after} must run after createProduct`);
    }
    assert.equal(count(fx.calls, 'markSucceeded'), 1);
    assert.equal(count(fx.calls, 'markSafetyIncident'), 0);
  });

  it('files the supplier cost against the id the create returned, in its own currency', async () => {
    await pushCandidateAsDraft(fx.ports, 'cand-1', input());
    assert.equal(fx.costs.length, 1);
    assert.equal(fx.costs[0]?.shopifyProductId, 'gid://shopify/Product/1');
    // NOT relabelled to the selling currency - the supplier currency as stored.
    assert.equal(fx.costs[0]?.currencyCode, 'GBP');
  });

  it('tags the created product with the per-candidate identity tag', async () => {
    await pushCandidateAsDraft(fx.ports, 'cand-1', input());
    assert.ok(fx.createRequests[0]?.tags?.includes(researchIdentityTag('cand-1')));
  });

  it('writes exactly one audit entry, recording the decision hash it acted on', async () => {
    await pushCandidateAsDraft(fx.ports, 'cand-1', input());
    assert.equal(fx.audits.length, 1);
    assert.equal(fx.audits[0]?.outcome, 'CREATED');
    assert.equal(fx.audits[0]?.actualDecisionHash, 'hash-current');
    assert.equal(fx.audits[0]?.expectedDecisionHash, 'hash-current');
  });
});

/* ===========================================================================
 * Refusals that must write NOTHING to Shopify
 * ======================================================================== */

describe('refusals never reach Shopify', () => {
  it('an unlabelled supplier currency blocks with zero Shopify calls and no claim', async () => {
    const fx = makePorts({
      row: candidate({
        commercials: {
          supplierCost: 10,
          supplierCurrency: null, // present amount, no currency
          shippingCost: 2,
          shippingCurrency: 'GBP',
          shippingDays: 8,
          expectedSellingPrice: null,
          expectedSellingCurrency: 'GBP',
          costObservedAt: NOW_ISO,
        },
      }),
    });

    const error = await expectAppError(pushCandidateAsDraft(fx.ports, 'cand-1', input()));
    assert.equal(error.code, 'CURRENCY_MISMATCH');
    assert.equal(count(fx.calls, 'createProduct'), 0);
    // Refused before the claim: currency can never become labelled by waiting.
    assert.equal(count(fx.calls, 'claim'), 0);
  });

  it('a stale decision hash blocks with RECOMMENDATION_CHANGED and no product', async () => {
    const fx = makePorts({ row: candidate() });
    const error = await expectAppError(
      pushCandidateAsDraft(fx.ports, 'cand-1', input({ expectedDecisionHash: 'hash-the-operator-saw' })),
    );
    assert.equal(error.code, 'RECOMMENDATION_CHANGED');
    assert.equal(count(fx.calls, 'createProduct'), 0);
    // It claimed first (so it computed a fresh analysis), then released on the way out.
    assert.equal(count(fx.calls, 'claim'), 1);
    assert.equal(count(fx.calls, 'release'), 1);
    assert.equal(count(fx.calls, 'markSucceeded'), 0);
    // The refusal is still audited - a blocked push is often the interesting entry.
    assert.equal(fx.audits.length, 1);
    assert.equal(fx.audits[0]?.outcome, null);
  });

  it('an exact duplicate blocks unless allowDuplicate is exactly true', async () => {
    const world = {
      row: candidate(),
      catalogue: [
        {
          shopifyProductId: 'gid://shopify/Product/existing',
          title: 'Portable Neck Fan',
          status: 'ACTIVE',
          tags: [],
        },
      ],
    };

    const blocked = makePorts({ ...world });
    const error = await expectAppError(pushCandidateAsDraft(blocked.ports, 'cand-1', input()));
    assert.equal(error.code, 'VALIDATION_ERROR');
    assert.equal(count(blocked.calls, 'createProduct'), 0);

    const overridden = makePorts({ ...world, row: candidate() });
    const result = await pushCandidateAsDraft(
      overridden.ports,
      'cand-1',
      input({ allowDuplicate: true }),
    );
    assert.equal(result.outcome, 'CREATED');
    assert.equal(count(overridden.calls, 'createProduct'), 1);
  });

  it('a guard-breaching price blocks unless acknowledgeGuardBreach is exactly true', async () => {
    // A break-even selling price: below every margin floor, so the scenarios breach.
    const breaching = candidate({
      commercials: {
        supplierCost: 100,
        supplierCurrency: 'GBP',
        shippingCost: 0,
        shippingCurrency: 'GBP',
        shippingDays: 8,
        expectedSellingPrice: null,
        expectedSellingCurrency: 'GBP',
        costObservedAt: NOW_ISO,
      },
    });

    const blocked = makePorts({ row: breaching });
    const error = await expectAppError(
      pushCandidateAsDraft(blocked.ports, 'cand-1', input({ price: 100 })),
    );
    assert.equal(error.code, 'VALIDATION_ERROR');
    assert.match(error.message, /floor/i);
    assert.equal(count(blocked.calls, 'createProduct'), 0);

    const overridden = makePorts({ row: breaching });
    const result = await pushCandidateAsDraft(
      overridden.ports,
      'cand-1',
      input({ price: 100, acknowledgeGuardBreach: true }),
    );
    assert.equal(result.outcome, 'CREATED');
    assert.equal(count(overridden.calls, 'createProduct'), 1);
    // The accepted breach is warned about and recorded, not silently swallowed.
    assert.ok(result.warnings.some((warning) => /breach/i.test(warning)));
  });

  it('an already-pushed candidate is refused before it even claims', async () => {
    const fx = makePorts({
      row: candidate({
        status: 'PUSHED_TO_SHOPIFY',
        pushState: 'SUCCEEDED',
        pushedShopifyProductId: 'gid://shopify/Product/9',
      }),
    });
    const error = await expectAppError(pushCandidateAsDraft(fx.ports, 'cand-1', input()));
    assert.equal(error.code, 'RESEARCH_ALREADY_PUSHED');
    assert.equal(count(fx.calls, 'claim'), 0);
    assert.equal(count(fx.calls, 'createProduct'), 0);
  });

  it('a candidate left in a safety incident is refused, and stays that way', async () => {
    const fx = makePorts({
      row: candidate({ pushState: 'SAFETY_INCIDENT', pushSafetyReason: 'was visible' }),
    });
    const error = await expectAppError(pushCandidateAsDraft(fx.ports, 'cand-1', input()));
    assert.equal(error.code, 'RESEARCH_PUSH_SAFETY');
    assert.equal(count(fx.calls, 'claim'), 0);
    assert.equal(count(fx.calls, 'createProduct'), 0);
  });
});

/* ===========================================================================
 * Concurrency and idempotency - the point of the atomic claim
 * ======================================================================== */

describe('two pushes cannot both create a product', () => {
  it('two DIFFERENT operations racing produce exactly one createProduct', async () => {
    const fx = makePorts({ row: candidate() });

    const [a, b] = await Promise.allSettled([
      pushCandidateAsDraft(fx.ports, 'cand-1', input({ operationId: 'op-A' })),
      pushCandidateAsDraft(fx.ports, 'cand-1', input({ operationId: 'op-B' })),
    ]);

    // Exactly one product, no matter how the two interleaved.
    assert.equal(count(fx.calls, 'createProduct'), 1);

    const outcomes = [a, b];
    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
    const rejected = outcomes.filter((o) => o.status === 'rejected');
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);

    const refusal = (rejected[0] as PromiseRejectedResult).reason;
    assert.ok(refusal instanceof AppError);
    // The loser is told a push is running, not that something broke.
    assert.equal((refusal as AppError).code, 'RESEARCH_PUSH_IN_PROGRESS');
  });

  it('the loser makes no Shopify call of any kind', async () => {
    const fx = makePorts({ row: candidate() });
    await Promise.allSettled([
      pushCandidateAsDraft(fx.ports, 'cand-1', input({ operationId: 'op-A' })),
      pushCandidateAsDraft(fx.ports, 'cand-1', input({ operationId: 'op-B' })),
    ]);
    // One create. The winner does TWO identity lookups (the step-4 reconcile check and the
    // final pre-create check); the loser never reaches either, so the total is 2, not more.
    assert.equal(count(fx.calls, 'createProduct'), 1);
    assert.equal(count(fx.calls, 'findByResearchTag'), 2);
  });
});

/* ===========================================================================
 * Crash recovery - a claim alone is not enough, the identity tag is
 * ======================================================================== */

describe('recovery after a create that never finished recording', () => {
  it('a retry with the same operation reconciles instead of creating a second product', async () => {
    /*
     * The exact crash window: createProduct succeeds, then the Mongo write fails and the
     * process dies. The candidate is left IN_PROGRESS with this operation's id, and a
     * product exists in Shopify carrying the identity tag - but Mongo never learned its id.
     */
    const fx = makePorts({
      row: candidate(),
      failOnce: {
        markSucceeded: () => {
          throw new Error('mongo write failed after the product was created');
        },
      },
    });

    // First attempt: creates the product, then the mark fails and the error propagates.
    let firstThrew = false;
    try {
      await pushCandidateAsDraft(fx.ports, 'cand-1', input({ operationId: 'op-retry' }));
    } catch {
      firstThrew = true;
    }
    assert.ok(firstThrew, 'the first attempt must surface the failed write, not swallow it');
    assert.equal(count(fx.calls, 'createProduct'), 1);
    // The claim was NOT released, because a product exists - a naive retry must not race.
    assert.equal(count(fx.calls, 'release'), 0);
    // A refused/failed push is still audited.
    assert.ok(fx.audits.length >= 1);

    // The orphaned product is now discoverable by its identity tag.
    fx.world.existingResearchProduct = {
      shopifyProductId: 'gid://shopify/Product/1',
      shopifyVariantId: 'gid://shopify/ProductVariant/1',
      state: hiddenState,
    };

    // Retry, SAME operation id. It owns the claim, so step 1 lets it through to reconcile.
    const result = await pushCandidateAsDraft(
      fx.ports,
      'cand-1',
      input({ operationId: 'op-retry' }),
    );

    assert.equal(result.outcome, 'RECONCILED');
    // STILL exactly one create across both attempts. This is the whole guarantee.
    assert.equal(count(fx.calls, 'createProduct'), 1);
  });

  it('an expired lease lets a new operation reconcile the orphaned product', async () => {
    const claimedLongAgo = new Date(NOW.getTime() - PUSH_CLAIM_LEASE_MS - 1_000).toISOString();
    const fx = makePorts({
      row: candidate({
        pushState: 'IN_PROGRESS',
        pushOperationId: 'op-dead',
        pushClaimedAt: claimedLongAgo,
      }),
      existingResearchProduct: {
        shopifyProductId: 'gid://shopify/Product/orphan',
        shopifyVariantId: 'gid://shopify/ProductVariant/orphan',
        state: hiddenState,
      },
    });

    const result = await pushCandidateAsDraft(
      fx.ports,
      'cand-1',
      input({ operationId: 'op-fresh' }),
    );

    assert.equal(result.outcome, 'RECONCILED');
    assert.equal(result.shopifyProductId, 'gid://shopify/Product/orphan');
    // Reconciliation, so nothing new was created.
    assert.equal(count(fx.calls, 'createProduct'), 0);
  });

  it('a live lease held by another operation is NOT recoverable', async () => {
    const claimedJustNow = new Date(NOW.getTime() - 1_000).toISOString();
    const fx = makePorts({
      row: candidate({
        pushState: 'IN_PROGRESS',
        pushOperationId: 'op-active',
        pushClaimedAt: claimedJustNow,
      }),
    });
    const error = await expectAppError(
      pushCandidateAsDraft(fx.ports, 'cand-1', input({ operationId: 'op-intruder' })),
    );
    assert.equal(error.code, 'RESEARCH_PUSH_IN_PROGRESS');
    assert.equal(count(fx.calls, 'createProduct'), 0);
    assert.equal(count(fx.calls, 'claim'), 0);
  });
});

/* ===========================================================================
 * The draft-only postcondition
 * ======================================================================== */

describe('a product that comes back visible is forced hidden, never reported as success', () => {
  it('runs forceHidden and succeeds quietly when the repair works', async () => {
    const fx = makePorts({
      row: candidate(),
      createdState: visibleState,
      forceHiddenState: hiddenState,
    });

    const result = await pushCandidateAsDraft(fx.ports, 'cand-1', input());
    assert.equal(count(fx.calls, 'forceHidden'), 1);
    assert.ok(fx.calls.indexOf('forceHidden') > fx.calls.indexOf('createProduct'));
    // Repaired, so it is an ordinary success - but it says so through the verified state.
    assert.equal(result.productState.visibleToCustomers, false);
    assert.equal(result.safetyIncident, null);
    assert.equal(count(fx.calls, 'markSucceeded'), 1);
    assert.equal(count(fx.calls, 'markSafetyIncident'), 0);
  });

  it('raises RESEARCH_PUSH_SAFETY and marks an incident when the product stays visible', async () => {
    const fx = makePorts({
      row: candidate(),
      createdState: visibleState,
      forceHiddenState: visibleState, // the repair did not take
    });

    const error = await expectAppError(pushCandidateAsDraft(fx.ports, 'cand-1', input()));
    assert.equal(error.code, 'RESEARCH_PUSH_SAFETY');
    // The product was created, so its id survives for a human to find.
    assert.match(String((error.details as { shopifyProductId?: string })?.shopifyProductId), /Product/);
    assert.equal(count(fx.calls, 'forceHidden'), 1);
    assert.equal(count(fx.calls, 'markSafetyIncident'), 1);
    assert.equal(count(fx.calls, 'markSucceeded'), 0);
    // The claim is NOT released - the candidate stays in SAFETY_INCIDENT so no retry races.
    assert.equal(count(fx.calls, 'release'), 0);
  });

  it('escalates when forceHidden itself throws', async () => {
    const fx = makePorts({
      row: candidate(),
      createdState: visibleState,
      failOnce: {
        forceHidden: () => {
          throw new Error('shopify unreachable');
        },
      },
    });

    const error = await expectAppError(pushCandidateAsDraft(fx.ports, 'cand-1', input()));
    assert.equal(error.code, 'RESEARCH_PUSH_SAFETY');
    assert.equal(count(fx.calls, 'markSafetyIncident'), 1);
    assert.equal(count(fx.calls, 'createProduct'), 1);
  });
});

/* ===========================================================================
 * Reconciliation specifics
 * ======================================================================== */

describe('reconcile adopts an existing product without re-pricing it', () => {
  it('creates nothing, records no cost, and reports RECONCILED', async () => {
    const fx = makePorts({
      row: candidate(),
      existingResearchProduct: {
        shopifyProductId: 'gid://shopify/Product/already',
        shopifyVariantId: 'gid://shopify/ProductVariant/already',
        state: hiddenState,
      },
    });

    const result = await pushCandidateAsDraft(fx.ports, 'cand-1', input());
    assert.equal(result.outcome, 'RECONCILED');
    assert.equal(count(fx.calls, 'createProduct'), 0);
    assert.equal(count(fx.calls, 'prepare'), 0); // no re-analysis needed to adopt
    assert.equal(fx.costs.length, 0);
    assert.equal(count(fx.calls, 'markSucceeded'), 1);
    assert.equal(fx.audits[0]?.outcome, 'RECONCILED');
  });
});

/* ===========================================================================
 * Claim ownership - the lease-expiry race and the completion CAS
 * ======================================================================== */

describe('a push that loses its claim mid-flight creates nothing', () => {
  it('refuses with PUSH_CLAIM_LOST and ZERO Shopify writes when another op takes over during analysis', async () => {
    /*
     * The race Part 1 is about: A claims, A is slow, A's lease expires, B takes over. A
     * resumes. Modelled by having a concurrent operation seize ownership during A's
     * analysis (interfereOnce.prepare). A then reaches the renew/assert-ownership write,
     * finds it no longer owns the claim, and MUST create nothing.
     */
    const fx = makePorts({
      row: candidate(),
      interfereOnce: {
        prepare: () => {
          // B takes the claim over while A is analysing.
          fx.world.row = {
            ...fx.world.row,
            pushState: 'IN_PROGRESS',
            pushOperationId: 'op-B',
            pushClaimedAt: NOW.toISOString(),
          };
        },
      },
    });

    const error = await expectAppError(
      pushCandidateAsDraft(fx.ports, 'cand-1', input({ operationId: 'op-A' })),
    );
    assert.equal(error.code, 'PUSH_CLAIM_LOST');
    // The renew/assert happened, but the create did NOT.
    assert.equal(count(fx.calls, 'recordIntent'), 1);
    assert.equal(count(fx.calls, 'createProduct'), 0);
    // And it never reached the final lookup either - ownership is checked first.
    assert.equal(count(fx.calls, 'markSucceeded'), 0);
  });

  it('the stale owner cannot mark success after it lost ownership post-create (markSucceeded CAS)', async () => {
    /*
     * A holds the claim, renews it, and creates the product. Between persistence and the
     * completion write, B takes the claim over. A's markSucceeded is an ownership CAS, so
     * it returns false and A raises PUSH_CLAIM_LOST rather than finalizing a candidate it
     * no longer owns. The product id is preserved for the owner (B) to reconcile.
     */
    const fx = makePorts({
      row: candidate(),
      interfereOnce: {
        persist: () => {
          fx.world.row = {
            ...fx.world.row,
            pushOperationId: 'op-B',
          };
        },
      },
    });

    const error = await expectAppError(
      pushCandidateAsDraft(fx.ports, 'cand-1', input({ operationId: 'op-A' })),
    );
    assert.equal(error.code, 'PUSH_CLAIM_LOST');
    assert.equal(count(fx.calls, 'createProduct'), 1);
    assert.equal(count(fx.calls, 'markSucceeded'), 1); // attempted...
    // ...but it returned false, so the candidate was NOT finalized by A.
    assert.notEqual(fx.world.row.pushState, 'SUCCEEDED');
    // The product exists, so the id is preserved in the error for the owner to reconcile.
    assert.match(
      String((error.details as { shopifyProductId?: string })?.shopifyProductId),
      /Product/,
    );
    // A does NOT release the claim - a product exists.
    assert.equal(count(fx.calls, 'release'), 0);
  });
});

/* ===========================================================================
 * Final identity reconciliation - a product appearing between the two lookups
 * ======================================================================== */

describe('a product created between the early and final lookups is reconciled, not duplicated', () => {
  it('does NOT create a second product when the final pre-create lookup finds one', async () => {
    const fx = makePorts({
      row: candidate(),
      // Step-4 lookup: nothing. Step-8c lookup: a product has appeared.
      findByResearchTagSequence: [
        null,
        {
          shopifyProductId: 'gid://shopify/Product/raced',
          shopifyVariantId: 'gid://shopify/ProductVariant/raced',
          state: hiddenState,
        },
      ],
    });

    const result = await pushCandidateAsDraft(fx.ports, 'cand-1', input());

    assert.equal(result.outcome, 'RECONCILED');
    assert.equal(result.shopifyProductId, 'gid://shopify/Product/raced');
    // The whole point: no create, even though the early lookup was clear.
    assert.equal(count(fx.calls, 'createProduct'), 0);
    assert.equal(count(fx.calls, 'findByResearchTag'), 2);
    // Ownership was renewed before the final lookup.
    assert.equal(count(fx.calls, 'recordIntent'), 1);
  });
});

/* ===========================================================================
 * Crash recovery uses the frozen intent, not nulls
 * ======================================================================== */

describe('recovery restores the original decision from the push intent', () => {
  it('reconciles a crashed push using its frozen price, currency and supplier cost', async () => {
    // A crashed attempt already exists: a product carries the identity tag, and the intent
    // it froze before creating is present. This is the complete-recovery case.
    const frozenIntent: PushIntent = {
      operationId: 'op-original',
      expectedDecisionHash: 'hash-current',
      actualDecisionHash: 'hash-current',
      scenario: 'BALANCED',
      listedPrice: 21.5,
      sellingCurrency: 'GBP',
      supplierCost: 10,
      supplierCurrency: 'GBP',
      shippingCost: 2,
      shippingCurrency: 'GBP',
      overallScore: 79,
      confidenceScore: 61,
      recommendation: 'GOOD_CANDIDATE',
      analyzedInputRevision: 1,
      supplierProvider: 'TRADELLE',
      supplierProductId: 'TRD-1',
      supplierAvailability: 'AVAILABLE',
      supplierAvailabilitySource: 'MANUAL',
      supplierAvailabilityCheckedAt: NOW.toISOString(),
      supplierVariantSnapshot: [],
      createdAt: NOW.toISOString(),
    };
    const fx = makePorts({
      row: candidate(),
      existingResearchProduct: {
        shopifyProductId: 'gid://shopify/Product/crashed',
        shopifyVariantId: 'gid://shopify/ProductVariant/crashed',
        state: hiddenState,
      },
      pushIntent: frozenIntent,
    });

    const result = await pushCandidateAsDraft(fx.ports, 'cand-1', input());

    assert.equal(result.outcome, 'RECONCILED');
    assert.equal(count(fx.calls, 'createProduct'), 0);
    // The listed price is RECOVERED from the intent, not returned as null.
    assert.equal(result.listedPrice?.amount, 21.5);
    assert.equal(result.listedPrice?.currencyCode, 'GBP');
    // The supplier cost is restored from the intent, against the reconciled variant.
    assert.equal(result.costRecorded, true);
    assert.equal(fx.costs.length, 1);
    assert.equal(fx.costs[0]?.currencyCode, 'GBP');
    assert.equal(fx.costs[0]?.supplierProductCost, 10);
    assert.equal(fx.costs[0]?.shopifyVariantId, 'gid://shopify/ProductVariant/crashed');
    // The audit records the ORIGINAL decision hash and price, not nulls.
    assert.equal(fx.audits[0]?.actualDecisionHash, 'hash-current');
    assert.equal(fx.audits[0]?.listedPrice, 21.5);
  });

  it('reconciles conservatively, inventing nothing, when the intent is missing', async () => {
    // A legacy/partial row: the product exists but no intent was ever frozen. Recovery must
    // NOT invent a price or cost - it reconciles honestly and says the values are unknown.
    const fx = makePorts({
      row: candidate(),
      existingResearchProduct: {
        shopifyProductId: 'gid://shopify/Product/legacy',
        shopifyVariantId: 'gid://shopify/ProductVariant/legacy',
        state: hiddenState,
      },
      // no pushIntent
    });

    const result = await pushCandidateAsDraft(fx.ports, 'cand-1', input());

    assert.equal(result.outcome, 'RECONCILED');
    assert.equal(result.listedPrice, null); // not invented
    assert.equal(result.costRecorded, false); // not invented
    assert.equal(fx.costs.length, 0);
    assert.equal(fx.audits[0]?.listedPrice ?? null, null);
    assert.ok(
      result.warnings.some((warning) => /could not be (found|reconstructed)/i.test(warning)),
      'a conservative reconcile must say the historical values are unknown',
    );
  });
});

/* ===========================================================================
 * Terminal status cannot push
 * ======================================================================== */

describe('a terminal candidate cannot be pushed', () => {
  it('refuses a REJECTED candidate before any claim or Shopify call', async () => {
    const fx = makePorts({ row: candidate({ status: 'REJECTED' }) });
    const error = await expectAppError(pushCandidateAsDraft(fx.ports, 'cand-1', input()));
    assert.notEqual(error.code, 'INTERNAL_ERROR');
    assert.equal(count(fx.calls, 'claim'), 0);
    assert.equal(count(fx.calls, 'createProduct'), 0);
  });
});


/* ===========================================================================
 * Supplier sourceability gate (Part 11) - nothing reaches Shopify unsourceable
 * ======================================================================== */

describe('the supplier sourceability gate blocks a push before any Shopify write', () => {
  it('supplier UNAVAILABLE => RESEARCH_SUPPLIER_UNAVAILABLE, createProduct = 0', async () => {
    const fx = makePorts({
      row: candidate(),
      prepared: preparedFor(candidate(), {
        sourceability: sourceableResult({
          availability: 'UNAVAILABLE',
          current: 'NOT_SOURCEABLE',
          pushEligible: false,
          block: 'SUPPLIER_UNAVAILABLE',
          reasons: ['SUPPLIER_UNAVAILABLE'],
        }),
      }),
    });
    const error = await expectAppError(pushCandidateAsDraft(fx.ports, 'cand-1', input()));
    assert.equal(error.code, 'RESEARCH_SUPPLIER_UNAVAILABLE');
    assert.equal(count(fx.calls, 'createProduct'), 0);
    // It claimed and prepared, then released cleanly - no product, so the claim is freed.
    assert.equal(count(fx.calls, 'release'), 1);
  });

  it('supplier UNKNOWN => RESEARCH_SUPPLIER_UNVERIFIED, createProduct = 0', async () => {
    const fx = makePorts({
      row: candidate(),
      prepared: preparedFor(candidate(), {
        sourceability: sourceableResult({
          availability: 'UNKNOWN',
          current: 'UNVERIFIED',
          pushEligible: false,
          block: 'SUPPLIER_AVAILABILITY_UNKNOWN',
          reasons: ['SUPPLIER_AVAILABILITY_UNKNOWN', 'SUPPLIER_CHECK_REQUIRED'],
        }),
      }),
    });
    const error = await expectAppError(pushCandidateAsDraft(fx.ports, 'cand-1', input()));
    assert.equal(error.code, 'RESEARCH_SUPPLIER_UNVERIFIED');
    assert.equal(count(fx.calls, 'createProduct'), 0);
  });

  it('supplier AVAILABLE but STALE => RESEARCH_SUPPLIER_STALE, createProduct = 0', async () => {
    const fx = makePorts({
      row: candidate(),
      prepared: preparedFor(candidate(), {
        sourceability: sourceableResult({
          availability: 'AVAILABLE',
          freshness: 'STALE',
          current: 'NEEDS_RECHECK',
          pushEligible: false,
          block: 'SUPPLIER_AVAILABILITY_STALE',
          reasons: ['SUPPLIER_AVAILABILITY_STALE', 'SUPPLIER_CHECK_REQUIRED'],
        }),
      }),
    });
    const error = await expectAppError(pushCandidateAsDraft(fx.ports, 'cand-1', input()));
    assert.equal(error.code, 'RESEARCH_SUPPLIER_STALE');
    assert.equal(count(fx.calls, 'createProduct'), 0);
  });

  it('a fresh manual verification lets the push proceed', async () => {
    const fx = makePorts({ row: candidate() }); // preparedFor defaults to SOURCEABLE
    const result = await pushCandidateAsDraft(fx.ports, 'cand-1', input());
    assert.equal(result.outcome, 'CREATED');
    assert.equal(count(fx.calls, 'createProduct'), 1);
  });
});

describe('the variant gate never silently creates unavailable variants', () => {
  const partial = () =>
    preparedFor(candidate(), {
      sourceability: sourceableResult({
        current: 'PARTIALLY_SOURCEABLE',
        variantCoverage: 'PARTIAL',
        reasons: ['SUPPLIER_AVAILABLE', 'SUPPLIER_VARIANTS_PARTIALLY_AVAILABLE'],
        variants: [
          { supplierVariantId: 'v1', sku: 'A', title: 'Black / M', optionValues: {}, availability: 'AVAILABLE', stockKnown: true, cost: null, currencyCode: null, checkedAt: NOW.toISOString() },
          { supplierVariantId: 'v2', sku: 'B', title: 'Black / L', optionValues: {}, availability: 'UNAVAILABLE', stockKnown: true, cost: null, currencyCode: null, checkedAt: NOW.toISOString() },
        ],
      }),
    });

  it('blocks a PARTIAL coverage push until the operator acknowledges it', async () => {
    const fx = makePorts({ row: candidate(), prepared: partial() });
    const error = await expectAppError(pushCandidateAsDraft(fx.ports, 'cand-1', input()));
    assert.equal(error.code, 'RESEARCH_SUPPLIER_VARIANTS');
    assert.equal(count(fx.calls, 'createProduct'), 0);
  });

  it('proceeds when partial coverage is explicitly acknowledged', async () => {
    const fx = makePorts({ row: candidate(), prepared: partial() });
    const result = await pushCandidateAsDraft(
      fx.ports,
      'cand-1',
      input({ acknowledgePartialVariants: true }),
    );
    assert.equal(result.outcome, 'CREATED');
    assert.equal(count(fx.calls, 'createProduct'), 1);
    assert.ok(result.warnings.some((warning) => /variant/i.test(warning)));
  });
});

describe('supplier state is frozen into the push intent', () => {
  it('records the supplier snapshot in the intent before the Shopify create', async () => {
    const fx = makePorts({
      row: candidate(),
      prepared: preparedFor(candidate(), {
        sourceability: sourceableResult({ supplierProductId: 'TRD-777', availability: 'AVAILABLE' }),
      }),
    });
    await pushCandidateAsDraft(fx.ports, 'cand-1', input());
    assert.equal(fx.intents.length, 1);
    assert.equal(fx.intents[0]?.supplierProvider, 'TRADELLE');
    assert.equal(fx.intents[0]?.supplierProductId, 'TRD-777');
    assert.equal(fx.intents[0]?.supplierAvailability, 'AVAILABLE');
    assert.equal(fx.intents[0]?.supplierAvailabilitySource, 'MANUAL');
    // ...and the audit records it too.
    assert.equal(fx.audits[0]?.supplierAvailability, 'AVAILABLE');
    assert.equal(fx.audits[0]?.supplierProductId, 'TRD-777');
  });
});

/* ===========================================================================
 * Lease renewal uses a FRESH clock (Part 19)
 * ======================================================================== */

describe('lease renewal is stamped with the current clock, not operation start', () => {
  it('recordIntent uses the time it actually runs, even if analysis was slow', async () => {
    let advance: (ms: number) => void = () => {};
    const fx = makePorts({
      row: candidate(),
      // Simulate analysis taking longer than the lease (2 min): jump 2m05s during prepare.
      interfereOnce: { prepare: () => advance(125_000) },
    });
    advance = fx.advanceClock;

    await pushCandidateAsDraft(fx.ports, 'cand-1', input());

    // The claim was taken at 12:00:00; analysis pushed the clock to 12:02:05; the lease
    // renewal must be stamped 12:02:05, NOT the operation-start 12:00:00 (the old bug).
    assert.equal(fx.recordIntentTimes.length, 1);
    assert.equal(fx.recordIntentTimes[0], new Date(NOW.getTime() + 125_000).toISOString());
    assert.notEqual(fx.recordIntentTimes[0], NOW.toISOString());
  });
});
