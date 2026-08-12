/**
 * GET /api/shopify/customers
 *
 * Protected customer data: PII fields are only returned when Shopify actually
 * permits them. When they are denied, the request still succeeds with the
 * non-PII fields and `meta.degraded` lists what was withheld.
 *
 * Trademart does not persist customer PII.
 */

import { Router } from 'express';

import { asyncHandler, sendSuccess } from '../common/http';
import { parseIntParam, parseStringParam } from '../common/validate';
import { listCustomers } from '../shopify/shopify.service';

export const customersRouter = Router();

customersRouter.get(
  '/customers',
  asyncHandler(async (req, res) => {
    const first = parseIntParam(req.query['limit'], 'limit', {
      min: 1,
      max: 100,
      fallback: 25,
    });
    const after = parseStringParam(req.query['cursor'], 'cursor', { maxLength: 500 });
    const query = parseStringParam(req.query['query'], 'query', { maxLength: 300 });

    const result = await listCustomers({ first, after, query });
    const meta = { ...result.meta };
    if (meta.degraded && meta.degraded.length > 0) {
      sendSuccess(res, result.items, {
        ...meta,
        note: 'Some customer fields were withheld by Shopify. This usually means the app lacks read_customers or protected customer data approval.',
      });
      return;
    }
    sendSuccess(res, result.items, meta);
  }),
);
