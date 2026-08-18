/**
 * Webhook registration planning - pure decision logic.
 *
 * Kept separate from webhooks.service.ts (which performs the GraphQL calls) so
 * the part that is easy to get wrong - deciding what to create, update, leave
 * alone or flag - is unit testable with no network, mirroring how
 * webhook.verify.ts is separated from the controller.
 *
 * Registration must be IDEMPOTENT: calling it twice must not create duplicate
 * subscriptions, because Shopify would then deliver every event twice.
 */

/** A subscription as reported by Shopify. */
export interface ExistingSubscription {
  id: string;
  /** GraphQL enum form, e.g. ORDERS_CREATE. */
  topic: string;
  /** Null for non-HTTP endpoints (EventBridge/PubSub), which we never create. */
  callbackUrl: string | null;
}

export type WebhookAction =
  /** No subscription exists for this topic. */
  | { action: 'create'; topic: string }
  /** Exists but points somewhere else - repoint it. */
  | { action: 'update'; topic: string; id: string; currentCallbackUrl: string | null }
  /** Already correct. */
  | { action: 'keep'; topic: string; id: string }
  /**
   * Exists on a non-HTTP transport (EventBridge, Pub/Sub). Left strictly alone:
   * silently converting someone's EventBridge pipeline to an HTTP POST would be
   * a destructive surprise.
   */
  | { action: 'skip'; topic: string; id: string; reason: string };

export interface WebhookPlan {
  actions: WebhookAction[];
  /**
   * Subscriptions pointing at THIS app's callback path but for a topic no longer
   * in the desired set - reported so an operator can prune them deliberately.
   * Never auto-deleted.
   */
  orphaned: ExistingSubscription[];
}

/**
 * Normalises a callback URL for comparison.
 *
 * Shopify may echo a URL back with a trailing slash or a different case in the
 * host, and neither difference means "repoint this subscription". The path case
 * IS significant, so only the host is lowercased.
 */
export function normaliseCallbackUrl(raw: string | null): string | null {
  if (raw === null || raw.trim().length === 0) return null;
  try {
    const url = new URL(raw.trim());
    const path = url.pathname.replace(/\/+$/, '');
    return `${url.protocol}//${url.host.toLowerCase()}${path}${url.search}`;
  } catch {
    // Not a parseable URL - compare the raw text rather than crashing.
    return raw.trim();
  }
}

/**
 * Converts a delivery header topic (`orders/create`) into the GraphQL enum form
 * (`ORDERS_CREATE`).
 *
 * Needed because a delivery identifies its topic in REST form while
 * subscriptions are created with the enum form.
 */
export function topicHeaderToEnum(header: string): string {
  return header.trim().toUpperCase().replace(/[/.-]/g, '_');
}

/** Inverse of `topicHeaderToEnum`, for display alongside a delivery. */
export function topicEnumToHeader(topic: string): string {
  const normalised = topic.trim().toLowerCase();
  const separator = normalised.lastIndexOf('_');
  if (separator === -1) return normalised;
  // Only the LAST underscore is the resource/action boundary:
  // DRAFT_ORDERS_CREATE -> draft_orders/create, not draft/orders_create.
  return `${normalised.slice(0, separator)}/${normalised.slice(separator + 1)}`;
}

/**
 * Decides what to do for each desired topic.
 *
 * `existing` may contain several subscriptions for one topic (Shopify permits
 * one per endpoint). Preference order: an exact callbackUrl match wins, then any
 * HTTP subscription (which gets repointed), then a non-HTTP one (skipped).
 */
export function planWebhookRegistration(
  desiredTopics: readonly string[],
  callbackUrl: string,
  existing: readonly ExistingSubscription[],
): WebhookPlan {
  const target = normaliseCallbackUrl(callbackUrl);
  const desired = new Set(desiredTopics);
  const actions: WebhookAction[] = [];

  for (const topic of desiredTopics) {
    const matches = existing.filter((entry) => entry.topic === topic);

    if (matches.length === 0) {
      actions.push({ action: 'create', topic });
      continue;
    }

    const exact = matches.find(
      (entry) => normaliseCallbackUrl(entry.callbackUrl) === target,
    );
    if (exact !== undefined) {
      actions.push({ action: 'keep', topic, id: exact.id });
      continue;
    }

    const http = matches.find((entry) => entry.callbackUrl !== null);
    if (http !== undefined) {
      actions.push({
        action: 'update',
        topic,
        id: http.id,
        currentCallbackUrl: http.callbackUrl,
      });
      continue;
    }

    // Only non-HTTP endpoints remain.
    actions.push({
      action: 'skip',
      topic,
      id: (matches[0] as ExistingSubscription).id,
      reason:
        'A subscription for this topic exists on a non-HTTP endpoint (EventBridge or Pub/Sub). Remove it manually if you want an HTTPS delivery instead.',
    });
  }

  // Anything aimed at our own host that we no longer want.
  const orphaned = existing.filter((entry) => {
    if (desired.has(entry.topic)) return false;
    const normalised = normaliseCallbackUrl(entry.callbackUrl);
    return normalised !== null && normalised === target;
  });

  return { actions, orphaned };
}

/** Convenience counts for logs and API responses. */
export function summarisePlan(plan: WebhookPlan): {
  create: number;
  update: number;
  keep: number;
  skip: number;
  orphaned: number;
} {
  return {
    create: plan.actions.filter((entry) => entry.action === 'create').length,
    update: plan.actions.filter((entry) => entry.action === 'update').length,
    keep: plan.actions.filter((entry) => entry.action === 'keep').length,
    skip: plan.actions.filter((entry) => entry.action === 'skip').length,
    orphaned: plan.orphaned.length,
  };
}
