import { StorefrontError } from '../checkout/storefront.error';

export interface RazorpayConfig {
  keyId: string;
  keySecret: string;
  webhookSecret: string;
  testMode: boolean;
  apiBaseUrl: string;
}

export function loadRazorpayConfig(
  env: Record<string, string | undefined>,
  nodeEnv: 'development' | 'test' | 'production',
): RazorpayConfig {
  const keyId = env['RAZORPAY_KEY_ID']?.trim() ?? '';
  const keySecret = env['RAZORPAY_KEY_SECRET']?.trim() ?? '';
  const webhookSecret = env['RAZORPAY_WEBHOOK_SECRET']?.trim() ?? '';
  if (!/^rzp_(test|live)_[A-Za-z0-9]+$/.test(keyId) || keySecret.length < 8) {
    throw new StorefrontError(
      'PAYMENT_NOT_CONFIGURED',
      'Payment is temporarily unavailable.',
      503,
    );
  }
  if (webhookSecret.length < 8) {
    throw new StorefrontError(
      'PAYMENT_NOT_CONFIGURED',
      'Payment reconciliation is not configured.',
      503,
    );
  }
  const testMode = keyId.startsWith('rzp_test_');
  if (nodeEnv !== 'production' && !testMode) {
    throw new StorefrontError(
      'PAYMENT_NOT_CONFIGURED',
      'Development and test environments require Razorpay test credentials.',
      503,
    );
  }
  return {
    keyId,
    keySecret,
    webhookSecret,
    testMode,
    apiBaseUrl: 'https://api.razorpay.com/v1',
  };
}
