/**
 * 9. A publication write is verified by READ-BACK.
 *
 * Shopify accepting `publishablePublish` is not proof the product is published.
 * Before this existed the service re-fetched the state and returned it without
 * looking at it, so a write that silently did not apply was reported as success.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { verifyPublicationState } from './publication.verify';
import type { ProductPublicationState } from './publications.types';

const HEADLESS = { id: 'gid://shopify/Publication/777', name: 'Kanay Headless' };
const ONLINE_STORE = { id: 'gid://shopify/Publication/111', name: 'Online Store' };

function state(
  entries: { id: string; name: string; isPublished: boolean }[],
): ProductPublicationState[] {
  return entries.map((entry) => ({
    publicationId: entry.id,
    name: entry.name,
    isPublished: entry.isPublished,
    publishDate: entry.isPublished ? '2026-01-01T00:00:00Z' : null,
  }));
}

describe('9. publication write is verified with read-back', () => {
  it('confirms a publish that actually took effect', () => {
    const failures = verifyPublicationState({
      targets: [HEADLESS],
      state: state([{ ...HEADLESS, isPublished: true }]),
      expected: 'published',
    });
    assert.deepEqual(failures, []);
  });

  it('FAILS when Shopify accepted the publish but the channel still reports unpublished', () => {
    const failures = verifyPublicationState({
      targets: [HEADLESS],
      state: state([{ ...HEADLESS, isPublished: false }]),
      expected: 'published',
    });
    assert.equal(failures.length, 1);
    assert.match(failures[0] as string, /Kanay Headless/);
    assert.match(failures[0] as string, /isPublished=false/);
  });

  it('FAILS when the target channel is absent from the read-back entirely', () => {
    // Absence is failure, not an unverifiable maybe: a specific channel was named
    // and Shopify did not confirm the outcome on it.
    const failures = verifyPublicationState({
      targets: [HEADLESS],
      state: state([{ ...ONLINE_STORE, isPublished: true }]),
      expected: 'published',
    });
    assert.equal(failures.length, 1);
    assert.match(failures[0] as string, /absent/);
  });

  it('FAILS when the read-back is empty', () => {
    const failures = verifyPublicationState({
      targets: [HEADLESS],
      state: [],
      expected: 'published',
    });
    assert.equal(failures.length, 1);
  });

  it('does not accept publication of a DIFFERENT channel as success', () => {
    // Publishing to the wrong storefront must never read as success.
    const failures = verifyPublicationState({
      targets: [HEADLESS],
      state: state([
        { ...ONLINE_STORE, isPublished: true },
        { ...HEADLESS, isPublished: false },
      ]),
      expected: 'published',
    });
    assert.equal(failures.length, 1);
    assert.match(failures[0] as string, /Kanay Headless/);
  });

  it('reports every failing target, not just the first', () => {
    const failures = verifyPublicationState({
      targets: [HEADLESS, ONLINE_STORE],
      state: state([
        { ...HEADLESS, isPublished: false },
        { ...ONLINE_STORE, isPublished: false },
      ]),
      expected: 'published',
    });
    assert.equal(failures.length, 2);
  });

  it('verifies unpublish symmetrically', () => {
    assert.deepEqual(
      verifyPublicationState({
        targets: [HEADLESS],
        state: state([{ ...HEADLESS, isPublished: false }]),
        expected: 'unpublished',
      }),
      [],
    );

    const failures = verifyPublicationState({
      targets: [HEADLESS],
      state: state([{ ...HEADLESS, isPublished: true }]),
      expected: 'unpublished',
    });
    assert.equal(failures.length, 1);
    assert.match(failures[0] as string, /isPublished=true/);
  });

  it('an unpublish whose channel vanished from the read-back is NOT silently accepted', () => {
    // Tempting to read absence as "definitely gone". It is not: the app may simply
    // have lost sight of the channel, and the product could still be on sale.
    const failures = verifyPublicationState({
      targets: [HEADLESS],
      state: [],
      expected: 'unpublished',
    });
    assert.equal(failures.length, 1);
    assert.match(failures[0] as string, /absent/);
  });
});
