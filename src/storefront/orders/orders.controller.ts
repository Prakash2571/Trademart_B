import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';

import { sendSuccess } from '../../common/http';
import { getRequestId } from '../../common/requestContext';
import { StorefrontError } from '../checkout/storefront.error';
import type { StorefrontTrackingService } from './tracking.service';

function safeHandler(
  fn: (req: Request, res: Response) => Promise<void>,
): RequestHandler {
  return (req, res, next: NextFunction) => {
    fn(req, res).catch((error: unknown) => {
      if (!(error instanceof StorefrontError)) {
        next(error);
        return;
      }
      const requestId = getRequestId();
      res.status(error.status).json({
        success: false,
        code: error.code,
        message: error.message,
        ...(requestId ? { requestId } : {}),
        error: { code: error.code, message: error.message, ...(requestId ? { requestId } : {}) },
      });
    });
  };
}

export function createStorefrontOrdersRouter(tracking: StorefrontTrackingService): Router {
  const router = Router();
  router.get(
    '/storefront/orders/track/:token',
    safeHandler(async (req, res) => {
      sendSuccess(res, await tracking.get(req.params['token'] ?? ''));
    }),
  );
  return router;
}
