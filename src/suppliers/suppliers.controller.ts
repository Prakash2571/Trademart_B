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
        // The provider's DECLARED capabilities. Previously this was inferred
        // from method presence, which reported getSupplierCost:true for a
        // method whose entire body is `return null` - so the UI advertised a
        // supplier cost feed that does not exist.
        capabilities: provider.capabilities,
        /** Why each false capability is false. Keyed by capability name. */
        limitations: provider.limitations ?? {},
      })),
      { count: providers.length },
    );
  }),
);
