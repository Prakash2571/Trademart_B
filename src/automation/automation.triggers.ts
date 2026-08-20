/**
 * Webhook → automation trigger mapping.
 *
 * Pure: decides, from a webhook topic and payload, whether an automation run is
 * warranted and which product it concerns. No Shopify calls and no timers, so
 * the loop-safety rules below are unit testable — which matters, because getting
 * them wrong means an infinite write loop against a live store.
 *
 * THE FEEDBACK LOOP PROBLEM
 * -------------------------
 * Automation writes a price -> Shopify emits products/update -> that webhook
 * triggers automation -> which writes a price -> ...
 *
 * Shopify does not tell a webhook which app caused the change, so the loop
 * cannot be broken by inspecting the delivery. Two things break it instead:
 *
 *  1. THE FIXED POINT (the real defence). Automation is idempotent: it writes
 *     only when the current price differs from the computed target by at least
 *     `minChangeAmount`. After our own write the product IS at the target, so
 *     the follow-up run computes the same number, finds nothing to do, and
 *     stops. The loop terminates after exactly one extra no-op run.
 *
 *  2. A COOLDOWN (belt and braces). Even a terminating loop wastes Shopify API
 *     calls, and a genuinely oscillating rule set (bad rounding interacting with
 *     a clamp) would thrash. Ignoring repeat triggers for the same product
 *     within a short window bounds the damage regardless.
 *
 * Both are needed: the fixed point is correct but depends on the price rules
 * being well behaved, while the cooldown holds even when they are not.
 */

/** Topics that can justify an automation run, in delivery-header form. */
export const AUTOMATION_TRIGGER_TOPICS = [
  'products/create',
  'products/update',
  'inventory_levels/update',
] as const;

/**
 * How long to ignore further triggers for the same product.
 *
 * Long enough to absorb the echo of our own write plus a burst of edits from a
 * bulk import; short enough that a real cost change is picked up promptly.
 */
export const TRIGGER_COOLDOWN_MS = 60_000;

export type TriggerDecision =
  | {
      run: true;
      /** Product GID, or null when only an inventory item id is known. */
      shopifyProductId: string | null;
      /** Set for inventory_levels/update, which does not carry a product id. */
      inventoryItemId: string | null;
      topic: string;
      reason: string;
    }
  | { run: false; reason: string };

/** Coerces a Shopify numeric or GID product id into a GID. */
export function toProductGid(raw: unknown): string | null {
  if (typeof raw === 'string') {
    if (raw.startsWith('gid://shopify/Product/')) return raw;
    if (/^\d+$/.test(raw)) return `gid://shopify/Product/${raw}`;
    return null;
  }
  // Webhook payloads deliver ids as JSON numbers; they exceed nothing here but
  // must be treated as opaque, so they are stringified rather than arithmetic'd.
  if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0) {
    return `gid://shopify/Product/${raw}`;
  }
  return null;
}

function toInventoryItemGid(raw: unknown): string | null {
  if (typeof raw === 'string') {
    if (raw.startsWith('gid://shopify/InventoryItem/')) return raw;
    if (/^\d+$/.test(raw)) return `gid://shopify/InventoryItem/${raw}`;
    return null;
  }
  if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0) {
    return `gid://shopify/InventoryItem/${raw}`;
  }
  return null;
}

/**
 * Decides whether a delivery should trigger a run.
 *
 * `topic` is the raw X-Shopify-Topic header (REST form, e.g. `products/update`).
 */
export function decideTrigger(topic: string, payload: unknown): TriggerDecision {
  const normalised = topic.trim().toLowerCase();

  if (!(AUTOMATION_TRIGGER_TOPICS as readonly string[]).includes(normalised)) {
    return { run: false, reason: `Topic ${topic} does not affect pricing or stock.` };
  }
  if (typeof payload !== 'object' || payload === null) {
    return { run: false, reason: 'Webhook payload was not an object.' };
  }

  const body = payload as Record<string, unknown>;

  if (normalised === 'inventory_levels/update') {
    // This payload identifies an inventory ITEM, not a product. The caller has
    // to resolve it; passing the id through is more honest than guessing.
    const inventoryItemId = toInventoryItemGid(body['inventory_item_id']);
    if (inventoryItemId === null) {
      return { run: false, reason: 'inventory_levels/update payload had no inventory_item_id.' };
    }
    return {
      run: true,
      shopifyProductId: null,
      inventoryItemId,
      topic: normalised,
      reason: 'Stock changed; visibility may need updating.',
    };
  }

  const shopifyProductId = toProductGid(body['id'] ?? body['admin_graphql_api_id']);
  if (shopifyProductId === null) {
    return { run: false, reason: `${topic} payload had no usable product id.` };
  }

  return {
    run: true,
    shopifyProductId,
    inventoryItemId: null,
    topic: normalised,
    reason:
      normalised === 'products/create'
        ? 'New product imported; needs pricing and a visibility decision.'
        : 'Product changed; cost or stock may have moved.',
  };
}

/**
 * Per-product cooldown tracker.
 *
 * In-memory on purpose: it is an optimisation, not a correctness guarantee (the
 * fixed-point property is what guarantees termination). Losing it on restart
 * costs one redundant no-op run, which is acceptable — whereas persisting it
 * would make automation depend on Mongo being up.
 */
export class TriggerCooldown {
  private readonly seen = new Map<string, number>();
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(options: { windowMs?: number; now?: () => number } = {}) {
    this.windowMs = options.windowMs ?? TRIGGER_COOLDOWN_MS;
    this.now = options.now ?? Date.now;
  }

  /**
   * Returns true when this key may run, and records the attempt.
   * Named for its side effect: it is not a pure predicate.
   */
  tryAcquire(key: string): boolean {
    const now = this.now();
    const last = this.seen.get(key);
    if (last !== undefined && now - last < this.windowMs) return false;
    this.seen.set(key, now);
    this.prune(now);
    return true;
  }

  /** Drops expired entries so a large catalogue cannot grow the map forever. */
  private prune(now: number): void {
    if (this.seen.size < 1000) return;
    for (const [key, at] of this.seen) {
      if (now - at >= this.windowMs) this.seen.delete(key);
    }
  }

  /** Test/diagnostic helper. */
  size(): number {
    return this.seen.size;
  }
}
