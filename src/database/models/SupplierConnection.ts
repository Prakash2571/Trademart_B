/**
 * A supplier account connected to Trademart (today only DeoDap), one per shop.
 *
 * Holds two very different things:
 *
 *   settings              non-secret configuration, validated in TypeScript
 *                         (suppliers/deodap/deodap.settings.ts) and stored as Mixed,
 *                         like DropshippingSettings
 *   credentialsEncrypted  the supplier login or API key, AES-256-GCM encrypted with
 *                         TOKEN_ENCRYPTION_KEY (common/crypto.ts). No route ever
 *                         returns it, and no readable credential is ever stored.
 *
 * `maskedIdentifier` and `accountLabel` exist so the UI can say WHICH account is
 * connected without decrypting anything.
 */

import { Schema, model, type InferSchemaType } from 'mongoose';

const supplierConnectionSchema = new Schema(
  {
    shopDomain: { type: String, required: true },
    provider: { type: String, required: true, enum: ['DEODAP'] },
    settings: { type: Schema.Types.Mixed, default: null },
    settingsUpdatedAt: { type: Date, default: null },
    /** API_KEY | ACCOUNT_LOGIN, or null when nothing is stored. Checked in code. */
    credentialKind: { type: String, default: null },
    credentialsEncrypted: { type: String, default: null },
    maskedIdentifier: { type: String, default: null },
    accountLabel: { type: String, default: null },
    credentialsUpdatedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'supplier_connections' },
);

supplierConnectionSchema.index({ shopDomain: 1, provider: 1 }, { unique: true });

export type SupplierConnection = InferSchemaType<typeof supplierConnectionSchema>;
export const SupplierConnectionModel = model('SupplierConnection', supplierConnectionSchema);
