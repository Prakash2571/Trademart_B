/**
 * Supplier descriptions reach a storefront, so nothing executable may survive.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MAX_DESCRIPTION_CHARS, sanitiseDescription } from './deodap.description';

describe('sanitiseDescription', () => {
  it('returns null for an empty description', () => {
    assert.equal(sanitiseDescription('   ').html, null);
    assert.equal(sanitiseDescription('<p> </p>').html, null);
  });

  it('turns plain text into escaped paragraphs', () => {
    const result = sanitiseDescription('Steel bottle <1L> & lid\nKeeps cold\n\nDishwasher safe');
    assert.equal(
      result.html,
      '<p>Steel bottle &lt;1L&gt; &amp; lid<br>Keeps cold</p><p>Dishwasher safe</p>',
    );
    assert.deepEqual(result.removed, []);
  });

  it('keeps formatting tags but strips their attributes', () => {
    const result = sanitiseDescription('<p class="x" style="color:red"><strong>Steel</strong> bottle</p><ul><li>1L</li></ul>');
    assert.equal(result.html, '<p><strong>Steel</strong> bottle</p><ul><li>1L</li></ul>');
  });

  it('removes scripts and styles together with their content', () => {
    const result = sanitiseDescription('<p>Hi</p><script>alert(1)</script><style>p{}</style><iframe src="x"></iframe>');
    assert.equal(result.html, '<p>Hi</p>');
    assert.ok(result.removed.some((entry) => entry.includes('scripts')));
  });

  it('never lets an event handler or javascript: address through', () => {
    const result = sanitiseDescription('<p onclick="alert(1)">A</p><img src=x onerror=alert(1)><a href="javascript:alert(1)">B</a>');
    assert.ok(!/onclick|onerror|javascript:/i.test(result.html ?? ''));
    assert.equal(result.html, '<p>A</p>B');
  });

  it('keeps https images with their address only', () => {
    const result = sanitiseDescription('<p>Look</p><img src="https://cdn.example.com/a.jpg" onerror="x()" width="10">');
    assert.equal(result.html, '<p>Look</p><img src="https://cdn.example.com/a.jpg" alt="">');
  });

  it('drops links but keeps their text, so a supplier site is not advertised', () => {
    const result = sanitiseDescription('<p>Buy at <a href="https://supplier.example">our site</a></p>');
    assert.equal(result.html, '<p>Buy at our site</p>');
    assert.ok(result.removed.includes('links'));
  });

  it('escapes angle brackets that are not tags, including split-up script tags', () => {
    const result = sanitiseDescription('<p>2 < 3</p><scr<script>x</script>ipt>alert(1)');
    assert.ok(!/<script/i.test(result.html ?? ''));
    assert.ok((result.html ?? '').includes('2 &lt; 3'));
  });

  it('caps the length without leaving half a tag behind', () => {
    const long = `<p>${'a'.repeat(MAX_DESCRIPTION_CHARS)}</p><p>b</p>`;
    const result = sanitiseDescription(long);
    assert.equal(result.truncated, true);
    assert.ok((result.html ?? '').length <= MAX_DESCRIPTION_CHARS);
    assert.ok(!/<[^>]*$/.test(result.html ?? ''));
  });
});
