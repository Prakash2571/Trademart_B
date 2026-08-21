/**
 * Entry point.
 *
 * Boot order: validate config (in ./config, which exits on failure) -> attempt
 * the database connection (non-fatal) -> listen.
 */

import { createApp } from './app';
import { logger } from './common/logger';
import { config, isShopifyConfigured } from './config';
import { connectDatabase, disconnectDatabase, ensureIndexes } from './database/mongo';
import { processWebhookEvent } from './webhooks/webhook.processor';
import {
  registerWebhookProcessor,
  startWebhookWorker,
  stopWebhookWorker,
} from './webhooks/webhook.queue';

async function main(): Promise<void> {
  await connectDatabase();

  // Explicit, awaited index creation. The webhook dedupe key and the idempotency
  // claim are enforced by unique indexes, so they must exist before traffic
  // arrives rather than being built lazily in the background.
  await ensureIndexes();

  // Wired here rather than inside the queue so the queue carries no domain
  // knowledge and stays testable on its own.
  registerWebhookProcessor(processWebhookEvent);

  const app = createApp();
  const server = app.listen(config.port, () => {
    logger.info('Trademart backend listening.', {
      port: config.port,
      environment: config.nodeEnv,
      corsOrigin: config.frontendUrl,
      shopifyStore: config.shopify.storeDomain,
      shopifyApiVersion: config.shopify.apiVersion,
      shopifyConfigured: isShopifyConfigured(),
    });

    if (!isShopifyConfigured()) {
      logger.warn(
        'Shopify endpoints will return SHOPIFY_NOT_CONFIGURED until SHOPIFY_ACCESS_TOKEN is set.',
      );
    }

    // Started after `listen` so the process is already answering health probes
    // when the first (possibly slow) queue drain runs.
    startWebhookWorker();
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    // A second SIGTERM must not start a second shutdown and race the first.
    if (shuttingDown) return;
    shuttingDown = true;

    // Stop CLAIMING new webhook work before closing what it depends on. An event
    // already claimed simply has its lease expire and is retried, which is why
    // the queue leases at all.
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
