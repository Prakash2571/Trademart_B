/**
 * DeoDap settings and credential input.
 *
 * The credential rules that matter: nothing is accepted half-formed, and no error
 * message ever repeats the secret it rejected.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AppError } from '../../common/errors';
import {
  DEFAULT_DEODAP_SETTINGS,
  defaultDeodapSettings,
  maskDeodapIdentifier,
  readStoredSettings,
  validateDeodapCredentials,
  validateDeodapSettings,
} from './deodap.settings';

function isValidationError(error: unknown): boolean {
  return error instanceof AppError && error.code === 'VALIDATION_ERROR';
}

describe('validateDeodapSettings', () => {
  it('updates only the fields sent', () => {
    const next = validateDeodapSettings(
      { markupPercent: 80, skuPrefixes: [' DD- ', 'dd-', 'DEO'], currencyCode: 'inr' },
      defaultDeodapSettings(),
    );
    assert.equal(next.markupPercent, 80);
    assert.deepEqual(next.skuPrefixes, ['DD-', 'DEO']);
    assert.equal(next.currencyCode, 'INR');
    assert.equal(next.vendorName, 'DeoDap');
    assert.equal(next.priceRounding, DEFAULT_DEODAP_SETTINGS.priceRounding);
  });

  it('refuses a present-but-invalid field instead of ignoring it', () => {
    const current = defaultDeodapSettings();
    for (const body of [
      { markupPercent: -5 },
      { markupPercent: '50' },
      { priceRounding: 'up' },
      { pricingMode: 'CHEAP' },
      { currencyCode: 'rupees' },
      { vendorName: '   ' },
      { skuPrefixes: 'DD-' },
      { skuPrefixes: ['has space'] },
      { skuPrefixes: ['-'] },
      { includeShippingInPrice: 'yes' },
      { skuPrefixes: Array.from({ length: 11 }, (_value, index) => `P${index}`) },
    ]) {
      assert.throws(() => validateDeodapSettings(body, current), isValidationError, JSON.stringify(body));
    }
  });

  it('does not share the defaults between callers', () => {
    const first = defaultDeodapSettings();
    first.skuPrefixes.push('X');
    assert.deepEqual(defaultDeodapSettings().skuPrefixes, []);
  });
});

describe('readStoredSettings', () => {
  it('falls back to defaults for missing or invalid stored fields only', () => {
    const settings = readStoredSettings({ markupPercent: 70, priceRounding: 'bogus', skuPrefixes: ['DD-'] });
    assert.equal(settings.markupPercent, 70);
    assert.equal(settings.priceRounding, 'integer');
    assert.deepEqual(settings.skuPrefixes, ['DD-']);
  });

  it('returns defaults for nothing at all', () => {
    assert.deepEqual(readStoredSettings(null), defaultDeodapSettings());
    assert.deepEqual(readStoredSettings('garbage'), defaultDeodapSettings());
  });
});

describe('validateDeodapCredentials', () => {
  it('accepts an API key, trimmed', () => {
    const input = validateDeodapCredentials({ kind: 'API_KEY', apiKey: '  abcd1234efgh5678  ', accountLabel: ' Reseller 42 ' });
    assert.deepEqual(input, {
      credentials: { kind: 'API_KEY', apiKey: 'abcd1234efgh5678' },
      accountLabel: 'Reseller 42',
    });
  });

  it('accepts a login and keeps the password exactly as typed', () => {
    const input = validateDeodapCredentials({ kind: 'ACCOUNT_LOGIN', username: ' me@example.com ', password: ' pass word ' });
    assert.deepEqual(input.credentials, { kind: 'ACCOUNT_LOGIN', username: 'me@example.com', password: ' pass word ' });
    assert.equal(input.accountLabel, null);
  });

  it('refuses incomplete or malformed credentials', () => {
    for (const body of [
      {},
      { kind: 'PASSWORD' },
      { kind: 'API_KEY' },
      { kind: 'API_KEY', apiKey: 'short' },
      { kind: 'API_KEY', apiKey: 'has a space in it' },
      { kind: 'ACCOUNT_LOGIN', username: 'me@example.com' },
      { kind: 'ACCOUNT_LOGIN', username: 'me@example.com', password: '123' },
    ]) {
      assert.throws(() => validateDeodapCredentials(body), isValidationError, JSON.stringify(body));
    }
  });

  it('never repeats the rejected secret in its message', () => {
    const secret = 'secret value with spaces';
    try {
      validateDeodapCredentials({ kind: 'API_KEY', apiKey: secret });
      assert.fail('expected a validation error');
    } catch (error) {
      assert.ok(error instanceof AppError && !error.message.includes(secret));
    }
  });
});

describe('maskDeodapIdentifier', () => {
  it('shows only the last four characters of an API key', () => {
    assert.equal(maskDeodapIdentifier({ kind: 'API_KEY', apiKey: 'abcdefgh1234WXYZ' }), '\u2022\u2022\u2022\u2022WXYZ');
    assert.equal(maskDeodapIdentifier({ kind: 'API_KEY', apiKey: 'shortkey1' }), '\u2022\u2022\u2022\u2022');
  });

  it('masks a login while keeping it recognisable', () => {
    assert.equal(
      maskDeodapIdentifier({ kind: 'ACCOUNT_LOGIN', username: 'reseller@example.com', password: 'x' }),
      're\u2022\u2022\u2022\u2022@example.com',
    );
    assert.equal(
      maskDeodapIdentifier({ kind: 'ACCOUNT_LOGIN', username: '9876543210', password: 'x' }),
      '98\u2022\u2022\u2022\u202210',
    );
  });
});
