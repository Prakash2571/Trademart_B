/**
 * Unit tests for webhook registration planning.
 *
 * The property that matters most is idempotency: running registration twice must
 * not create a second subscription for a topic, because Shopify would then
 * deliver every event twice.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  normaliseCallbackUrl,
  planWebhookRegistration,
  summarisePlan,
  topicEnumToHeader,
  topicHeaderToEnum,
  type ExistingSubscription,
} from './webhook.registration';

const CALLBACK = 'https://app.example.com/api/webhooks/shopify';

function subscription(
  topic: string,
  callbackUrl: string | null,
  id = `gid://shopify/WebhookSubscription/${topic}`,
): ExistingSubscription {
  return { id, topic, callbackUrl };
}

describe('normaliseCallbackUrl', () => {
  it('ignores a trailing slash', () => {
    assert.equal(
      normaliseCallbackUrl('https://a.example.com/hook/'),
      normaliseCallbackUrl('https://a.example.com/hook'),
    );
  });

  it('ignores host casing', () => {
    assert.equal(
      normaliseCallbackUrl('https://A.Example.COM/hook'),
      normaliseCallbackUrl('https://a.example.com/hook'),
    );
  });

  it('preserves path casing, which IS significant', () => {
    assert.notEqual(
      normaliseCallbackUrl('https://a.example.com/Hook'),
      normaliseCallbackUrl('https://a.example.com/hook'),
    );
  });

  it('returns null for null or blank input', () => {
    assert.equal(normaliseCallbackUrl(null), null);
    assert.equal(normaliseCallbackUrl('   '), null);
  });

  it('falls back to raw text for an unparseable URL', () => {
    assert.equal(normaliseCallbackUrl('not a url'), 'not a url');
  });
});

describe('topicHeaderToEnum', () => {
  it('converts the delivery header form to the enum form', () => {
    assert.equal(topicHeaderToEnum('orders/create'), 'ORDERS_CREATE');
    assert.equal(topicHeaderToEnum('app/uninstalled'), 'APP_UNINSTALLED');
  });

  it('handles multi-word resources', () => {
    assert.equal(topicHeaderToEnum('draft_orders/create'), 'DRAFT_ORDERS_CREATE');
  });
});

describe('topicEnumToHeader', () => {
  it('converts the enum form back to the header form', () => {
    assert.equal(topicEnumToHeader('ORDERS_CREATE'), 'orders/create');
  });

  it('splits on the LAST underscore, not the first', () => {
    // DRAFT_ORDERS_CREATE must not become draft/orders_create.
    assert.equal(topicEnumToHeader('DRAFT_ORDERS_CREATE'), 'draft_orders/create');
  });

  it('round-trips every planned topic', () => {
    for (const topic of ['ORDERS_CREATE', 'PRODUCTS_DELETE', 'APP_UNINSTALLED']) {
      assert.equal(topicHeaderToEnum(topicEnumToHeader(topic)), topic);
    }
  });
});

describe('planWebhookRegistration', () => {
  it('plans a create when nothing is registered', () => {
    const plan = planWebhookRegistration(['ORDERS_CREATE'], CALLBACK, []);
    assert.deepEqual(plan.actions, [{ action: 'create', topic: 'ORDERS_CREATE' }]);
  });

  it('is idempotent - an already-correct subscription is kept, not recreated', () => {
    const existing = [subscription('ORDERS_CREATE', CALLBACK)];
    const plan = planWebhookRegistration(['ORDERS_CREATE'], CALLBACK, existing);
    assert.equal(plan.actions.length, 1);
    assert.equal(plan.actions[0]?.action, 'keep');
  });

  it('keeps a subscription whose URL differs only by a trailing slash', () => {
    const existing = [subscription('ORDERS_CREATE', `${CALLBACK}/`)];
    const plan = planWebhookRegistration(['ORDERS_CREATE'], CALLBACK, existing);
    assert.equal(plan.actions[0]?.action, 'keep');
  });

  it('plans an update when the topic points at a different URL', () => {
    const existing = [
      subscription('ORDERS_CREATE', 'https://old-tunnel.example.com/api/webhooks/shopify'),
    ];
    const plan = planWebhookRegistration(['ORDERS_CREATE'], CALLBACK, existing);
    const action = plan.actions[0];
    assert.equal(action?.action, 'update');
    assert.equal(
      action?.action === 'update' ? action.currentCallbackUrl : null,
      'https://old-tunnel.example.com/api/webhooks/shopify',
    );
  });

  it('skips a topic registered on a non-HTTP endpoint instead of hijacking it', () => {
    // An EventBridge subscription must not be silently converted to HTTP.
    const existing = [subscription('ORDERS_CREATE', null)];
    const plan = planWebhookRegistration(['ORDERS_CREATE'], CALLBACK, existing);
    const action = plan.actions[0];
    assert.equal(action?.action, 'skip');
    assert.match(action?.action === 'skip' ? action.reason : '', /non-HTTP/);
  });

  it('prefers an exact match over repointing another HTTP subscription', () => {
    const existing = [
      subscription('ORDERS_CREATE', 'https://other.example.com/hook', 'gid://a'),
      subscription('ORDERS_CREATE', CALLBACK, 'gid://b'),
    ];
    const plan = planWebhookRegistration(['ORDERS_CREATE'], CALLBACK, existing);
    assert.equal(plan.actions[0]?.action, 'keep');
    assert.equal(
      plan.actions[0]?.action === 'keep' ? plan.actions[0].id : null,
      'gid://b',
    );
  });

  it('prefers repointing an HTTP subscription over skipping a non-HTTP one', () => {
    const existing = [
      subscription('ORDERS_CREATE', null, 'gid://eventbridge'),
      subscription('ORDERS_CREATE', 'https://old.example.com/hook', 'gid://http'),
    ];
    const plan = planWebhookRegistration(['ORDERS_CREATE'], CALLBACK, existing);
    assert.equal(plan.actions[0]?.action, 'update');
    assert.equal(
      plan.actions[0]?.action === 'update' ? plan.actions[0].id : null,
      'gid://http',
    );
  });

  it('reports our own subscriptions for undesired topics as orphaned', () => {
    const existing = [subscription('CARTS_UPDATE', CALLBACK, 'gid://orphan')];
    const plan = planWebhookRegistration(['ORDERS_CREATE'], CALLBACK, existing);
    assert.equal(plan.orphaned.length, 1);
    assert.equal(plan.orphaned[0]?.id, 'gid://orphan');
  });

  it('does not treat another app\'s subscription as orphaned', () => {
    // Only subscriptions aimed at OUR callback URL are ours to prune.
    const existing = [
      subscription('CARTS_UPDATE', 'https://someone-else.example.com/hook'),
    ];
    const plan = planWebhookRegistration(['ORDERS_CREATE'], CALLBACK, existing);
    assert.equal(plan.orphaned.length, 0);
  });

  it('never emits a delete action - pruning stays a deliberate operator step', () => {
    const existing = [subscription('CARTS_UPDATE', CALLBACK)];
    const plan = planWebhookRegistration(['ORDERS_CREATE'], CALLBACK, existing);
    assert.ok(plan.actions.every((entry) => entry.action !== ('delete' as never)));
  });

  it('handles a mixed set of topics in one pass', () => {
    const existing = [
      subscription('ORDERS_CREATE', CALLBACK),
      subscription('ORDERS_UPDATED', 'https://old.example.com/hook'),
      subscription('PRODUCTS_CREATE', null),
    ];
    const plan = planWebhookRegistration(
      ['ORDERS_CREATE', 'ORDERS_UPDATED', 'PRODUCTS_CREATE', 'PRODUCTS_DELETE'],
      CALLBACK,
      existing,
    );
    assert.deepEqual(summarisePlan(plan), {
      create: 1,
      update: 1,
      keep: 1,
      skip: 1,
      orphaned: 0,
    });
  });

  it('produces one action per desired topic, in order', () => {
    const topics = ['APP_UNINSTALLED', 'ORDERS_CREATE', 'PRODUCTS_UPDATE'];
    const plan = planWebhookRegistration(topics, CALLBACK, []);
    assert.deepEqual(
      plan.actions.map((entry) => entry.topic),
      topics,
    );
  });

  it('returns an empty plan for no desired topics', () => {
    const plan = planWebhookRegistration([], CALLBACK, []);
    assert.deepEqual(plan.actions, []);
    assert.deepEqual(plan.orphaned, []);
  });
});
