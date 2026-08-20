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

  return { inventoryItemId, locationId, quantity: rawQuantity, name };
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
