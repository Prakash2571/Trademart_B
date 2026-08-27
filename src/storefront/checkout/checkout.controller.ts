import { Router, raw } from 'express';

import { sendSuccess } from '../../common/http';
import { incrementCounter } from '../../common/metrics';
import { requireAllowedOrigin, storefrontHandler } from '../http/storefront.http';
import type { CheckoutService } from './checkout.service';
import { StorefrontError } from './storefront.error';
import { validateCreateCheckoutRequest, validateIdempotencyKey } from './checkout.validation';
import type { StorefrontPaymentService, VerifyPaymentInput } from '../payments/payment.service';
import type { RazorpayConfig } from '../payments/razorpay.config';
import { verifyRazorpayWebhookSignature } from '../payments/razorpay.signature';
import { parseSafeRazorpayWebhook } from '../payments/razorpay.webhook';
import {
  drainRazorpayWebhookQueue,
  enqueueRazorpayWebhook,
} from '../payments/payment-webhook.queue';

function bodyObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function createStorefrontCheckoutRouter(input: {
  checkout: CheckoutService;
  payments: StorefrontPaymentService;
  allowedOrigins: readonly string[];
}): Router {
  const router = Router();
  const origin = requireAllowedOrigin(input.allowedOrigins);

  router.post(
    '/storefront/checkout',
    origin,
    storefrontHandler(async (req, res) => {
      const rawBody = bodyObject(req.body);
      const idempotencyKey = validateIdempotencyKey(
        req.header('Idempotency-Key') ?? rawBody['idempotencyKey'],
      );
      const data = await input.checkout
        .create(validateCreateCheckoutRequest(rawBody), idempotencyKey)
        .catch((error: unknown) => {
          // Counted here rather than inside the service so one increment covers every
          // reason a checkout can fail to be created - including validation, which is
          // the signal that the storefront and backend have drifted apart.
          incrementCounter('storefront.checkout.failed');
          throw error;
        });
      res.status(201);
      sendSuccess(res, data);
    }),
  );

  router.post(
    '/storefront/payments/verify',
    origin,
    storefrontHandler(async (req, res) => {
      const body = bodyObject(req.body);
      const data = await input.payments.verify({
        checkoutSessionId: String(body['checkoutSessionId'] ?? ''),
        razorpayOrderId: String(body['razorpayOrderId'] ?? ''),
        razorpayPaymentId: String(body['razorpayPaymentId'] ?? ''),
        razorpaySignature: String(body['razorpaySignature'] ?? ''),
      } satisfies VerifyPaymentInput);
      res.status(data.status === 'COMPLETE' ? 200 : 202);
      sendSuccess(res, data);
    }),
  );

  router.get(
    '/storefront/checkout/:id/status',
    storefrontHandler(async (req, res) => {
      const token = typeof req.query['token'] === 'string' ? req.query['token'] : '';
      sendSuccess(res, await input.payments.status(req.params['id'] ?? '', token));
    }),
  );

  return router;
}

/** Mount before express.json(); HMAC verification requires exact raw bytes. */
export function createRazorpayWebhookRouter(config: RazorpayConfig): Router {
  const router = Router();
  router.post(
    '/webhooks/razorpay',
    raw({ type: '*/*', limit: '512kb' }),
    storefrontHandler(async (req, res) => {
      const rawBody = Buffer.isBuffer(req.body) ? req.body : undefined;
      if (
        !verifyRazorpayWebhookSignature({
          rawBody,
          providedSignature: req.header('X-Razorpay-Signature'),
          webhookSecret: config.webhookSecret,
        })
      ) {
        throw new StorefrontError(
          'PAYMENT_INVALID_SIGNATURE',
          'Webhook signature could not be verified.',
          401,
        );
      }
      const event = parseSafeRazorpayWebhook(
        rawBody!,
        req.header('X-Razorpay-Event-Id'),
      );
      const result = await enqueueRazorpayWebhook(event);
      res.status(result.duplicate ? 200 : 202).json({
        success: true,
        duplicate: result.duplicate,
        queued: !result.duplicate,
      });
      if (!result.duplicate) {
        void drainRazorpayWebhookQueue(1).catch(() => undefined);
      }
    }),
  );
  return router;
}
