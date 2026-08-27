/**
 * The failure contract, asserted once.
 *
 * Every JSON failure this service emits carries the flat keys AND a nested `error`
 * object. Both exist on purpose - the flat keys are what existing clients read, the
 * nested object is the taxonomy shape that carries the correlation id - and they
 * must never disagree, because the admin console keys its retry decisions off
 * `code` and an operator has nothing but `requestId` to search the logs with.
 *
 * There were three hand-written copies of this construction and two failure paths
 * that skipped it (the storefront origin rejection and every rate-limit response,
 * which answered with no requestId at all). These tests pin the shared builder, and
 * the wiring tests below pin the fact that the copies are gone.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { buildErrorBody } from './errorBody';
import { AppError } from './errors';

function repoFile(...segments: string[]): string {
  return readFileSync(join(process.cwd(), ...segments), 'utf8');
}

/** Drops /* *​/ blocks and // lines so prose about the contract is not mistaken for it. */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

describe('buildErrorBody', () => {
  it('emits the flat and nested shapes with the same values', () => {
    const body = buildErrorBody({ code: 'RATE_LIMITED', message: 'slow down', requestId: 'req-1' });

    assert.equal(body.success, false);
    assert.equal(body.code, 'RATE_LIMITED');
    assert.equal(body.message, 'slow down');
    assert.equal(body.requestId, 'req-1');
    assert.deepEqual(body.error, { code: 'RATE_LIMITED', message: 'slow down', requestId: 'req-1' });
  });

  it('omits requestId entirely when there is none', () => {
    // Not null, not "": a client testing `if (body.requestId)` must not be handed a
    // falsy value it then tries to show to an operator.
    const body = buildErrorBody({ code: 'X', message: 'y', requestId: null });

    assert.ok(!('requestId' in body));
    assert.ok(!('requestId' in body.error));
  });

  it('carries details on both shapes when present, and omits them when not', () => {
    const withDetails = buildErrorBody({
      code: 'PRICE_CHANGED',
      message: 'moved',
      details: { newPricePaise: 119900 },
    });
    assert.deepEqual(withDetails.details, { newPricePaise: 119900 });
    assert.deepEqual(withDetails.error.details, { newPricePaise: 119900 });

    const without = buildErrorBody({ code: 'X', message: 'y' });
    assert.ok(!('details' in without));
    assert.ok(!('details' in without.error));
  });

  it('is what AppError.toBody produces', () => {
    // AppError is the operator API's error type; if it stopped using the shared
    // builder the two contracts could drift again.
    const error = new AppError('DATABASE_UNAVAILABLE', 'no storage', {
      details: { requires: ['audit'] },
    });

    assert.deepEqual(
      error.toBody('req-9'),
      buildErrorBody({
        code: 'DATABASE_UNAVAILABLE',
        message: 'no storage',
        details: { requires: ['audit'] },
        requestId: 'req-9',
      }),
    );
  });
});

describe('no failure path builds its own body', () => {
  // Read from the real sources: a future edit that hand-rolls a failure body is
  // exactly how the contract drifted the first time.
  const files = [
    'src/common/errors.ts',
    'src/common/rateLimit.ts',
    'src/storefront/http/storefront.http.ts',
    'src/storefront/checkout/checkout.controller.ts',
    'src/storefront/orders/orders.controller.ts',
    'src/common/errorHandler.ts',
  ];

  for (const file of files) {
    it(`${file} does not construct "success: false" by hand`, () => {
      // Comments are stripped first: several of these files DESCRIBE the contract in
      // prose, and the point is to catch a literal body, not a doc comment.
      const source = withoutComments(repoFile(...file.split('/')));
      // The comma is what distinguishes an object literal from the `success: false;`
      // field in a type declaration. errorBody.ts is the one place allowed to write
      // it, and it is not in this list.
      assert.ok(
        !source.includes('success: false,'),
        `${file} contains a hand-written "success: false" body. Use buildErrorBody so the flat and nested shapes cannot disagree, and so requestId is never dropped.`,
      );
    });
  }

  it('every rate limiter goes through createRateLimiter', () => {
    // A limiter configured with express-rate-limit's static `message` option cannot
    // include a requestId - the body is fixed at construction time. A 429 is the
    // response most likely to be reported, so it is the one that most needs a
    // correlation id.
    for (const file of ['src/app.ts', 'src/auth/operator/operator.controller.ts']) {
      const source = repoFile(...file.split('/'));
      assert.ok(
        !/rateLimit\(\{/.test(source),
        `${file} builds a limiter directly; use createRateLimiter so the 429 body carries a requestId`,
      );
    }
  });

  it('the storefront routers share one error path', () => {
    const checkout = repoFile('src', 'storefront', 'checkout', 'checkout.controller.ts');
    const orders = repoFile('src', 'storefront', 'orders', 'orders.controller.ts');

    for (const [name, source] of [
      ['checkout.controller.ts', checkout],
      ['orders.controller.ts', orders],
    ] as const) {
      assert.ok(
        source.includes("from '../http/storefront.http'") ||
          source.includes("from '../../storefront/http/storefront.http'"),
        `${name} must use the shared storefront error handler`,
      );
      assert.ok(
        !source.includes('res.status(error.status)'),
        `${name} still formats a StorefrontError itself`,
      );
    }
  });
});
