export const CHECKOUT_STATUSES = [
  'CREATED',
  'PAYMENT_PENDING',
  'PAYMENT_PAID',
  'ORDER_PENDING',
  'ORDER_CREATING',
  'ORDER_CREATED',
  'REFUNDED',
] as const;

export type CheckoutStatus = (typeof CHECKOUT_STATUSES)[number];

/**
 * Frontend-facing status vocabulary. The backend retains richer internal state.
 *
 * CREATED, PAYMENT_PENDING → PAYMENT_PENDING
 * PAYMENT_PAID → PAID
 * ORDER_PENDING, ORDER_CREATING → ORDER_PENDING
 * ORDER_CREATED → COMPLETE
 * REFUNDED is handled via paymentStatus = REFUNDED (mapped separately)
 */
export type PublicCheckoutStatus = 'PAYMENT_PENDING' | 'PAID' | 'ORDER_PENDING' | 'COMPLETE';

export function mapToPublicCheckoutStatus(internal: CheckoutStatus): PublicCheckoutStatus {
  switch (internal) {
    case 'CREATED':
    case 'PAYMENT_PENDING':
      return 'PAYMENT_PENDING';
    case 'PAYMENT_PAID':
      return 'PAID';
    case 'ORDER_PENDING':
    case 'ORDER_CREATING':
      return 'ORDER_PENDING';
    case 'ORDER_CREATED':
      return 'COMPLETE';
    case 'REFUNDED':
      // REFUNDED is surfaced via paymentStatus; map to the last meaningful order status.
      return 'COMPLETE';
  }
}

export interface CheckoutCustomer {
  fullName: string;
  email: string;
  phone: string;
}

export interface ShippingAddress {
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  state: string;
  pinCode: string;
  countryCode: 'IN';
}

/** The browser may identify a line, but it never supplies an authoritative total. */
export interface RequestedCheckoutLine {
  productId: string;
  variantId: string;
  quantity: number;
  /** Display snapshot only. A mismatch is returned as PRICE_CHANGED, never charged. */
  expectedUnitPricePaise?: number;
  /**
   * Optional Shopify variant GID supplied by the browser.
   * Cross-checked against the durable mapping; a mismatch throws VARIANT_UNAVAILABLE.
   */
  shopifyVariantId?: string;
  /**
   * Optional Shopify product GID supplied by the browser.
   * Only used for cross-check; the opaque productId remains the primary identity.
   */
  shopifyProductId?: string;
}

export interface CreateCheckoutRequest {
  lines: RequestedCheckoutLine[];
  customer: CheckoutCustomer;
  shippingAddress: ShippingAddress;
}

export interface AuthoritativeCheckoutLine {
  publicProductId: string;
  publicVariantId: string;
  shopifyProductId: string;
  shopifyVariantId: string;
  title: string;
  variantTitle: string | null;
  selectedOptions: { name: string; value: string }[];
  image: { url: string; alt: string | null } | null;
  quantity: number;
  unitPricePaise: number;
  currencyCode: 'INR';
  availableQuantity: number | null;
  sellability: 'SELLABLE' | 'OUT_OF_STOCK' | 'UNAVAILABLE';
  /**
   * The product's wholesale minimum, re-read from Shopify during revalidation.
   *
   * Authoritative: the browser also knows this number and uses it to set the quantity
   * stepper, but a request that ignores it is refused here. Null means no minimum.
   */
  minimumOrderQuantity: number | null;
}

export interface CheckoutSnapshotLine extends AuthoritativeCheckoutLine {
  lineTotalPaise: number;
}

export interface CheckoutSnapshot {
  lines: CheckoutSnapshotLine[];
  subtotalPaise: number;
  shippingPaise: number;
  discountPaise: number;
  taxPaise: number;
  totalPaise: number;
  currency: 'INR';
  customer: CheckoutCustomer;
  shippingAddress: ShippingAddress;
}

export interface ShippingQuote {
  shippingPaise: number;
  discountPaise: number;
  taxPaise: number;
}

export interface CheckoutCatalogPort {
  /** Must re-read current sourceability, Shopify visibility/variant, stock, and INR price. */
  revalidateLines(lines: RequestedCheckoutLine[]): Promise<AuthoritativeCheckoutLine[]>;
}

export interface CustomerShippingPolicyPort {
  quote(input: {
    lines: readonly AuthoritativeCheckoutLine[];
    subtotalPaise: number;
    shippingAddress: ShippingAddress;
  }): Promise<ShippingQuote>;
}

export interface CheckoutSessionRecord {
  publicId: string;
  idempotencyKey: string;
  requestHash: string;
  status: CheckoutStatus;
  snapshot: CheckoutSnapshot;
  statusTokenHash: string;
  trackingTokenHash: string;
  razorpayOrderId: string | null;
  razorpayPaymentId: string | null;
  razorpayOrderStatus: string | null;
  paidAt: Date | null;
  shopifySourceIdentifier: string;
  shopifyOrderId: string | null;
  shopifyOrderName: string | null;
  shopifyOrderCreatedAt: Date | null;
  orderAttempts: number;
  nextOrderAttemptAt: Date | null;
  orderLeaseExpiresAt: Date | null;
  orderErrorCode: string | null;
  orderErrorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewCheckoutSession {
  publicId: string;
  idempotencyKey: string;
  requestHash: string;
  snapshot: CheckoutSnapshot;
  statusTokenHash: string;
  trackingTokenHash: string;
  shopifySourceIdentifier: string;
}

export interface CheckoutSessionRepository {
  findByIdempotencyKey(key: string): Promise<CheckoutSessionRecord | null>;
  findByPublicId(publicId: string): Promise<CheckoutSessionRecord | null>;
  findByRazorpayOrderId(orderId: string): Promise<CheckoutSessionRecord | null>;
  findByStatusTokenHash(publicId: string, hash: string): Promise<CheckoutSessionRecord | null>;
  findByTrackingTokenHash(hash: string): Promise<CheckoutSessionRecord | null>;
  create(input: NewCheckoutSession): Promise<CheckoutSessionRecord>;
  attachRazorpayOrder(input: {
    publicId: string;
    razorpayOrderId: string;
    razorpayOrderStatus: string;
  }): Promise<CheckoutSessionRecord>;
  markPaid(input: {
    publicId: string;
    razorpayOrderId: string;
    razorpayPaymentId: string;
    paidAt: Date;
  }): Promise<CheckoutSessionRecord>;
  markRefunded(input: {
    publicId: string;
    razorpayPaymentId: string;
    refundedAt: Date;
  }): Promise<CheckoutSessionRecord>;
  claimOrder(publicId?: string): Promise<CheckoutSessionRecord | null>;
  markOrderCreated(input: {
    publicId: string;
    shopifyOrderId: string;
    shopifyOrderName: string;
    createdAt: Date;
  }): Promise<CheckoutSessionRecord>;
  releaseOrderForRetry(input: {
    publicId: string;
    nextAttemptAt: Date;
    errorCode: string;
    errorMessage: string;
  }): Promise<void>;
}

export interface CreateCheckoutResponse {
  checkoutSessionId: string;
  statusToken: string;
  razorpayOrderId: string;
  amountPaise: number;
  currency: 'INR';
  keyId: string;
  summary: {
    items: {
      title: string;
      variantTitle: string | null;
      quantity: number;
      unitPricePaise: number;
      lineTotalPaise: number;
      image?: { url: string; alt: string | null };
    }[];
    subtotalPaise: number;
    shippingPaise: number;
    discountPaise: number;
    taxPaise: number;
    totalPaise: number;
  };
}
