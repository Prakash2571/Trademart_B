import { config } from '../../config';
import { getTokenProvider } from '../../shopify/token';
import { StorefrontError } from '../checkout/storefront.error';
import type { CheckoutSessionRecord } from '../checkout/checkout.types';
import {
  KANAY_ORDER_BY_SOURCE_IDENTIFIER_QUERY,
  KANAY_ORDER_CREATE_MUTATION,
} from './shopify-order.mutation';

export interface CreatedShopifyOrder {
  id: string;
  name: string;
  createdAt: Date;
}

export interface ShopifyOrderCreationPort {
  ensureOrder(session: CheckoutSessionRecord): Promise<CreatedShopifyOrder>;
}

interface RawShopifyOrder {
  id?: unknown;
  name?: unknown;
  createdAt?: unknown;
  sourceIdentifier?: unknown;
  displayFinancialStatus?: unknown;
  currentTotalPriceSet?: {
    shopMoney?: { amount?: unknown; currencyCode?: unknown } | null;
  } | null;
}

interface GraphqlEnvelope<T> {
  data?: T | null;
  errors?: { message?: unknown; extensions?: { code?: unknown } | null }[] | null;
}

function money(amountPaise: number): { amount: string; currencyCode: 'INR' } {
  if (!Number.isSafeInteger(amountPaise) || amountPaise < 0) {
    throw new StorefrontError('INTERNAL_ERROR', 'Shopify order amount was invalid.', 500);
  }
  return { amount: (amountPaise / 100).toFixed(2), currencyCode: 'INR' };
}

function splitName(fullName: string): { firstName: string; lastName: string } {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0]!, lastName: '-' };
  return { firstName: parts.slice(0, -1).join(' '), lastName: parts.at(-1)! };
}

function mapOrder(
  raw: RawShopifyOrder,
  session: CheckoutSessionRecord,
): CreatedShopifyOrder | null {
  if (
    typeof raw.id !== 'string' ||
    typeof raw.name !== 'string' ||
    typeof raw.createdAt !== 'string' ||
    raw.sourceIdentifier !== session.shopifySourceIdentifier
  ) {
    return null;
  }
  const shopMoney = raw.currentTotalPriceSet?.shopMoney;
  if (
    shopMoney?.currencyCode !== 'INR' ||
    typeof shopMoney.amount !== 'string' ||
    Math.round(Number(shopMoney.amount) * 100) !== session.snapshot.totalPaise
  ) {
    throw new StorefrontError(
      'INTERNAL_ERROR',
      'Reconciled Shopify order total did not match the paid checkout snapshot.',
      500,
    );
  }
  return { id: raw.id, name: raw.name, createdAt: new Date(raw.createdAt) };
}

export class ShopifyOrderCreateAdapter implements ShopifyOrderCreationPort {
  public constructor(
    private readonly testMode: boolean,
    private readonly requestFetch: typeof fetch = fetch,
  ) {}

  /**
   * One network attempt only. Retrying an uncertain orderCreate inside the HTTP
   * client can duplicate an order because this mutation is not @idempotent.
   */
  private async graphqlOnce<T>(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<T> {
    const provider = getTokenProvider();
    if (!provider) {
      throw new StorefrontError('ORDER_CREATION_PENDING', 'Shopify is not configured.', 503, undefined, true);
    }
    const token = await provider.getAccessToken(config.shopify.storeDomain);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    let response: Response;
    try {
      response = await this.requestFetch(config.shopify.graphqlEndpoint, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': token.accessToken,
          'User-Agent': 'Trademart-Kanay-Store/1.0',
        },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      });
    } catch {
      throw new StorefrontError(
        'ORDER_CREATION_PENDING',
        'Shopify order outcome is not confirmed yet.',
        503,
        { outcomeUncertain: true },
        true,
      );
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      throw new StorefrontError(
        'ORDER_CREATION_PENDING',
        'Shopify order creation is temporarily unavailable.',
        503,
        { providerStatus: response.status },
        response.status === 429 || response.status >= 500,
      );
    }
    const envelope = (await response.json()) as GraphqlEnvelope<T>;
    if (envelope.errors?.length) {
      const code = envelope.errors[0]?.extensions?.code;
      throw new StorefrontError(
        'ORDER_CREATION_PENDING',
        'Shopify did not accept the order yet.',
        503,
        { providerCode: typeof code === 'string' ? code : undefined },
        code === 'THROTTLED',
      );
    }
    if (!envelope.data) {
      throw new StorefrontError('ORDER_CREATION_PENDING', 'Shopify returned no order data.', 503, undefined, true);
    }
    return envelope.data;
  }

  private async findExisting(session: CheckoutSessionRecord): Promise<CreatedShopifyOrder | null> {
    const data = await this.graphqlOnce<{ orders?: { nodes?: RawShopifyOrder[] | null } | null }>(
      KANAY_ORDER_BY_SOURCE_IDENTIFIER_QUERY,
      { query: `source_identifier:${session.shopifySourceIdentifier}` },
    );
    const matches = (data.orders?.nodes ?? [])
      .filter((row) => row.sourceIdentifier === session.shopifySourceIdentifier)
      .map((row) => mapOrder(row, session))
      .filter((row): row is CreatedShopifyOrder => row !== null);
    if (matches.length > 1) {
      throw new StorefrontError(
        'INTERNAL_ERROR',
        'More than one Shopify order exists for this paid checkout. Manual review is required.',
        500,
      );
    }
    return matches[0] ?? null;
  }

  private input(session: CheckoutSessionRecord): Record<string, unknown> {
    if (session.snapshot.discountPaise !== 0 || session.snapshot.taxPaise !== 0) {
      // Do not make Shopify totals lie. The v1 policy supplies zero for both; a
      // future policy needs an explicit Shopify discount/tax representation here.
      throw new StorefrontError(
        'INTERNAL_ERROR',
        'Configured discount or tax cannot yet be represented exactly in Shopify.',
        500,
      );
    }
    if (!session.razorpayPaymentId) {
      throw new StorefrontError('ORDER_CREATION_PENDING', 'Verified payment is not recorded yet.', 409, undefined, true);
    }
    const name = splitName(session.snapshot.customer.fullName);
    const address = session.snapshot.shippingAddress;
    const order: Record<string, unknown> = {
      currency: 'INR',
      presentmentCurrency: 'INR',
      email: session.snapshot.customer.email,
      phone: session.snapshot.customer.phone,
      financialStatus: 'PAID',
      test: this.testMode,
      sourceIdentifier: session.shopifySourceIdentifier,
      tags: ['kanay-store', 'razorpay-paid'],
      customAttributes: [
        { key: 'kanay_checkout_id', value: session.publicId },
        { key: 'razorpay_order_id', value: session.razorpayOrderId },
      ],
      shippingAddress: {
        firstName: name.firstName,
        lastName: name.lastName,
        address1: address.addressLine1,
        address2: address.addressLine2,
        city: address.city,
        province: address.state,
        zip: address.pinCode,
        countryCode: 'IN',
        phone: session.snapshot.customer.phone,
      },
      lineItems: session.snapshot.lines.map((line) => ({
        variantId: line.shopifyVariantId,
        quantity: line.quantity,
        priceSet: { shopMoney: money(line.unitPricePaise) },
        requiresShipping: true,
      })),
      transactions: [
        {
          amountSet: { shopMoney: money(session.snapshot.totalPaise) },
          gateway: 'Razorpay',
          kind: 'SALE',
          status: 'SUCCESS',
          authorizationCode: session.razorpayPaymentId,
          test: this.testMode,
        },
      ],
    };
    if (session.snapshot.shippingPaise > 0) {
      order['shippingLines'] = [
        {
          title: 'Standard shipping',
          code: 'KANAY_STANDARD',
          source: 'Kanay Store',
          priceSet: { shopMoney: money(session.snapshot.shippingPaise) },
        },
      ];
    }
    return order;
  }

  public async ensureOrder(session: CheckoutSessionRecord): Promise<CreatedShopifyOrder> {
    const existing = await this.findExisting(session);
    if (existing) return existing;

    try {
      const data = await this.graphqlOnce<{
        orderCreate?: {
          order?: RawShopifyOrder | null;
          userErrors?: { field?: unknown; message?: unknown }[] | null;
        } | null;
      }>(KANAY_ORDER_CREATE_MUTATION, {
        order: this.input(session),
        options: { sendReceipt: false, sendFulfillmentReceipt: false, inventoryBehaviour: 'DECREMENT_OBEYING_POLICY' },
      });
      const result = data.orderCreate;
      if (result?.userErrors?.length) {
        throw new StorefrontError(
          'ORDER_CREATION_PENDING',
          'Shopify rejected the order details. The paid checkout is queued for review.',
          503,
          { userErrorCount: result.userErrors.length },
        );
      }
      const order = result?.order ? mapOrder(result.order, session) : null;
      if (!order) {
        throw new StorefrontError('ORDER_CREATION_PENDING', 'Shopify returned an invalid order.', 503, undefined, true);
      }
      return order;
    } catch (error) {
      // If the create response was lost after Shopify committed it, a safe read
      // can recover the order. Never issue a second create in this attempt.
      if (error instanceof StorefrontError && error.details && typeof error.details === 'object' && 'outcomeUncertain' in error.details) {
        try {
          const recovered = await this.findExisting(session);
          if (recovered) return recovered;
        } catch {
          // Retain the uncertain outcome and let the durable retry query again later.
        }
      }
      throw error;
    }
  }
}
