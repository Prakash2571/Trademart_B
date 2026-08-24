/**
 * Candidate input validation.
 *
 * The rule these tests exist for: an amount may never be stored without its currency.
 *
 * A cost of 10 with no currency looks complete in the database, survives every later
 * read, and invites exactly one "fix" - borrow the selling currency. Do that and 10 USD
 * of cost becomes 10 INR, the margin reads about 99%, and nothing on any screen looks
 * unusual. Refusing at the door means that state never exists to be papered over.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  validateCandidateInput,
  type CreateCandidateInput,
} from './candidate.validation';

function input(overrides: Partial<CreateCandidateInput> = {}): CreateCandidateInput {
  return { title: 'Portable neck fan', ...overrides };
}

describe('the basics', () => {
  it('accepts a title alone - every other field is optional', () => {
    assert.deepEqual(validateCandidateInput(input()), []);
  });

  it('requires a title', () => {
    assert.ok(validateCandidateInput(input({ title: '   ' })).length > 0);
  });

  it('reports every problem at once rather than the first', () => {
    const problems = validateCandidateInput(
      input({
        title: '',
        market: { horizonDays: 45, countryCode: 'GBR' },
        commercials: { supplierCost: -1, supplierCurrency: null },
      }),
    );
    assert.ok(problems.length >= 4, `expected several problems, got ${problems.length}`);
  });

  it('restricts the horizon to the windows the trend bands are calibrated for', () => {
    assert.deepEqual(validateCandidateInput(input({ market: { horizonDays: 30 } })), []);
    assert.ok(
      validateCandidateInput(input({ market: { horizonDays: 45 } })).some((problem) =>
        problem.includes('Horizon must be one of'),
      ),
    );
  });

  it('requires a two-letter target country, because region isolation depends on it', () => {
    assert.ok(
      validateCandidateInput(input({ market: { countryCode: 'GBR' } })).some((problem) =>
        problem.includes('two-letter'),
      ),
    );
  });
});

/* ===========================================================================
 * Currency - the point of this file
 * ======================================================================== */

describe('an amount may never be stored without its currency', () => {
  it('rejects a supplier cost with NO currency', () => {
    const problems = validateCandidateInput(
      input({ commercials: { supplierCost: 10, supplierCurrency: null } }),
    );
    assert.ok(problems.some((problem) => problem.includes('supplierCurrency is required')));
  });

  it('says explicitly that it will not infer the currency', () => {
    // The message must explain WHY, or the next person to read it adds the fallback
    // that makes the error go away and the bug appear.
    const problems = validateCandidateInput(
      input({ commercials: { supplierCost: 10, supplierCurrency: null } }),
    );
    assert.ok(
      problems.some((problem) => problem.includes('will not infer it from another field')),
    );
  });

  it('rejects a supplier cost with a MALFORMED currency', () => {
    for (const bad of ['', '  ', '12', 'GB', 'GBPX', 'pounds']) {
      const problems = validateCandidateInput(
        input({ commercials: { supplierCost: 10, supplierCurrency: bad } }),
      );
      assert.ok(
        problems.some((problem) => problem.includes('supplierCurrency is required')),
        `"${bad}" must be rejected as a currency`,
      );
    }
  });

  it('rejects a shipping cost with no currency', () => {
    const problems = validateCandidateInput(
      input({
        commercials: {
          supplierCost: 10,
          supplierCurrency: 'GBP',
          shippingCost: 2,
          shippingCurrency: null,
        },
      }),
    );
    assert.ok(problems.some((problem) => problem.includes('shippingCurrency is required')));
    // And NOT a complaint about the supplier cost, which is correctly labelled.
    assert.ok(!problems.some((problem) => problem.includes('supplierCurrency')));
  });

  it('rejects an expected selling price with no currency', () => {
    const problems = validateCandidateInput(
      input({
        commercials: { expectedSellingPrice: 24.99, expectedSellingCurrency: null },
      }),
    );
    assert.ok(
      problems.some((problem) => problem.includes('expectedSellingCurrency is required')),
    );
  });

  it('does NOT let a present selling currency excuse a missing supplier currency', () => {
    // The exact unsafe path: the selling currency is right there, and borrowing it
    // would silently relabel the supplier cost.
    const problems = validateCandidateInput(
      input({
        commercials: {
          supplierCost: 10,
          supplierCurrency: null,
          expectedSellingPrice: 30,
          expectedSellingCurrency: 'INR',
        },
      }),
    );
    assert.ok(problems.some((problem) => problem.includes('supplierCurrency is required')));
  });

  it('accepts amounts that are all properly labelled', () => {
    assert.deepEqual(
      validateCandidateInput(
        input({
          commercials: {
            supplierCost: 10,
            supplierCurrency: 'GBP',
            shippingCost: 2,
            shippingCurrency: 'GBP',
            expectedSellingPrice: 24.99,
            expectedSellingCurrency: 'GBP',
          },
        }),
      ),
      [],
    );
  });

  it('accepts different currencies at the WRITE - the mismatch is caught at pricing', () => {
    // Storing a USD cost against an INR price is a legitimate intermediate state while
    // an operator is still typing. What must never happen is PRICING it, and
    // recommendPrice refuses that. Blocking the write too would make the form
    // unusable in the order the operator naturally fills it in.
    assert.deepEqual(
      validateCandidateInput(
        input({
          commercials: {
            supplierCost: 10,
            supplierCurrency: 'USD',
            expectedSellingPrice: 900,
            expectedSellingCurrency: 'INR',
          },
        }),
      ),
      [],
    );
  });
});

describe('UNKNOWN is still allowed', () => {
  it('accepts an absent shipping cost with an absent currency', () => {
    // This is UNKNOWN SHIPPING, not free shipping. It must remain enterable, or the
    // guard would force operators to invent a number.
    assert.deepEqual(
      validateCandidateInput(
        input({
          commercials: {
            supplierCost: 10,
            supplierCurrency: 'GBP',
            shippingCost: null,
            shippingCurrency: null,
          },
        }),
      ),
      [],
    );
  });

  it('accepts a candidate with no commercials at all', () => {
    assert.deepEqual(validateCandidateInput(input({ commercials: {} })), []);
  });

  it('does not demand a currency for an amount left null', () => {
    assert.deepEqual(
      validateCandidateInput(
        input({ commercials: { supplierCost: null, supplierCurrency: null } }),
      ),
      [],
    );
  });

  it('rejects a NEGATIVE amount and its missing currency together', () => {
    const problems = validateCandidateInput(
      input({ commercials: { supplierCost: -5, supplierCurrency: null } }),
    );
    assert.ok(problems.some((problem) => problem.includes('at least 0')));
    assert.ok(problems.some((problem) => problem.includes('supplierCurrency is required')));
  });
});

/* ===========================================================================
 * Research provenance
 * ======================================================================== */

describe('manual research provenance', () => {
  it('rejects a malformed country for the figures the operator recorded', () => {
    // Region isolation DISCARDS a figure from the wrong country, so a malformed code
    // would quietly turn a usable observation into a discarded one.
    const problems = validateCandidateInput(
      input({ manualResearch: { geography: { countryCode: 'USA', region: null } } }),
    );
    assert.ok(problems.some((problem) => problem.includes('two-letter ISO code')));
  });

  it('accepts a blank provenance country - unstated is a real answer', () => {
    assert.deepEqual(
      validateCandidateInput(
        input({ manualResearch: { geography: { countryCode: null, region: null } } }),
      ),
      [],
    );
  });

  it('accepts a region alongside the country', () => {
    assert.deepEqual(
      validateCandidateInput(
        input({ manualResearch: { geography: { countryCode: 'IN', region: 'Jharkhand' } } }),
      ),
      [],
    );
  });

  it('rejects peak months outside 1-12', () => {
    assert.ok(
      validateCandidateInput(input({ manualResearch: { peakMonths: [0, 13] } })).length > 0,
    );
  });
});
