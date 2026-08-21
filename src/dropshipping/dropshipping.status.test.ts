/**
 * Fulfillment normalisation.
 *
 * Exhaustive on purpose. Every case here is a way a dropshipping dashboard can lie
 * to an operator or a customer:
 *
 *   - calling a printed label "shipped"
 *   - calling an unknown status "processing"
 *   - reporting one parcel of a split shipment and hiding the other
 *   - showing "in transit" for an order the supplier declined
 *   - losing the parcel's position in order to say "delayed"
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { describeState, effectiveStatus, resolveShipment } from './dropshipping.status';
import { DEFAULT_SHIPPING_SLA, STATE_RANK } from './dropshipping.types';
import type { FulfillmentDto } from '../shopify/shopify.types';

const NOW = new Date('2026-03-10T12:00:00Z');
const CREATED = '2026-03-10T11:00:00Z';

function fulfillment(overrides: Partial<FulfillmentDto> = {}): FulfillmentDto {
  return {
    id: 'gid://shopify/Fulfillment/1',
    status: 'SUCCESS',
    displayStatus: null,
    createdAt: '2026-03-10T11:30:00Z',
    updatedAt: null,
    estimatedDeliveryAt: null,
    inTransitAt: null,
    deliveredAt: null,
    trackingCompany: null,
    trackingNumber: null,
    trackingUrl: null,
    tracking: [],
    events: [],
    ...overrides,
  };
}

function resolve(input: Partial<Parameters<typeof resolveShipment>[0]> = {}) {
  return resolveShipment({
    orderFulfillmentStatus: 'UNFULFILLED',
    financialStatus: 'PAID',
    fulfillments: [],
    createdAt: CREATED,
    now: NOW,
    ...input,
  });
}

describe('no fulfillments: the order-level status is all we have', () => {
  it('PAID and unfulfilled is AWAITING_SUPPLIER - money is committed, nothing is happening', () => {
    assert.equal(resolve({ financialStatus: 'PAID' }).normalizedStatus, 'AWAITING_SUPPLIER');
  });

  it('UNPAID and unfulfilled is only ORDER_RECEIVED - nothing is expected of the supplier yet', () => {
    assert.equal(resolve({ financialStatus: 'PENDING' }).normalizedStatus, 'ORDER_RECEIVED');
  });

  it('IN_PROGRESS is SUPPLIER_PROCESSING', () => {
    assert.equal(
      resolve({ orderFulfillmentStatus: 'IN_PROGRESS' }).normalizedStatus,
      'SUPPLIER_PROCESSING',
    );
  });

  it('RESTOCKED means the order was cancelled or refunded', () => {
    const shipment = resolve({ orderFulfillmentStatus: 'RESTOCKED' });
    assert.equal(shipment.normalizedStatus, 'CANCELLED');
    assert.ok(shipment.delaySignals.some((s) => /restocked/i.test(s)));
  });

  it('ON_HOLD says so, because it will not progress on its own', () => {
    const shipment = resolve({ orderFulfillmentStatus: 'ON_HOLD' });
    assert.equal(shipment.normalizedStatus, 'AWAITING_SUPPLIER');
    assert.ok(shipment.delaySignals.some((s) => /ON_HOLD/.test(s)));
  });

  it('REQUEST_DECLINED is NOT a delivery failure - nothing was ever dispatched', () => {
    const shipment = resolve({ orderFulfillmentStatus: 'REQUEST_DECLINED' });
    assert.equal(shipment.normalizedStatus, 'AWAITING_SUPPLIER');
    assert.notEqual(shipment.normalizedStatus, 'DELIVERY_FAILED');
    // But it must be loud: it will never ship without intervention.
    assert.ok(shipment.delaySignals.some((s) => /DECLINED/.test(s)));
    assert.equal(shipment.delayed, true);
  });

  it('an unrecognised status is UNKNOWN, never "processing"', () => {
    // Assuming progress that may not exist is the failure this guards.
    const shipment = resolve({ orderFulfillmentStatus: 'SOMETHING_NEW_FROM_SHOPIFY' });
    assert.equal(shipment.normalizedStatus, 'UNKNOWN');
  });

  it('a null status is UNKNOWN', () => {
    assert.equal(resolve({ orderFulfillmentStatus: null }).normalizedStatus, 'UNKNOWN');
  });
});

describe('a printed label is NOT a shipment', () => {
  for (const display of ['LABEL_PRINTED', 'LABEL_PURCHASED'] as const) {
    it(`${display} maps to LABEL_CREATED, not IN_TRANSIT`, () => {
      const shipment = resolve({ fulfillments: [fulfillment({ displayStatus: display })] });
      assert.equal(shipment.normalizedStatus, 'LABEL_CREATED');
    });
  }

  it('a voided label means this parcel is not coming', () => {
    const shipment = resolve({
      fulfillments: [fulfillment({ displayStatus: 'LABEL_VOIDED' })],
    });
    assert.equal(shipment.normalizedStatus, 'CANCELLED');
  });
});

describe('display status mapping', () => {
  const cases: [string, string][] = [
    ['SUBMITTED', 'SUPPLIER_PROCESSING'],
    ['CONFIRMED', 'SUPPLIER_PROCESSING'],
    ['FULFILLED', 'FULFILLED'],
    ['MARKED_AS_FULFILLED', 'FULFILLED'],
    ['PICKED_UP', 'CARRIER_PICKED_UP'],
    ['IN_TRANSIT', 'IN_TRANSIT'],
    ['OUT_FOR_DELIVERY', 'OUT_FOR_DELIVERY'],
    ['READY_FOR_PICKUP', 'OUT_FOR_DELIVERY'],
    ['DELIVERED', 'DELIVERED'],
    ['ATTEMPTED_DELIVERY', 'DELIVERY_FAILED'],
    ['NOT_DELIVERED', 'DELIVERY_FAILED'],
    ['FAILURE', 'DELIVERY_FAILED'],
    ['CANCELED', 'CANCELLED'],
  ];

  for (const [display, expected] of cases) {
    it(`${display} -> ${expected}`, () => {
      assert.equal(
        resolve({ fulfillments: [fulfillment({ displayStatus: display })] }).normalizedStatus,
        expected,
      );
    });
  }

  it('a confirmation is not a shipment', () => {
    // SUBMITTED/CONFIRMED mean the supplier has the job, not that it is packed.
    assert.ok(STATE_RANK.SUPPLIER_PROCESSING < STATE_RANK.FULFILLED);
  });
});

describe('falls back through the fulfillment fields when displayStatus is absent', () => {
  it('a deliveredAt timestamp beats the coarse status field', () => {
    const shipment = resolve({
      fulfillments: [fulfillment({ status: 'OPEN', deliveredAt: '2026-03-09T10:00:00Z' })],
    });
    assert.equal(shipment.normalizedStatus, 'DELIVERED');
  });

  it('an inTransitAt timestamp is believed', () => {
    const shipment = resolve({
      fulfillments: [fulfillment({ status: 'OPEN', inTransitAt: '2026-03-09T10:00:00Z' })],
    });
    assert.equal(shipment.normalizedStatus, 'IN_TRANSIT');
  });

  it('SUCCESS with no movement data is FULFILLED, not IN_TRANSIT', () => {
    // The furthest defensible claim: the record is complete, but whether a carrier
    // has the parcel is genuinely unknown.
    assert.equal(resolve({ fulfillments: [fulfillment()] }).normalizedStatus, 'FULFILLED');
  });

  it('ERROR is a delivery failure', () => {
    assert.equal(
      resolve({ fulfillments: [fulfillment({ status: 'ERROR' })] }).normalizedStatus,
      'DELIVERY_FAILED',
    );
  });

  it('an unrecognised fulfillment status is UNKNOWN', () => {
    assert.equal(
      resolve({ fulfillments: [fulfillment({ status: 'BRAND_NEW' })] }).normalizedStatus,
      'UNKNOWN',
    );
  });
});

describe('several parcels: report the one that matters', () => {
  it('reports the furthest-progressed parcel', () => {
    const shipment = resolve({
      fulfillments: [
        fulfillment({ id: 'f1', displayStatus: 'LABEL_PRINTED' }),
        fulfillment({ id: 'f2', displayStatus: 'IN_TRANSIT' }),
      ],
    });
    assert.equal(shipment.normalizedStatus, 'IN_TRANSIT');
  });

  it('a FAILED parcel outranks one still moving - the failure needs attention', () => {
    const shipment = resolve({
      fulfillments: [
        fulfillment({ id: 'f1', displayStatus: 'IN_TRANSIT' }),
        fulfillment({ id: 'f2', displayStatus: 'ATTEMPTED_DELIVERY' }),
      ],
    });
    assert.equal(shipment.normalizedStatus, 'DELIVERY_FAILED');
  });

  it('is only DELIVERED once EVERY parcel has arrived', () => {
    const partly = resolve({
      fulfillments: [
        fulfillment({ id: 'f1', deliveredAt: '2026-03-09T10:00:00Z', displayStatus: 'DELIVERED' }),
        fulfillment({ id: 'f2', displayStatus: 'IN_TRANSIT' }),
      ],
    });
    // The furthest parcel is delivered, but the ORDER is not fully delivered, so no
    // order-level deliveredAt is claimed.
    assert.equal(partly.deliveredAt, null);

    const fully = resolve({
      fulfillments: [
        fulfillment({ id: 'f1', deliveredAt: '2026-03-09T10:00:00Z', displayStatus: 'DELIVERED' }),
        fulfillment({ id: 'f2', deliveredAt: '2026-03-09T14:00:00Z', displayStatus: 'DELIVERED' }),
      ],
    });
    // The LAST arrival is when the order completed.
    assert.equal(fully.deliveredAt, '2026-03-09T14:00:00.000Z');
  });

  it('collects tracking from every parcel', () => {
    const shipment = resolve({
      fulfillments: [
        fulfillment({
          id: 'f1',
          tracking: [{ company: 'YunExpress', number: 'YT1', url: 'https://t/1' }],
        }),
        fulfillment({
          id: 'f2',
          tracking: [{ company: 'YunExpress', number: 'YT2', url: 'https://t/2' }],
        }),
      ],
    });
    assert.deepEqual(shipment.trackingNumbers, ['YT1', 'YT2']);
    assert.deepEqual(shipment.trackingUrls, ['https://t/1', 'https://t/2']);
    assert.equal(shipment.carrier, 'YunExpress');
    assert.equal(shipment.hasTracking, true);
  });

  it('warns when only part of the order shipped', () => {
    const shipment = resolve({
      orderFulfillmentStatus: 'PARTIALLY_FULFILLED',
      fulfillments: [fulfillment({ displayStatus: 'IN_TRANSIT' })],
    });
    assert.ok(shipment.delaySignals.some((s) => /Only part of this order/.test(s)));
  });
});

describe('a cancelled order is cancelled, whatever the parcels say', () => {
  it('overrides an in-transit parcel', () => {
    const shipment = resolve({
      cancelledAt: '2026-03-09T09:00:00Z',
      fulfillments: [fulfillment({ displayStatus: 'IN_TRANSIT' })],
    });
    assert.equal(shipment.normalizedStatus, 'CANCELLED');
  });
});

describe('delay is orthogonal to progress', () => {
  it('an order can be IN_TRANSIT and delayed at the same time', () => {
    const shipment = resolve({
      fulfillments: [
        fulfillment({
          displayStatus: 'IN_TRANSIT',
          estimatedDeliveryAt: '2026-03-07T00:00:00Z', // 3 days before NOW
        }),
      ],
    });
    // The parcel's position is NOT lost in order to report lateness.
    assert.equal(shipment.normalizedStatus, 'IN_TRANSIT');
    assert.equal(shipment.delayed, true);
    assert.ok(shipment.delaySignals.some((s) => /estimated delivery date by 3 day/.test(s)));
    // ...and a single-badge display can still show one value.
    assert.equal(effectiveStatus(shipment), 'DELAYED');
  });

  it('a delivered order is never marked delayed', () => {
    const shipment = resolve({
      fulfillments: [
        fulfillment({
          displayStatus: 'DELIVERED',
          deliveredAt: '2026-03-09T10:00:00Z',
          estimatedDeliveryAt: '2026-03-01T00:00:00Z',
        }),
      ],
    });
    assert.equal(shipment.delayed, false);
    assert.equal(effectiveStatus(shipment), 'DELIVERED');
  });

  it('flags a paid order the supplier has sat on past the threshold', () => {
    const shipment = resolve({
      financialStatus: 'PAID',
      createdAt: '2026-03-08T12:00:00Z', // 48h before NOW, threshold is 24h
      fulfillments: [],
    });
    assert.equal(shipment.normalizedStatus, 'AWAITING_SUPPLIER');
    assert.ok(shipment.delaySignals.some((s) => /has not dispatched/.test(s)));
  });

  it('does NOT flag an unpaid order for slow processing', () => {
    // Nothing is expected of the supplier until the money is taken.
    const shipment = resolve({
      financialStatus: 'PENDING',
      createdAt: '2026-03-01T12:00:00Z',
      fulfillments: [],
    });
    assert.equal(shipment.normalizedStatus, 'ORDER_RECEIVED');
    assert.equal(shipment.delayed, false);
  });

  it('flags a fulfilled order with no tracking after the threshold', () => {
    // The customer can see nothing at all - the most common "where is my order?".
    const shipment = resolve({
      fulfillments: [
        fulfillment({ createdAt: '2026-03-08T00:00:00Z', tracking: [] }), // 60h before NOW
      ],
    });
    assert.equal(shipment.hasTracking, false);
    assert.ok(shipment.delaySignals.some((s) => /no tracking number/.test(s)));
  });

  it('does not flag missing tracking on an order that has not been fulfilled yet', () => {
    const shipment = resolve({
      fulfillments: [fulfillment({ status: 'OPEN', createdAt: '2026-03-01T00:00:00Z' })],
    });
    assert.equal(shipment.normalizedStatus, 'SUPPLIER_PROCESSING');
    assert.ok(!shipment.delaySignals.some((s) => /no tracking number/.test(s)));
  });

  it('respects a configured grace period past the ETA', () => {
    const late = {
      fulfillments: [
        fulfillment({ displayStatus: 'IN_TRANSIT', estimatedDeliveryAt: '2026-03-09T12:00:00Z' }),
      ],
    };
    // 1 day past ETA: delayed with the default zero grace...
    assert.equal(resolve(late).delayed, true);
    // ...but not with a 3-day grace period.
    assert.equal(
      resolve({ ...late, sla: { ...DEFAULT_SHIPPING_SLA, deliveryDelayDays: 3 } }).delayed,
      false,
    );
  });
});

describe('the raw Shopify state is always retained', () => {
  it('keeps the order status and every parcel display status', () => {
    // When a normalisation looks wrong, this is what makes it debuggable.
    const shipment = resolve({
      orderFulfillmentStatus: 'PARTIALLY_FULFILLED',
      fulfillments: [
        fulfillment({ id: 'f1', displayStatus: 'IN_TRANSIT' }),
        fulfillment({ id: 'f2', displayStatus: null }),
      ],
    });
    assert.equal(shipment.rawShopifyStatus.orderFulfillmentStatus, 'PARTIALLY_FULFILLED');
    assert.deepEqual(shipment.rawShopifyStatus.fulfillmentDisplayStatuses, ['IN_TRANSIT', null]);
  });

  it('flattens carrier events for the timeline', () => {
    const shipment = resolve({
      fulfillments: [
        fulfillment({
          events: [
            { id: 'e1', status: 'IN_TRANSIT', happenedAt: '2026-03-09T08:00:00Z', message: 'Departed' },
          ],
        }),
      ],
    });
    assert.equal(shipment.events.length, 1);
    assert.equal(shipment.events[0]?.message, 'Departed');
  });
});

describe('describeState', () => {
  it('labels every state', () => {
    const states = [...Object.keys(STATE_RANK), 'DELAYED'] as const;
    for (const state of states) {
      const label = describeState(state as never);
      assert.ok(label.length > 0, `no label for ${state}`);
      // Labels are for humans - no SCREAMING_SNAKE leaking into the UI.
      assert.ok(!label.includes('_'), `${state} label looks like an enum: ${label}`);
    }
  });
});
