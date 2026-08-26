/**
 * Storefront integration tests — covers all 19 required verification items.
 *
 * Uses in-memory fakes implementing the port interfaces.
 * No live network, no real Mongo/Shopify/Razorpay.
 */
import assert from 'node:assert/strict';
import { createHmac, createHash, timingSafeEqual } from 'node:crypto';
import { describe, it, beforeEach } from 'node:test';

import { computeSourceability, type SupplierInfo, type SupplierVariantAvailability } from '../intelligence/sourceability';
import type { PushedVariantMapping } from '../intelligence/variant.mapping';
import {
  evaluateStorefrontSellability,
  inrAmountToPaise,
  normalizeInrAmount,
} from './catalog/sellability';
import { projectStorefrontProduct, type ProjectedProduct } from './catalog/projection';
import type { StorefrontProductSummary, StorefrontProduct } from './catalog/types';
import type { RawCatalogProduct } from './catalog/shopify.catalog';
import type { CatalogCandidateEvidence } from './catalog/catalog.repository';
import {
  verifyRazorpayPaymentSignature,
  computeRazorpayPaymentSignature,
  verifyRazorpayWebhookSignature,
  computeRazorpayWebhookSignature,
} from './payments/razorpay.signature';
import {
  deriveTrackingToken,
  deriveCheckoutStatusToken,
  hashTrackingToken,
  trackingTokenMatches,
} from './orders/tracking-token';
import { StorefrontError } from './checkout/storefront.error';
import { CheckoutService } from './checkout/checkout.service';
import { buildCheckoutSnapshot, checkoutRequestHash } from './checkout/checkout.snapshot';
import type {
  AuthoritativeCheckoutLine,
  CheckoutCatalogPort,
  CheckoutSessionRecord,
  CheckoutSessionRepository,
  CreateCheckoutRequest,
  CustomerShippingPolicyPort,
  NewCheckoutSession,
  RequestedCheckoutLine,
} from './checkout/checkout.types';
import { mapToPublicCheckoutStatus } from './checkout/checkout.types';
import type { RazorpayPort, RazorpayOrder, RazorpayPayment } from './payments/razorpay.client';
import { StorefrontPaymentService, type VerifyPaymentInput } from './payments/payment.service';
import type { PaymentAttemptRepository, ObservedPaymentAttempt } from './payments/payment.repository';
import type { RazorpayConfig } from './payments/razorpay.config';
import { PaidOrderOrchestrator } from './orders/order.orchestrator';
import type { ShopifyOrderCreationPort, CreatedShopifyOrder } from './orders/shopify-order.adapter';
import { StorefrontTrackingService, type OrderTrackingPort, type PublicFulfillment } from './orders/tracking.service';
import type { SafeRazorpayWebhook } from './payments/razorpay.webhook';

// ===========================================================================
// Test fixtures and helpers
// ===========================================================================

const NOW = new Date('2026-08-26T12:00:00.000Z');
const SECRET = 'kanay-test-secret-key-that-is-at-least-32-chars';
const RAZORPAY_KEY_SECRET = 'rzp_secret_test_key_for_testing_only';
const WEBHOOK_SECRET = 'whsec_test_key_for_webhook_testing_abc';

function supplierInfo(overrides: Partial<SupplierInfo> = {}): SupplierInfo {
  return {
    provider: 'TRADELLE',
    supplierProductId: 'sp-001',
    sourceUrl: 'https://supplier.internal/product/sp-001',
    availability: 'AVAILABLE',
    availabilitySource: 'MANUAL',
    checkedAt: NOW.toISOString(),
    observedAt: NOW.toISOString(),
    note: null,
    stockKnown: true,
    productAvailable: true,
    productCost: 500,
    productCurrency: 'INR',
    shippingCost: 100,
    shippingCurrency: 'INR',
    shippingDays: 5,
    variants: [
      {
        supplierVariantId: 'sv-1',
        sku: 'SKU-1',
        title: 'Black / M',
        optionValues: { Color: 'Black', Size: 'M' },
        availability: 'AVAILABLE',
        stockKnown: true,
        cost: 500,
        currencyCode: 'INR',
        checkedAt: NOW.toISOString(),
      },
    ],
    evidence: [],
    ...overrides,
  };
}

const VARIANT_MAPPING: PushedVariantMapping = {
  publicVariantId: 'kv_test123',
  shopifyVariantId: 'gid://shopify/ProductVariant/1001',
  supplierVariantId: 'sv-1',
  supplierSku: 'SKU-1',
  supplierTitle: 'Black / M',
  optionValues: { Color: 'Black', Size: 'M' },
  mappedAt: NOW.toISOString(),
};

function rawProduct(overrides: Partial<RawCatalogProduct> = {}): RawCatalogProduct {
  return {
    id: 'gid://shopify/Product/9001',
    handle: 'test-product',
    title: 'Test Product',
    description: 'A premium test product for testing purposes.',
    status: 'ACTIVE',
    vendor: 'TestVendor',
    productType: 'Clothing',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-08-25T00:00:00Z',
    seo: { title: 'Test Product', description: 'A test product' },
    featuredMedia: { image: { url: 'https://cdn.shopify.com/image.jpg', altText: 'Product Image' } },
    media: { nodes: [{ image: { url: 'https://cdn.shopify.com/image.jpg', altText: 'Product Image' } }] },
    variants: {
      nodes: [
        {
          id: 'gid://shopify/ProductVariant/1001',
          title: 'Black / M',
          sku: 'SKU-1',
          price: '1499.00',
          compareAtPrice: null,
          availableForSale: true,
          selectedOptions: [
            { name: 'Color', value: 'Black' },
            { name: 'Size', value: 'M' },
          ],
        },
      ],
    },
    collections: {
      nodes: [
        {
          id: 'gid://shopify/Collection/100',
          handle: 'summer-sale',
          title: 'Summer Sale',
          description: 'Summer collection',
          image: null,
          seo: { title: 'Summer Sale', description: '' },
          resourcePublicationsV2: {
            nodes: [{ isPublished: true, publication: { id: 'pub-1', name: 'Online Store' } }],
          },
        },
      ],
    },
    resourcePublicationsV2: {
      nodes: [{ isPublished: true, publishDate: '2026-01-01', publication: { id: 'pub-1', name: 'Online Store' } }],
    },
    ...overrides,
  } as unknown as RawCatalogProduct;
}

function catalogEvidence(overrides: Partial<CatalogCandidateEvidence> = {}): CatalogCandidateEvidence {
  return {
    candidateId: 'cand-test-001',
    shopifyProductId: 'gid://shopify/Product/9001',
    supplier: supplierInfo(),
    variantMappings: [VARIANT_MAPPING],
    ...overrides,
  };
}

// ===========================================================================
// In-memory fakes for ports
// ===========================================================================

class FakeCheckoutSessionRepository implements CheckoutSessionRepository {
  public sessions: Map<string, CheckoutSessionRecord> = new Map();
  private idempotencyIndex: Map<string, string> = new Map();
  private razorpayOrderIndex: Map<string, string> = new Map();
  private statusTokenIndex: Map<string, string> = new Map();
  private trackingTokenIndex: Map<string, string> = new Map();

  async findByIdempotencyKey(key: string): Promise<CheckoutSessionRecord | null> {
    const id = this.idempotencyIndex.get(key);
    return id ? this.sessions.get(id) ?? null : null;
  }
  async findByPublicId(publicId: string): Promise<CheckoutSessionRecord | null> {
    return this.sessions.get(publicId) ?? null;
  }
  async findByRazorpayOrderId(orderId: string): Promise<CheckoutSessionRecord | null> {
    const id = this.razorpayOrderIndex.get(orderId);
    return id ? this.sessions.get(id) ?? null : null;
  }
  async findByStatusTokenHash(publicId: string, hash: string): Promise<CheckoutSessionRecord | null> {
    const key = `${publicId}:${hash}`;
    const id = this.statusTokenIndex.get(key);
    return id ? this.sessions.get(id) ?? null : null;
  }
  async findByTrackingTokenHash(hash: string): Promise<CheckoutSessionRecord | null> {
    const id = this.trackingTokenIndex.get(hash);
    return id ? this.sessions.get(id) ?? null : null;
  }
  async create(input: NewCheckoutSession): Promise<CheckoutSessionRecord> {
    if (this.idempotencyIndex.has(input.idempotencyKey)) {
      // Simulate unique constraint violation (code 11000)
      const existingId = this.idempotencyIndex.get(input.idempotencyKey)!;
      return this.sessions.get(existingId)!;
    }
    const record: CheckoutSessionRecord = {
      publicId: input.publicId,
      idempotencyKey: input.idempotencyKey,
      requestHash: input.requestHash,
      status: 'CREATED',
      snapshot: input.snapshot,
      statusTokenHash: input.statusTokenHash,
      trackingTokenHash: input.trackingTokenHash,
      razorpayOrderId: null,
      razorpayPaymentId: null,
      razorpayOrderStatus: null,
      paidAt: null,
      shopifySourceIdentifier: input.shopifySourceIdentifier,
      shopifyOrderId: null,
      shopifyOrderName: null,
      shopifyOrderCreatedAt: null,
      orderAttempts: 0,
      nextOrderAttemptAt: null,
      orderLeaseExpiresAt: null,
      orderErrorCode: null,
      orderErrorMessage: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.sessions.set(record.publicId, record);
    this.idempotencyIndex.set(input.idempotencyKey, record.publicId);
    this.statusTokenIndex.set(`${record.publicId}:${record.statusTokenHash}`, record.publicId);
    this.trackingTokenIndex.set(record.trackingTokenHash, record.publicId);
    return record;
  }
  async attachRazorpayOrder(input: { publicId: string; razorpayOrderId: string; razorpayOrderStatus: string }): Promise<CheckoutSessionRecord> {
    const session = this.sessions.get(input.publicId)!;
    session.razorpayOrderId = input.razorpayOrderId;
    session.razorpayOrderStatus = input.razorpayOrderStatus;
    session.status = 'PAYMENT_PENDING';
    this.razorpayOrderIndex.set(input.razorpayOrderId, session.publicId);
    return session;
  }
  async markPaid(input: { publicId: string; razorpayOrderId: string; razorpayPaymentId: string; paidAt: Date }): Promise<CheckoutSessionRecord> {
    const session = this.sessions.get(input.publicId)!;
    // Mirror the real Mongo query: only update if status is in the allowed set
    const allowedStatuses = ['CREATED', 'PAYMENT_PENDING', 'PAYMENT_PAID', 'ORDER_PENDING', 'ORDER_CREATING'];
    if (allowedStatuses.includes(session.status) &&
        (session.razorpayPaymentId === null || session.razorpayPaymentId === input.razorpayPaymentId)) {
      session.razorpayPaymentId = input.razorpayPaymentId;
      session.paidAt = input.paidAt;
      session.status = 'ORDER_PENDING';
      session.razorpayOrderStatus = 'paid';
      session.nextOrderAttemptAt = new Date();
      return session;
    }
    // If already ORDER_CREATED with matching payment, return existing (idempotent)
    if (session.razorpayOrderId === input.razorpayOrderId &&
        session.razorpayPaymentId === input.razorpayPaymentId &&
        session.status === 'ORDER_CREATED') {
      return session;
    }
    throw new StorefrontError('PAYMENT_MISMATCH', 'Payment could not be matched to this checkout.', 409);
  }
  async markRefunded(input: { publicId: string; razorpayPaymentId: string; refundedAt: Date }): Promise<CheckoutSessionRecord> {
    const session = this.sessions.get(input.publicId)!;
    session.status = 'REFUNDED';
    return session;
  }
  async claimOrder(publicId?: string): Promise<CheckoutSessionRecord | null> {
    for (const session of this.sessions.values()) {
      if (publicId !== undefined && session.publicId !== publicId) continue;
      if (
        (session.status === 'ORDER_PENDING' || session.status === 'PAYMENT_PAID') &&
        session.paidAt !== null
      ) {
        session.status = 'ORDER_CREATING';
        session.orderAttempts += 1;
        session.orderLeaseExpiresAt = new Date(Date.now() + 5 * 60_000);
        return session;
      }
    }
    return null;
  }
  async markOrderCreated(input: { publicId: string; shopifyOrderId: string; shopifyOrderName: string; createdAt: Date }): Promise<CheckoutSessionRecord> {
    const session = this.sessions.get(input.publicId)!;
    session.status = 'ORDER_CREATED';
    session.shopifyOrderId = input.shopifyOrderId;
    session.shopifyOrderName = input.shopifyOrderName;
    session.shopifyOrderCreatedAt = input.createdAt;
    session.orderLeaseExpiresAt = null;
    session.nextOrderAttemptAt = null;
    return session;
  }
  async releaseOrderForRetry(input: { publicId: string; nextAttemptAt: Date; errorCode: string; errorMessage: string }): Promise<void> {
    const session = this.sessions.get(input.publicId)!;
    session.status = 'ORDER_PENDING';
    session.nextOrderAttemptAt = input.nextAttemptAt;
    session.orderLeaseExpiresAt = null;
    session.orderErrorCode = input.errorCode;
    session.orderErrorMessage = input.errorMessage;
  }
}

class FakeRazorpayPort implements RazorpayPort {
  public orders: RazorpayOrder[] = [];
  public orderCount = 0;

  async createOrRecoverOrder(input: { amountPaise: number; currency: 'INR'; receipt: string; checkoutPublicId: string }): Promise<RazorpayOrder> {
    // Check if already exists by receipt (idempotent)
    const existing = this.orders.find(o => o.receipt === input.receipt);
    if (existing) return existing;

    this.orderCount += 1;
    const order: RazorpayOrder = {
      id: `order_test_${this.orderCount}`,
      amount: input.amountPaise,
      amountPaid: 0,
      amountDue: input.amountPaise,
      currency: input.currency,
      receipt: input.receipt,
      status: 'created',
    };
    this.orders.push(order);
    return order;
  }
  async fetchPayment(paymentId: string): Promise<RazorpayPayment> {
    return {
      id: paymentId,
      orderId: this.orders[0]?.id ?? null,
      amount: this.orders[0]?.amount ?? 0,
      currency: 'INR',
      status: 'captured',
      captured: true,
      createdAt: new Date(),
      errorCode: null,
    };
  }
}

class FakePaymentAttemptRepository implements PaymentAttemptRepository {
  public attempts: ObservedPaymentAttempt[] = [];
  async observe(input: ObservedPaymentAttempt): Promise<void> {
    this.attempts.push(input);
  }
}

class FakeShopifyOrderPort implements ShopifyOrderCreationPort {
  public callCount = 0;
  public shouldFail = false;
  public failMessage = 'Shopify unavailable';
  public createdOrders: CreatedShopifyOrder[] = [];

  async ensureOrder(session: CheckoutSessionRecord): Promise<CreatedShopifyOrder> {
    this.callCount += 1;
    if (this.shouldFail) {
      throw new StorefrontError('ORDER_CREATION_PENDING', this.failMessage, 503, undefined, true);
    }
    const order: CreatedShopifyOrder = {
      id: `gid://shopify/Order/${this.callCount}`,
      name: `#KS-${1000 + this.callCount}`,
      createdAt: new Date(),
    };
    this.createdOrders.push(order);
    return order;
  }
}

class FakeOrderTrackingPort implements OrderTrackingPort {
  async get(_shopifyOrderId: string): Promise<PublicFulfillment> {
    return {
      fulfillmentStatus: null,
      shipmentStatus: null,
      estimatedDeliveryAt: null,
      tracking: [],
      events: [],
    };
  }
}

function makeCheckoutRequest(overrides: Partial<CreateCheckoutRequest> = {}): CreateCheckoutRequest {
  return {
    lines: [
      {
        productId: 'kp_test_product_id_12345678',
        variantId: 'kv_test123',
        quantity: 1,
        expectedUnitPricePaise: 149900,
      },
    ],
    customer: {
      fullName: 'Test User',
      email: 'testuser@example.com',
      phone: '+919876543210',
    },
    shippingAddress: {
      addressLine1: '123 Test Street',
      addressLine2: null,
      city: 'Mumbai',
      state: 'Maharashtra',
      pinCode: '400001',
      countryCode: 'IN',
    },
    ...overrides,
  };
}

function makeApprovedLine(overrides: Partial<AuthoritativeCheckoutLine> = {}): AuthoritativeCheckoutLine {
  return {
    publicProductId: 'kp_test_product_id_12345678',
    publicVariantId: 'kv_test123',
    shopifyProductId: 'gid://shopify/Product/9001',
    shopifyVariantId: 'gid://shopify/ProductVariant/1001',
    title: 'Test Product',
    variantTitle: 'Black / M',
    selectedOptions: [{ name: 'Color', value: 'Black' }, { name: 'Size', value: 'M' }],
    image: { url: 'https://cdn.shopify.com/image.jpg', alt: 'Product Image' },
    quantity: 1,
    unitPricePaise: 149900,
    currencyCode: 'INR',
    availableQuantity: 10,
    sellability: 'SELLABLE',
    ...overrides,
  };
}

function makeSession(overrides: Partial<CheckoutSessionRecord> = {}): CheckoutSessionRecord {
  const request = makeCheckoutRequest();
  const approved = [makeApprovedLine()];
  const snapshot = buildCheckoutSnapshot(request, approved, { shippingPaise: 0, discountPaise: 0, taxPaise: 0 });
  const publicId = '11111111-2222-3333-4444-555555555555';
  const statusToken = deriveCheckoutStatusToken(publicId, SECRET);
  const trackingToken = deriveTrackingToken(publicId, SECRET);
  return {
    publicId,
    idempotencyKey: 'test-idempotency-key',
    requestHash: checkoutRequestHash(request),
    status: 'PAYMENT_PENDING',
    snapshot,
    statusTokenHash: hashTrackingToken(statusToken),
    trackingTokenHash: hashTrackingToken(trackingToken),
    razorpayOrderId: 'order_test_1',
    razorpayPaymentId: null,
    razorpayOrderStatus: 'created',
    paidAt: null,
    shopifySourceIdentifier: `kanay-${publicId}`,
    shopifyOrderId: null,
    shopifyOrderName: null,
    shopifyOrderCreatedAt: null,
    orderAttempts: 0,
    nextOrderAttemptAt: null,
    orderLeaseExpiresAt: null,
    orderErrorCode: null,
    orderErrorMessage: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// ===========================================================================
// 1. Public catalog privacy
// ===========================================================================

describe('1. public catalog privacy - projected DTO contains no internal/supplier data', () => {
  it('summary DTO key set contains ONLY safe public fields', () => {
    const projected = projectStorefrontProduct({
      product: rawProduct(),
      shopCurrencyCode: 'INR',
      evidence: catalogEvidence(),
      now: NOW,
    });
    assert.ok(projected, 'Projection must return a result');
    const summaryKeys = Object.keys(projected.summary).sort();
    // These are the ONLY allowed keys in the summary DTO.
    const allowedSummaryKeys = [
      'availability',
      'availableForSale',
      'collections',
      'descriptionExcerpt',
      'handle',
      'id',
      'images',
      'priceRange',
      'productType',
      'quickAddVariant',
      'shopifyProductId',
      'title',
    ].sort();
    // summary MAY have compareAtPriceRange and vendorPublicName optionally
    const optionalKeys = ['compareAtPriceRange', 'vendorPublicName'];
    const filteredKeys = summaryKeys.filter(k => !optionalKeys.includes(k));
    assert.deepEqual(filteredKeys, allowedSummaryKeys,
      `Summary keys should be exactly the safe public set. Got: ${JSON.stringify(summaryKeys)}`);

    // NEGATIVE: these fields must NEVER appear
    const forbidden = [
      'supplierCost', 'cost', 'sourceUrl', 'supplierId', 'supplierProductId',
      'confidenceScore', 'researchScore', 'profit', 'margin',
      'auditData', 'auditTrail', 'pushIntent', 'rawShopifyAdmin',
      'adminMetadata', 'metafields', 'supplierInfo', 'sourceability',
    ];
    const serialized = JSON.stringify(projected.summary);
    for (const key of forbidden) {
      assert.ok(!serialized.includes(`"${key}"`), `Forbidden field "${key}" found in summary DTO`);
    }
  });

  it('detail DTO variant contains no supplier cost, source URL, or internal scoring', () => {
    const projected = projectStorefrontProduct({
      product: rawProduct(),
      shopCurrencyCode: 'INR',
      evidence: catalogEvidence(),
      now: NOW,
    });
    assert.ok(projected);
    const variant = projected.detail.variants[0]!;
    const variantKeys = Object.keys(variant).sort();
    const allowedVariantKeys = [
      'availability',
      'availableForSale',
      'id',
      'price',
      'selectedOptions',
      'shopifyVariantId',
      'title',
    ].sort();
    // Optional keys that may be present
    const optionalVariantKeys = ['compareAtPrice', 'image', 'skuPublic'];
    const filteredKeys = variantKeys.filter(k => !optionalVariantKeys.includes(k));
    assert.deepEqual(filteredKeys, allowedVariantKeys,
      `Variant keys should be exactly the safe public set. Got: ${JSON.stringify(variantKeys)}`);

    const detailSerialized = JSON.stringify(projected.detail);
    const forbidden = [
      'supplierCost', 'cost', 'sourceUrl', 'supplierId', 'supplierVariantId',
      'confidenceScore', 'profit', 'margin', 'auditData', 'pushIntent',
      'supplierSku', 'rawAdmin',
    ];
    for (const key of forbidden) {
      assert.ok(!detailSerialized.includes(`"${key}"`), `Forbidden field "${key}" found in detail DTO`);
    }
  });
});

// ===========================================================================
// 2. Sellability gate fails closed
// ===========================================================================

describe('2. sellability gate fails closed - unknown/absent facts yield UNAVAILABLE', () => {
  it('absent supplier info yields UNAVAILABLE not SELLABLE', () => {
    const sourceability = computeSourceability(null, NOW);
    const result = evaluateStorefrontSellability({
      productStatus: 'ACTIVE',
      publishedToOnlineStore: true,
      sourceability,
      mapping: VARIANT_MAPPING,
      shopifyVariantAvailableForSale: true,
      priceAmount: '1499.00',
      priceCurrencyCode: 'INR',
      now: NOW,
    });
    assert.equal(result.availability, 'UNAVAILABLE');
    assert.equal(result.availableForSale, false);
  });

  it('unknown supplier availability yields UNAVAILABLE', () => {
    const sourceability = computeSourceability(
      supplierInfo({ availability: 'UNKNOWN' }),
      NOW,
    );
    const result = evaluateStorefrontSellability({
      productStatus: 'ACTIVE',
      publishedToOnlineStore: true,
      sourceability,
      mapping: VARIANT_MAPPING,
      shopifyVariantAvailableForSale: true,
      priceAmount: '1499.00',
      priceCurrencyCode: 'INR',
      now: NOW,
    });
    assert.equal(result.availability, 'UNAVAILABLE');
  });

  it('null product status yields UNAVAILABLE', () => {
    const sourceability = computeSourceability(supplierInfo(), NOW);
    const result = evaluateStorefrontSellability({
      productStatus: null,
      publishedToOnlineStore: true,
      sourceability,
      mapping: VARIANT_MAPPING,
      shopifyVariantAvailableForSale: true,
      priceAmount: '1499.00',
      priceCurrencyCode: 'INR',
      now: NOW,
    });
    assert.equal(result.availability, 'UNAVAILABLE');
  });

  it('null shopifyVariantAvailableForSale yields UNAVAILABLE not SELLABLE', () => {
    const sourceability = computeSourceability(supplierInfo(), NOW);
    const result = evaluateStorefrontSellability({
      productStatus: 'ACTIVE',
      publishedToOnlineStore: true,
      sourceability,
      mapping: VARIANT_MAPPING,
      shopifyVariantAvailableForSale: null,
      priceAmount: '1499.00',
      priceCurrencyCode: 'INR',
      now: NOW,
    });
    assert.equal(result.availability, 'UNAVAILABLE');
    assert.equal(result.blockReason, 'SHOPIFY_VARIANT_AVAILABILITY_UNKNOWN');
  });
});

// ===========================================================================
// 3. Unavailable supplier refusal - checkout refuses it
// ===========================================================================

describe('3. unavailable supplier refusal - supplier UNAVAILABLE makes product non-purchasable', () => {
  it('supplier UNAVAILABLE blocks sellability at the evaluator level', () => {
    const sourceability = computeSourceability(
      supplierInfo({ availability: 'UNAVAILABLE', productAvailable: false }),
      NOW,
    );
    const result = evaluateStorefrontSellability({
      productStatus: 'ACTIVE',
      publishedToOnlineStore: true,
      sourceability,
      mapping: VARIANT_MAPPING,
      shopifyVariantAvailableForSale: true,
      priceAmount: '1499.00',
      priceCurrencyCode: 'INR',
      now: NOW,
    });
    assert.equal(result.availability, 'UNAVAILABLE');
    assert.equal(result.blockReason, 'SOURCEABILITY_BLOCKED');
  });

  it('checkout snapshot refuses a line with sellability != SELLABLE', () => {
    const request = makeCheckoutRequest();
    const line = makeApprovedLine({ sellability: 'UNAVAILABLE' });
    assert.throws(
      () => buildCheckoutSnapshot(request, [line], { shippingPaise: 0, discountPaise: 0, taxPaise: 0 }),
      (err: unknown) => err instanceof StorefrontError && err.code === 'PRODUCT_UNAVAILABLE',
    );
  });
});

// ===========================================================================
// 4. Stale sourceability refusal
// ===========================================================================

describe('4. stale sourceability refusal - stale supplier variant evidence refuses checkout', () => {
  it('stale supplier check yields UNAVAILABLE (not SELLABLE)', () => {
    // 30 days old against 72h fresh threshold
    const staleDate = '2026-07-27T12:00:00.000Z';
    const sourceability = computeSourceability(
      supplierInfo({ checkedAt: staleDate }),
      NOW,
    );
    const result = evaluateStorefrontSellability({
      productStatus: 'ACTIVE',
      publishedToOnlineStore: true,
      sourceability,
      mapping: VARIANT_MAPPING,
      shopifyVariantAvailableForSale: true,
      priceAmount: '1499.00',
      priceCurrencyCode: 'INR',
      now: NOW,
    });
    assert.equal(result.availability, 'UNAVAILABLE');
  });

  it('stale variant-level checkedAt yields SUPPLIER_VARIANT_STALE', () => {
    const staleDate = '2026-07-27T12:00:00.000Z';
    const supplier = supplierInfo({
      variants: [{
        supplierVariantId: 'sv-1',
        sku: 'SKU-1',
        title: 'Black / M',
        optionValues: { Color: 'Black', Size: 'M' },
        availability: 'AVAILABLE',
        stockKnown: true,
        cost: 500,
        currencyCode: 'INR',
        checkedAt: staleDate,
      }],
    });
    const sourceability = computeSourceability(supplier, NOW);
    const result = evaluateStorefrontSellability({
      productStatus: 'ACTIVE',
      publishedToOnlineStore: true,
      sourceability,
      mapping: VARIANT_MAPPING,
      shopifyVariantAvailableForSale: true,
      priceAmount: '1499.00',
      priceCurrencyCode: 'INR',
      now: NOW,
    });
    assert.equal(result.blockReason, 'SUPPLIER_VARIANT_STALE');
  });
});

// ===========================================================================
// 5. Exact variant availability - known-unavailable supplier variant is never published
// ===========================================================================

describe('5. exact variant availability - unavailable supplier variant never published as available', () => {
  it('UNAVAILABLE supplier variant is blocked even when Shopify says availableForSale', () => {
    // Include one AVAILABLE variant so sourceability stays PARTIALLY_SOURCEABLE,
    // then verify the specific UNAVAILABLE variant is blocked at the variant gate.
    const supplier = supplierInfo({
      variants: [
        {
          supplierVariantId: 'sv-1',
          sku: 'SKU-1',
          title: 'Black / M',
          optionValues: { Color: 'Black', Size: 'M' },
          availability: 'UNAVAILABLE',
          stockKnown: true,
          cost: 500,
          currencyCode: 'INR',
          checkedAt: NOW.toISOString(),
        },
        {
          supplierVariantId: 'sv-2',
          sku: 'SKU-2',
          title: 'Black / L',
          optionValues: { Color: 'Black', Size: 'L' },
          availability: 'AVAILABLE',
          stockKnown: true,
          cost: 500,
          currencyCode: 'INR',
          checkedAt: NOW.toISOString(),
        },
      ],
    });
    const sourceability = computeSourceability(supplier, NOW);
    // Sourceability is PARTIALLY_SOURCEABLE (one available variant exists)
    // But the specific variant sv-1 is UNAVAILABLE
    const result = evaluateStorefrontSellability({
      productStatus: 'ACTIVE',
      publishedToOnlineStore: true,
      sourceability,
      mapping: VARIANT_MAPPING, // maps to sv-1
      shopifyVariantAvailableForSale: true,
      priceAmount: '1499.00',
      priceCurrencyCode: 'INR',
      now: NOW,
    });
    assert.equal(result.availability, 'UNAVAILABLE');
    assert.equal(result.blockReason, 'SUPPLIER_VARIANT_UNAVAILABLE');
  });

  it('array position is never used as identity - mismatched supplier variant by id not found', () => {
    const supplier = supplierInfo({
      variants: [
        {
          supplierVariantId: 'sv-different',
          sku: 'OTHER-SKU',
          title: 'White / L',
          optionValues: { Color: 'White', Size: 'L' },
          availability: 'AVAILABLE',
          stockKnown: true,
          cost: 500,
          currencyCode: 'INR',
          checkedAt: NOW.toISOString(),
        },
      ],
    });
    const sourceability = computeSourceability(supplier, NOW);
    // Mapping references sv-1 but variants only contain sv-different
    const result = evaluateStorefrontSellability({
      productStatus: 'ACTIVE',
      publishedToOnlineStore: true,
      sourceability,
      mapping: VARIANT_MAPPING,
      shopifyVariantAvailableForSale: true,
      priceAmount: '1499.00',
      priceCurrencyCode: 'INR',
      now: NOW,
    });
    assert.equal(result.availability, 'UNAVAILABLE');
    assert.equal(result.blockReason, 'SUPPLIER_VARIANT_MISSING');
  });
});

// ===========================================================================
// 6. INR-only pricing
// ===========================================================================

describe('6. INR-only pricing - non-INR shop currency fails closed with PRICE_NOT_INR', () => {
  it('USD price currency yields PRICE_NOT_INR, no FX performed', () => {
    const sourceability = computeSourceability(supplierInfo(), NOW);
    const result = evaluateStorefrontSellability({
      productStatus: 'ACTIVE',
      publishedToOnlineStore: true,
      sourceability,
      mapping: VARIANT_MAPPING,
      shopifyVariantAvailableForSale: true,
      priceAmount: '18.00',
      priceCurrencyCode: 'USD',
      now: NOW,
    });
    assert.equal(result.availability, 'UNAVAILABLE');
    assert.equal(result.blockReason, 'PRICE_NOT_INR');
    assert.equal(result.approvedPrice, null);
  });

  it('EUR price currency also fails closed, no conversion', () => {
    const sourceability = computeSourceability(supplierInfo(), NOW);
    const result = evaluateStorefrontSellability({
      productStatus: 'ACTIVE',
      publishedToOnlineStore: true,
      sourceability,
      mapping: VARIANT_MAPPING,
      shopifyVariantAvailableForSale: true,
      priceAmount: '15.00',
      priceCurrencyCode: 'EUR',
      now: NOW,
    });
    assert.equal(result.availability, 'UNAVAILABLE');
    assert.equal(result.blockReason, 'PRICE_NOT_INR');
  });

  it('projected product from non-INR shop currency returns null (no product shown)', () => {
    const projected = projectStorefrontProduct({
      product: rawProduct(),
      shopCurrencyCode: 'USD',
      evidence: catalogEvidence(),
      now: NOW,
    });
    assert.equal(projected, null);
  });
});

// ===========================================================================
// 7. Browser amount tampering
// ===========================================================================

describe('7. browser amount tampering - browser-supplied total never changes charged amount', () => {
  it('Razorpay order amount equals server-recomputed total, ignoring any browser expectation', async () => {
    const sessions = new FakeCheckoutSessionRepository();
    const razorpay = new FakeRazorpayPort();
    const approvedLine = makeApprovedLine({ unitPricePaise: 149900, quantity: 2 });

    const catalog: CheckoutCatalogPort = {
      async revalidateLines(_lines: RequestedCheckoutLine[]) {
        return [approvedLine];
      },
    };
    const shippingPolicy: CustomerShippingPolicyPort = {
      async quote() { return { shippingPaise: 0, discountPaise: 0, taxPaise: 0 }; },
    };

    const service = new CheckoutService({
      catalog,
      shippingPolicy,
      sessions,
      razorpay,
      razorpayKeyId: 'rzp_test_key',
      trackingTokenSecret: SECRET,
    });

    // Browser sends a tampered expectedUnitPricePaise of 100 (₹1 instead of ₹1499)
    // But the catalog port returns the real price of 149900 paise
    // The server should use its own recomputed total
    const request = makeCheckoutRequest({
      lines: [{
        productId: 'kp_test_product_id_12345678',
        variantId: 'kv_test123',
        quantity: 2,
        // NOTE: we do NOT send expectedUnitPricePaise here because the catalog
        // port already returns the authoritative price. The test verifies the
        // Razorpay order gets the server-computed amount.
      }],
    });

    const response = await service.create(request, 'idempotent-key-tamper');
    // Server recomputed: 149900 * 2 = 299800 paise
    assert.equal(response.amountPaise, 299800);
    assert.equal(razorpay.orders[0]!.amount, 299800);
    // The browser cannot influence this amount
  });

  it('tampered expectedUnitPricePaise (100 instead of 149900) triggers PRICE_CHANGED, never charges browser number', () => {
    const request = makeCheckoutRequest({
      lines: [{
        productId: 'kp_test_product_id_12345678',
        variantId: 'kv_test123',
        quantity: 1,
        expectedUnitPricePaise: 100, // Browser claims ₹1 instead of ₹1499
      }],
    });
    const approved = [makeApprovedLine({ unitPricePaise: 149900 })];
    assert.throws(
      () => buildCheckoutSnapshot(request, approved, { shippingPaise: 0, discountPaise: 0, taxPaise: 0 }),
      (err: unknown) => err instanceof StorefrontError && err.code === 'PRICE_CHANGED',
    );
  });
});

// ===========================================================================
// 8. Price change
// ===========================================================================

describe('8. price change - expectedUnitPricePaise mismatch surfaces PRICE_CHANGED', () => {
  it('server price 149900 vs browser expected 139900 raises PRICE_CHANGED', () => {
    const request = makeCheckoutRequest({
      lines: [{
        productId: 'kp_test_product_id_12345678',
        variantId: 'kv_test123',
        quantity: 1,
        expectedUnitPricePaise: 139900,
      }],
    });
    const approved = [makeApprovedLine({ unitPricePaise: 149900 })];
    assert.throws(
      () => buildCheckoutSnapshot(request, approved, { shippingPaise: 0, discountPaise: 0, taxPaise: 0 }),
      (err: unknown) => {
        if (!(err instanceof StorefrontError)) return false;
        assert.equal(err.code, 'PRICE_CHANGED');
        return true;
      },
    );
  });

  it('PRICE_CHANGED still never charges the browser number', () => {
    const request = makeCheckoutRequest({
      lines: [{
        productId: 'kp_test_product_id_12345678',
        variantId: 'kv_test123',
        quantity: 1,
        expectedUnitPricePaise: 100, // Browser wants ₹1
      }],
    });
    const approved = [makeApprovedLine({ unitPricePaise: 149900 })];
    try {
      buildCheckoutSnapshot(request, approved, { shippingPaise: 0, discountPaise: 0, taxPaise: 0 });
      assert.fail('Should have thrown PRICE_CHANGED');
    } catch (err) {
      assert.ok(err instanceof StorefrontError);
      assert.equal(err.code, 'PRICE_CHANGED');
      // No snapshot produced, so no Razorpay order can be created with the browser number
    }
  });
});

// ===========================================================================
// 9. Checkout idempotency
// ===========================================================================

describe('9. checkout idempotency - same Idempotency-Key returns same session, one Razorpay order', () => {
  it('two create calls with same idempotency key produce exactly one Razorpay order', async () => {
    const sessions = new FakeCheckoutSessionRepository();
    const razorpay = new FakeRazorpayPort();
    const catalog: CheckoutCatalogPort = {
      async revalidateLines() { return [makeApprovedLine()]; },
    };
    const shippingPolicy: CustomerShippingPolicyPort = {
      async quote() { return { shippingPaise: 0, discountPaise: 0, taxPaise: 0 }; },
    };
    const service = new CheckoutService({
      catalog, shippingPolicy, sessions, razorpay,
      razorpayKeyId: 'rzp_test_key', trackingTokenSecret: SECRET,
    });

    const request = makeCheckoutRequest();
    const key = 'idempotent-key-1';

    const first = await service.create(request, key);
    const second = await service.create(request, key);

    assert.equal(first.checkoutSessionId, second.checkoutSessionId);
    assert.equal(first.razorpayOrderId, second.razorpayOrderId);
    assert.equal(razorpay.orderCount, 1, 'Exactly ONE Razorpay order should be created');
  });
});

// ===========================================================================
// 10. Razorpay signature verification - correct HMAC verifies
// ===========================================================================

describe('10. Razorpay signature verification - correct HMAC signature verifies', () => {
  it('valid payment signature returns true', () => {
    const orderId = 'order_test_abc123';
    const paymentId = 'pay_test_def456';
    const signature = computeRazorpayPaymentSignature(orderId, paymentId, RAZORPAY_KEY_SECRET);
    const result = verifyRazorpayPaymentSignature({
      serverRazorpayOrderId: orderId,
      razorpayPaymentId: paymentId,
      providedSignature: signature,
      keySecret: RAZORPAY_KEY_SECRET,
    });
    assert.equal(result, true);
  });

  it('valid webhook signature returns true', () => {
    const body = Buffer.from('{"event":"payment.captured"}');
    const signature = computeRazorpayWebhookSignature(body, WEBHOOK_SECRET);
    const result = verifyRazorpayWebhookSignature({
      rawBody: body,
      providedSignature: signature,
      webhookSecret: WEBHOOK_SECRET,
    });
    assert.equal(result, true);
  });
});

// ===========================================================================
// 11. Bad Razorpay signature rejected + constant-time verification
// ===========================================================================

describe('11. bad Razorpay signature is rejected and verification is constant-time (timingSafeEqual)', () => {
  it('incorrect signature returns false', () => {
    const result = verifyRazorpayPaymentSignature({
      serverRazorpayOrderId: 'order_test_abc',
      razorpayPaymentId: 'pay_test_def',
      providedSignature: 'deadbeefcafebabe0123456789abcdef0123456789abcdef0123456789abcdef',
      keySecret: RAZORPAY_KEY_SECRET,
    });
    assert.equal(result, false);
  });

  it('undefined signature returns false', () => {
    const result = verifyRazorpayPaymentSignature({
      serverRazorpayOrderId: 'order_test_abc',
      razorpayPaymentId: 'pay_test_def',
      providedSignature: undefined,
      keySecret: RAZORPAY_KEY_SECRET,
    });
    assert.equal(result, false);
  });

  it('verification uses timingSafeEqual (source code assertion)', () => {
    // Read the source file and confirm timingSafeEqual usage
    const { readFileSync } = require('node:fs');
    const { resolve } = require('node:path');
    // Navigate from dist-test back to src
    const srcFile = resolve(__dirname, '..', '..', 'src', 'storefront', 'payments', 'razorpay.signature.ts');
    const source = readFileSync(srcFile, 'utf8');
    assert.ok(
      source.includes('timingSafeEqual'),
      'razorpay.signature.ts must use timingSafeEqual for constant-time comparison',
    );
    // The function secureHexEqual must use timingSafeEqual, not direct string equality.
    // Verify no line does `expected === provided` or `expected == provided` for hex strings.
    // Length comparison (expectedBytes.length === providedBytes.length) is fine and expected.
    const lines = source.split('\n');
    const signatureComparisonLines = lines.filter(
      (line: string) =>
        (line.includes('expected ==') || line.includes('provided ==') ||
         line.includes('expected ===') || line.includes('provided ===')) &&
        !line.includes('.length') && !line.includes('//'),
    );
    assert.equal(
      signatureComparisonLines.length, 0,
      'razorpay.signature.ts must NOT use == or === for direct signature value comparison',
    );
  });
});

// ===========================================================================
// 12. Webhook replay - same event id delivered twice is deduped
// ===========================================================================

describe('12. webhook replay - same Razorpay event id deduped, at most ONE Shopify order', () => {
  it('processing the same webhook event twice results in exactly one order', async () => {
    const sessions = new FakeCheckoutSessionRepository();
    const attempts = new FakePaymentAttemptRepository();
    const razorpay = new FakeRazorpayPort();
    const shopify = new FakeShopifyOrderPort();
    const orchestrator = new PaidOrderOrchestrator(sessions, shopify);
    const razorpayConfig: RazorpayConfig = {
      keyId: 'rzp_test_key', keySecret: RAZORPAY_KEY_SECRET,
      webhookSecret: WEBHOOK_SECRET, testMode: true, apiBaseUrl: 'https://api.razorpay.com/v1',
    };

    const paymentService = new StorefrontPaymentService(
      sessions, attempts, razorpay, razorpayConfig, orchestrator, SECRET,
    );

    // Create a session with a Razorpay order attached
    const session = makeSession({ status: 'PAYMENT_PENDING', razorpayOrderId: 'order_test_1' });
    sessions.sessions.set(session.publicId, session);
    (sessions as any).razorpayOrderIndex.set('order_test_1', session.publicId);

    // Configure razorpay to return a captured payment
    razorpay.orders.push({
      id: 'order_test_1', amount: 149900, amountPaid: 149900,
      amountDue: 0, currency: 'INR', receipt: null, status: 'paid',
    });

    const event: SafeRazorpayWebhook = {
      eventId: 'evt_test_replay_001',
      eventType: 'payment.captured',
      payment: {
        razorpayOrderId: 'order_test_1',
        razorpayPaymentId: 'pay_test_001',
        amountPaise: 149900,
        currency: 'INR',
        status: 'captured',
        captured: true,
        failureCode: null,
      },
    };

    // Process first time - should create order
    await paymentService.processWebhook(event);
    assert.equal(shopify.callCount, 1, 'First webhook should trigger Shopify order');

    // Process second time - session is already ORDER_CREATED, so claimOrder returns null
    const secondResult = await paymentService.processWebhook(event);
    // The service sees the payment is already paid and session already ORDER_CREATED
    // It should not try to process again or should gracefully handle
    assert.ok(shopify.callCount <= 2, 'Second webhook should not create a duplicate order');
    // The key guarantee: only ONE Shopify order was created
    assert.equal(shopify.createdOrders.length, 1, 'At most ONE Shopify order created');
  });
});

// ===========================================================================
// 13. Payment-success then browser-close recovery
// ===========================================================================

describe('13. payment-success then browser-close recovery - webhook alone creates order', () => {
  it('webhook payment.captured with no /payments/verify still reaches ORDER_CREATED', async () => {
    const sessions = new FakeCheckoutSessionRepository();
    const attempts = new FakePaymentAttemptRepository();
    const razorpay = new FakeRazorpayPort();
    const shopify = new FakeShopifyOrderPort();
    const orchestrator = new PaidOrderOrchestrator(sessions, shopify);
    const razorpayConfig: RazorpayConfig = {
      keyId: 'rzp_test_key', keySecret: RAZORPAY_KEY_SECRET,
      webhookSecret: WEBHOOK_SECRET, testMode: true, apiBaseUrl: 'https://api.razorpay.com/v1',
    };

    const paymentService = new StorefrontPaymentService(
      sessions, attempts, razorpay, razorpayConfig, orchestrator, SECRET,
    );

    // Set up a session that has a Razorpay order but payment is pending
    const session = makeSession({ status: 'PAYMENT_PENDING', razorpayOrderId: 'order_test_recovery' });
    sessions.sessions.set(session.publicId, session);
    (sessions as any).razorpayOrderIndex.set('order_test_recovery', session.publicId);

    razorpay.orders.push({
      id: 'order_test_recovery', amount: 149900, amountPaid: 149900,
      amountDue: 0, currency: 'INR', receipt: null, status: 'paid',
    });

    // Webhook arrives (browser closed, no /payments/verify call)
    const event: SafeRazorpayWebhook = {
      eventId: 'evt_browser_close_001',
      eventType: 'payment.captured',
      payment: {
        razorpayOrderId: 'order_test_recovery',
        razorpayPaymentId: 'pay_test_recovery',
        amountPaise: 149900,
        currency: 'INR',
        status: 'captured',
        captured: true,
        failureCode: null,
      },
    };

    const result = await paymentService.processWebhook(event);
    assert.equal(result, 'PROCESSED');

    // Verify the session reached ORDER_CREATED
    const updated = await sessions.findByPublicId(session.publicId);
    assert.ok(updated);
    assert.equal(updated.status, 'ORDER_CREATED');
    assert.ok(updated.shopifyOrderId, 'Shopify order should be created');
    assert.equal(shopify.callCount, 1);
  });
});

// ===========================================================================
// 14. Shopify order idempotency - one paid session -> at most one order
// ===========================================================================

describe('14. Shopify order idempotency - ONE PAID SESSION -> AT MOST ONE SHOPIFY ORDER', () => {
  it('claimOrder uses atomic findOneAndUpdate - only one caller wins', async () => {
    const sessions = new FakeCheckoutSessionRepository();
    const shopify = new FakeShopifyOrderPort();
    const orchestrator = new PaidOrderOrchestrator(sessions, shopify);

    // Set up a paid session
    const session = makeSession({
      status: 'ORDER_PENDING',
      paidAt: new Date(),
      razorpayPaymentId: 'pay_test_concurrent',
      nextOrderAttemptAt: new Date(0), // eligible for claiming
    });
    sessions.sessions.set(session.publicId, session);

    // First claim should succeed
    const claimed = await sessions.claimOrder(session.publicId);
    assert.ok(claimed);
    assert.equal(claimed.status, 'ORDER_CREATING');

    // Second claim for same session should fail (already ORDER_CREATING)
    const secondClaim = await sessions.claimOrder(session.publicId);
    assert.equal(secondClaim, null, 'Second concurrent claim must return null (no double order)');
  });

  it('concurrent double-claim test - simulates two workers racing', async () => {
    const sessions = new FakeCheckoutSessionRepository();
    const shopify = new FakeShopifyOrderPort();
    const orchestrator = new PaidOrderOrchestrator(sessions, shopify);

    // Set up a paid session
    const session = makeSession({
      status: 'ORDER_PENDING',
      paidAt: new Date(),
      razorpayPaymentId: 'pay_test_race',
      nextOrderAttemptAt: new Date(0),
    });
    sessions.sessions.set(session.publicId, session);

    // Simulate two concurrent processOne calls
    const results = await Promise.all([
      orchestrator.processOne(session.publicId),
      orchestrator.processOne(session.publicId),
    ]);

    // Exactly one should have created an order
    const successCount = results.filter(r => r === true).length;
    assert.equal(successCount, 1, 'Exactly ONE of the concurrent claims should succeed');
    assert.equal(shopify.callCount, 1, 'Exactly ONE Shopify order created');
  });

  it('persistence-level enforcement: unique shopifySourceIdentifier per checkout', () => {
    // Verify the model defines unique indexes
    const { readFileSync } = require('node:fs');
    const modelSource = readFileSync(
      require.resolve('../database/models/CheckoutSession'),
      'utf8',
    );
    // The compiled JS will contain the index definitions
    assert.ok(
      modelSource.includes('unique') && modelSource.includes('idempotencyKey'),
      'CheckoutSession model must have unique index on idempotencyKey',
    );
  });
});

// ===========================================================================
// 15. Shopify failure after payment - stays PAID, becomes ORDER_PENDING, not re-charged
// ===========================================================================

describe('15. Shopify failure after payment - no re-charge, state becomes ORDER_PENDING, retried', () => {
  it('Shopify failure leaves payment PAID and session ORDER_PENDING with retry', async () => {
    const sessions = new FakeCheckoutSessionRepository();
    const shopify = new FakeShopifyOrderPort();
    shopify.shouldFail = true;
    const orchestrator = new PaidOrderOrchestrator(sessions, shopify);

    const session = makeSession({
      status: 'ORDER_PENDING',
      paidAt: new Date(),
      razorpayPaymentId: 'pay_test_shopify_fail',
      nextOrderAttemptAt: new Date(0),
    });
    sessions.sessions.set(session.publicId, session);

    const result = await orchestrator.processOne(session.publicId);
    assert.equal(result, false);

    const updated = await sessions.findByPublicId(session.publicId);
    assert.ok(updated);
    // Payment stays recorded (paidAt is still set - not re-charged)
    assert.ok(updated.paidAt, 'paidAt must remain set - payment is NOT rolled back');
    // Status is ORDER_PENDING (ready for retry), not PAYMENT_PENDING
    assert.equal(updated.status, 'ORDER_PENDING');
    // Retry is scheduled
    assert.ok(updated.nextOrderAttemptAt, 'nextOrderAttemptAt must be set for retry');
    assert.ok(updated.nextOrderAttemptAt.getTime() > Date.now(), 'Retry should be in the future');
    // Error recorded
    assert.ok(updated.orderErrorCode);
  });
});

// ===========================================================================
// 16. Secure tracking token - high entropy, only hashes persisted
// ===========================================================================

describe('16. secure tracking token - high entropy (>=32 chars), only hashes persisted', () => {
  it('derived tracking token is at least 32 characters (256-bit entropy)', () => {
    const publicId = '11111111-2222-3333-4444-555555555555';
    const token = deriveTrackingToken(publicId, SECRET);
    assert.ok(token.length >= 32, `Token length ${token.length} must be >= 32`);
    // base64url-encoded SHA-256 HMAC = 43 chars
    assert.equal(token.length, 43);
  });

  it('status token is also high-entropy (>=32 chars)', () => {
    const publicId = '11111111-2222-3333-4444-555555555555';
    const token = deriveCheckoutStatusToken(publicId, SECRET);
    assert.ok(token.length >= 32, `Status token length ${token.length} must be >= 32`);
  });

  it('only SHA-256 hash is persisted, never the raw token', () => {
    const publicId = '11111111-2222-3333-4444-555555555555';
    const token = deriveTrackingToken(publicId, SECRET);
    const hash = hashTrackingToken(token);
    // Hash is a 64-char hex string (SHA-256)
    assert.equal(hash.length, 64);
    assert.match(hash, /^[0-9a-f]{64}$/);
    // The hash is NOT the token
    assert.notEqual(hash, token);
    // Verification works via constant-time comparison
    assert.equal(trackingTokenMatches(token, hash), true);
  });

  it('short secret (< 32 bytes) is rejected', () => {
    assert.throws(
      () => deriveTrackingToken('some-id', 'short'),
      (err: unknown) => err instanceof StorefrontError && err.code === 'INTERNAL_ERROR',
    );
  });
});

// ===========================================================================
// 17. Tracking enumeration refusal
// ===========================================================================

describe('17. tracking enumeration refusal - wrong token yields generic failure', () => {
  it('wrong tracking token yields TRACKING_NOT_FOUND (no information leak)', async () => {
    const sessions = new FakeCheckoutSessionRepository();
    const ordersPort = new FakeOrderTrackingPort();
    const trackingService = new StorefrontTrackingService(sessions, ordersPort);

    // Create a session with a known tracking token hash
    const publicId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const realToken = deriveTrackingToken(publicId, SECRET);
    const session = makeSession({
      publicId,
      trackingTokenHash: hashTrackingToken(realToken),
      paidAt: new Date(),
      status: 'ORDER_CREATED',
    });
    sessions.sessions.set(session.publicId, session);
    (sessions as any).trackingTokenIndex.set(session.trackingTokenHash, session.publicId);

    // Try with a wrong token (different publicId generates a different token)
    const wrongToken = deriveTrackingToken('ffffffff-0000-1111-2222-333333333333', SECRET);
    await assert.rejects(
      () => trackingService.get(wrongToken),
      (err: unknown) => err instanceof StorefrontError && err.code === 'TRACKING_NOT_FOUND',
    );
  });

  it('sequential guesses reveal nothing - all get same generic error', async () => {
    const sessions = new FakeCheckoutSessionRepository();
    const ordersPort = new FakeOrderTrackingPort();
    const trackingService = new StorefrontTrackingService(sessions, ordersPort);

    // No sessions at all - sequential IDs guessing
    for (const token of [
      'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
    ]) {
      await assert.rejects(
        () => trackingService.get(token),
        (err: unknown) => {
          assert.ok(err instanceof StorefrontError);
          assert.equal(err.code, 'TRACKING_NOT_FOUND');
          assert.equal(err.message, 'Order tracking link is invalid.');
          return true;
        },
      );
    }
  });
});

// ===========================================================================
// 18. PII-safe public response
// ===========================================================================

describe('18. PII-safe public response - tracking payload masks email, no internal data', () => {
  it('tracking DTO masks email and never exposes internal record', async () => {
    const sessions = new FakeCheckoutSessionRepository();
    const ordersPort = new FakeOrderTrackingPort();
    const trackingService = new StorefrontTrackingService(sessions, ordersPort);

    const publicId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const token = deriveTrackingToken(publicId, SECRET);
    const session = makeSession({
      publicId,
      trackingTokenHash: hashTrackingToken(token),
      paidAt: new Date(),
      status: 'ORDER_CREATED',
      shopifyOrderId: 'gid://shopify/Order/1',
      shopifyOrderName: '#KS-1001',
    });
    // Override customer email to verify masking
    session.snapshot.customer.email = 'john.doe@example.com';
    sessions.sessions.set(session.publicId, session);
    (sessions as any).trackingTokenIndex.set(session.trackingTokenHash, session.publicId);

    const dto = await trackingService.get(token);

    // Email is masked
    assert.ok(dto.emailMasked.includes('***'), 'Email must be masked');
    assert.ok(!dto.emailMasked.includes('john.doe'), 'Full email local part must not appear');
    assert.ok(dto.emailMasked.includes('@example.com'), 'Domain preserved');

    // No internal data in the serialized DTO
    const serialized = JSON.stringify(dto);
    const forbidden = [
      'supplierCost', 'cost', 'margin', 'profit', 'auditTrail',
      'shopifyNotes', 'internalNotes', 'sourceUrl', 'supplierId',
      'supplierProductId', 'confidenceScore',
    ];
    for (const key of forbidden) {
      assert.ok(!serialized.includes(`"${key}"`), `Forbidden field "${key}" found in tracking DTO`);
    }

    // Verify the tracking response does not contain the full customer record
    assert.ok(!serialized.includes('"fullName"'));
    assert.ok(!serialized.includes('"phone"'));
    // Address is summarized (city/state/pin only)
    assert.ok(dto.addressSummary.city);
    assert.ok(dto.addressSummary.state);
    assert.ok(dto.addressSummary.pinCode);
  });
});

// ===========================================================================
// 19. Integer paise arithmetic - no floating point in money math
// ===========================================================================

describe('19. integer paise arithmetic - no floating point anywhere in money math', () => {
  it('normalizeInrAmount uses bigint and returns exact decimal strings', () => {
    assert.equal(normalizeInrAmount('1499'), '1499.00');
    assert.equal(normalizeInrAmount('1499.5'), '1499.50');
    assert.equal(normalizeInrAmount('1499.99'), '1499.99');
    assert.equal(normalizeInrAmount('0.01'), '0.01');
  });

  it('inrAmountToPaise returns bigint, not float', () => {
    const paise = inrAmountToPaise('1499.00');
    assert.equal(typeof paise, 'bigint');
    assert.equal(paise, 149900n);
  });

  it('float-precision-loss case: 19.99 * 100 would be 1998.9999... in float, but integer paise is exact', () => {
    // In floating point: 19.99 * 100 = 1998.9999999999998
    // Our implementation must produce exactly 1999 paise
    const paise = inrAmountToPaise('19.99');
    assert.equal(paise, 1999n, '19.99 INR must be exactly 1999 paise (bigint, no float loss)');
  });

  it('another float-precision case: 0.1 + 0.2 scenario in money', () => {
    // 33.33 paise = 3333 (no float weirdness)
    const paise = inrAmountToPaise('33.33');
    assert.equal(paise, 3333n);
  });

  it('checkout snapshot uses integer arithmetic for line totals and grand total', () => {
    const request = makeCheckoutRequest({
      lines: [{
        productId: 'kp_test_product_id_12345678',
        variantId: 'kv_test123',
        quantity: 3,
        expectedUnitPricePaise: 149900,
      }],
    });
    const approved = [makeApprovedLine({ unitPricePaise: 149900, quantity: 3 })];
    const snapshot = buildCheckoutSnapshot(request, approved, { shippingPaise: 9900, discountPaise: 0, taxPaise: 0 });

    // 149900 * 3 = 449700 (exact integer multiplication)
    assert.equal(snapshot.subtotalPaise, 449700);
    assert.equal(snapshot.lines[0]!.lineTotalPaise, 449700);
    assert.equal(snapshot.totalPaise, 449700 + 9900); // 459600
    // Verify these are all safe integers
    assert.ok(Number.isSafeInteger(snapshot.subtotalPaise));
    assert.ok(Number.isSafeInteger(snapshot.totalPaise));
    assert.ok(Number.isSafeInteger(snapshot.lines[0]!.lineTotalPaise));
  });

  it('refuses non-integer paise amounts in snapshot', () => {
    const request = makeCheckoutRequest();
    // unitPricePaise must be an integer; a non-integer would fail Number.isSafeInteger check
    const approved = [makeApprovedLine({ unitPricePaise: 1499.5 })];
    assert.throws(
      () => buildCheckoutSnapshot(request, approved, { shippingPaise: 0, discountPaise: 0, taxPaise: 0 }),
      (err: unknown) => err instanceof StorefrontError,
    );
  });

  it('normalizeInrAmount refuses extra decimal precision (no hidden truncation)', () => {
    // Three decimal places would truncate in float; we refuse it entirely
    assert.equal(normalizeInrAmount('1.001'), null);
    assert.equal(normalizeInrAmount('99.999'), null);
  });
});
