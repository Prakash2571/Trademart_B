/**
 * Inventory-quantity write validation and input building — pure.
 *
 * A dropshipped product needs stock to be sellable, so this sets an absolute
 * quantity for one inventory item at one location using Shopify's current
 * `inventorySetQuantities` mutation (which supersedes the on-hand-only one).
 *
 * Pure so the rules are unit testable: ids must be the right GID type, quantity
 * is a non-negative integer, and the state is one Shopify actually accepts.
 * A negative quantity is refused rather than coerced.
 */

import { AppError } from '../common/errors';

/** Inventory states this endpoint may set. */
export type InventoryQuantityName = 'available' | 'on_hand';
const NAMES: readonly InventoryQuantityName[] = ['available', 'on_hand'];

export interface InventorySetRequest {
  inventoryItemId: string;
  locationId: string;
  quantity: number;
  name: InventoryQuantityName;
  /**
   * The quantity the caller believes is currently set.
   *
   * When supplied, the write is refused with PRODUCT_CHANGED if Shopify disagrees.
   * This is what stops a stale browser tab overwriting a newer change: the
   * operator opened the page when stock was 40, someone sold 5, and saving "40"
   * would silently put the 5 back.
   */
  expectedQuantity?: number;
  /**
   * Explicit acknowledgement of a change larger than MAX_INVENTORY_DELTA.
   *
   * Enforced on the SERVER. The frontend also confirms large changes, but a
   * browser dialog is not a control - anything reachable with curl has to be
   * checked here too.
   */
  confirmLargeChange: boolean;
}

/**
 * Decides whether a stock change is allowed, given the current value.
 *
 * Pure and separate from the Shopify call so the rule is unit testable without a
 * network: the interesting cases are all about arithmetic and thresholds.
 */
export interface InventoryChangeAssessment {
  from: number | null;
  to: number;
  /** Absolute size of the change. Null when the current value is unknown. */
  delta: number | null;
  requiresConfirmation: boolean;
  allowed: boolean;
  reason: string | null;
}

export function assessInventoryChange(
  current: number | null,
  request: InventorySetRequest,
  maxDelta: number,
): InventoryChangeAssessment {
  const to = request.quantity;

  // Unknown current value: the delta cannot be computed, so the cap cannot be
  // enforced. Requiring confirmation is the conservative choice - it is the only
  // way to avoid either blocking a legitimate write or waving through an
  // arbitrarily large one.
  if (current === null) {
    return {
      from: null,
      to,
      delta: null,
      requiresConfirmation: true,
      allowed: request.confirmLargeChange,
      reason: request.confirmLargeChange
        ? null
        : `The current quantity could not be read, so a change of unknown size cannot be checked against the ${maxDelta}-unit limit. Send confirmLargeChange: true to proceed anyway.`,
    };
  }

  const delta = Math.abs(to - current);
  const requiresConfirmation = delta > maxDelta;

  if (requiresConfirmation && !request.confirmLargeChange) {
    return {
      from: current,
      to,
      delta,
      requiresConfirmation: true,
      allowed: false,
      reason: `Changing stock from ${current} to ${to} is a change of ${delta} units, which exceeds the ${maxDelta}-unit limit. Send confirmLargeChange: true if that is intended.`,
    };
  }

  return {
    from: current,
    to,
    delta,
    requiresConfirmation,
    allowed: true,
    reason: null,
  };
}

function requireGid(raw: unknown, resource: string, field: string): string {
  if (typeof raw !== 'string') {
    throw new AppError('VALIDATION_ERROR', `${field} is required.`);
  }
  const value = raw.trim();
  const prefix = `gid://shopify/${resource}/`;
  if (value.startsWith(prefix)) return value;
  // Accept a bare numeric id and normalise.
  if (/^\d+$/.test(value)) return `${prefix}${value}`;
  throw new AppError(
    'VALIDATION_ERROR',
    `${field} must be a ${resource} id or a ${prefix}... value.`,
  );
}

export function validateInventorySet(body: Record<string, unknown>): InventorySetRequest {
  const inventoryItemId = requireGid(body['inventoryItemId'], 'InventoryItem', 'inventoryItemId');
  const locationId = requireGid(body['locationId'], 'Location', 'locationId');

  const rawQuantity = body['quantity'];
  if (typeof rawQuantity !== 'number' || !Number.isInteger(rawQuantity)) {
    throw new AppError('VALIDATION_ERROR', 'quantity must be an integer.');
  }
  if (rawQuantity < 0) {
    // Never coerce a negative to 0 silently - it signals a caller bug.
    throw new AppError('VALIDATION_ERROR', 'quantity must not be negative.');
  }
  if (rawQuantity > 1_000_000_000) {
    throw new AppError('VALIDATION_ERROR', 'quantity is implausibly large.');
  }

  let name: InventoryQuantityName = 'available';
  if (body['name'] !== undefined && body['name'] !== null) {
    const raw = String(body['name']).toLowerCase();
    if (!(NAMES as readonly string[]).includes(raw)) {
      throw new AppError('VALIDATION_ERROR', `name must be one of ${NAMES.join(', ')}.`);
    }
    name = raw as InventoryQuantityName;
  }

  const request: InventorySetRequest = {
    inventoryItemId,
    locationId,
    quantity: rawQuantity,
    name,
    confirmLargeChange: false,
  };

  if (body['expectedQuantity'] !== undefined && body['expectedQuantity'] !== null) {
    const expected = body['expectedQuantity'];
    if (typeof expected !== 'number' || !Number.isInteger(expected) || expected < 0) {
      throw new AppError(
        'VALIDATION_ERROR',
        'expectedQuantity must be a non-negative integer - the quantity you believe is currently set.',
      );
    }
    request.expectedQuantity = expected;
  }

  if (body['confirmLargeChange'] !== undefined && body['confirmLargeChange'] !== null) {
    if (typeof body['confirmLargeChange'] !== 'boolean') {
      throw new AppError('VALIDATION_ERROR', 'confirmLargeChange must be true or false.');
    }
    request.confirmLargeChange = body['confirmLargeChange'];
  }

  return request;
}

/**
 * Builds the InventorySetQuantitiesInput variable.
 *
 * `ignoreCompareQuantity: true` because this is an operator setting an absolute
 * value from the UI, not a concurrent sync that needs compare-and-set. `reason`
 * is recorded by Shopify for its own audit trail.
 */
export function buildInventorySetInput(request: InventorySetRequest): Record<string, unknown> {
  return {
    name: request.name,
    reason: 'correction',
    ignoreCompareQuantity: true,
    quantities: [
      {
        inventoryItemId: request.inventoryItemId,
        locationId: request.locationId,
        quantity: request.quantity,
      },
    ],
  };
}
