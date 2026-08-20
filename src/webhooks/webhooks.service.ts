/**
 * Webhook subscription management against the Shopify Admin API.
 *
 * The decision logic lives in webhook.registration.ts (pure, unit tested); this
 * module only talks to Shopify and reports what happened.
 *
 * SCOPES: there is no dedicated webhook scope. Each TOPIC requires the scope for
 * the data it carries, so the scopes needed here are just the ones the app
 * already holds to read that data:
 *
 *   APP_UNINSTALLED          - none
 *   PRODUCTS_*               - read_products
 *   ORDERS_* / FULFILLMENTS_*- read_orders
 *   CUSTOMERS_*              - read_customers
 *   INVENTORY_LEVELS_UPDATE  - read_inventory
 *
 * https://shopify.dev/docs/apps/build/webhooks/subscribe
 *
 * A missing scope surfaces as SHOPIFY_SCOPE_MISSING from the shared error mapper,
 * exactly like every other scope problem — and only for the affected topic, since
 * registration isolates per-topic failures.
 */

import { AppError } from '../common/errors';
import { logger } from '../common/logger';
import { config } from '../config';
import {
  WEBHOOK_SUBSCRIPTIONS_QUERY,
  WEBHOOK_SUBSCRIPTION_CREATE_MUTATION,
  WEBHOOK_SUBSCRIPTION_DELETE_MUTATION,
  WEBHOOK_SUBSCRIPTION_UPDATE_MUTATION,
} from '../shopify/graphql/webhook.queries';
import { shopifyGraphql, type GraphqlResult } from '../shopify/shopify.client';
import { mapUserErrors } from '../shopify/shopify.errors';
import {
  planWebhookRegistration,
  summarisePlan,
  type ExistingSubscription,
  type WebhookPlan,
} from './webhook.registration';
import { PLANNED_WEBHOOK_TOPICS } from './webhook.verify';

/** Shopify caps webhookSubscriptions at 250 per page. */
const PAGE_SIZE = 100;
/** Safety valve so a pagination bug cannot spin forever. */
const MAX_PAGES = 10;

interface RawSubscriptionNode {
  id: string;
  topic: string;
  createdAt?: string | null;
  updatedAt?: string | null;
  endpoint?: {
    __typename?: string | null;
    callbackUrl?: string | null;
  } | null;
}

interface SubscriptionsResponse {
  webhookSubscriptions: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    edges: { node: RawSubscriptionNode }[];
  } | null;
}

/** Flattens Shopify's edge/node shape into the pure planner's input type. */
function toExisting(node: RawSubscriptionNode): ExistingSubscription {
  return {
    id: node.id,
    topic: node.topic,
    // Null for EventBridge/PubSub endpoints, which have no callbackUrl field.
    callbackUrl: node.endpoint?.callbackUrl ?? null,
  };
}

/** Lists every registered subscription, following pagination. */
export async function listWebhookSubscriptions(): Promise<ExistingSubscription[]> {
  const all: ExistingSubscription[] = [];
  let after: string | null = null;
  let page = 0;

  while (page < MAX_PAGES) {
    page += 1;
    // Both locals are annotated explicitly: `after` is assigned from a value
    // derived from `result`, and leaving these to inference makes the cursor a
    // self-referential type.
    const result: GraphqlResult<SubscriptionsResponse> =
      await shopifyGraphql<SubscriptionsResponse>(
        WEBHOOK_SUBSCRIPTIONS_QUERY,
        { first: PAGE_SIZE, after },
        { operation: 'listWebhookSubscriptions' },
      );

    const connection: SubscriptionsResponse['webhookSubscriptions'] =
      result.data.webhookSubscriptions;
    if (connection === null || connection === undefined) break;

    for (const edge of connection.edges) {
      all.push(toExisting(edge.node));
    }

    if (!connection.pageInfo.hasNextPage) break;
    after = connection.pageInfo.endCursor;
    if (after === null) break;
  }

  return all;
}

/** The callback URL, or a clear error explaining why there isn't one. */
function requireCallbackUrl(): string {
  const callbackUrl = config.shopify.webhookCallbackUrl;
  if (callbackUrl === null) {
    throw new AppError(
      'WEBHOOK_REGISTRATION_FAILED',
      'APP_URL is not set, so there is no address to register. Shopify must be able to reach this backend over HTTPS - use a tunnel URL for local development.',
    );
  }
  if (config.shopify.webhookSecret === null) {
    // Registering without a secret would create subscriptions whose deliveries
    // the receiver then rejects - worse than not registering at all.
    throw new AppError(
      'WEBHOOK_NOT_CONFIGURED',
      'SHOPIFY_WEBHOOK_SECRET is not set, so delivered webhooks would all be rejected. Set it before registering subscriptions.',
    );
  }
  return callbackUrl;
}

export interface RegistrationOutcome {
  topic: string;
  action: 'created' | 'updated' | 'kept' | 'skipped' | 'failed';
  id: string | null;
  message?: string;
}

export interface RegistrationReport {
  callbackUrl: string;
  outcomes: RegistrationOutcome[];
  orphaned: ExistingSubscription[];
  summary: ReturnType<typeof summarisePlan> & { failed: number };
}

interface CreateResponse {
  webhookSubscriptionCreate: {
    webhookSubscription: RawSubscriptionNode | null;
    userErrors: { field?: string[] | null; message?: string }[];
  } | null;
}

interface UpdateResponse {
  webhookSubscriptionUpdate: {
    webhookSubscription: RawSubscriptionNode | null;
    userErrors: { field?: string[] | null; message?: string }[];
  } | null;
}

interface DeleteResponse {
  webhookSubscriptionDelete: {
    deletedWebhookSubscriptionId: string | null;
    userErrors: { field?: string[] | null; message?: string }[];
  } | null;
}

/**
 * Reconciles the registered subscriptions with PLANNED_WEBHOOK_TOPICS.
 *
 * Safe to run repeatedly - a topic already pointing at the right URL is left
 * untouched. `dryRun` returns the plan without changing anything, which is the
 * honest way to answer "what would this do?" before it does it.
 *
 * One topic failing does NOT abort the rest: a single unsupported topic should
 * not prevent the other nine from being registered.
 */
export async function registerWebhookSubscriptions(
  options: { dryRun?: boolean; topics?: readonly string[] } = {},
): Promise<RegistrationReport> {
  const callbackUrl = requireCallbackUrl();
  const topics = options.topics ?? PLANNED_WEBHOOK_TOPICS;

  const existing = await listWebhookSubscriptions();
  const plan: WebhookPlan = planWebhookRegistration(topics, callbackUrl, existing);

  const outcomes: RegistrationOutcome[] = [];
  let failed = 0;

  for (const entry of plan.actions) {
    if (entry.action === 'keep') {
      outcomes.push({ topic: entry.topic, action: 'kept', id: entry.id });
      continue;
    }
    if (entry.action === 'skip') {
      outcomes.push({
        topic: entry.topic,
        action: 'skipped',
        id: entry.id,
        message: entry.reason,
      });
      continue;
    }

    if (options.dryRun === true) {
      outcomes.push({
        topic: entry.topic,
        action: entry.action === 'create' ? 'created' : 'updated',
        id: entry.action === 'update' ? entry.id : null,
        message: 'Dry run - nothing was changed.',
      });
      continue;
    }

    try {
      if (entry.action === 'create') {
        const result = await shopifyGraphql<CreateResponse>(
          WEBHOOK_SUBSCRIPTION_CREATE_MUTATION,
          {
            topic: entry.topic,
            webhookSubscription: {
              callbackUrl,
              format: 'JSON',
              apiVersion: config.shopify.apiVersion,
            },
          },
          { operation: 'webhookSubscriptionCreate' },
        );

        const payload = result.data.webhookSubscriptionCreate;
        const userError = mapUserErrors(payload?.userErrors);
        if (userError !== null) throw userError;

        outcomes.push({
          topic: entry.topic,
          action: 'created',
          id: payload?.webhookSubscription?.id ?? null,
        });
      } else {
        const result = await shopifyGraphql<UpdateResponse>(
          WEBHOOK_SUBSCRIPTION_UPDATE_MUTATION,
          {
            id: entry.id,
            webhookSubscription: {
              callbackUrl,
              format: 'JSON',
              apiVersion: config.shopify.apiVersion,
            },
          },
          { operation: 'webhookSubscriptionUpdate' },
        );

        const payload = result.data.webhookSubscriptionUpdate;
        const userError = mapUserErrors(payload?.userErrors);
        if (userError !== null) throw userError;

        outcomes.push({
          topic: entry.topic,
          action: 'updated',
          id: payload?.webhookSubscription?.id ?? entry.id,
        });
      }
    } catch (error) {
      failed += 1;
      const message =
        error instanceof AppError ? error.message : 'Unexpected registration failure.';
      logger.warn('Webhook subscription registration failed for one topic.', {
        topic: entry.topic,
        code: error instanceof AppError ? error.code : 'INTERNAL_ERROR',
      });
      outcomes.push({
        topic: entry.topic,
        action: 'failed',
        id: entry.action === 'update' ? entry.id : null,
        message,
      });
    }
  }

  const report: RegistrationReport = {
    callbackUrl,
    outcomes,
    orphaned: plan.orphaned,
    summary: { ...summarisePlan(plan), failed },
  };

  logger.info('Webhook subscription reconciliation finished.', {
    callbackUrl,
    dryRun: options.dryRun === true,
    ...report.summary,
  });

  return report;
}

/** Deletes one subscription by GID. */
export async function deleteWebhookSubscription(id: string): Promise<string | null> {
  const result = await shopifyGraphql<DeleteResponse>(
    WEBHOOK_SUBSCRIPTION_DELETE_MUTATION,
    { id },
    { operation: 'webhookSubscriptionDelete' },
  );

  const payload = result.data.webhookSubscriptionDelete;
  const userError = mapUserErrors(payload?.userErrors);
  if (userError !== null) throw userError;

  const deletedId = payload?.deletedWebhookSubscriptionId ?? null;
  logger.info('Deleted webhook subscription.', { id: deletedId });
  return deletedId;
}
