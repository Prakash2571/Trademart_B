/**
 * Store-safety guard for automated tooling.
 *
 * The property that matters: a dev/test/seed/smoke tool cannot write to a store
 * unless it is a development store OR the operator explicitly acknowledged the
 * risk (ALLOW_LIVE_STORE_WRITES). Shopify's real flag beats the configured mode.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AppError } from '../common/errors';
import {
  assertToolingWritesAllowed,
  resolveStoreSafety,
  type StoreSafetyInput,
} from './storeSafety';

const NO_ACK: Pick<StoreSafetyInput, 'storeMode' | 'allowLiveStoreWrites'> = {
  storeMode: null,
  allowLiveStoreWrites: false,
};

function code(fn: () => unknown): string {
  try {
    fn();
    return 'NO_THROW';
  } catch (error) {
    return error instanceof AppError ? error.code : 'OTHER';
  }
}

describe('resolveStoreSafety', () => {
  it('allows tooling writes on a Shopify-confirmed development store', () => {
    const safety = resolveStoreSafety({ shopIsDevelopmentStore: true, ...NO_ACK });
    assert.equal(safety.classification, 'DEVELOPMENT');
    assert.equal(safety.source, 'shopify');
    assert.equal(safety.toolingWritesAllowed, true);
  });

  it('refuses tooling writes on a Shopify-confirmed live store (no override)', () => {
    const safety = resolveStoreSafety({ shopIsDevelopmentStore: false, ...NO_ACK });
    assert.equal(safety.classification, 'LIVE');
    assert.equal(safety.source, 'shopify');
    assert.equal(safety.toolingWritesAllowed, false);
  });

  it('treats an unknown store as live and refuses by default', () => {
    const safety = resolveStoreSafety({ shopIsDevelopmentStore: null, ...NO_ACK });
    assert.equal(safety.classification, 'UNKNOWN');
    assert.equal(safety.toolingWritesAllowed, false);
  });

  it('the Shopify live flag overrides a mislabelled development config', () => {
    const safety = resolveStoreSafety({
      shopIsDevelopmentStore: false,
      storeMode: 'development',
      allowLiveStoreWrites: false,
    });
    assert.equal(safety.classification, 'LIVE');
    assert.equal(safety.toolingWritesAllowed, false);
  });

  it('permits a live store only with the explicit acknowledgement', () => {
    const safety = resolveStoreSafety({
      shopIsDevelopmentStore: false,
      storeMode: null,
      allowLiveStoreWrites: true,
    });
    assert.equal(safety.classification, 'LIVE');
    assert.equal(safety.toolingWritesAllowed, true);
  });

  it('classifies from config when Shopify flag is unknown', () => {
    assert.equal(
      resolveStoreSafety({ shopIsDevelopmentStore: null, storeMode: 'development', allowLiveStoreWrites: false })
        .classification,
      'DEVELOPMENT',
    );
    assert.equal(
      resolveStoreSafety({ shopIsDevelopmentStore: null, storeMode: 'production', allowLiveStoreWrites: false })
        .source,
      'config',
    );
  });
});

describe('assertToolingWritesAllowed', () => {
  it('throws LIVE_STORE_WRITE_BLOCKED for a live store', () => {
    assert.equal(
      code(() => assertToolingWritesAllowed({ shopIsDevelopmentStore: false, ...NO_ACK })),
      'LIVE_STORE_WRITE_BLOCKED',
    );
  });

  it('throws for an unknown store', () => {
    assert.equal(
      code(() => assertToolingWritesAllowed({ shopIsDevelopmentStore: null, ...NO_ACK })),
      'LIVE_STORE_WRITE_BLOCKED',
    );
  });

  it('permits a development store', () => {
    assert.equal(
      code(() => assertToolingWritesAllowed({ shopIsDevelopmentStore: true, ...NO_ACK })),
      'NO_THROW',
    );
  });
});
