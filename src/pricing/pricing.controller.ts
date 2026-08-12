/**
 * POST /api/pricing/calculate       - profit/margin from a selling price
 * POST /api/pricing/suggest-price   - selling price from a desired margin
 *
 * Works with zero Shopify configuration and no database - the pricing engine is
 * intentionally standalone.
 */

import { Router } from 'express';

import { AppError } from '../common/errors';
import { asyncHandler, sendSuccess } from '../common/http';
import { parseNumberField } from '../common/validate';
import { calculatePricing, calculateSuggestedPrice } from './pricing.service';

export const pricingRouter = Router();

const MAX_MONEY = 1_000_000_000;

function requireObjectBody(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new AppError('VALIDATION_ERROR', 'Request body must be a JSON object.');
  }
  return body as Record<string, unknown>;
}

pricingRouter.post(
  '/pricing/calculate',
  asyncHandler(async (req, res) => {
    const body = requireObjectBody(req.body);

    const result = calculatePricing({
      sellingPrice:
        parseNumberField(body['sellingPrice'], 'sellingPrice', {
          min: 0,
          max: MAX_MONEY,
          required: true,
        }) ?? 0,
      supplierProductCost: parseNumberField(
        body['supplierProductCost'],
        'supplierProductCost',
        { min: 0, max: MAX_MONEY },
      ),
      supplierShippingCost: parseNumberField(
        body['supplierShippingCost'],
        'supplierShippingCost',
        { min: 0, max: MAX_MONEY },
      ),
      paymentFee: parseNumberField(body['paymentFee'], 'paymentFee', {
        min: 0,
        max: MAX_MONEY,
      }),
      shopifyFee: parseNumberField(body['shopifyFee'], 'shopifyFee', {
        min: 0,
        max: MAX_MONEY,
      }),
      advertisingCost: parseNumberField(body['advertisingCost'], 'advertisingCost', {
        min: 0,
        max: MAX_MONEY,
      }),
      taxes: parseNumberField(body['taxes'], 'taxes', { min: 0, max: MAX_MONEY }),
      otherCosts: parseNumberField(body['otherCosts'], 'otherCosts', {
        min: 0,
        max: MAX_MONEY,
      }),
    });

    sendSuccess(res, result);
  }),
);

pricingRouter.post(
  '/pricing/suggest-price',
  asyncHandler(async (req, res) => {
    const body = requireObjectBody(req.body);

    const result = calculateSuggestedPrice({
      desiredMarginPercentage:
        parseNumberField(body['desiredMarginPercentage'], 'desiredMarginPercentage', {
          min: 0,
          max: 99.99,
          required: true,
        }) ?? 0,
      supplierProductCost: parseNumberField(
        body['supplierProductCost'],
        'supplierProductCost',
        { min: 0, max: MAX_MONEY },
      ),
      supplierShippingCost: parseNumberField(
        body['supplierShippingCost'],
        'supplierShippingCost',
        { min: 0, max: MAX_MONEY },
      ),
      advertisingCost: parseNumberField(body['advertisingCost'], 'advertisingCost', {
        min: 0,
        max: MAX_MONEY,
      }),
      taxes: parseNumberField(body['taxes'], 'taxes', { min: 0, max: MAX_MONEY }),
      otherCosts: parseNumberField(body['otherCosts'], 'otherCosts', {
        min: 0,
        max: MAX_MONEY,
      }),
      paymentFeePercentage: parseNumberField(
        body['paymentFeePercentage'],
        'paymentFeePercentage',
        { min: 0, max: 100 },
      ),
      shopifyFeePercentage: parseNumberField(
        body['shopifyFeePercentage'],
        'shopifyFeePercentage',
        { min: 0, max: 100 },
      ),
    });

    sendSuccess(res, result);
  }),
);
