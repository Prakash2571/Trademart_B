/**
 * Entry point.
 *
 * Boot order: validate config (in ./config, which exits on failure) -> attempt
 * the database connection (non-fatal) -> listen.
 */

import { createApp } from './app';
import { logger } from './common/logger';
import { config, isShopifyConfigured } from './config';
import { connectDatabase, disconnectDatabase } from './database/mongo';

async function main(): Promise<void> {
  await connectDatabase();

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
  });

  const shutdown = (signal: string): void => {
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
