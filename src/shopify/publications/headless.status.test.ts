/**
 * Headless channel readiness reporting.
 *
 * The point of these assertions is that each failure names a DIFFERENT fix. A single
 * "headless: not ready" boolean sends an operator hunting; reporting which
 * precondition failed sends them to the one thing they need to change.
 *
 * Also pins down what this must NOT claim: the storefront application's Storefront
 * API token lives outside this backend, so a green publication status is never
 * allowed to read as "the storefront works".
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveHeadlessChannelStatus } from './headless.status';

const CHANNEL = { id: 'gid://shopify/Publication/777', name: 'Kanay Headless' };

describe('headless channel readiness distinguishes each failure', () => {
  it('reports unconfigured when no channel was named', () => {
    const status = resolveHeadlessChannelStatus({
      selector: null,
      resolved: null,
      canReadPublications: true,
      canPublish: true,
    });

    assert.equal(status.channelConfigured, false);
    assert.equal(status.publicationReady, false);
    assert.equal(status.configuredAs, null);
    assert.match(status.reason, /SHOPIFY_HEADLESS_PUBLICATION_ID/);
  });

  it('blames the missing read scope BEFORE reporting "not found"', () => {
    // Without read_publications, "not found" is meaningless - the app cannot see any
    // channel. Reporting it would send the operator to fix the wrong thing.
    const status = resolveHeadlessChannelStatus({
      selector: { publicationId: CHANNEL.id },
      resolved: null,
      canReadPublications: false,
      canPublish: true,
    });

    assert.equal(status.publicationReady, false);
    assert.match(status.reason, /read_publications/);
    assert.doesNotMatch(status.reason, /does not exist/);
  });

  it('reports not-found when the channel is configured but absent from the shop', () => {
    const status = resolveHeadlessChannelStatus({
      selector: { publicationId: CHANNEL.id },
      resolved: null,
      canReadPublications: true,
      canPublish: true,
    });

    assert.equal(status.channelConfigured, true);
    assert.equal(status.channelResolved, false);
    assert.equal(status.publicationReady, false);
    assert.match(status.reason, /gid:\/\/shopify\/Publication\/777/);
    assert.match(status.reason, /api\/shopify\/publications/);
  });

  it('is publication-ready but read-only when write_publications is missing', () => {
    const status = resolveHeadlessChannelStatus({
      selector: { publicationId: CHANNEL.id },
      resolved: CHANNEL,
      canReadPublications: true,
      canPublish: false,
    });

    // The channel is genuinely usable for REPORTING, which is worth saying, while
    // the console must not offer a publish control it cannot perform.
    assert.equal(status.publicationReady, true);
    assert.equal(status.canPublish, false);
    assert.match(status.reason, /write_publications/);
  });

  it('is fully ready when configured, found, readable and writable', () => {
    const status = resolveHeadlessChannelStatus({
      selector: { publicationId: CHANNEL.id },
      resolved: CHANNEL,
      canReadPublications: true,
      canPublish: true,
    });

    assert.equal(status.publicationReady, true);
    assert.equal(status.canPublish, true);
    assert.deepEqual(status.channel, CHANNEL);
  });

  it('never claims the storefront application itself works', () => {
    // publicationReady is a Shopify-side precondition only. The Storefront API
    // access token lives in the storefront app, which this backend cannot check.
    const status = resolveHeadlessChannelStatus({
      selector: { publicationId: CHANNEL.id },
      resolved: CHANNEL,
      canReadPublications: true,
      canPublish: true,
    });

    assert.match(status.reason, /does not verify the storefront application/i);
  });

  it('reports the configured identity, preferring the id over the name', () => {
    const byId = resolveHeadlessChannelStatus({
      selector: { publicationId: CHANNEL.id, name: 'Kanay Headless' },
      resolved: CHANNEL,
      canReadPublications: true,
      canPublish: true,
    });
    assert.equal(byId.configuredAs, CHANNEL.id);

    const byName = resolveHeadlessChannelStatus({
      selector: { name: 'Kanay Headless' },
      resolved: CHANNEL,
      canReadPublications: true,
      canPublish: true,
    });
    assert.equal(byName.configuredAs, 'Kanay Headless');
  });

  it('treats an all-blank selector as unconfigured rather than as a channel named ""', () => {
    const status = resolveHeadlessChannelStatus({
      selector: { publicationId: '  ', name: '' },
      resolved: null,
      canReadPublications: true,
      canPublish: true,
    });

    assert.equal(status.channelConfigured, false);
    assert.equal(status.configuredAs, null);
  });
});
