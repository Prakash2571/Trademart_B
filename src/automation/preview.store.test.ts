/**
 * Server-side preview -> apply enforcement.
 *
 * These prove the property that matters: an apply cannot happen without a
 * valid, current, single-use preview for the same store and rules - so a direct
 * API caller cannot skip review and change live prices.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { AppError } from '../common/errors';
import type { AutomationRules } from './rules.types';
import {
  _expirePreviewForTest,
  _resetPreviewsForTest,
  computeRulesHash,
  consumePreview,
  findApplicablePreview,
  recordPreview,
} from './preview.store';

const SHOP = 'teststore.myshopify.com';

// Minimal but distinct rule objects; only their hash matters here.
const RULES_A = { price: { enabled: true, targetMarginPercentage: 30 } } as unknown as AutomationRules;
const RULES_B = { price: { enabled: true, targetMarginPercentage: 45 } } as unknown as AutomationRules;

function record(rules: AutomationRules, store = SHOP) {
  return recordPreview({
    rulesHash: computeRulesHash(rules),
    storeDomain: store,
    query: undefined,
    maxProducts: undefined,
    overrides: undefined,
  });
}

function code(fn: () => unknown): string {
  try {
    fn();
    return 'NO_THROW';
  } catch (error) {
    return error instanceof AppError ? error.code : 'NOT_APP_ERROR';
  }
}

beforeEach(() => _resetPreviewsForTest());

describe('computeRulesHash', () => {
  it('is stable regardless of key order', () => {
    const a = { x: 1, y: { b: 2, a: 1 } } as unknown as AutomationRules;
    const b = { y: { a: 1, b: 2 }, x: 1 } as unknown as AutomationRules;
    assert.equal(computeRulesHash(a), computeRulesHash(b));
  });

  it('differs when rules differ', () => {
    assert.notEqual(computeRulesHash(RULES_A), computeRulesHash(RULES_B));
  });
});

describe('apply requires a preview', () => {
  it('rejects a missing previewId with PREVIEW_REQUIRED', () => {
    assert.equal(code(() => findApplicablePreview(undefined, SHOP)), 'PREVIEW_REQUIRED');
    assert.equal(code(() => findApplicablePreview('', SHOP)), 'PREVIEW_REQUIRED');
  });

  it('rejects an unknown previewId with PREVIEW_NOT_FOUND', () => {
    assert.equal(code(() => findApplicablePreview('nope', SHOP)), 'PREVIEW_NOT_FOUND');
  });
});

describe('a valid preview can be applied exactly once', () => {
  it('accepts the matching hash and marks it used', () => {
    const token = record(RULES_A);
    const found = findApplicablePreview(token.previewId, SHOP);
    const consumed = consumePreview(found.previewId, computeRulesHash(RULES_A));
    assert.equal(consumed.previewId, token.previewId);
  });

  it('refuses to apply the same preview twice (single-use)', () => {
    const token = record(RULES_A);
    findApplicablePreview(token.previewId, SHOP);
    consumePreview(token.previewId, computeRulesHash(RULES_A));

    // A replay is now rejected at the find step.
    assert.equal(
      code(() => findApplicablePreview(token.previewId, SHOP)),
      'PREVIEW_ALREADY_APPLIED',
    );
  });
});

describe('a preview is bound to its store and rules', () => {
  it('rejects when the connected store changed', () => {
    const token = record(RULES_A, 'old.myshopify.com');
    assert.equal(
      code(() => findApplicablePreview(token.previewId, 'new.myshopify.com')),
      'PREVIEW_STALE',
    );
  });

  it('rejects when the rules changed after previewing', () => {
    const token = record(RULES_A);
    findApplicablePreview(token.previewId, SHOP);
    // The saved rules now hash to RULES_B - the preview no longer describes what
    // apply would do.
    assert.equal(
      code(() => consumePreview(token.previewId, computeRulesHash(RULES_B))),
      'PREVIEW_STALE',
    );
  });

  it('does not consume a preview that failed the rules check', () => {
    const token = record(RULES_A);
    // Stale attempt does not mark it applied...
    code(() => consumePreview(token.previewId, computeRulesHash(RULES_B)));
    // ...so a correct apply still succeeds.
    const consumed = consumePreview(token.previewId, computeRulesHash(RULES_A));
    assert.equal(consumed.previewId, token.previewId);
  });
});

describe('a preview expires', () => {
  it('rejects an expired preview with PREVIEW_EXPIRED', () => {
    const token = record(RULES_A);
    _expirePreviewForTest(token.previewId);
    assert.equal(code(() => findApplicablePreview(token.previewId, SHOP)), 'PREVIEW_EXPIRED');
  });
});
