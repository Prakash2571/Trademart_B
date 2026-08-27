/**
 * The pricing router is mounted behind requireOperatorForReads, and it serves two
 * POSTs.
 *
 * That combination is normally the exact mistake the wiring tests hunt for: a mutation
 * on the read guard is unauthenticated whenever OPERATOR_PROTECT_READS is false. These
 * two are safe for one reason only - they are pure functions. They take numbers in a
 * body (POST because a pricing request does not fit in a query string) and return
 * numbers. They touch no Shopify API, no database and no audit trail.
 *
 * That is a property, not a promise, so it is asserted. If a future change makes
 * /api/pricing/* write anything, this fails and the router has to move behind
 * requireOperatorForWrites.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const CONTROLLER = readFileSync(
  join(process.cwd(), 'src', 'pricing', 'pricing.controller.ts'),
  'utf8',
);
const SERVICE = readFileSync(
  join(process.cwd(), 'src', 'pricing', 'pricing.service.ts'),
  'utf8',
);

describe('the pricing routes are side-effect free', () => {
  const FORBIDDEN: [pattern: RegExp, why: string][] = [
    [/shopifyGraphql|shopify\.client/, 'calls Shopify'],
    [/Model\b/, 'touches a Mongoose model'],
    [/recordAudit|auditing\(/, 'writes an audit entry'],
    [/getDatabaseStatus/, 'depends on the database'],
    [/idempotent\(/, 'needs idempotency, which means it mutates'],
  ];

  for (const [name, source] of [
    ['pricing.controller.ts', CONTROLLER],
    ['pricing.service.ts', SERVICE],
  ] as const) {
    for (const [pattern, why] of FORBIDDEN) {
      it(`${name} never ${why}`, () => {
        assert.ok(
          !pattern.test(source),
          `${name} ${why}. The pricing router is mounted behind requireOperatorForReads, so a POST that changes anything there would be world-writable whenever OPERATOR_PROTECT_READS is false. Move the router behind requireOperatorForWrites instead.`,
        );
      });
    }
  }

  it('is still mounted on the read guard, which is what makes this test load-bearing', () => {
    const app = readFileSync(join(process.cwd(), 'src', 'app.ts'), 'utf8');
    const line = app
      .split('\n')
      .find((candidate) => candidate.includes('pricingRouter') && candidate.includes('app.use('));

    assert.ok(line !== undefined, 'pricingRouter is not mounted in app.ts');
    assert.ok(
      line.includes('requireOperatorForReads'),
      `pricingRouter moved guards - re-check whether this test is still the right one: ${line.trim()}`,
    );
  });
});
