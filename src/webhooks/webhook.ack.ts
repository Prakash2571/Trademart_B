/**
 * What to tell a webhook sender after a delivery has been verified.
 *
 * WHY THIS IS A SEPARATE, PURE MODULE
 * -----------------------------------
 * This decision is the difference between "an event was delayed" and "an event
 * was lost forever", and it is impossible to unit test inside an Express handler
 * that needs Mongo, Shopify and a live socket. So the policy lives here as a
 * function of three booleans, and the controller does nothing but apply it.
 *
 * THE RULE
 * --------
 * A 2xx is a PROMISE. Shopify (and Razorpay) treat it as "you have this event
 * now, I will never send it again". So a 2xx may only be returned when one of
 * these is true:
 *
 *   * the event is durably stored (a worker will process and retry it), or
 *   * it is a duplicate of something already stored, or
 *   * it was fully handled inline, right now, with nothing left to do.
 *
 * If the event could not be made durable, the honest answer is a retryable 503:
 * the sender keeps it and redelivers. The previous behaviour - log the storage
 * failure and answer 200 anyway - converted a transient Mongo blip into
 * permanent silent data loss, which is precisely the failure mode that is
 * invisible until an order does not exist.
 *
 * WHY app/uninstalled IS SPECIAL
 * ------------------------------
 * An uninstall revokes the offline token. Leaving a revoked token in storage is a
 * security problem, so it is honoured inline even with no database at all. When
 * that inline work succeeds there is genuinely nothing left to retry, so a 200 is
 * truthful. When it fails, the token is still there, so a 503 is truthful.
 */

/** Topic (header form) that means the merchant removed the app. */
export const APP_UNINSTALLED_TOPIC = 'app/uninstalled';

export interface WebhookAckInput {
  /** Delivery topic, in Shopify's header form (e.g. "orders/create"). */
  topic: string;
  /** True when the event row exists after this request. */
  stored: boolean;
  /** True when this delivery was already recorded (dedupe key hit). */
  duplicate: boolean;
  /**
   * Outcome of the no-database inline path, when one ran.
   *   'handled'    - the work is complete; nothing is pending
   *   'failed'     - the work was attempted and did not complete
   *   'not-needed' - no inline path applies to this topic
   */
  inline?: 'handled' | 'failed' | 'not-needed';
}

export type WebhookAck =
  | { kind: 'duplicate'; status: 200 }
  | { kind: 'queued'; status: 200 }
  | { kind: 'handled-inline'; status: 200 }
  | { kind: 'not-persisted'; status: 503; message: string };

/** True when this topic must still be honoured with no durable storage. */
export function requiresInlineHandling(topic: string): boolean {
  return topic.toLowerCase() === APP_UNINSTALLED_TOPIC;
}

/**
 * Decides the response for a delivery that has ALREADY passed HMAC and shop
 * domain verification. Rejecting an unverified delivery is a different decision,
 * made before this is reached.
 */
export function decideWebhookAck(input: WebhookAckInput): WebhookAck {
  // Checked first: a duplicate is proof the original delivery is stored, so it is
  // acknowledged even if storage is unhealthy for new inserts right now.
  if (input.duplicate) return { kind: 'duplicate', status: 200 };

  if (input.stored) return { kind: 'queued', status: 200 };

  if (input.inline === 'handled') return { kind: 'handled-inline', status: 200 };

  return {
    kind: 'not-persisted',
    status: 503,
    message:
      'The webhook was verified but could not be stored, so it cannot be processed or retried from here. Redeliver it: acknowledging an event nobody stored would lose it permanently.',
  };
}
