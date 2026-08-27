/**
 * MOQ enforcement is SERVER-SIDE, and the quantity cap is wholesale-sized.
 *
 * These two facts are the difference between a wholesale marketplace and a retail
 * storefront wearing wholesale copy, so they are asserted against the real source rather
 * than trusted to review.
 *
 * The cap was 10 per variant. That silently made every bulk order impossible and, worse,
 * would have rejected any product carrying an MOQ above 10 outright - the storefront would
 * advertise "MOQ 12" and the checkout would answer "maximum 10".
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { MAX_MINIMUM_ORDER_QUANTITY } from '../catalog/moq';
import { MAX_LINE_QUANTITY } from './checkout.validation';

function source(...segments: string[]): string {
  return readFileSync(join(process.cwd(), 'src', 'storefront', ...segments), 'utf8');
}

describe('the quantity cap fits a wholesale order', () => {
  it('is far above a retail cap', () => {
    assert.ok(
      MAX_LINE_QUANTITY >= 1000,
      `MAX_LINE_QUANTITY is ${MAX_LINE_QUANTITY}; a wholesale checkout cannot refuse an order of a few hundred units`,
    );
  });

  it('is bounded, so arithmetic stays safe and a typo is not an order', () => {
    assert.ok(MAX_LINE_QUANTITY <= 100_000);
    // The largest conceivable line must stay a safe integer in paise: a ₹1,00,000 item at
    // the cap is 10^12 paise, comfortably inside 2^53.
    assert.ok(Number.isSafeInteger(MAX_LINE_QUANTITY * 10_000_000));
  });

  it('can never be exceeded by a parsed MOQ', () => {
    // Otherwise the catalog could advertise a minimum the checkout is guaranteed to reject.
    assert.ok(
      MAX_MINIMUM_ORDER_QUANTITY <= MAX_LINE_QUANTITY,
      'an MOQ above the line cap would be unsatisfiable',
    );
  });

  it('no longer hard-codes 10 in the validator', () => {
    const validation = source('checkout', 'checkout.validation.ts');
    // The two former literals: the per-line bound and the combined-lines bound.
    assert.ok(
      !/quantity as number\) > 10\b/.test(validation),
      'the per-line quantity check still caps at 10',
    );
    assert.ok(!/total > 10\b/.test(validation), 'the combined-quantity check still caps at 10');
  });
});

describe('MOQ is enforced against re-read Shopify data', () => {
  const service = source('checkout', 'checkout.service.ts');
  const adapter = source('checkout', 'catalog-checkout.adapter.ts');

  it('the service checks minimums before pricing the cart', () => {
    // The CALL SITE, not the helper's definition - the definition sits above the class, so
    // searching for the bare name would compare the wrong two positions and pass either way.
    const check = service.indexOf('assertMinimumOrderQuantities(approved)');
    const revalidate = service.indexOf('revalidateLines(');
    const subtotal = service.indexOf('preliminarySubtotal');

    assert.ok(check !== -1, 'checkout.service must call assertMinimumOrderQuantities(approved)');
    assert.ok(revalidate !== -1 && revalidate < check, 'the check must run AFTER revalidation');
    assert.ok(
      check < subtotal,
      'the check must run BEFORE the cart is priced, so a refused order never reaches Razorpay',
    );
  });

  it('the minimum comes from the projected product, not from the request', () => {
    // The whole point: a stale tab or a crafted request must not be able to buy under a
    // minimum the merchant has raised since the page was rendered.
    assert.match(
      adapter,
      /minimumOrderQuantity:\s*projected\.summary\.minimumOrderQuantity/,
      'the adapter must take the MOQ from the freshly projected product',
    );
    assert.ok(
      !/minimumOrderQuantity:\s*line\./.test(adapter),
      'the adapter must never trust a browser-supplied minimum',
    );
  });

  it('refuses with a code the storefront can act on', () => {
    assert.ok(service.includes("'MOQ_NOT_MET'"), 'a dedicated error code is needed');
    // The storefront corrects the quantity itself, so it needs the numbers - not prose.
    for (const field of ['minimumOrderQuantity', 'requestedQuantity', 'publicVariantId']) {
      assert.ok(service.includes(field), `the refusal must carry ${field} in details`);
    }
  });

  it('answers 409, not 400', () => {
    // The request is well-formed; the quantity conflicts with a merchandising rule. 400
    // would tell the storefront it sent malformed JSON.
    const block = service.slice(service.indexOf('function assertMinimumOrderQuantities'));
    assert.match(block.slice(0, 900), /409/);
  });
});
