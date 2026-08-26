import { createHash } from 'node:crypto';

import { stableStringify } from '../../common/stableStringify';
import { StorefrontError } from './storefront.error';
import type {
  AuthoritativeCheckoutLine,
  CheckoutSnapshot,
  CreateCheckoutRequest,
  ShippingQuote,
} from './checkout.types';

function paise(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new StorefrontError('INTERNAL_ERROR', `${field} was not a safe paise amount.`, 500);
  }
  return value;
}

function checkedAdd(a: number, b: number, field: string): number {
  const value = a + b;
  if (!Number.isSafeInteger(value)) {
    throw new StorefrontError('INTERNAL_ERROR', `${field} exceeded the safe payment range.`, 500);
  }
  return value;
}

export function checkoutRequestHash(input: CreateCheckoutRequest): string {
  return createHash('sha256').update(stableStringify(input)).digest('hex');
}

export function buildCheckoutSnapshot(
  request: CreateCheckoutRequest,
  approved: AuthoritativeCheckoutLine[],
  quote: ShippingQuote,
): CheckoutSnapshot {
  if (approved.length !== request.lines.length) {
    throw new StorefrontError(
      'PRODUCT_UNAVAILABLE',
      'One or more items are no longer available.',
      409,
    );
  }

  const requestByVariant = new Map(request.lines.map((line) => [line.variantId, line]));
  let subtotalPaise = 0;
  const lines = approved.map((line) => {
    const requested = requestByVariant.get(line.publicVariantId);
    if (!requested || requested.productId !== line.publicProductId || requested.quantity !== line.quantity) {
      throw new StorefrontError('PRODUCT_UNAVAILABLE', 'An item could not be revalidated.', 409);
    }
    if (line.sellability !== 'SELLABLE') {
      throw new StorefrontError(
        line.sellability === 'OUT_OF_STOCK' ? 'VARIANT_UNAVAILABLE' : 'PRODUCT_UNAVAILABLE',
        line.sellability === 'OUT_OF_STOCK'
          ? 'That option just sold out. Please choose another.'
          : 'This item is no longer available.',
        409,
        { productId: line.publicProductId, variantId: line.publicVariantId },
      );
    }
    if (line.currencyCode !== 'INR') {
      throw new StorefrontError('PRODUCT_UNAVAILABLE', 'This item does not have an approved INR price.', 409);
    }
    paise(line.unitPricePaise, 'unitPricePaise');
    if (line.unitPricePaise <= 0) {
      throw new StorefrontError('PRODUCT_UNAVAILABLE', 'This item does not have a valid retail price.', 409);
    }
    if (line.availableQuantity !== null && line.quantity > line.availableQuantity) {
      throw new StorefrontError(
        'VARIANT_UNAVAILABLE',
        'The requested quantity is no longer available.',
        409,
        { variantId: line.publicVariantId, availableQuantity: line.availableQuantity },
      );
    }
    if (
      requested.expectedUnitPricePaise !== undefined &&
      requested.expectedUnitPricePaise !== line.unitPricePaise
    ) {
      throw new StorefrontError(
        'PRICE_CHANGED',
        'The price changed since you added this item. Your cart has been updated.',
        409,
        {
          productId: line.publicProductId,
          variantId: line.publicVariantId,
          unitPricePaise: line.unitPricePaise,
          currency: 'INR',
        },
      );
    }

    const lineTotalPaise = line.unitPricePaise * line.quantity;
    paise(lineTotalPaise, 'lineTotalPaise');
    subtotalPaise = checkedAdd(subtotalPaise, lineTotalPaise, 'subtotalPaise');
    return { ...line, lineTotalPaise };
  });

  const shippingPaise = paise(quote.shippingPaise, 'shippingPaise');
  const discountPaise = paise(quote.discountPaise, 'discountPaise');
  const taxPaise = paise(quote.taxPaise, 'taxPaise');
  if (discountPaise > checkedAdd(subtotalPaise, shippingPaise, 'grossPaise')) {
    throw new StorefrontError('INTERNAL_ERROR', 'Discount exceeds the approved checkout amount.', 500);
  }
  const totalPaise = checkedAdd(
    checkedAdd(subtotalPaise, shippingPaise, 'grossPaise') - discountPaise,
    taxPaise,
    'totalPaise',
  );
  if (totalPaise < 10) {
    throw new StorefrontError('VALIDATION_ERROR', 'Checkout total is below the payment minimum.', 400);
  }

  return {
    lines,
    subtotalPaise,
    shippingPaise,
    discountPaise,
    taxPaise,
    totalPaise,
    currency: 'INR',
    customer: request.customer,
    shippingAddress: request.shippingAddress,
  };
}
