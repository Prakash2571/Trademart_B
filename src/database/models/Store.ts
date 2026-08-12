/**
 * A connected Shopify store.
 *
 * Note: no access token field. This milestone reads the token from the
 * environment. When merchant OAuth is implemented, tokens must be encrypted at
 * rest - never stored in plaintext here.
 */

import { Schema, model, type InferSchemaType } from 'mongoose';

const storeSchema = new Schema(
  {
    shopDomain: { type: String, required: true, unique: true, index: true },
    shopifyShopId: { type: String, default: null },
    name: { type: String, default: null },
    currencyCode: { type: String, default: null },
    timezone: { type: String, default: null },
    planDisplayName: { type: String, default: null },
    isDevelopmentStore: { type: Boolean, default: null },
    apiVersion: { type: String, required: true },
    lastConnectedAt: { type: Date, default: null },
    lastConnectionError: { type: String, default: null },
  },
  { timestamps: true, collection: 'stores' },
);

export type Store = InferSchemaType<typeof storeSchema>;
export const StoreModel = model('Store', storeSchema);
