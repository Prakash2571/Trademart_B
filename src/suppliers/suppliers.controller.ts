/**
 * GET /api/suppliers/providers
 *
 * Exposes which supplier providers are registered and which capabilities they
 * actually support, so the UI can explain *why* a cost is unavailable instead of
 * showing a blank cell.
 */

import { Router } from 'express';

import { asyncHandler, sendSuccess } from '../common/http';
import { providers } from './supplier.registry';

export const suppliersRouter = Router();

suppliersRouter.get(
  '/suppliers/providers',
  asyncHandler(async (_req, res) => {
    sendSuccess(
      res,
      providers.map((provider) => ({
        providerName: provider.providerName,
        capabilities: {
          identifyProduct: typeof provider.identifyProduct === 'function',
          getSupplierCost: typeof provider.getSupplierCost === 'function',
          getShippingCost: typeof provider.getShippingCost === 'function',
        },
        // Honest capability reporting: the methods exist but return null.
        notes:
          provider.providerName === 'TRADELLE'
            ? 'Tradelle documents a Shopify integration, not a public API. Cost and shipping lookups return null until Tradelle publishes documented endpoints.'
            : null,
      })),
    );
  }),
);
