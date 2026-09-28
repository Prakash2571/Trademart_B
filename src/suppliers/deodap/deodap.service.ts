/**
 * DeoDap: the impure half - MongoDB, Shopify and encryption.
 *
 * Every rule is in a pure module next door and unit tested there:
 *
 *   deodap.settings.ts   settings and credential validation, masking
 *   deodap.catalog.ts    reading a DeoDap file into products
 *   deodap.pricing.ts    selling prices
 *   deodap.import.ts     preview, drafts, the import batch contract
 *   deodap.sync.ts       matching a new price list to what was imported
 *   deodap.orders.ts     which order lines are DeoDap's, and what was recorded
 *
 * This file only loads, saves and calls. Three guarantees are enforced HERE because
 * they need the database or Shopify:
 *
 *   1. Credentials are encrypted before they are written and never returned.
 *   2. One DeoDap product is created in Shopify at most once: a unique-index claim in
 *      the import ledger comes before the first Shopify write, and a product whose SKU
 *      already exists in Shopify is skipped.
 *   3. Nothing is sent to DeoDap. There is no DeoDap API to send it to (deodap.api.ts).
 */

import { recordAudit } from '../../audit/audit.service';
import { decodeEncryptionKey, decryptSecret, encryptSecret } from '../../common/crypto';
import { AppError } from '../../common/errors';
import { logger } from '../../common/logger';
import { getContext, getRequestId } from '../../common/requestContext';
import { toShopifyGid } from '../../common/validate';
import { config } from '../../config';
import { SupplierConnectionModel } from '../../database/models/SupplierConnection';
import { SupplierImportModel } from '../../database/models/SupplierImport';
import { SupplierOrderModel } from '../../database/models/SupplierOrder';
import { SupplierProductModel } from '../../database/models/SupplierProduct';
import { getDatabaseStatus } from '../../database/mongo';
import {
  createProduct,
  type ProductCreateResult,
} from '../../products/products.create.service';
import { getOrder, getShop, listOrders, listProducts } from '../../shopify/shopify.service';
import type { OrderDto, PageMeta } from '../../shopify/shopify.types';
import type { ManualCost } from '../cost';
import { findManualCost, loadManualCostMap, upsertManualCost } from '../manualCost.service';
import { DEODAP_API_AVAILABILITY, type DeodapApiAvailability } from './deodap.api';
import {
  CATALOG_FIELDS,
  readCatalog,
  refKeyOf,
  type CatalogFieldInfo,
  type ColumnMapping,
} from './deodap.catalog';
import { getDeodapSkuPrefixes, setDeodapSkuPrefixes } from './deodap.identify';
import {
  buildImportPreview,
  matchCreatedVariants,
  summariseImport,
  validateCsvRequest,
  validateImportPreviewRequest,
  validateImportRequest,
  type ExistingImport,
  type ImportBatchResult,
  type ImportItem,
  type ImportItemResult,
  type ImportOutcome,
  type ImportPreview,
  type ImportRequest,
} from './deodap.import';
import {
  buildDeodapOrderView,
  extractDeodapLines,
  stageTimestamps,
  validateForwardingUpdate,
  type DeodapLineMatch,
  type DeodapOrderStatus,
  type DeodapOrderView,
  type ForwardingRecord,
} from './deodap.orders';
import {
  maskDeodapIdentifier,
  readStoredSettings,
  validateDeodapCredentials,
  validateDeodapSettings,
  type DeodapCredentialKind,
  type DeodapSettings,
} from './deodap.settings';
import {
  planCostSync,
  validateSyncRequest,
  type LedgerProductRef,
  type StoredCost,
  type SyncPlan,
} from './deodap.sync';

const PROVIDER = 'DEODAP';

/** How long an import claim protects a product before a crashed import is taken over. */
const CLAIM_LEASE_MS = 10 * 60_000;

/** Failures that would fail every remaining product in a batch the same way. */
const STOP_CODES: ReadonlySet<string> = new Set([
  'SHOPIFY_NOT_CONFIGURED',
  'SHOPIFY_UNAUTHORIZED',
  'SHOPIFY_AUTH_FAILED',
  'SHOPIFY_APP_NOT_INSTALLED',
  'SHOPIFY_SCOPE_MISSING',
  'SHOPIFY_THROTTLED',
  'SHOPIFY_DEGRADED',
  'SHOPIFY_TIMEOUT',
  'SHOPIFY_NETWORK_ERROR',
  'DATABASE_UNAVAILABLE',
]);

/* ===========================================================================
 * Row shapes, as read back with lean()
 * ======================================================================== */

interface ConnectionRow {
  settings?: unknown;
  settingsUpdatedAt?: Date | null;
  credentialKind?: string | null;
  credentialsEncrypted?: string | null;
  maskedIdentifier?: string | null;
  accountLabel?: string | null;
  credentialsUpdatedAt?: Date | null;
}

interface ImportedVariantRow {
  shopifyVariantId?: string | null;
  sku?: string | null;
  optionValues?: string[];
  cost?: number | null;
  shippingCost?: number | null;
}

interface ImportRow {
  supplierRef: string;
  refKey: string;
  status: ExistingImport['status'];
  title: string;
  shopifyProductId?: string | null;
  currencyCode?: string | null;
  variants?: ImportedVariantRow[];
  sourceFile?: string | null;
  sourceLine?: number | null;
  error?: string | null;
  errorCode?: string | null;
  lastCostSyncAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

interface OrderRow {
  shopifyOrderId: string;
  status: DeodapOrderStatus;
  placedVia?: string | null;
  supplierOrderId?: string | null;
  trackingCompany?: string | null;
  trackingNumber?: string | null;
  trackingUrl?: string | null;
  note?: string | null;
  placedAt?: Date | null;
  shippedAt?: Date | null;
  deliveredAt?: Date | null;
  updatedBy?: string | null;
  updatedAt?: Date;
}

/* ===========================================================================
 * Helpers
 * ======================================================================== */

function shopDomain(): string {
  return config.shopify.storeDomain;
}

function databaseConnected(): boolean {
  return getDatabaseStatus().status === 'connected';
}

function requireDatabase(what: string): void {
  if (!databaseConnected()) {
    throw new AppError(
      'DATABASE_UNAVAILABLE',
      `${what} needs MongoDB, which is not connected. Nothing was changed. Set MONGODB_URI and retry.`,
    );
  }
}

function iso(value: unknown): string | null {
  return value instanceof Date ? value.toISOString() : null;
}

function isDuplicateKeyError(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  return code === 11000 || code === 11001;
}

/**
 * An AppError that is safe to show. An unexpected error's own message can contain
 * internals, so it is logged here and replaced, as the global error handler does.
 */
function safeError(error: unknown, context: string): AppError {
  if (error instanceof AppError) return error;
  logger.error(`Unexpected error ${context}.`, {
    reason: error instanceof Error ? error.message : String(error),
  });
  return new AppError(
    'INTERNAL_ERROR',
    'An unexpected error stopped this step. The server log has the details for this request id.',
  );
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function nonNull<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

/** Splits a list so a $in query never carries thousands of values at once. */
function chunks<T>(values: readonly T[], size = 500): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    out.push(values.slice(index, index + size));
  }
  return out;
}

function connectionKey(): { shopDomain: string; provider: string } {
  return { shopDomain: shopDomain(), provider: PROVIDER };
}

async function loadConnection(): Promise<ConnectionRow | null> {
  const row = await SupplierConnectionModel.findOne(connectionKey()).lean();
  return row as unknown as ConnectionRow | null;
}

/* ===========================================================================
 * Connection: settings and credentials
 * ======================================================================== */

export interface DeodapCredentialStatus {
  stored: boolean;
  kind: DeodapCredentialKind | null;
  accountLabel: string | null;
  maskedIdentifier: string | null;
  updatedAt: string | null;
  /**
   * Whether the stored credentials decrypt with the current TOKEN_ENCRYPTION_KEY.
   * False means the key changed since they were saved: save them again. Null when
   * nothing is stored or no key is configured.
   */
  readable: boolean | null;
}

export interface DeodapStatus {
  provider: 'DEODAP';
  databaseConnected: boolean;
  /** TOKEN_ENCRYPTION_KEY is set, so credentials can be stored. */
  encryptionConfigured: boolean;
  settings: DeodapSettings;
  settingsUpdatedAt: string | null;
  /** The SKU prefixes supplier identification is using right now. */
  activeSkuPrefixes: string[];
  credentials: DeodapCredentialStatus;
  api: DeodapApiAvailability;
  counts: { importedProducts: number; recordedOrders: number } | null;
}

function credentialStatus(row: ConnectionRow | null): DeodapCredentialStatus {
  const encrypted = row?.credentialsEncrypted ?? null;
  const keyValue = config.tokenEncryptionKey;
  let readable: boolean | null = null;
  if (encrypted !== null && keyValue !== null) {
    try {
      // Decrypted only to prove it can be; the plaintext is discarded immediately.
      decryptSecret(encrypted, decodeEncryptionKey(keyValue));
      readable = true;
    } catch {
      readable = false;
    }
  }
  const rawKind = row?.credentialKind ?? null;
  const kind: DeodapCredentialKind | null =
    rawKind === 'API_KEY' || rawKind === 'ACCOUNT_LOGIN' ? rawKind : null;
  const stored = encrypted !== null;
  return {
    stored,
    kind: stored ? kind : null,
    accountLabel: stored ? (row?.accountLabel ?? null) : null,
    maskedIdentifier: stored ? (row?.maskedIdentifier ?? null) : null,
    updatedAt: iso(row?.credentialsUpdatedAt),
    readable,
  };
}

/** The stored settings, or the defaults when there are none or no database. */
export async function loadDeodapSettings(): Promise<{
  settings: DeodapSettings;
  updatedAt: string | null;
}> {
  if (!databaseConnected()) return { settings: readStoredSettings(null), updatedAt: null };
  const row = await loadConnection();
  return { settings: readStoredSettings(row?.settings), updatedAt: iso(row?.settingsUpdatedAt) };
}

/**
 * Puts the stored SKU prefixes into effect. Called once at startup; never throws,
 * because a supplier setting must not stop the server from booting.
 */
export async function applyStoredDeodapSettings(): Promise<void> {
  if (!databaseConnected()) return;
  try {
    const { settings } = await loadDeodapSettings();
    setDeodapSkuPrefixes(settings.skuPrefixes);
    if (settings.skuPrefixes.length > 0) {
      logger.info('DeoDap SKU prefixes are in effect.', { count: settings.skuPrefixes.length });
    }
  } catch (error) {
    logger.warn(
      'Could not load the DeoDap settings. DeoDap SKU prefix matching is off until they are saved again.',
      { reason: error instanceof Error ? error.message : 'unknown' },
    );
  }
}

export async function getDeodapStatus(): Promise<DeodapStatus> {
  const connected = databaseConnected();
  const row = connected ? await loadConnection() : null;

  let counts: DeodapStatus['counts'] = null;
  if (connected) {
    const [importedProducts, recordedOrders] = await Promise.all([
      SupplierImportModel.countDocuments({
        ...connectionKey(),
        status: { $in: ['CREATED', 'PARTIAL'] },
      }),
      SupplierOrderModel.countDocuments(connectionKey()),
    ]);
    counts = { importedProducts, recordedOrders };
  }

  return {
    provider: 'DEODAP',
    databaseConnected: connected,
    encryptionConfigured: config.tokenEncryptionKey !== null,
    settings: readStoredSettings(row?.settings),
    settingsUpdatedAt: iso(row?.settingsUpdatedAt),
    activeSkuPrefixes: [...getDeodapSkuPrefixes()],
    credentials: credentialStatus(row),
    api: DEODAP_API_AVAILABILITY,
    counts,
  };
}

export async function saveDeodapSettings(
  body: Record<string, unknown>,
): Promise<{ settings: DeodapSettings; updatedAt: string }> {
  requireDatabase('Saving the DeoDap settings');
  const row = await loadConnection();
  const before = readStoredSettings(row?.settings);
  const settings = validateDeodapSettings(body, before);
  const now = new Date();

  await SupplierConnectionModel.updateOne(
    connectionKey(),
    { $set: { settings, settingsUpdatedAt: now } },
    { upsert: true },
  );
  setDeodapSkuPrefixes(settings.skuPrefixes);

  await recordAudit({
    action: 'SUPPLIER_SETTINGS_UPDATE',
    resourceType: 'SUPPLIER',
    resourceId: PROVIDER,
    before,
    after: settings,
  });
  logger.info('Saved the DeoDap settings.', {
    skuPrefixCount: settings.skuPrefixes.length,
    markupPercent: settings.markupPercent,
  });
  return { settings, updatedAt: now.toISOString() };
}

export async function saveDeodapCredentials(
  body: Record<string, unknown>,
): Promise<DeodapCredentialStatus> {
  const keyValue = config.tokenEncryptionKey;
  if (keyValue === null) {
    throw new AppError(
      'ENCRYPTION_NOT_CONFIGURED',
      'TOKEN_ENCRYPTION_KEY is not set on the backend, so DeoDap credentials cannot be stored safely. Nothing was saved. Generate one with "openssl rand -base64 32", set it, restart the backend and try again.',
    );
  }
  requireDatabase('Saving DeoDap credentials');

  const input = validateDeodapCredentials(body);
  const encrypted = encryptSecret(JSON.stringify(input.credentials), decodeEncryptionKey(keyValue));
  const masked = maskDeodapIdentifier(input.credentials);

  const previous = await loadConnection();
  const replaced = (previous?.credentialsEncrypted ?? null) !== null;

  await SupplierConnectionModel.updateOne(
    connectionKey(),
    {
      $set: {
        credentialKind: input.credentials.kind,
        credentialsEncrypted: encrypted,
        maskedIdentifier: masked,
        accountLabel: input.accountLabel,
        credentialsUpdatedAt: new Date(),
      },
    },
    { upsert: true },
  );

  // Kind, label and masked identifier only. The audit sanitiser would redact a
  // credential-named field anyway, but the value is never handed to it at all.
  await recordAudit({
    action: 'SUPPLIER_CONNECT',
    resourceType: 'SUPPLIER',
    resourceId: PROVIDER,
    before: replaced
      ? {
          kind: previous?.credentialKind ?? null,
          label: previous?.accountLabel ?? null,
          masked: previous?.maskedIdentifier ?? null,
        }
      : null,
    after: { kind: input.credentials.kind, label: input.accountLabel, masked },
    metadata: { replaced },
  });
  logger.info('Stored encrypted DeoDap credentials.', {
    kind: input.credentials.kind,
    replaced,
  });

  return credentialStatus(await loadConnection());
}

export async function deleteDeodapCredentials(): Promise<{ removed: boolean }> {
  requireDatabase('Removing DeoDap credentials');
  const previous = await loadConnection();
  const removed = (previous?.credentialsEncrypted ?? null) !== null;

  if (removed) {
    await SupplierConnectionModel.updateOne(connectionKey(), {
      $set: {
        credentialKind: null,
        credentialsEncrypted: null,
        maskedIdentifier: null,
        accountLabel: null,
        credentialsUpdatedAt: new Date(),
      },
    });
  }

  await recordAudit({
    action: 'SUPPLIER_DISCONNECT',
    resourceType: 'SUPPLIER',
    resourceId: PROVIDER,
    before: removed
      ? {
          kind: previous?.credentialKind ?? null,
          label: previous?.accountLabel ?? null,
          masked: previous?.maskedIdentifier ?? null,
        }
      : null,
    after: null,
    metadata: { removed },
  });
  if (removed) logger.info('Removed the stored DeoDap credentials.');
  return { removed };
}

/* ===========================================================================
 * Import
 * ======================================================================== */

export async function previewDeodapImport(body: Record<string, unknown>): Promise<ImportPreview> {
  const { settings } = await loadDeodapSettings();
  const request = validateImportPreviewRequest(body, settings);
  const catalog = readCatalog(request.csv, request.mapping);

  const ledgerChecked = databaseConnected();
  const existing = new Map<string, ExistingImport>();
  if (ledgerChecked) {
    const refKeys = unique(
      catalog.products.map((product) => product.ref).filter(nonNull).map(refKeyOf),
    );
    for (const batch of chunks(refKeys)) {
      const rows = (await SupplierImportModel.find({
        ...connectionKey(),
        refKey: { $in: batch },
      }).lean()) as unknown as ImportRow[];
      for (const row of rows) {
        existing.set(row.refKey, {
          status: row.status,
          shopifyProductId: row.shopifyProductId ?? null,
          error: row.error ?? null,
          updatedAt: iso(row.updatedAt),
        });
      }
    }
  }

  let shopCurrency: string | null = null;
  let shopCurrencyError: string | null = null;
  try {
    shopCurrency = (await getShop()).currencyCode;
  } catch (error) {
    shopCurrencyError = safeError(error, 'reading the store currency').message;
  }

  return buildImportPreview({
    catalog,
    request,
    vendor: settings.vendorName,
    existing,
    ledgerChecked,
    shopCurrency,
    shopCurrencyError,
  });
}

function itemResult(
  item: ImportItem,
  outcome: ImportOutcome,
  extra: { reason?: string | null; errorCode?: string | null; shopifyProductId?: string | null },
): ImportItemResult {
  return {
    ref: item.draft.ref,
    title: item.draft.title,
    outcome,
    shopifyProductId: extra.shopifyProductId ?? null,
    reason: extra.reason ?? null,
    errorCode: extra.errorCode ?? null,
    warnings: [],
    costsRecorded: 0,
  };
}

function quoteSearchTerm(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * The first Shopify product already carrying one of these SKUs, or null.
 *
 * This is what stops a duplicate when the import ledger cannot: a product created by a
 * previous attempt whose response was lost, or one that reached Shopify some other way.
 */
async function findProductWithSku(
  skus: readonly (string | null)[],
): Promise<{ sku: string; shopifyProductId: string } | null> {
  const wanted = unique(
    skus.filter(nonNull).map((sku) => sku.trim()).filter((sku) => sku.length > 0),
  ).slice(0, 20);
  if (wanted.length === 0) return null;

  const bySku = new Map(wanted.map((sku) => [sku.toLowerCase(), sku] as const));
  const page = await listProducts({
    first: 10,
    query: wanted.map((sku) => `sku:${quoteSearchTerm(sku)}`).join(' OR '),
  });
  for (const product of page.items) {
    for (const variant of product.variants) {
      const match = variant.sku === null ? undefined : bySku.get(variant.sku.trim().toLowerCase());
      if (match !== undefined) return { sku: match, shopifyProductId: product.shopifyProductId };
    }
  }
  return null;
}

/**
 * Claims a supplier reference for this import. Returns null when claimed, or the
 * reason it was skipped.
 *
 * The insert is the claim: the unique index means only one concurrent import can
 * succeed. A FAILED row, or a CLAIMED row whose lease ran out (the import that held it
 * crashed), is taken over with a conditional update, which is equally atomic.
 */
async function claimImport(
  item: ImportItem,
  refKey: string,
  request: ImportRequest,
): Promise<{ reason: string; shopifyProductId: string | null } | null> {
  const now = new Date();
  const key = { ...connectionKey(), refKey };
  const fields = {
    supplierRef: item.draft.ref,
    title: item.draft.title,
    status: 'CLAIMED',
    currencyCode: request.currencyCode,
    source: 'CSV',
    sourceFile: request.sourceFile,
    sourceLine: item.draft.sourceLine,
    claimedAt: now,
    error: null,
    errorCode: null,
    requestId: getRequestId(),
  };

  try {
    await SupplierImportModel.create({ ...key, ...fields });
    return null;
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;
  }

  const takenOver = await SupplierImportModel.findOneAndUpdate(
    {
      ...key,
      $or: [
        { status: 'FAILED' },
        { status: 'CLAIMED', claimedAt: { $lt: new Date(now.getTime() - CLAIM_LEASE_MS) } },
      ],
    },
    { $set: fields },
    { new: true },
  ).lean();
  if (takenOver !== null) return null;

  const existing = (await SupplierImportModel.findOne(key).lean()) as unknown as ImportRow | null;
  if (existing === null) {
    return {
      reason: 'Its import record changed while this batch was running. Preview the file again and retry.',
      shopifyProductId: null,
    };
  }
  if (existing.status === 'CLAIMED') {
    return {
      reason: 'Another import of this product is still running. Wait a minute, then preview the file again.',
      shopifyProductId: null,
    };
  }
  return { reason: 'Already imported from DeoDap.', shopifyProductId: existing.shopifyProductId ?? null };
}

async function markImportFailed(refKey: string, error: AppError): Promise<void> {
  try {
    await SupplierImportModel.updateOne(
      { ...connectionKey(), refKey, status: 'CLAIMED' },
      {
        $set: {
          status: 'FAILED',
          claimedAt: null,
          error: error.message.slice(0, 500),
          errorCode: error.code,
        },
      },
    );
  } catch (inner) {
    logger.error(
      'Could not mark a DeoDap import as failed. It stays claimed until its lease runs out.',
      { refKey, reason: inner instanceof Error ? inner.message : 'unknown' },
    );
  }
}

function costNote(item: ImportItem, sourceFile: string | null): string {
  const from = sourceFile === null ? 'a DeoDap file' : `"${sourceFile}"`;
  const line = item.draft.sourceLine === null ? '' : `, line ${item.draft.sourceLine}`;
  return `DeoDap ${item.draft.ref} - imported from ${from}${line}.`.slice(0, 500);
}

async function importOne(item: ImportItem, request: ImportRequest): Promise<ImportItemResult> {
  const { draft } = item;
  const refKey = refKeyOf(draft.ref);

  const skipped = await claimImport(item, refKey, request);
  if (skipped !== null) return itemResult(item, 'SKIPPED', skipped);

  // ---- Before any write: is it already in Shopify under the same SKU? -------
  let duplicate: { sku: string; shopifyProductId: string } | null;
  try {
    duplicate = await findProductWithSku(draft.variants.map((variant) => variant.sku));
  } catch (error) {
    const appError = safeError(error, 'checking Shopify for an existing SKU');
    await markImportFailed(refKey, appError);
    throw appError;
  }
  if (duplicate !== null) {
    await SupplierImportModel.deleteOne({ ...connectionKey(), refKey, status: 'CLAIMED' });
    return itemResult(item, 'SKIPPED', {
      reason: `A product with SKU "${duplicate.sku}" is already in Shopify, so it was not created again.`,
      shopifyProductId: duplicate.shopifyProductId,
    });
  }

  // ---- The Shopify write ---------------------------------------------------
  let created: ProductCreateResult;
  try {
    created = await createProduct(item.create);
  } catch (error) {
    const appError = safeError(error, 'creating a DeoDap product in Shopify');
    await markImportFailed(refKey, appError);
    throw appError;
  }

  // ---- From here the product EXISTS. Nothing below may report a failure that
  // ---- would invite a retry and a second product.
  const warnings = [...created.warnings];
  const variantIds = matchCreatedVariants(draft.variants, created.variants);
  let costsRecorded = 0;
  for (const [index, variant] of draft.variants.entries()) {
    const shopifyVariantId = variantIds[index] ?? null;
    const label = variant.sku === null ? `variant ${index + 1}` : `SKU ${variant.sku}`;
    if (shopifyVariantId === null) {
      warnings.push(
        `The DeoDap cost for ${label} was not recorded: it could not be matched to a created variant. Set it from the product page.`,
      );
      continue;
    }
    try {
      await upsertManualCost({
        shopifyProductId: created.shopifyProductId,
        shopifyVariantId,
        provider: 'DEODAP',
        supplierProductCost: variant.cost,
        // A manual cost never stores 0; free shipping is recorded as none.
        supplierShippingCost:
          variant.shippingCost !== null && variant.shippingCost > 0 ? variant.shippingCost : null,
        currencyCode: request.currencyCode,
        // The DeoDap price list is the operator's chosen cost source for these
        // products, so it wins over an empty Shopify cost per item - as a research
        // push does.
        override: true,
        note: costNote(item, request.sourceFile),
      });
      costsRecorded += 1;
    } catch (error) {
      warnings.push(
        `The DeoDap cost for ${label} could not be recorded (${safeError(error, 'recording a DeoDap cost').code}). Set it from the product page.`,
      );
    }
  }

  let complete = !created.partialSuccess && costsRecorded === draft.variants.length;
  try {
    await SupplierImportModel.updateOne(
      { ...connectionKey(), refKey },
      {
        $set: {
          status: complete ? 'CREATED' : 'PARTIAL',
          shopifyProductId: created.shopifyProductId,
          title: created.title,
          variants: draft.variants.map((variant, index) => ({
            shopifyVariantId: variantIds[index] ?? null,
            sku: variant.sku,
            optionValues: variant.optionValues.map((option) => option.name),
            cost: variant.cost,
            shippingCost: variant.shippingCost,
          })),
          claimedAt: null,
          error: complete ? null : warnings.join(' ').slice(0, 1000),
          errorCode: null,
        },
      },
    );
  } catch (error) {
    complete = false;
    warnings.push(
      `The product was created, but Trademart could not update its import record (${safeError(error, 'updating the DeoDap import ledger').code}). Do not import it again - find it in the review queue.`,
    );
  }

  await recordAudit({
    action: 'SUPPLIER_IMPORT',
    resourceType: 'PRODUCT',
    resourceId: created.shopifyProductId,
    before: null,
    after: {
      title: created.title,
      status: created.status,
      supplierRef: draft.ref,
      variants: draft.variants.length,
      costsRecorded,
      currencyCode: request.currencyCode,
    },
    result: complete ? 'SUCCESS' : 'PARTIAL',
    metadata: {
      provider: PROVIDER,
      sourceFile: request.sourceFile,
      sourceLine: draft.sourceLine,
      warnings,
    },
  });

  return {
    ref: draft.ref,
    title: created.title,
    outcome: complete ? 'CREATED' : 'PARTIAL',
    shopifyProductId: created.shopifyProductId,
    reason: null,
    errorCode: null,
    warnings,
    costsRecorded,
  };
}

/**
 * Imports a batch of drafts from the preview, one product at a time.
 *
 * One product failing does not stop the others - unless it failed for a reason that
 * would fail them all (Shopify throttled, credentials missing, database down), in
 * which case the rest are reported NOT_ATTEMPTED rather than hammered into failure.
 */
export async function importDeodapProducts(body: Record<string, unknown>): Promise<ImportBatchResult> {
  requireDatabase('Importing DeoDap products');
  const { settings } = await loadDeodapSettings();
  const request = validateImportRequest(body, settings.vendorName);

  const shop = await getShop();
  if (shop.currencyCode.toUpperCase() !== request.currencyCode) {
    throw new AppError(
      'CURRENCY_MISMATCH',
      `Your Shopify store sells in ${shop.currencyCode}, but these DeoDap costs are in ${request.currencyCode}. The selling prices were worked out from the costs, so they would be in the wrong currency. Nothing was imported. Trademart does not convert currencies.`,
    );
  }

  const results: ImportItemResult[] = [];
  let stop: AppError | null = null;
  for (const item of request.items) {
    if (stop !== null) {
      results.push(
        itemResult(item, 'NOT_ATTEMPTED', {
          reason: `Not attempted: an earlier product failed with ${stop.code}, which would fail this one too.`,
          errorCode: stop.code,
        }),
      );
      continue;
    }
    try {
      results.push(await importOne(item, request));
    } catch (error) {
      const appError = safeError(error, 'importing a DeoDap product');
      if (STOP_CODES.has(appError.code)) stop = appError;
      results.push(itemResult(item, 'FAILED', { reason: appError.message, errorCode: appError.code }));
      await recordAudit({
        action: 'SUPPLIER_IMPORT',
        resourceType: 'PRODUCT',
        resourceId: null,
        after: { title: item.draft.title, supplierRef: item.draft.ref },
        metadata: {
          provider: PROVIDER,
          sourceFile: request.sourceFile,
          sourceLine: item.draft.sourceLine,
        },
        result: 'FAILURE',
        error: appError,
      });
    }
  }

  const batch = summariseImport(results);
  logger.info('DeoDap import batch finished.', { ...batch.summary });
  return batch;
}

export interface ImportRecordView {
  supplierRef: string;
  title: string;
  status: ExistingImport['status'];
  shopifyProductId: string | null;
  variantCount: number;
  costMin: number | null;
  costMax: number | null;
  currencyCode: string | null;
  sourceFile: string | null;
  sourceLine: number | null;
  error: string | null;
  importedAt: string | null;
  updatedAt: string | null;
  lastCostSyncAt: string | null;
}

/** The import ledger, most recent first. */
export async function listDeodapImports(limit: number): Promise<ImportRecordView[]> {
  requireDatabase('Listing DeoDap imports');
  const rows = (await SupplierImportModel.find(connectionKey())
    .sort({ updatedAt: -1 })
    .limit(limit)
    .lean()) as unknown as ImportRow[];

  return rows.map((row) => {
    const costs = (row.variants ?? [])
      .map((variant) => variant.cost ?? null)
      .filter(nonNull);
    return {
      supplierRef: row.supplierRef,
      title: row.title,
      status: row.status,
      shopifyProductId: row.shopifyProductId ?? null,
      variantCount: (row.variants ?? []).length,
      costMin: costs.length > 0 ? Math.min(...costs) : null,
      costMax: costs.length > 0 ? Math.max(...costs) : null,
      currencyCode: row.currencyCode ?? null,
      sourceFile: row.sourceFile ?? null,
      sourceLine: row.sourceLine ?? null,
      error: row.error ?? null,
      importedAt: iso(row.createdAt),
      updatedAt: iso(row.updatedAt),
      lastCostSyncAt: iso(row.lastCostSyncAt),
    };
  });
}

/* ===========================================================================
 * Cost sync
 * ======================================================================== */

export interface SyncPreview extends SyncPlan {
  file: { sourceFile: string | null; headers: string[]; recordCount: number };
  fields: readonly CatalogFieldInfo[];
  mapping: ColumnMapping;
  warnings: string[];
}

async function loadLedger(): Promise<LedgerProductRef[]> {
  const rows = (await SupplierImportModel.find({
    ...connectionKey(),
    status: { $in: ['CREATED', 'PARTIAL'] },
    shopifyProductId: { $ne: null },
  }).lean()) as unknown as ImportRow[];

  return rows
    .filter((row) => typeof row.shopifyProductId === 'string')
    .map((row) => ({
      supplierRef: row.supplierRef,
      title: row.title,
      shopifyProductId: row.shopifyProductId as string,
      variants: (row.variants ?? [])
        .filter((variant) => typeof variant.shopifyVariantId === 'string')
        .map((variant) => ({
          shopifyVariantId: variant.shopifyVariantId as string,
          sku: variant.sku ?? null,
          optionValues: variant.optionValues ?? [],
        })),
    }));
}

async function loadStoredCosts(ledger: readonly LedgerProductRef[]): Promise<Map<string, StoredCost>> {
  const variantIds = ledger.flatMap((product) => product.variants.map((variant) => variant.shopifyVariantId));
  const costs = new Map<string, StoredCost>();
  for (const batch of chunks(variantIds)) {
    const rows = await SupplierProductModel.find({
      shopDomain: shopDomain(),
      costSource: 'MANUAL',
      shopifyVariantId: { $in: batch },
    }).lean();
    for (const row of rows) {
      if (row.shopifyVariantId == null || row.supplierProductCost == null) continue;
      costs.set(row.shopifyVariantId, {
        amount: row.supplierProductCost,
        shippingCost: row.supplierShippingCost ?? null,
        currencyCode: row.currencyCode ?? null,
      });
    }
  }
  return costs;
}

export async function previewDeodapSync(body: Record<string, unknown>): Promise<SyncPreview> {
  requireDatabase('Matching a DeoDap price list');
  const { settings } = await loadDeodapSettings();
  const request = validateCsvRequest(body, settings);
  const catalog = readCatalog(request.csv, request.mapping);
  const ledger = await loadLedger();
  const plan = planCostSync(catalog.products, ledger, await loadStoredCosts(ledger), request.currencyCode);

  const warnings = [...catalog.warnings];
  if (ledger.length === 0) {
    warnings.push(
      'Nothing has been imported from DeoDap yet, so there is nothing to update. Import products first.',
    );
  }
  return {
    ...plan,
    file: {
      sourceFile: request.sourceFile,
      headers: catalog.headers,
      recordCount: catalog.recordCount,
    },
    fields: CATALOG_FIELDS,
    mapping: catalog.mapping,
    warnings,
  };
}

export interface SyncApplyResult {
  results: { shopifyVariantId: string; outcome: 'UPDATED' | 'SKIPPED' | 'FAILED'; reason: string | null }[];
  summary: { updated: number; skipped: number; failed: number };
}

/**
 * Records the chosen cost changes. Only Trademart's supplier cost changes; the Shopify
 * selling price is left alone.
 */
export async function applyDeodapSync(body: Record<string, unknown>): Promise<SyncApplyResult> {
  requireDatabase('Updating DeoDap costs');
  const request = validateSyncRequest(body);
  const variantIds = request.updates.map((update) => update.shopifyVariantId);

  const rows = (await SupplierImportModel.find({
    ...connectionKey(),
    status: { $in: ['CREATED', 'PARTIAL'] },
    'variants.shopifyVariantId': { $in: variantIds },
  }).lean()) as unknown as ImportRow[];
  const owners = new Map<string, ImportRow>();
  for (const row of rows) {
    for (const variant of row.variants ?? []) {
      if (typeof variant.shopifyVariantId === 'string') owners.set(variant.shopifyVariantId, row);
    }
  }

  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const results: SyncApplyResult['results'] = [];

  for (const update of request.updates) {
    const owner = owners.get(update.shopifyVariantId);
    const shopifyProductId = owner?.shopifyProductId ?? null;
    if (owner === undefined || shopifyProductId === null) {
      results.push({
        shopifyVariantId: update.shopifyVariantId,
        outcome: 'SKIPPED',
        reason: 'This variant was not imported from DeoDap by Trademart.',
      });
      continue;
    }
    try {
      const previous = await findManualCost(shopifyProductId, update.shopifyVariantId);
      const stored = await upsertManualCost({
        shopifyProductId,
        shopifyVariantId: update.shopifyVariantId,
        provider: 'DEODAP',
        supplierProductCost: update.cost,
        supplierShippingCost: update.shippingCost,
        currencyCode: request.currencyCode,
        // An operator who switched the override off keeps it off.
        override: previous?.override ?? true,
        note: `DeoDap ${owner.supplierRef} - cost updated from a DeoDap price list on ${day}.`,
      });
      await SupplierImportModel.updateOne(
        {
          ...connectionKey(),
          refKey: owner.refKey,
          'variants.shopifyVariantId': update.shopifyVariantId,
        },
        {
          $set: {
            'variants.$.cost': update.cost,
            'variants.$.shippingCost': update.shippingCost,
            lastCostSyncAt: now,
          },
        },
      );
      await recordAudit({
        action: 'COST_UPDATE',
        resourceType: 'COST',
        resourceId: update.shopifyVariantId,
        before: previous,
        after: stored,
        metadata: {
          shopifyProductId,
          shopifyVariantId: update.shopifyVariantId,
          provider: PROVIDER,
          source: 'DEODAP_PRICE_LIST',
          created: previous === null,
        },
      });
      results.push({ shopifyVariantId: update.shopifyVariantId, outcome: 'UPDATED', reason: null });
    } catch (error) {
      const appError = safeError(error, 'updating a DeoDap cost');
      results.push({
        shopifyVariantId: update.shopifyVariantId,
        outcome: 'FAILED',
        reason: `${appError.code}: ${appError.message}`,
      });
    }
  }

  const summary = {
    updated: results.filter((result) => result.outcome === 'UPDATED').length,
    skipped: results.filter((result) => result.outcome === 'SKIPPED').length,
    failed: results.filter((result) => result.outcome === 'FAILED').length,
  };
  logger.info('DeoDap cost sync applied.', summary);
  return { results, summary };
}

/* ===========================================================================
 * Orders
 * ======================================================================== */

async function loadRefsByVariant(variantIds: readonly string[]): Promise<Map<string, string>> {
  const refs = new Map<string, string>();
  if (variantIds.length === 0 || !databaseConnected()) return refs;
  const wanted = new Set(variantIds);
  for (const batch of chunks(variantIds)) {
    const rows = (await SupplierImportModel.find({
      ...connectionKey(),
      'variants.shopifyVariantId': { $in: batch },
    }).lean()) as unknown as ImportRow[];
    for (const row of rows) {
      for (const variant of row.variants ?? []) {
        if (typeof variant.shopifyVariantId === 'string' && wanted.has(variant.shopifyVariantId)) {
          refs.set(variant.shopifyVariantId, row.supplierRef);
        }
      }
    }
  }
  return refs;
}

function toForwardingRecord(row: OrderRow): ForwardingRecord {
  return {
    status: row.status,
    supplierOrderId: row.supplierOrderId ?? null,
    trackingCompany: row.trackingCompany ?? null,
    trackingNumber: row.trackingNumber ?? null,
    trackingUrl: row.trackingUrl ?? null,
    note: row.note ?? null,
    placedVia: row.placedVia === 'API' ? 'API' : 'MANUAL',
    placedAt: iso(row.placedAt),
    shippedAt: iso(row.shippedAt),
    deliveredAt: iso(row.deliveredAt),
    updatedAt: iso(row.updatedAt),
    updatedBy: row.updatedBy ?? null,
  };
}

async function loadForwarding(orderIds: readonly string[]): Promise<Map<string, ForwardingRecord>> {
  const records = new Map<string, ForwardingRecord>();
  if (orderIds.length === 0 || !databaseConnected()) return records;
  const rows = (await SupplierOrderModel.find({
    ...connectionKey(),
    shopifyOrderId: { $in: [...orderIds] },
  }).lean()) as unknown as OrderRow[];
  for (const row of rows) records.set(row.shopifyOrderId, toForwardingRecord(row));
  return records;
}

async function loadLineCosts(lines: readonly DeodapLineMatch[]): Promise<ReadonlyMap<string, ManualCost>> {
  const byProduct = new Map<string, Set<string>>();
  for (const line of lines) {
    if (line.shopifyProductId === null || line.shopifyVariantId === null) continue;
    const variants = byProduct.get(line.shopifyProductId) ?? new Set<string>();
    variants.add(line.shopifyVariantId);
    byProduct.set(line.shopifyProductId, variants);
  }
  if (byProduct.size === 0) return new Map();
  try {
    return await loadManualCostMap(
      [...byProduct].map(([shopifyProductId, variantIds]) => ({
        shopifyProductId,
        variantIds: [...variantIds],
      })),
    );
  } catch (error) {
    // Costs are context, not the point of the page. Missing costs show as unknown.
    logger.warn('Could not load DeoDap costs for the orders page.', {
      reason: error instanceof Error ? error.message : 'unknown',
    });
    return new Map();
  }
}

function variantIdsOf(orders: readonly OrderDto[]): string[] {
  return unique(
    orders.flatMap((order) => order.lineItems.map((line) => line.shopifyVariantId)).filter(nonNull),
  );
}

export interface DeodapOrdersPage {
  orders: DeodapOrderView[];
  meta: {
    /** Shopify orders looked at for this page. */
    scanned: number;
    /** Of those, how many contain DeoDap products. */
    matched: number;
    hasNextPage: boolean;
    endCursor: string | null;
    degraded?: string[];
  };
}

/**
 * One page of Shopify orders, reduced to those containing DeoDap products.
 *
 * Shopify's order search cannot filter by supplier, so a page is scanned and filtered
 * here; `scanned` and `matched` say how many of each, so a short page is explained.
 */
export async function listDeodapOrders(params: {
  first: number;
  after?: string;
  query?: string;
}): Promise<DeodapOrdersPage> {
  const page = await listOrders({
    first: params.first,
    ...(params.after === undefined ? {} : { after: params.after }),
    ...(params.query === undefined ? {} : { query: params.query }),
  });

  const refs = await loadRefsByVariant(variantIdsOf(page.items));
  const matches = page.items
    .map((order) => ({ order, match: extractDeodapLines(order, refs) }))
    .filter((entry) => entry.match.lines.length > 0);

  const forwarding = await loadForwarding(matches.map((entry) => entry.order.shopifyOrderId));
  const costs = await loadLineCosts(matches.flatMap((entry) => entry.match.lines));
  const meta: PageMeta = page.meta;

  return {
    orders: matches.map((entry) =>
      buildDeodapOrderView(
        entry.order,
        entry.match,
        forwarding.get(entry.order.shopifyOrderId) ?? null,
        costs,
      ),
    ),
    meta: {
      scanned: page.items.length,
      matched: matches.length,
      hasNextPage: meta.hasNextPage,
      endCursor: meta.endCursor,
      ...(meta.degraded !== undefined && meta.degraded.length > 0 ? { degraded: meta.degraded } : {}),
    },
  };
}

/** Records what was done with DeoDap for one Shopify order. */
export async function updateDeodapOrder(
  rawOrderId: string,
  body: Record<string, unknown>,
): Promise<DeodapOrderView> {
  const shopifyOrderId = toShopifyGid(rawOrderId, 'Order');
  const update = validateForwardingUpdate(body);
  requireDatabase('Recording a DeoDap order');

  const order = await getOrder(shopifyOrderId);
  const match = extractDeodapLines(order, await loadRefsByVariant(variantIdsOf([order])));
  if (match.lines.length === 0) {
    throw new AppError(
      'VALIDATION_ERROR',
      `Order ${order.name} has no DeoDap products, so there is nothing to record against DeoDap.`,
    );
  }

  const key = { ...connectionKey(), shopifyOrderId };
  const previous = (await SupplierOrderModel.findOne(key).lean()) as unknown as OrderRow | null;
  const stages = stageTimestamps(
    previous === null
      ? null
      : {
          placedAt: previous.placedAt ?? null,
          shippedAt: previous.shippedAt ?? null,
          deliveredAt: previous.deliveredAt ?? null,
        },
    update.status,
    new Date(),
  );

  const set = {
    shopifyOrderName: order.name,
    status: update.status,
    placedVia: 'MANUAL',
    supplierOrderId: update.supplierOrderId,
    trackingCompany: update.trackingCompany,
    trackingNumber: update.trackingNumber,
    trackingUrl: update.trackingUrl,
    note: update.note,
    lines: match.lines.map((line) => ({
      shopifyLineItemId: line.shopifyLineItemId,
      shopifyVariantId: line.shopifyVariantId,
      title: line.title,
      sku: line.sku,
      supplierRef: line.supplierRef,
      quantity: line.quantity,
    })),
    ...stages,
    updatedBy: getContext()?.actor ?? null,
  };

  try {
    await SupplierOrderModel.updateOne(key, { $set: set }, { upsert: true });
  } catch (error) {
    // Two first saves at once: the loser's insert hits the unique index. The row
    // exists now, so write to it.
    if (!isDuplicateKeyError(error)) throw error;
    await SupplierOrderModel.updateOne(key, { $set: set });
  }

  await recordAudit({
    action: 'SUPPLIER_ORDER_UPDATE',
    resourceType: 'ORDER',
    resourceId: shopifyOrderId,
    before:
      previous === null
        ? null
        : {
            status: previous.status,
            supplierOrderId: previous.supplierOrderId ?? null,
            trackingCompany: previous.trackingCompany ?? null,
            trackingNumber: previous.trackingNumber ?? null,
            trackingUrl: previous.trackingUrl ?? null,
          },
    after: {
      status: update.status,
      supplierOrderId: update.supplierOrderId,
      trackingCompany: update.trackingCompany,
      trackingNumber: update.trackingNumber,
      trackingUrl: update.trackingUrl,
    },
    metadata: { provider: PROVIDER, orderName: order.name, lines: match.lines.length },
  });

  const saved = (await SupplierOrderModel.findOne(key).lean()) as unknown as OrderRow | null;
  return buildDeodapOrderView(
    order,
    match,
    saved === null ? null : toForwardingRecord(saved),
    await loadLineCosts(match.lines),
  );
}
