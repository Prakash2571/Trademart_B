import { Router, raw, type NextFunction, type Request, type RequestHandler, type Response } from 'express';

import { sendSuccess } from '../../common/http';
import { getRequestId } from '../../common/requestContext';
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

function storefrontHandler(
  fn: (req: Request, res: Response) => Promise<void>,
): RequestHandler {
  return (req, res, next: NextFunction) => {
    fn(req, res).catch((error: unknown) => {
      if (!(error instanceof StorefrontError)) {
        next(error);
        return;
      }
      const requestId = getRequestId();
      res.status(error.status).json({
        success: false,
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
        ...(requestId ? { requestId } : {}),
        error: {
          code: error.code,
          message: error.message,
          ...(error.details === undefined ? {} : { details: error.details }),
          ...(requestId ? { requestId } : {}),
        },
      });
    });
  };
}

function requireAllowedOrigin(allowedOrigins: readonly string[]): RequestHandler {
  const allowed = new Set(allowedOrigins.map((origin) => origin.replace(/\/+$/, '')));
  return (req, res, next) => {
    const origin = req.header('Origin');
    if (origin && !allowed.has(origin.replace(/\/+$/, ''))) {
      res.status(403).json({
        success: false,
        code: 'FORBIDDEN',
        message: 'This storefront origin is not allowed.',
      });
      return;
    }
    next();
  };
}

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
      const data = await input.checkout.create(validateCreateCheckoutRequest(rawBody), idempotencyKey);
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
