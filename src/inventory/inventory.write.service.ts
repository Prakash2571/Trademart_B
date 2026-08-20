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

import { logger } from '../common/logger';
import {
  INVENTORY_SET_QUANTITIES_MUTATION,
  LOCATIONS_QUERY,
} from '../shopify/graphql/inventory.queries';
import { shopifyGraphql } from '../shopify/shopify.client';
import { mapUserErrors } from '../shopify/shopify.errors';
import { buildInventorySetInput, type InventorySetRequest } from './inventory.write';

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
  name: string;
  quantityAfter: number | null;
}

interface SetResponse {
  inventorySetQuantities: {
    inventoryAdjustmentGroup: {
      changes: { name: string; quantityAfterChange: number | null }[] | null;
    } | null;
    userErrors: { field?: string[] | null; message?: string }[];
  } | null;
}

/** Sets an absolute quantity for one inventory item at one location. */
export async function setInventoryQuantity(
  request: InventorySetRequest,
): Promise<InventorySetResult> {
  const result = await shopifyGraphql<SetResponse>(
    INVENTORY_SET_QUANTITIES_MUTATION,
    { input: buildInventorySetInput(request) },
    { operation: 'inventorySetQuantities' },
  );

  const userError = mapUserErrors(result.data.inventorySetQuantities?.userErrors);
  if (userError !== null) throw userError;

  // Report the resulting quantity for the state we set, when Shopify returns it.
  const changes = result.data.inventorySetQuantities?.inventoryAdjustmentGroup?.changes ?? [];
  const change = changes.find((c) => c.name === request.name) ?? changes[0] ?? null;

  logger.info('Set inventory quantity.', {
    inventoryItemId: request.inventoryItemId,
    locationId: request.locationId,
    name: request.name,
    quantity: request.quantity,
  });

  return {
    inventoryItemId: request.inventoryItemId,
    locationId: request.locationId,
    name: request.name,
    quantityAfter: change?.quantityAfterChange ?? request.quantity,
  };
}
