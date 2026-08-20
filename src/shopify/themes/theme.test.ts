/**
 * Unit tests for theme mapping and the live-theme write guard.
 *
 * The guard is the safety-critical part: it must refuse to modify the live
 * (MAIN) theme, always, so a future write path cannot push straight to what
 * customers see.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AppError } from '../../common/errors';
import {
  assertThemeWritable,
  isLiveTheme,
  isWritableRole,
} from './theme.guard';
import { mapTheme, mapThemeFile } from './theme.mappers';

describe('theme guard', () => {
  it('identifies the MAIN role as live', () => {
    assert.equal(isLiveTheme('MAIN'), true);
    assert.equal(isLiveTheme('UNPUBLISHED'), false);
  });

  it('REFUSES to modify the live theme', () => {
    assert.throws(
      () => assertThemeWritable('MAIN'),
      (e: unknown) => e instanceof AppError && e.code === 'THEME_PROTECTED',
    );
  });

  it('allows editing an unpublished or development theme', () => {
    assert.doesNotThrow(() => assertThemeWritable('UNPUBLISHED'));
    assert.doesNotThrow(() => assertThemeWritable('DEVELOPMENT'));
    assert.equal(isWritableRole('UNPUBLISHED'), true);
  });

  it('refuses demo / locked / archived themes with a clear reason', () => {
    for (const role of ['DEMO', 'LOCKED', 'ARCHIVED'] as const) {
      assert.throws(
        () => assertThemeWritable(role),
        (e: unknown) => e instanceof AppError && e.code === 'THEME_PROTECTED',
      );
    }
  });
});

describe('mapTheme', () => {
  it('derives live from the MAIN role', () => {
    const theme = mapTheme({ id: 'gid://shopify/OnlineStoreTheme/1', name: 'Dawn', role: 'MAIN' });
    assert.equal(theme.live, true);
    assert.equal(theme.role, 'MAIN');
  });

  it('marks a non-MAIN theme as not live', () => {
    assert.equal(mapTheme({ role: 'UNPUBLISHED' }).live, false);
  });

  it('falls back to a safe role and name for junk input', () => {
    const theme = mapTheme({ role: 'WEIRD' });
    assert.equal(theme.role, 'UNPUBLISHED');
    assert.equal(theme.live, false);
    assert.equal(theme.name, '(untitled theme)');
  });

  it('lower-cases nothing but normalises case of the role', () => {
    assert.equal(mapTheme({ role: 'main' }).role, 'MAIN');
  });
});

describe('mapThemeFile', () => {
  it('reads inline text content', () => {
    const file = mapThemeFile({
      filename: 'config/settings_data.json',
      contentType: 'application/json',
      size: 12,
      body: { content: '{"a":1}' },
    });
    assert.equal(file.content, '{"a":1}');
    assert.equal(file.url, null);
  });

  it('decodes base64 text bodies', () => {
    const file = mapThemeFile({
      filename: 'x.liquid',
      body: { contentBase64: Buffer.from('hello', 'utf8').toString('base64') },
    });
    assert.equal(file.content, 'hello');
  });

  it('keeps a url body as a url, not content', () => {
    const file = mapThemeFile({
      filename: 'a.png',
      body: { url: 'https://cdn.shopify.com/a.png' },
    });
    assert.equal(file.url, 'https://cdn.shopify.com/a.png');
    assert.equal(file.content, null);
  });

  it('tolerates a missing body', () => {
    const file = mapThemeFile({ filename: 'x', body: null });
    assert.equal(file.content, null);
    assert.equal(file.url, null);
  });
});
