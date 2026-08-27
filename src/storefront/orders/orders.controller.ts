import { Router } from 'express';

import { sendSuccess } from '../../common/http';
import { storefrontHandler } from '../http/storefront.http';
import type { StorefrontTrackingService } from './tracking.service';

export function createStorefrontOrdersRouter(tracking: StorefrontTrackingService): Router {
  const router = Router();
  router.get(
    '/storefront/orders/track/:token',
    // Shared with the checkout router: one error path, one contract. The previous
    // local copy of the formatting had already drifted (it dropped `details`).
    storefrontHandler(async (req, res) => {
      sendSuccess(res, await tracking.get(req.params['token'] ?? ''));
    }),
  );
  return router;
}
