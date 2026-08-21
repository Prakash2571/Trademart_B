/**
 * GET /api/dropshipping/orders       - the order book, normalised
 * GET /api/dropshipping/orders/:id   - one order in full
 * GET /api/dropshipping/dashboard    - counts, money, exposure, Needs Attention
 * GET /api/dropshipping/settings     - the thresholds the figures were computed with
 *
 * READ-ONLY, all of it. There is deliberately no write surface here: this module
 * reports on Shopify orders and never changes them. Fulfilling, refunding and
 * cancelling stay in Shopify, where the merchant's existing process and audit trail
 * already live - and where a mistake is recoverable by someone who knows the tools.
 *
 * Mounted at /api, so route paths here start with /dropshipping. (The publications
 * controller once carried its own /shopify prefix on top of a /api/shopify mount and
 * every route 404'd, so the convention is worth stating explicitly.)
 */

import { Router } from 'express';

import { asyncHandler, sendSuccess } from '../common/http';
import { parseIntParam, parseStringParam, toShopifyGid } from '../common/validate';
import { buildDashboard } from './dropshipping.analytics';
import {
  getDropshipOrder,
  listDropshipOrders,
  resolveSettings,
} from './dropshipping.service';

export const dropshippingRouter = Router();

/**
 * The order book.
 *
 * `query` is Shopify's own order search syntax, passed through unchanged rather than
 * wrapped in a Trademart-specific filter language - the operator can already write
 * `financial_status:paid fulfillment_status:unfulfilled`, and re-inventing that would
 * be a worse version of a thing that works.
 */
dropshippingRouter.get(
  '/dropshipping/orders',
  asyncHandler(async (req, res) => {
    const first = parseIntParam(req.query['limit'], 'limit', {
      min: 1,
      max: 100,
      fallback: 25,
    });
    const after = parseStringParam(req.query['cursor'], 'cursor', { maxLength: 500 });
    const query = parseStringParam(req.query['query'], 'query', { maxLength: 300 });

    const page = await listDropshipOrders({
      first,
      ...(after === undefined ? {} : { after }),
      ...(query === undefined ? {} : { query }),
    });

    sendSuccess(res, page.items, {
      ...page.meta,
      // How many need a human, so a list header can say so without a second request.
      ordersNeedingAttention: page.items.filter((order) => order.warnings.length > 0).length,
    });
  }),
);

/**
 * The dashboard.
 *
 * Computed over a WINDOW of recent orders rather than the whole order history: this
 * is an operations view answering "what needs doing now", and a full-history scan
 * would cost several Shopify pages per page load for figures nobody reads. The
 * window size is reported in the response so the numbers are never mistaken for
 * all-time totals.
 */
dropshippingRouter.get(
  '/dropshipping/dashboard',
  asyncHandler(async (req, res) => {
    const window = parseIntParam(req.query['limit'], 'limit', {
      min: 1,
      max: 250,
      fallback: 100,
    });

    const settings = resolveSettings();
    const page = await listDropshipOrders({ first: window });
    const dashboard = buildDashboard(page.items, settings.cost);

    sendSuccess(res, dashboard, {
      window,
      // Explicit, because "revenue" over the last 100 orders is a very different
      // claim from revenue over all time and the difference must not be guessable.
      scope: `The most recent ${window} order(s). Not all-time totals.`,
      degraded: page.meta.degraded,
      truncated: page.meta.hasNextPage === true,
    });
  }),
);

dropshippingRouter.get(
  '/dropshipping/orders/:id',
  asyncHandler(async (req, res) => {
    const gid = toShopifyGid(req.params.id ?? '', 'Order');
    const order = await getDropshipOrder(gid);
    sendSuccess(res, order);
  }),
);

/**
 * The thresholds and inclusions every figure was computed with.
 *
 * Exposed because a margin is meaningless without them: "41%" means one thing with
 * an advertising allowance deducted and another without. The UI shows these next to
 * the numbers so a figure can be interpreted rather than merely read.
 */
dropshippingRouter.get(
  '/dropshipping/settings',
  asyncHandler(async (_req, res) => {
    const settings = resolveSettings();
    sendSuccess(res, settings, {
      note: 'These thresholds decide which orders are flagged and what is folded into commercial cost. They never change a price by themselves.',
    });
  }),
);
