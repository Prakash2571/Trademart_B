export type StorefrontErrorCode =
  | 'VALIDATION_ERROR'
  | 'PRODUCT_UNAVAILABLE'
  | 'VARIANT_UNAVAILABLE'
  | 'PRICE_CHANGED'
  | 'PRICE_INVALID'
  | 'PAYMENT_NOT_CONFIGURED'
  | 'PAYMENT_FAILED'
  | 'PAYMENT_PENDING'
  | 'PAYMENT_INVALID_SIGNATURE'
  | 'PAYMENT_MISMATCH'
  | 'ORDER_CREATION_PENDING'
  | 'TRACKING_NOT_FOUND'
  | 'IDEMPOTENCY_CONFLICT'
  | 'DATABASE_UNAVAILABLE'
  | 'INTERNAL_ERROR';

export class StorefrontError extends Error {
  public constructor(
    public readonly code: StorefrontErrorCode,
    message: string,
    public readonly status: number,
    public readonly details?: unknown,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = 'StorefrontError';
    Error.captureStackTrace?.(this, StorefrontError);
  }
}

export function asStorefrontError(error: unknown): StorefrontError {
  if (error instanceof StorefrontError) return error;
  return new StorefrontError(
    'INTERNAL_ERROR',
    'Something went wrong while preparing your order. Please try again.',
    500,
    undefined,
    true,
  );
}
