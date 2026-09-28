/**
 * Entry point.
 *
 * Boot order: validate config (in ./config, which exits on failure) -> attempt
 * the database connection (non-fatal) -> bootstrap storefront -> listen.
 */

import { createApp } from './app';
import { logger } from './common/logger';
import { config, isShopifyConfigured, isStorefrontPaymentConfigured } from './config';
import { connectDatabase, disconnectDatabase, ensureIndexes } from './database/mongo';
import { processWebhookEvent } from './webhooks/webhook.processor';
import {
  registerWebhookProcessor,
  startWebhookWorker,
  stopWebhookWorker,
} from './webhooks/webhook.queue';
import {
  bootstrapStorefront,
  startStorefrontWorkers,
  stopStorefrontWorkers,
} from './storefront/bootstrap';
import { applyStoredDeodapSettings } from './suppliers/deodap/deodap.service';

async function main(): Promise<void> {
  await connectDatabase();

  // Explicit, awaited index creation. The webhook dedupe key and the idempotency
  // claim are enforced by unique indexes, so they must exist before traffic
  // arrives rather than being built lazily in the background.
  await ensureIndexes();

  // DeoDap SKU prefixes live in MongoDB, but supplier classification is synchronous
  // and runs inside the Shopify mappers, so they are loaded into memory once here
  // (and replaced whenever the settings are saved). Never throws.
  await applyStoredDeodapSettings();

  // Wired here rather than inside the queue so the queue carries no domain
  // knowledge and stays testable on its own.
  registerWebhookProcessor(processWebhookEvent);

  // Bootstrap the public storefront (Razorpay payments, checkout, tracking).
  // Returns null when credentials are absent — operator panel still works.
  const storefront = bootstrapStorefront();

  const app = createApp(storefront);
  const server = app.listen(config.port, () => {
    logger.info('Trademart backend listening.', {
      port: config.port,
      environment: config.nodeEnv,
      corsOrigin: config.frontendUrl,
      storefrontOrigin: config.storefrontUrl,
      shopifyStore: config.shopify.storeDomain,
      shopifyApiVersion: config.shopify.apiVersion,
      shopifyConfigured: isShopifyConfigured(),
      storefrontPaymentConfigured: isStorefrontPaymentConfigured(),
    });

    if (!isShopifyConfigured()) {
      logger.warn(
        'Shopify endpoints will return SHOPIFY_NOT_CONFIGURED until SHOPIFY_ACCESS_TOKEN is set.',
      );
    }

    // Started after `listen` so the process is already answering health probes
    // when the first (possibly slow) queue drain runs.
    startWebhookWorker();
    startStorefrontWorkers();
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    // A second SIGTERM must not start a second shutdown and race the first.
    if (shuttingDown) return;
    shuttingDown = true;

    // Stop CLAIMING new work before closing what it depends on. An event
    // already claimed simply has its lease expire and is retried, which is why
    // the queues lease at all.
    stopStorefrontWorkers();
    stopWebhookWorker();

    logger.info('Shutting down.', { signal });
    server.close(() => {
      void disconnectDatabase().finally(() => process.exit(0));
    });
    // Do not hang forever if connections refuse to drain.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection.', {
      reason: reason instanceof Error ? reason.message : String(reason),
    });
  });
}

main().catch((error: unknown) => {
  logger.error('Fatal startup error.', {
    reason: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
