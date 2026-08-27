/**
 * What a webhook sender is told, and why it matters.
 *
 * A 2xx on a webhook is not a status line, it is a PROMISE: Shopify records the
 * delivery as successful and will never send it again. So the only defensible
 * 200s are "it is durably stored", "it is a duplicate of something stored" and
 * "it was completely handled inline". Anything else has to be a retryable 5xx.
 *
 * The behaviour this replaces answered 200 when the insert failed, on the
 * reasoning that "Shopify would retry into the same broken storage". The cost of
 * that trade was permanent, silent loss of a verified event - invisible until an
 * order turns out not to exist. A 503 costs a redelivery attempt; a 200 costs the
 * event.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AppError, defaultRetryableForCode, defaultStatusForCode } from '../common/errors';
import {
  APP_UNINSTALLED_TOPIC,
  decideWebhookAck,
  requiresInlineHandling,
} from './webhook.ack';

describe('webhook acknowledgement policy', () => {
  it('acknowledges a durably stored event', () => {
    const ack = decideWebhookAck({
      topic: 'orders/create',
      stored: true,
      duplicate: false,
      inline: 'not-needed',
    });
    assert.equal(ack.kind, 'queued');
    assert.equal(ack.status, 200);
  });

  it('acknowledges a duplicate delivery with 200, not an error', () => {
    // The dedupe key hit means the ORIGINAL is stored. Shopify retrying a delivery
    // we already have is normal, expected traffic - answering 5xx would make it
    // retry forever over an event that is already safe.
    const ack = decideWebhookAck({
      topic: 'orders/create',
      stored: false,
      duplicate: true,
      inline: 'not-needed',
    });
    assert.equal(ack.kind, 'duplicate');
    assert.equal(ack.status, 200);
  });

  it('answers 503 when a verified event could not be persisted', () => {
    const ack = decideWebhookAck({
      topic: 'orders/create',
      stored: false,
      duplicate: false,
      inline: 'not-needed',
    });
    assert.equal(ack.kind, 'not-persisted');
    assert.equal(ack.status, 503);
  });

  it('answers 503 when persistence failed for a topic with no inline path', () => {
    // products/update has no inline fallback: without storage there is nowhere to
    // retry from, so it must not be acknowledged.
    for (const topic of ['products/update', 'inventory_levels/update', 'orders/paid']) {
      const ack = decideWebhookAck({ topic, stored: false, duplicate: false });
      assert.equal(ack.kind, 'not-persisted', `${topic} must not be acknowledged`);
    }
  });

  it('acknowledges an uninstall that was fully handled inline', () => {
    // The token was cleared. Nothing is pending, so a 200 is truthful even though
    // nothing was stored.
    const ack = decideWebhookAck({
      topic: APP_UNINSTALLED_TOPIC,
      stored: false,
      duplicate: false,
      inline: 'handled',
    });
    assert.equal(ack.kind, 'handled-inline');
    assert.equal(ack.status, 200);
  });

  it('does NOT acknowledge an uninstall whose inline handling failed', () => {
    // The revoked token is still stored. That is a security problem, and claiming
    // success would ensure nobody ever hears about the event again.
    const ack = decideWebhookAck({
      topic: APP_UNINSTALLED_TOPIC,
      stored: false,
      duplicate: false,
      inline: 'failed',
    });
    assert.equal(ack.kind, 'not-persisted');
    assert.equal(ack.status, 503);
  });

  it('prefers a stored event over the inline path', () => {
    // When the event IS queued, the durable worker owns it; nothing should be done
    // twice inline.
    const ack = decideWebhookAck({
      topic: APP_UNINSTALLED_TOPIC,
      stored: true,
      duplicate: false,
      inline: 'not-needed',
    });
    assert.equal(ack.kind, 'queued');
  });

  it('explains what the sender should do', () => {
    const ack = decideWebhookAck({ topic: 'orders/create', stored: false, duplicate: false });
    assert.equal(ack.kind, 'not-persisted');
    if (ack.kind !== 'not-persisted') return;
    // The message has to say "redeliver", because that is the only action that
    // recovers the event.
    assert.match(ack.message, /redeliver/i);
  });
});

describe('inline handling is limited to the uninstall topic', () => {
  it('applies to app/uninstalled, case-insensitively', () => {
    assert.equal(requiresInlineHandling('app/uninstalled'), true);
    assert.equal(requiresInlineHandling('APP/UNINSTALLED'), true);
  });

  it('does not apply to ordinary business topics', () => {
    // Processing an order inline with no database would leave no record that it
    // happened, and no way to retry the parts that failed.
    for (const topic of ['orders/create', 'orders/paid', 'products/update', 'unknown']) {
      assert.equal(requiresInlineHandling(topic), false, topic);
    }
  });
});

describe('WEBHOOK_NOT_PERSISTED is wired as a retryable 503', () => {
  it('maps to 503, not 500', () => {
    // 500 would read as "our bug"; 503 reads as "temporarily unable, come back",
    // which is exactly what a sender needs to schedule a redelivery.
    assert.equal(defaultStatusForCode('WEBHOOK_NOT_PERSISTED'), 503);
  });

  it('is retryable, because the condition is transient', () => {
    assert.equal(defaultRetryableForCode('WEBHOOK_NOT_PERSISTED'), true);
  });

  it('carries the status onto the thrown AppError', () => {
    const error = new AppError('WEBHOOK_NOT_PERSISTED', 'nope');
    assert.equal(error.status, 503);
    assert.equal(error.retryable, true);
  });
});
