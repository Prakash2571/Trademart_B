import { CheckoutSessionModel } from '../../database/models/CheckoutSession';
import { StorefrontError } from './storefront.error';
import type {
  CheckoutSessionRecord,
  CheckoutSessionRepository,
  NewCheckoutSession,
} from './checkout.types';

const ORDER_LEASE_MS = 5 * 60_000;

function record(value: unknown): CheckoutSessionRecord {
  return value as CheckoutSessionRecord;
}

function databaseError(message: string): StorefrontError {
  return new StorefrontError('DATABASE_UNAVAILABLE', message, 503, undefined, true);
}

export class MongooseCheckoutSessionRepository implements CheckoutSessionRepository {
  public async findByIdempotencyKey(key: string): Promise<CheckoutSessionRecord | null> {
    const row = await CheckoutSessionModel.findOne({ idempotencyKey: key }).lean();
    return row ? record(row) : null;
  }

  public async findByPublicId(publicId: string): Promise<CheckoutSessionRecord | null> {
    const row = await CheckoutSessionModel.findOne({ publicId }).lean();
    return row ? record(row) : null;
  }

  public async findByRazorpayOrderId(orderId: string): Promise<CheckoutSessionRecord | null> {
    const row = await CheckoutSessionModel.findOne({ razorpayOrderId: orderId }).lean();
    return row ? record(row) : null;
  }

  public async findByStatusTokenHash(
    publicId: string,
    hash: string,
  ): Promise<CheckoutSessionRecord | null> {
    const row = await CheckoutSessionModel.findOne({ publicId, statusTokenHash: hash }).lean();
    return row ? record(row) : null;
  }

  public async findByTrackingTokenHash(hash: string): Promise<CheckoutSessionRecord | null> {
    const row = await CheckoutSessionModel.findOne({ trackingTokenHash: hash }).lean();
    return row ? record(row) : null;
  }

  public async create(input: NewCheckoutSession): Promise<CheckoutSessionRecord> {
    try {
      const row = await CheckoutSessionModel.create({
        ...input,
        status: 'CREATED',
        razorpayOrderId: null,
        razorpayPaymentId: null,
        razorpayOrderStatus: null,
        paidAt: null,
        shopifyOrderId: null,
        shopifyOrderName: null,
        shopifyOrderCreatedAt: null,
        orderAttempts: 0,
        nextOrderAttemptAt: null,
        orderLeaseExpiresAt: null,
      });
      return record(row.toObject());
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (code === 11000 || code === 11001) {
        const existing = await this.findByIdempotencyKey(input.idempotencyKey);
        if (existing) return existing;
      }
      throw databaseError('Checkout could not be saved. Please try again.');
    }
  }

  public async attachRazorpayOrder(input: {
    publicId: string;
    razorpayOrderId: string;
    razorpayOrderStatus: string;
  }): Promise<CheckoutSessionRecord> {
    const row = await CheckoutSessionModel.findOneAndUpdate(
      {
        publicId: input.publicId,
        $or: [{ razorpayOrderId: null }, { razorpayOrderId: input.razorpayOrderId }],
      },
      {
        $set: {
          razorpayOrderId: input.razorpayOrderId,
          razorpayOrderStatus: input.razorpayOrderStatus,
          status: 'PAYMENT_PENDING',
        },
      },
      { new: true },
    ).lean();
    if (!row) {
      throw databaseError('Checkout payment order could not be attached safely.');
    }
    return record(row);
  }

  public async markPaid(input: {
    publicId: string;
    razorpayOrderId: string;
    razorpayPaymentId: string;
    paidAt: Date;
  }): Promise<CheckoutSessionRecord> {
    const row = await CheckoutSessionModel.findOneAndUpdate(
      {
        publicId: input.publicId,
        razorpayOrderId: input.razorpayOrderId,
        status: { $in: ['CREATED', 'PAYMENT_PENDING', 'PAYMENT_PAID', 'ORDER_PENDING', 'ORDER_CREATING'] },
        $or: [{ razorpayPaymentId: null }, { razorpayPaymentId: input.razorpayPaymentId }],
      },
      {
        $set: {
          razorpayPaymentId: input.razorpayPaymentId,
          razorpayOrderStatus: 'paid',
          paidAt: input.paidAt,
          status: 'ORDER_PENDING',
          nextOrderAttemptAt: new Date(),
        },
      },
      { new: true },
    ).lean();
    if (row) return record(row);

    const existing = await this.findByPublicId(input.publicId);
    if (
      existing &&
      existing.razorpayOrderId === input.razorpayOrderId &&
      existing.razorpayPaymentId === input.razorpayPaymentId &&
      existing.status === 'ORDER_CREATED'
    ) {
      return existing;
    }
    throw new StorefrontError(
      'PAYMENT_MISMATCH',
      'Payment could not be matched to this checkout.',
      409,
    );
  }

  public async markRefunded(input: {
    publicId: string;
    razorpayPaymentId: string;
    refundedAt: Date;
  }): Promise<CheckoutSessionRecord> {
    const row = await CheckoutSessionModel.findOneAndUpdate(
      { publicId: input.publicId, razorpayPaymentId: input.razorpayPaymentId },
      { $set: { status: 'REFUNDED', refundedAt: input.refundedAt } },
      { new: true },
    ).lean();
    if (!row) {
      throw new StorefrontError('PAYMENT_MISMATCH', 'Refund did not match a checkout.', 409);
    }
    return record(row);
  }

  public async claimOrder(publicId?: string): Promise<CheckoutSessionRecord | null> {
    const now = new Date();
    const filter: Record<string, unknown> = {
      $or: [
        {
          status: { $in: ['PAYMENT_PAID', 'ORDER_PENDING'] },
          nextOrderAttemptAt: { $lte: now },
        },
        { status: 'ORDER_CREATING', orderLeaseExpiresAt: { $lte: now } },
      ],
    };
    if (publicId !== undefined) filter['publicId'] = publicId;

    const row = await CheckoutSessionModel.findOneAndUpdate(
      filter,
      {
        $set: {
          status: 'ORDER_CREATING',
          orderLeaseExpiresAt: new Date(now.getTime() + ORDER_LEASE_MS),
          nextOrderAttemptAt: null,
        },
        $inc: { orderAttempts: 1 },
      },
      { sort: { paidAt: 1 }, new: true },
    ).lean();
    return row ? record(row) : null;
  }

  public async markOrderCreated(input: {
    publicId: string;
    shopifyOrderId: string;
    shopifyOrderName: string;
    createdAt: Date;
  }): Promise<CheckoutSessionRecord> {
    const row = await CheckoutSessionModel.findOneAndUpdate(
      {
        publicId: input.publicId,
        status: { $in: ['ORDER_CREATING', 'ORDER_PENDING', 'ORDER_CREATED'] },
        $or: [{ shopifyOrderId: null }, { shopifyOrderId: input.shopifyOrderId }],
      },
      {
        $set: {
          status: 'ORDER_CREATED',
          shopifyOrderId: input.shopifyOrderId,
          shopifyOrderName: input.shopifyOrderName,
          shopifyOrderCreatedAt: input.createdAt,
          orderLeaseExpiresAt: null,
          nextOrderAttemptAt: null,
          orderErrorCode: null,
          orderErrorMessage: null,
        },
      },
      { new: true },
    ).lean();
    if (!row) {
      throw databaseError('Created Shopify order could not be recorded safely.');
    }
    return record(row);
  }

  public async releaseOrderForRetry(input: {
    publicId: string;
    nextAttemptAt: Date;
    errorCode: string;
    errorMessage: string;
  }): Promise<void> {
    await CheckoutSessionModel.updateOne(
      { publicId: input.publicId, status: 'ORDER_CREATING' },
      {
        $set: {
          status: 'ORDER_PENDING',
          nextOrderAttemptAt: input.nextAttemptAt,
          orderLeaseExpiresAt: null,
          orderErrorCode: input.errorCode,
          orderErrorMessage: input.errorMessage.slice(0, 500),
        },
      },
    );
  }
}
