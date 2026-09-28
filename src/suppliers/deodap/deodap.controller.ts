/**
 * DeoDap routes, mounted at /api/suppliers/deodap behind requireOperator.
 *
 *   GET    /status             connection, settings, API availability, counts
 *   PUT    /settings           SKU prefixes, currency, vendor, import pricing defaults
 *   PUT    /credentials        store an API key or DeoDap login, encrypted
 *   DELETE /credentials        forget them
 *   POST   /import/preview     read a DeoDap CSV and price it. Writes nothing.
 *   POST   /import             create up to 10 previewed products as Shopify DRAFTS
 *   GET    /imports            the import ledger
 *   POST   /sync/preview       match a newer DeoDap price list. Writes nothing.
 *   POST   /sync               record the chosen cost changes
 *   GET    /orders             Shopify orders containing DeoDap products
 *   PUT    /orders/:id         record the DeoDap order number, status and tracking
 *
 * EVERY route requires an operator, reads included (see app.ts): this surface handles
 * supplier credentials, supplier costs and order data.
 *
 * The two preview routes are POSTs only because a CSV file does not fit in a query
 * string. They read and compute; they write nothing to Shopify or MongoDB.
 */

import { Router, type Request } from 'express';

import { asyncHandler, sendSuccess } from '../../common/http';
import { idempotent } from '../../common/idempotency';
import { parseIntParam, parseStringParam } from '../../common/validate';
import {
  applyDeodapSync,
  deleteDeodapCredentials,
  getDeodapStatus,
  importDeodapProducts,
  listDeodapImports,
  listDeodapOrders,
  previewDeodapImport,
  previewDeodapSync,
  saveDeodapCredentials,
  saveDeodapSettings,
  updateDeodapOrder,
} from './deodap.service';

export const deodapRouter = Router();

function bodyOf(req: Request): Record<string, unknown> {
  const body: unknown = req.body;
  return body !== null && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

deodapRouter.get(
  '/status',
  asyncHandler(async (_req, res) => {
    sendSuccess(res, await getDeodapStatus());
  }),
);

deodapRouter.put(
  '/settings',
  asyncHandler(async (req, res) => {
    sendSuccess(res, await saveDeodapSettings(bodyOf(req)));
  }),
);

deodapRouter.put(
  '/credentials',
  asyncHandler(async (req, res) => {
    // The response is the masked status only. Nothing submitted is echoed back.
    sendSuccess(res, await saveDeodapCredentials(bodyOf(req)));
  }),
);

deodapRouter.delete(
  '/credentials',
  asyncHandler(async (_req, res) => {
    sendSuccess(res, await deleteDeodapCredentials());
  }),
);

deodapRouter.post(
  '/import/preview',
  asyncHandler(async (req, res) => {
    const preview = await previewDeodapImport(bodyOf(req));
    sendSuccess(res, preview, { count: preview.products.length });
  }),
);

deodapRouter.post(
  '/import',
  // Creates Shopify products: a lost response followed by a retry must replay the
  // result, not create the batch again. The ledger claim is the second line of defence.
  idempotent('POST /api/suppliers/deodap/import'),
  asyncHandler(async (req, res) => {
    const batch = await importDeodapProducts(bodyOf(req));
    // 207 when anything did not end created or skipped, like POST /api/shopify/products.
    res.status(batch.partial ? 207 : 200);
    sendSuccess(res, batch, { partialSuccess: batch.partial });
  }),
);

deodapRouter.get(
  '/imports',
  asyncHandler(async (req, res) => {
    const limit = parseIntParam(req.query['limit'], 'limit', { min: 1, max: 500, fallback: 100 });
    const imports = await listDeodapImports(limit);
    sendSuccess(res, imports, { count: imports.length });
  }),
);

deodapRouter.post(
  '/sync/preview',
  asyncHandler(async (req, res) => {
    const preview = await previewDeodapSync(bodyOf(req));
    sendSuccess(res, preview, { count: preview.changes.length });
  }),
);

deodapRouter.post(
  '/sync',
  idempotent('POST /api/suppliers/deodap/sync'),
  asyncHandler(async (req, res) => {
    const result = await applyDeodapSync(bodyOf(req));
    const partial = result.summary.failed > 0 || result.summary.skipped > 0;
    res.status(partial ? 207 : 200);
    sendSuccess(res, result, { partialSuccess: partial });
  }),
);

deodapRouter.get(
  '/orders',
  asyncHandler(async (req, res) => {
    const first = parseIntParam(req.query['limit'], 'limit', { min: 1, max: 100, fallback: 50 });
    const after = parseStringParam(req.query['cursor'], 'cursor', { maxLength: 500 });
    const query = parseStringParam(req.query['query'], 'query', { maxLength: 300 });
    const page = await listDeodapOrders({
      first,
      ...(after === undefined ? {} : { after }),
      ...(query === undefined ? {} : { query }),
    });
    sendSuccess(res, page.orders, { ...page.meta, count: page.orders.length });
  }),
);

deodapRouter.put(
  '/orders/:id',
  asyncHandler(async (req, res) => {
    sendSuccess(res, await updateDeodapOrder(req.params.id ?? '', bodyOf(req)));
  }),
);
