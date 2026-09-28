/**
 * DeoDap identification and the provider's honesty.
 *
 * The guarantees: a product is attributed to DeoDap only on evidence someone wrote
 * into Shopify (never the title), SKU prefixes match only when configured, Tradelle
 * keeps precedence, and the provider advertises nothing it cannot do.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { classifySupplier, describeSupplierCostSupport, providers } from '../supplier.registry';
import type { SupplierCapabilities } from '../supplier.types';
import { DEODAP_API_AVAILABILITY, createDeodapApiClient } from './deodap.api';
import {
  collectDeodapEvidence,
  getDeodapSkuPrefixes,
  normaliseSkuPrefixes,
  setDeodapSkuPrefixes,
} from './deodap.identify';
import { deodapProvider } from './deodap.provider';

describe('collectDeodapEvidence', () => {
  it('matches the vendor the importer writes', () => {
    const evidence = collectDeodapEvidence({ vendor: 'DeoDap' }, []);
    assert.deepEqual(evidence, ['vendor="DeoDap"']);
  });

  it('matches a tag, ignoring case, spaces and dashes', () => {
    assert.equal(collectDeodapEvidence({ tags: ['Deo-Dap'] }, []).length, 1);
    assert.equal(collectDeodapEvidence({ tags: ['deo dap'] }, []).length, 1);
    assert.equal(collectDeodapEvidence({ vendor: 'DEODAP Wholesale' }, []).length, 1);
  });

  it('matches a fulfillment service', () => {
    const evidence = collectDeodapEvidence({ fulfillmentServices: ['deodap-fulfilment'] }, []);
    assert.ok(evidence.some((entry) => entry.startsWith('fulfillmentService=')));
  });

  it('finds nothing for unrelated products', () => {
    // The title is not part of the signal contract at all.
    assert.deepEqual(collectDeodapEvidence({ vendor: 'Kitchen Store', tags: ['steel'] }, []), []);
    assert.deepEqual(collectDeodapEvidence({}, []), []);
  });

  it('matches a SKU prefix only when one is configured', () => {
    assert.deepEqual(collectDeodapEvidence({ skus: ['DD-100'] }, []), []);

    const evidence = collectDeodapEvidence({ skus: ['dd-100', 'DD-101'] }, ['DD-']);
    assert.equal(evidence.length, 1, 'one matching SKU is enough evidence; twenty are not more');
    assert.match(evidence[0] ?? '', /prefix "DD-"/);
  });

  it('ignores blank SKUs', () => {
    assert.deepEqual(collectDeodapEvidence({ skus: ['', null, undefined, '  '] }, ['DD-']), []);
  });
});

describe('normaliseSkuPrefixes', () => {
  it('trims, de-duplicates ignoring case and keeps order', () => {
    assert.deepEqual(normaliseSkuPrefixes([' DD- ', 'dd-', 'DEO/']), ['DD-', 'DEO/']);
  });

  it('drops prefixes that could match too much or are malformed', () => {
    assert.deepEqual(normaliseSkuPrefixes(['-', 'has space', '', 'x'.repeat(21), 'OK1']), ['OK1']);
  });

  it('caps the list', () => {
    const many = Array.from({ length: 15 }, (_value, index) => `P${index}`);
    assert.equal(normaliseSkuPrefixes(many).length, 10);
  });
});

describe('configured SKU prefixes', () => {
  afterEach(() => setDeodapSkuPrefixes([]));

  it('are what classifySupplier matches against', () => {
    assert.equal(classifySupplier({ vendor: 'Acme', skus: ['DD-1'] }).supplier, 'OTHER');
    setDeodapSkuPrefixes(['DD-']);
    assert.deepEqual(getDeodapSkuPrefixes(), ['DD-']);
    assert.equal(classifySupplier({ vendor: 'Acme', skus: ['DD-1'] }).supplier, 'DEODAP');
  });

  it('can be switched off again', () => {
    setDeodapSkuPrefixes(['DD-']);
    setDeodapSkuPrefixes([]);
    assert.equal(classifySupplier({ skus: ['DD-1'] }).supplier, 'UNKNOWN');
  });
});

describe('classifySupplier with DeoDap registered', () => {
  it('classifies DEODAP from the vendor, with the evidence', () => {
    const result = classifySupplier({ vendor: 'DeoDap' });
    assert.equal(result.supplier, 'DEODAP');
    assert.ok(result.evidence.some((entry) => entry.includes('vendor')));
  });

  it('classifies DEODAP from the tag alone, so a custom vendor still works', () => {
    assert.equal(classifySupplier({ vendor: 'My Brand', tags: ['DeoDap'] }).supplier, 'DEODAP');
  });

  it('keeps TRADELLE when a product carries both markers', () => {
    assert.equal(classifySupplier({ vendor: 'DeoDap', tags: ['tradelle'] }).supplier, 'TRADELLE');
  });

  it('leaves other vendors as OTHER and nothing as UNKNOWN', () => {
    assert.equal(classifySupplier({ vendor: 'Acme Supplies' }).supplier, 'OTHER');
    assert.equal(classifySupplier({}).supplier, 'UNKNOWN');
  });
});

describe('deodapProvider', () => {
  it('is registered', () => {
    assert.ok(providers.some((provider) => provider.providerName === 'DEODAP'));
  });

  it('declares identification and nothing else', () => {
    const enabled = (Object.keys(deodapProvider.capabilities) as (keyof SupplierCapabilities)[]).filter(
      (key) => deodapProvider.capabilities[key],
    );
    assert.deepEqual(enabled, ['identifyProduct']);
  });

  it('explains every capability it does not have', () => {
    for (const [key, enabled] of Object.entries(deodapProvider.capabilities)) {
      if (enabled) continue;
      const reason = deodapProvider.limitations?.[key as keyof SupplierCapabilities];
      assert.ok(reason !== undefined && reason.length > 0, `${key} needs a limitation`);
    }
  });

  it('offers no cost lookup that could be mistaken for a feed', () => {
    assert.equal(deodapProvider.getSupplierCost, undefined);
    assert.equal(deodapProvider.getShippingCost, undefined);
    const support = describeSupplierCostSupport().find((entry) => entry.providerName === 'DEODAP');
    assert.equal(support?.supplierCostApi, false);
  });

  it('identifies from reliable signals only', () => {
    assert.equal(deodapProvider.identifyProduct?.({ vendor: 'DeoDap' }), true);
    assert.equal(deodapProvider.identifyProduct?.({ vendor: 'Acme' }), false);
  });
});

describe('the DeoDap API seam', () => {
  it('reports the API as unavailable, with a reason', () => {
    // Flips when a real client is implemented - and this test should be updated then.
    assert.equal(DEODAP_API_AVAILABILITY.available, false);
    assert.ok(DEODAP_API_AVAILABILITY.reason.length > 0);
  });

  it('returns no client, so nothing can pretend to call DeoDap', () => {
    assert.equal(createDeodapApiClient(null), null);
    assert.equal(createDeodapApiClient({ kind: 'API_KEY', apiKey: 'test-key-123456' }), null);
  });
});
