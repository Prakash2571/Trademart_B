/**
 * A connected Shopify store.
 *
 * Access tokens: the client credentials path keeps no token here at all - it
 * holds one in memory and refreshes it. The OAuth redirect flow does need to
 * persist a per-merchant offline token, and it is stored ENCRYPTED, never in
 * plaintext (see common/crypto.ts). Nothing in this schema may ever hold a
 * readable credential.
 */

import { Schema, model, type InferSchemaType } from 'mongoose';

const storeSchema = new Schema(
  {
    // `unique: true` already creates the index; adding `index: true` as well
    // would declare it twice.
    shopDomain: { type: String, required: true, unique: true },
    shopifyShopId: { type: String, default: null },
    name: { type: String, default: null },
    currencyCode: { type: String, default: null },
    timezone: { type: String, default: null },
    planDisplayName: { type: String, default: null },
    isDevelopmentStore: { type: Boolean, default: null },
    apiVersion: { type: String, required: true },
    lastConnectedAt: { type: Date, default: null },
    lastConnectionError: { type: String, default: null },

    // ---- OAuth offline token (redirect flow only) ------------------------
    /**
     * AES-256-GCM envelope produced by common/crypto.ts `encryptSecret`.
     * Named "...Encrypted" so a plaintext write is obvious in review.
     */
    accessTokenEncrypted: { type: String, default: null },
    /** Scopes Shopify actually granted at install time. */
    tokenScopes: { type: [String], default: [] },
    /**
     * Offline tokens do not expire, but the field exists so an online/expiring
     * token can be stored later without a migration.
     */
    tokenExpiresAt: { type: Date, default: null },
    installedAt: { type: Date, default: null },
    /**
     * Set when app/uninstalled arrives. The row is kept (not deleted) so the
     * install history survives, but the token is cleared at the same time.
     */
    uninstalledAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'stores' },
);

export type Store = InferSchemaType<typeof storeSchema>;
export const StoreModel = model('Store', storeSchema);
