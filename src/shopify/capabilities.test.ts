import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  REQUIRED_SCOPES,
  SHOPIFY_FEATURES,
  impliedScopes,
  resolveCapabilities,
} from './capabilities';

/**
 * The real granted scope list from the reference deployment.
 *
 * Note what it does NOT contain: read_products and read_inventory. Product and
 * inventory reads work against this store regardless, which is the evidence
 * that write access implies read access.
 */
const REAL_GRANTED = [
  'read_all_orders',
  'read_analytics',
  'read_customers',
  'write_inventory',
  'read_locations',
  'read_orders',
  'write_products',
  'write_publications',
  'read_themes',
  'write_theme_code',
  'read_files',
  'read_content',
];

describe('impliedScopes', () => {
  it('treats write access as granting read access', () => {
    const implied = impliedScopes(['write_products']);

    assert.ok(implied.has('write_products'));
    assert.ok(implied.has('read_products'));
  });

  it('leaves read scopes alone', () => {
    const implied = impliedScopes(['read_orders']);

    assert.ok(implied.has('read_orders'));
    assert.ok(!implied.has('write_orders'));
  });

  it('does not invent a read scope for a non-write prefix', () => {
    const implied = impliedScopes(['customer_read_orders']);

    assert.deepEqual([...implied], ['customer_read_orders']);
  });
});

describe('REQUIRED_SCOPES', () => {
  it('covers every scope an implemented feature declares', () => {
    for (const feature of SHOPIFY_FEATURES) {
      if (!feature.implemented) continue;
      for (const scope of feature.requiredScopes) {
        assert.ok(
          REQUIRED_SCOPES.includes(scope),
          `${scope} (needed by ${feature.key}) is missing from REQUIRED_SCOPES`,
        );
      }
    }
  });

  it('excludes scopes only unimplemented features need', () => {
    // write_themes is declared by themes.write, which is implemented:false.
    assert.ok(!REQUIRED_SCOPES.includes('write_themes'));
  });

  it('has no duplicates and is sorted', () => {
    assert.deepEqual([...REQUIRED_SCOPES], [...new Set(REQUIRED_SCOPES)].sort());
  });
});

describe('resolveCapabilities - real granted scopes', () => {
  const report = resolveCapabilities(REAL_GRANTED, REQUIRED_SCOPES);

  it('reports products readable from write_products alone', () => {
    // The whole point of the implication rule: read_products is NOT granted.
    assert.ok(!REAL_GRANTED.includes('read_products'));
    assert.equal(report.capabilities['products']?.['read'], true);
    assert.equal(report.capabilities['products']?.['write'], true);
    assert.equal(report.capabilities['products']?.['create'], true);
  });

  it('reports inventory readable and writable from write_inventory', () => {
    assert.ok(!REAL_GRANTED.includes('read_inventory'));
    assert.equal(report.capabilities['inventory']?.['read'], true);
    assert.equal(report.capabilities['inventory']?.['write'], true);
  });

  it('reports locations and themes readable', () => {
    assert.equal(report.capabilities['locations']?.['read'], true);
    assert.equal(report.capabilities['themes']?.['read'], true);
  });

  it('reports no missing scopes for this store', () => {
    assert.deepEqual(report.scopes.missing, []);
  });

  it('lists granted-but-unused scopes without treating them as a problem', () => {
    // read_analytics etc. are granted by the merchant's app config but no
    // implemented feature needs them.
    assert.ok(report.scopes.unused.includes('read_analytics'));
    assert.ok(!report.scopes.unused.includes('write_products'));
  });
});

describe('resolveCapabilities - scope missing vs not implemented', () => {
  it('distinguishes a missing scope from a missing implementation', () => {
    const report = resolveCapabilities(['read_products'], REQUIRED_SCOPES);

    const productsWrite = report.features.find((f) => f.key === 'products.write');
    const themesWrite = report.features.find((f) => f.key === 'themes.write');

    // Same outcome (unavailable), completely different remedy.
    assert.equal(productsWrite?.status, 'SCOPE_MISSING');
    assert.deepEqual(productsWrite?.missingScopes, ['write_products']);

    assert.equal(themesWrite?.status, 'NOT_IMPLEMENTED');
  });

  it('reports theme writes unimplemented even when write_themes IS granted', () => {
    // Granting the scope must not flip this to available: there is no code.
    const report = resolveCapabilities(
      [...REAL_GRANTED, 'write_themes'],
      REQUIRED_SCOPES,
    );

    const themesWrite = report.features.find((f) => f.key === 'themes.write');
    assert.equal(themesWrite?.status, 'NOT_IMPLEMENTED');
    assert.equal(themesWrite?.available, false);
    assert.equal(report.capabilities['themes']?.['write'], false);
  });

  it('lists every missing required scope on an empty grant', () => {
    const report = resolveCapabilities([], REQUIRED_SCOPES);

    assert.deepEqual([...report.scopes.missing], [...REQUIRED_SCOPES]);
  });

  it('does not gate scope-free features behind a scope', () => {
    // The shop query and webhook subscription management need no scope.
    const report = resolveCapabilities([], REQUIRED_SCOPES);

    assert.equal(report.features.find((f) => f.key === 'shop.read')?.status, 'AVAILABLE');
    assert.equal(
      report.features.find((f) => f.key === 'webhooks.manage')?.status,
      'AVAILABLE',
    );
  });
});

describe('resolveCapabilities - unknown scopes (static token)', () => {
  const report = resolveCapabilities(null, REQUIRED_SCOPES);

  it('reports scope-gated features as unknown rather than false', () => {
    // A static token does not report its scopes. Claiming `false` would invent
    // a problem on a deployment that works fine.
    assert.equal(report.features.find((f) => f.key === 'products.read')?.status, 'SCOPES_UNKNOWN');
    assert.equal(report.capabilities['products']?.['read'], null);
  });

  it('still reports unimplemented features as a hard false', () => {
    // No scope grant can make this work, so `null` would mislead.
    assert.equal(report.features.find((f) => f.key === 'themes.write')?.status, 'NOT_IMPLEMENTED');
    assert.equal(report.capabilities['themes']?.['write'], false);
  });

  it('claims nothing is missing when nothing is known', () => {
    assert.deepEqual(report.scopes.missing, []);
    assert.equal(report.scopes.granted, null);
  });
});

describe('resolveCapabilities - config drift', () => {
  it('flags a required scope the config forgot to request', () => {
    const report = resolveCapabilities(REAL_GRANTED, ['read_products']);

    // A required scope absent from SHOPIFY_SCOPES is a configuration bug: the
    // install prompt would never ask for it.
    assert.ok(report.scopes.notRequested.includes('write_products'));
    assert.ok(report.scopes.notRequested.includes('read_themes'));
  });

  it('reports no drift when the config requests the derived list', () => {
    const report = resolveCapabilities(REAL_GRANTED, REQUIRED_SCOPES);

    assert.deepEqual(report.scopes.notRequested, []);
  });

  it('accepts a write scope as satisfying a required read scope in config', () => {
    const report = resolveCapabilities(REAL_GRANTED, [
      'write_products',
      'write_inventory',
      'read_locations',
      'read_orders',
      'read_customers',
      'read_themes',
      // write_publications implies read_publications, satisfying both
      // publication features without listing read_publications explicitly.
      'write_publications',
    ]);

    assert.deepEqual(report.scopes.notRequested, []);
  });
});

describe('SHOPIFY_FEATURES catalogue integrity', () => {
  it('has a unique group.action key per feature', () => {
    const keys = SHOPIFY_FEATURES.map((f) => f.key);

    assert.deepEqual(keys, [...new Set(keys)]);
    for (const feature of SHOPIFY_FEATURES) {
      assert.equal(feature.key, `${feature.group}.${feature.action}`);
    }
  });

  it('gives every implemented feature a route to reach it by', () => {
    // A route is the minimum: an implemented capability nobody can call is not
    // implemented, whatever the flag says.
    for (const feature of SHOPIFY_FEATURES) {
      if (!feature.implemented) continue;
      assert.ok(feature.routes.length > 0, `${feature.key} declares no route`);
    }
  });

  it('names the operation behind every scope it demands', () => {
    // The real point of the operations list: a required scope must be traceable to the
    // Admin API call that needs it, or nobody can tell whether the scope is genuinely
    // required or was copied from a neighbouring entry.
    //
    // The converse is NOT required. Features like dropshipping.pricing and
    // research.candidates are Trademart-native - arithmetic and Mongo, no Admin API call
    // at all - so they declare no scopes and have no operation to name. Demanding one
    // would force an invented operation string, which is worse than an empty list.
    for (const feature of SHOPIFY_FEATURES) {
      if (!feature.implemented) continue;
      if (feature.requiredScopes.length === 0) continue;
      assert.ok(
        feature.operations.length > 0,
        `${feature.key} requires ${feature.requiredScopes.join(', ')} but names no operation that needs it`,
      );
    }
  });

  it('declares no scope for a feature that never calls Shopify', () => {
    // The mirror of the above, and the mistake it prevents is asking a merchant for
    // permission Trademart does not use - which costs install friction and trust.
    for (const feature of SHOPIFY_FEATURES) {
      if (!feature.implemented) continue;
      if (feature.operations.length > 0) continue;
      assert.deepEqual(
        feature.requiredScopes,
        [],
        `${feature.key} names no Admin API operation, so it must not require a scope`,
      );
    }
  });

  it('explains every unimplemented feature', () => {
    // An unexplained `implemented: false` is indistinguishable from an
    // oversight, and this payload is what an operator reads to decide whether
    // to grant a scope.
    for (const feature of SHOPIFY_FEATURES) {
      if (feature.implemented) continue;
      assert.ok(feature.note !== undefined && feature.note.length > 0, `${feature.key} has no note`);
    }
  });

  it('does not claim a scope for webhook management', () => {
    // write_webhooks / read_webhooks do not exist as Shopify scopes.
    const webhooks = SHOPIFY_FEATURES.find((f) => f.key === 'webhooks.manage');

    assert.deepEqual(webhooks?.requiredScopes, []);
    assert.ok(!REQUIRED_SCOPES.includes('write_webhooks'));
    assert.ok(!REQUIRED_SCOPES.includes('read_webhooks'));
  });
});
