'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  LIMIT_ORDER_CHECKPOINTS,
  scheduledOrderSlotAt,
  selectMidpointSides,
  simulateLimitBuy,
} = require('./midpoint-limit-strategy');

const START = 1_800_000_000_000;

test('scheduled order slots cover 20–120 seconds and 140–240 seconds', () => {
  assert.deepEqual(LIMIT_ORDER_CHECKPOINTS.map(({ seconds, phase, shares }) => [seconds, phase, shares]), [
    [20, 'CHEAP', 100], [40, 'CHEAP', 100], [60, 'CHEAP', 100],
    [80, 'CHEAP', 100], [100, 'CHEAP', 100], [120, 'CHEAP', 100],
    [140, 'EXPENSIVE', 300], [160, 'EXPENSIVE', 300],
    [180, 'EXPENSIVE', 300], [200, 'EXPENSIVE', 300],
    [220, 'EXPENSIVE', 300], [240, 'EXPENSIVE', 300],
  ]);
  for (const checkpoint of LIMIT_ORDER_CHECKPOINTS) {
    assert.equal(scheduledOrderSlotAt(START, START + checkpoint.seconds * 1000), checkpoint.slot);
    assert.equal(scheduledOrderSlotAt(START, START + (checkpoint.seconds + 19.999) * 1000), checkpoint.slot);
  }
  assert.equal(scheduledOrderSlotAt(START, START + 139_999), 5);
  assert.equal(scheduledOrderSlotAt(START, START + 260_000), -1);
});

test('midpoint side selection requires two fresh distinct prices', () => {
  const quotes = {
    UP: { midpoint: .31, updatedAt: START + 5_000 },
    DOWN: { midpoint: .68, updatedAt: START + 5_000 },
  };
  assert.deepEqual(selectMidpointSides(quotes, START + 5_000, 5_000), {
    status: 'READY',
    cheapSide: 'UP',
    expensiveSide: 'DOWN',
    midpoints: { UP: .31, DOWN: .68 },
  });
  assert.equal(selectMidpointSides({
    UP: { midpoint: .5, updatedAt: START },
    DOWN: { midpoint: .5, updatedAt: START },
  }, START, 5_000).status, 'MIDPOINTS_TIED');
  assert.equal(selectMidpointSides({
    UP: { midpoint: .3, updatedAt: START - 5_001 },
    DOWN: { midpoint: .7, updatedAt: START },
  }, START, 5_000).status, 'WAITING_FOR_FRESH_MIDPOINTS');
});

test('resting limit buy fills only eligible visible asks and respects cash plus fees', () => {
  const estimateFee = (price, shares) => price * (1 - price) * shares * .001;
  const fill = simulateLimitBuy([
    { price: .24, size: 20 },
    { price: .25, size: 50 },
    { price: .26, size: 500 },
  ], .25, 100, 18, estimateFee);
  assert.ok(fill);
  assert.equal(fill.shares, 70);
  assert.equal(fill.remainingShares, 30);
  assert.equal(fill.cost, 17.3);
  assert.ok(fill.fees > 0);
  assert.equal(simulateLimitBuy([{ price: .251, size: 100 }], .25, 100, 100, estimateFee), null);
  assert.equal(simulateLimitBuy([{ price: .2, size: 100 }], .25, 100, 0, estimateFee), null);
});
