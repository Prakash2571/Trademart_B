import {
  PAYMENT_ATTEMPT_STATUSES,
  PaymentAttemptModel,
} from '../../database/models/PaymentAttempt';
import { StorefrontError } from '../checkout/storefront.error';

export type PaymentAttemptStatus = (typeof PAYMENT_ATTEMPT_STATUSES)[number];

export interface ObservedPaymentAttempt {
  checkoutPublicId: string;
  razorpayOrderId: string;
  razorpayPaymentId: string;
  status: PaymentAttemptStatus;
  amountPaise: number;
  currency: 'INR';
  captured: boolean;
  source: 'BROWSER_VERIFY' | 'WEBHOOK';
  providerObservedAt: Date;
  failureCode?: string | null;
  failureMessage?: string | null;
}

export interface PaymentAttemptRepository {
  observe(input: ObservedPaymentAttempt): Promise<void>;
}

const RANK: Record<PaymentAttemptStatus, number> = {
  FAILED: 0,
  AUTHORIZED: 1,
  CAPTURED: 2,
  PAID: 3,
  REFUNDED: 4,
};

export class MongoosePaymentAttemptRepository implements PaymentAttemptRepository {
  public async observe(input: ObservedPaymentAttempt): Promise<void> {
    const existing = await PaymentAttemptModel.findOne({
      razorpayPaymentId: input.razorpayPaymentId,
    }).lean();
    if (existing && existing.checkoutPublicId !== input.checkoutPublicId) {
      throw new StorefrontError(
        'PAYMENT_MISMATCH',
        'Payment identifier is already associated with another checkout.',
        409,
      );
    }
    if (existing && RANK[existing.status as PaymentAttemptStatus] > RANK[input.status]) {
      return;
    }

    await PaymentAttemptModel.updateOne(
      { razorpayPaymentId: input.razorpayPaymentId },
      {
        $set: {
          ...input,
          failureCode: input.failureCode ?? null,
          failureMessage: input.failureMessage?.slice(0, 240) ?? null,
        },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true },
    );
  }
}
