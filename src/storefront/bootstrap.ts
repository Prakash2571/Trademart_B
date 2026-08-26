/**
 * Storefront composition root.
 *
 * Instantiates all storefront services, wires their dependencies, and returns
 * the routers ready for mounting in app.ts. Returns null when Razorpay
 * credentials are absent (the operator panel still works, just no public
 * commerce surface).
 */

import type { Router } from 'express';

import { config, isStorefrontPaymentConfigured } from '../config';
import { logger } from '../common/logger';
import { storefrontCatalogRouter } from './catalog';
import {
  createStorefrontCheckoutRouter,
  createRazorpayWebhookRouter,
} from './checkout/checkout.controller';
import { createStorefrontOrdersRouter } from './orders/orders.controller';
import { CheckoutService } from './checkout/checkout.service';
import { MongooseCheckoutSessionRepository } from './checkout/checkout.repository';
import { MongoosePaymentAttemptRepository } from './payments/payment.repository';
import { StorefrontPaymentService } from './payments/payment.service';
import { loadRazorpayConfig } from './payments/razorpay.config';
import { RazorpayHttpClient } from './payments/razorpay.client';
import {
  registerRazorpayWebhookProcessor,
  startRazorpayWebhookWorker,
  stopRazorpayWebhookWorker,
} from './payments/payment-webhook.queue';
import {
  PaidOrderOrchestrator,
  registerPaidOrderOrchestrator,
  startPaidOrderWorker,
  stopPaidOrderWorker,
} from './orders/order.orchestrator';
import { ShopifyOrderCreateAdapter } from './orders/shopify-order.adapter';
import { StorefrontTrackingService } from './orders/tracking.service';
import { ShopifyOrderTrackingAdapter } from './orders/shopify-tracking.adapter';
import { StorefrontCatalogCheckoutAdapter } from './checkout/catalog-checkout.adapter';
import type {
  AuthoritativeCheckoutLine,
  CustomerShippingPolicyPort,
  ShippingAddress,
  ShippingQuote,
} from './checkout/checkout.types';

export interface StorefrontRouters {
  catalogRouter: Router;
  checkoutRouter: Router;
  ordersRouter: Router;
  razorpayWebhookRouter: Router;
}

// ---- Default shipping policy ------------------------------------------------
// ₹79 standard, free above ₹999. Matches the Kanay frontend constants:
// NEXT_PUBLIC_FREE_SHIPPING_THRESHOLD_PAISE=99900
// NEXT_PUBLIC_STANDARD_SHIPPING_PAISE=7900
const FREE_SHIPPING_THRESHOLD_PAISE = 99_900;
const STANDARD_SHIPPING_PAISE = 7_900;

const defaultShippingPolicy: CustomerShippingPolicyPort = {
  async quote(input: {
    lines: readonly AuthoritativeCheckoutLine[];
    subtotalPaise: number;
    shippingAddress: ShippingAddress;
  }): Promise<ShippingQuote> {
    const shippingPaise =
      input.subtotalPaise >= FREE_SHIPPING_THRESHOLD_PAISE ? 0 : STANDARD_SHIPPING_PAISE;
    return { shippingPaise, discountPaise: 0, taxPaise: 0 };
  },
};

export function bootstrapStorefront(): StorefrontRouters | null {
  if (!isStorefrontPaymentConfigured()) {
    logger.info(
      'Storefront payment credentials not configured - public commerce surface disabled. Operator panel unaffected.',
    );
    return null;
  }

  const razorpayConfig = loadRazorpayConfig(process.env, config.nodeEnv);
  const razorpayClient = new RazorpayHttpClient(razorpayConfig);

  // The tracking/status token HMAC secret: the Razorpay webhook secret is
  // 256-bit, server-only, and never sent to the browser. Adequate for HMAC
  // key derivation.
  const trackingTokenSecret = config.trackingTokenSecret!;

  const sessions = new MongooseCheckoutSessionRepository();
  const attempts = new MongoosePaymentAttemptRepository();
  const catalogPort = new StorefrontCatalogCheckoutAdapter();
  const shopifyOrderAdapter = new ShopifyOrderCreateAdapter(razorpayConfig.testMode);

  const orchestrator = new PaidOrderOrchestrator(sessions, shopifyOrderAdapter);
  registerPaidOrderOrchestrator(orchestrator);

  const paymentService = new StorefrontPaymentService(
    sessions,
    attempts,
    razorpayClient,
    razorpayConfig,
    orchestrator,
    trackingTokenSecret,
  );
  registerRazorpayWebhookProcessor(paymentService);

  const checkoutService = new CheckoutService({
    catalog: catalogPort,
    shippingPolicy: defaultShippingPolicy,
    sessions,
    razorpay: razorpayClient,
    razorpayKeyId: razorpayConfig.keyId,
    trackingTokenSecret,
  });

  const trackingService = new StorefrontTrackingService(
    sessions,
    new ShopifyOrderTrackingAdapter(),
  );

  const storefrontOrigins = config.storefrontUrl ? [config.storefrontUrl] : [];

  return {
    catalogRouter: storefrontCatalogRouter,
    checkoutRouter: createStorefrontCheckoutRouter({
      checkout: checkoutService,
      payments: paymentService,
      allowedOrigins: storefrontOrigins,
    }),
    ordersRouter: createStorefrontOrdersRouter(trackingService),
    razorpayWebhookRouter: createRazorpayWebhookRouter(razorpayConfig),
  };
}

export function startStorefrontWorkers(): void {
  if (!isStorefrontPaymentConfigured()) return;
  startRazorpayWebhookWorker();
  startPaidOrderWorker();
  logger.info('Storefront background workers started (Razorpay webhook + paid-order orchestrator).');
}

export function stopStorefrontWorkers(): void {
  stopRazorpayWebhookWorker();
  stopPaidOrderWorker();
}
