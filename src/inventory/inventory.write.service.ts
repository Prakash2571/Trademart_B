/**
 * Inventory writes + location reads against the Shopify Admin API.
 *
 * Validation lives in inventory.write.ts (pure); this only calls. Setting an
 * absolute quantity requires the inventory item to be stocked at the location -
 * if Shopify reports it is not activated there, the userError is surfaced as-is
 * rather than silently swallowed.
 *
 * Requires read_locations (list) and write_inventory (set).
 */

import { AppError } from '../common/errors';
import { logger } from '../common/logger';
import { config } from '../config';
import {
  INVENTORY_LEVEL_QUERY,
  INVENTORY_SET_QUANTITIES_MUTATION,
  LOCATIONS_QUERY,
} from '../shopify/graphql/inventory.queries';
import { shopifyGraphql } from '../shopify/shopify.client';
import { mapUserErrors } from '../shopify/shopify.errors';
import {
  assessInventoryChange,
  buildInventorySetInput,
  type InventorySetRequest,
} from './inventory.write';

export interface LocationDto {
  id: string;
  name: string;
  isActive: boolean;
  shipsInventory: boolean;
  fulfillsOnlineOrders: boolean;
}

interface LocationsResponse {
  locations: { edges: { node: LocationDto }[] } | null;
}

/** Lists active store locations for the operator to choose from. */
export async function listLocations(): Promise<LocationDto[]> {
  const result = await shopifyGraphql<LocationsResponse>(
    LOCATIONS_QUERY,
    { first: 100 },
    { operation: 'listLocations' },
  );
  return (result.data.locations?.edges ?? []).map((edge) => edge.node);
}

export interface InventorySetResult {
  inventoryItemId: string;
  locationId: string;
  locationName: string | null;
  name: string;
  /** The quantity BEFORE the change, so the write is reversible. */
  quantityBefore: number | null;
  quantityAfter: number | null;
  delta: number | null;
  /** True when the change exceeded MAX_INVENTORY_DELTA and was confirmed. */
  largeChangeConfirmed: boolean;
  sku: string | null;
  shopifyProductId: string | null;
  shopifyVariantId: string | null;
}

interface InventoryLevelResponse {
  inventoryItem: {
    id: string;
    sku?: string | null;
    tracked?: boolean | null;
    variant?: {
      id: string;
      title?: string | null;
      product?: { id: string; title?: string | null } | null;
    } | null;
    inventoryLevel?: {
      id: string;
      location?: { id: string; name?: string | null } | null;
      quantities?: { name: string; quantity: number }[] | null;
    } | null;
  } | null;
}

export interface CurrentInventoryLevel {
  quantity: number | null;
  locationName: string | null;
  sku: string | null;
  shopifyProductId: string | null;
  shopifyVariantId: string | null;
  stockedAtLocation: boolean;
}

/**
 * Reads the current quantity before a write.
 *
 * Returns quantity: null rather than throwing when the value cannot be read - the
 * caller decides what to do about an unknown starting point (currently: require
 * explicit confirmation, because a change of unknown size cannot be capped).
 */
export async function getCurrentInventoryLevel(
  inventoryItemId: string,
  locationId: string,
  name: string,
): Promise<CurrentInventoryLevel> {
  const empty: CurrentInventoryLevel = {
    quantity: null,
    locationName: null,
    sku: null,
    shopifyProductId: null,
    shopifyVariantId: null,
    stockedAtLocation: false,
  };

  try {
    const result = await shopifyGraphql<InventoryLevelResponse>(
      INVENTORY_LEVEL_QUERY,
      { inventoryItemId, locationId },
      { operation: 'getInventoryLevel' },
    );

    const item = result.data.inventoryItem;
    if (item === null || item === undefined) return empty;

    const level = item.inventoryLevel ?? null;
    const quantities = level?.quantities ?? [];
    const match = quantities.find((entry) => entry.name === name) ?? null;

    return {
      quantity: match?.quantity ?? null,
      locationName: level?.location?.name ?? null,
      sku: item.sku ?? null,
      shopifyProductId: item.variant?.product?.id ?? null,
      shopifyVariantId: item.variant?.id ?? null,
      stockedAtLocation: level !== null,
    };
  } catch (error) {
    // A missing read_inventory scope must not block a write that write_inventory
    // would allow; it only means the guardrail has to fall back to requiring
    // confirmation.
    logger.info('Could not read the current inventory level before writing.', {
      inventoryItemId,
      locationId,
      code: error instanceof AppError ? error.code : 'INTERNAL_ERROR',
    });
    return empty;
  }
}

interface SetResponse {
  inventorySetQuantities: {
    inventoryAdjustmentGroup: {
      changes: { name: string; quantityAfterChange: number | null }[] | null;
    } | null;
    userErrors: { field?: string[] | null; message?: string }[];
  } | null;
}

/**
 * Sets an absolute quantity for one inventory item at one location.
 *
 * Reads the current value FIRST, which is what makes three guarantees possible:
 *
 *   - a stale write can be detected (expectedQuantity vs reality)
 *   - an oversized change can be capped server-side (MAX_INVENTORY_DELTA)
 *   - the audit entry can record the previous quantity, so the change is
 *     reversible
 *
 * The extra read costs one cheap Shopify query per write. Stock is the field an
 * operator changes while looking at a page that may be minutes old, so it is
 * worth it.
 */
export async function setInventoryQuantity(
  request: InventorySetRequest,
): Promise<InventorySetResult> {
  const current = await getCurrentInventoryLevel(
    request.inventoryItemId,
    request.locationId,
    request.name,
  );

  // ---- Stale-write detection ----------------------------------------------
  if (
    request.expectedQuantity !== undefined &&
    current.quantity !== null &&
    current.quantity !== request.expectedQuantity
  ) {
    throw new AppError(
      'PRODUCT_CHANGED',
      `Stock has changed since this page was loaded: you expected ${request.expectedQuantity} but Shopify now reports ${current.quantity}. Setting ${request.quantity} would overwrite that newer change. Refresh and try again.`,
      {
        details: {
          expectedQuantity: request.expectedQuantity,
          currentQuantity: current.quantity,
          requestedQuantity: request.quantity,
          inventoryItemId: request.inventoryItemId,
          locationId: request.locationId,
        },
      },
    );
  }

  // ---- Server-side size cap ------------------------------------------------
  const assessment = assessInventoryChange(
    current.quantity,
    request,
    config.maxInventoryDelta,
  );
  if (!assessment.allowed) {
    throw new AppError('INVENTORY_DELTA_TOO_LARGE', assessment.reason ?? 'Change refused.', {
      details: {
        from: assessment.from,
        to: assessment.to,
        delta: assessment.delta,
        maxInventoryDelta: config.maxInventoryDelta,
        inventoryItemId: request.inventoryItemId,
        locationId: request.locationId,
      },
    });
  }

  // A clearly-flagged large change is worth an explicit log line of its own -
  // this is the write most likely to be regretted.
  if (assessment.requiresConfirmation) {
    logger.warn('Applying a confirmed large inventory change.', {
      inventoryItemId: request.inventoryItemId,
      locationId: request.locationId,
      from: assessment.from,
      to: assessment.to,
      delta: assessment.delta,
      maxInventoryDelta: config.maxInventoryDelta,
    });
  }

  const result = await shopifyGraphql<SetResponse>(
    INVENTORY_SET_QUANTITIES_MUTATION,
    { input: buildInventorySetInput(request) },
    { operation: 'inventorySetQuantities' },
  );

  const userError = mapUserErrors(result.data.inventorySetQuantities?.userErrors);
  if (userError !== null) {
    // A common, fixable cause worth naming rather than passing through raw.
    if (!current.stockedAtLocation) {
      throw new AppError(
        userError.code,
        `${userError.message} This inventory item does not appear to be stocked at ${current.locationName ?? 'that location'} - activate it there first.`,
        { details: userError.details },
      );
    }
    throw userError;
  }

  // Report the resulting quantity for the state we set, when Shopify returns it.
  const changes = result.data.inventorySetQuantities?.inventoryAdjustmentGroup?.changes ?? [];
  const change = changes.find((c) => c.name === request.name) ?? changes[0] ?? null;

  logger.info('Set inventory quantity.', {
    inventoryItemId: request.inventoryItemId,
    locationId: request.locationId,
    name: request.name,
    quantityBefore: current.quantity,
    quantity: request.quantity,
    delta: assessment.delta,
  });

  return {
    inventoryItemId: request.inventoryItemId,
    locationId: request.locationId,
    locationName: current.locationName,
    name: request.name,
    quantityBefore: current.quantity,
    quantityAfter: change?.quantityAfterChange ?? request.quantity,
    delta: assessment.delta,
    largeChangeConfirmed: assessment.requiresConfirmation,
    sku: current.sku,
    shopifyProductId: current.shopifyProductId,
    shopifyVariantId: current.shopifyVariantId,
  };
}
