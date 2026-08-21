/**
 * Entry point.
 *
 * Boot order: validate config (in ./config, which exits on failure) -> attempt
 * the database connection (non-fatal) -> ensure indexes -> start the webhook
 * worker -> listen.
 *
 * Shutdown drains in the reverse order, and the webhook worker is stopped FIRST
 * so a claimed event is not abandoned mid-flight while the process is closing.
 */

import { createApp } from './app';
import { logger } from './common/logger';
import { getVersionInfo } from './common/version';
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

  // Indexes are created explicitly rather than left to Mongoose's autoIndex,
  // which is asynchronous and silent: a unique index that has not finished
  // building yet does not enforce uniqueness, and the webhook dedupe key and the
  // idempotency key both depend on that enforcement being real.
  await ensureIndexes();

  // Wired here rather than inside the queue so the queue module carries no domain
  // knowledge and can be tested on its own.
  registerWebhookProcessor(processWebhookEvent);

  const app = createApp();
  const server = app.listen(config.port, () => {
    const version = getVersionInfo();
    logger.info('Trademart backend listening.', {
      port: config.port,
      environment: config.nodeEnv,
      version: version.version,
      gitSha: version.gitShaShort,
      corsOrigin: config.frontendUrl,
      shopifyStore: config.shopify.storeDomain,
      shopifyApiVersion: config.shopify.apiVersion,
      shopifyConfigured: isShopifyConfigured(),
      declaredStoreMode: config.shopify.storeMode,
      allowLiveStoreWrites: config.allowLiveStoreWrites,
    });

    if (!isShopifyConfigured()) {
      logger.warn(
        'Shopify endpoints will return SHOPIFY_NOT_CONFIGURED until SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET are set.',
      );
    }

    // Started after `listen` so the process is already serving health probes when
    // the first (possibly slow) drain runs.
    startWebhookWorker();
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    // A second SIGTERM must not start a second shutdown and race the first.
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Shutting down.', { signal });

    // Stop claiming new webhook work before closing anything it depends on. An
    // event already claimed will have its lease expire and be retried, which is
    // why the queue leases at all.
    stopWebhookWorker();

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
