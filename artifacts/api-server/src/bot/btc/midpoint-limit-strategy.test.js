'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  TAKER_ORDER_CHECKPOINTS,
  scheduledOrderSlotAt,
  selectCheapestAskSide,
  simulateTakerBuy,
} = require('./midpoint-limit-strategy');

const START = 1_800_000_000_000;

test('taker checkpoints are 50 shares every 3 seconds through 60, then 150 every 10 through 150', () => {
  assert.equal(TAKER_ORDER_CHECKPOINTS.length, 29);
  assert.deepEqual(TAKER_ORDER_CHECKPOINTS.slice(0, 3)
    .map(({ seconds, phase, shares }) => [seconds, phase, shares]), [
    [3, 'FIRST', 50], [6, 'FIRST', 50], [9, 'FIRST', 50],
  ]);
  assert.deepEqual(TAKER_ORDER_CHECKPOINTS.slice(18, 22)
    .map(({ seconds, phase, shares }) => [seconds, phase, shares]), [
    [57, 'FIRST', 50], [60, 'FIRST', 50], [70, 'SECOND', 150], [80, 'SECOND', 150],
  ]);
  assert.deepEqual(TAKER_ORDER_CHECKPOINTS.slice(-2)
    .map(({ seconds, phase, shares }) => [seconds, phase, shares]), [
    [140, 'SECOND', 150], [150, 'SECOND', 150],
  ]);
  for (const checkpoint of TAKER_ORDER_CHECKPOINTS) {
    assert.equal(scheduledOrderSlotAt(START, START + checkpoint.seconds * 1000), checkpoint.slot);
    const next = TAKER_ORDER_CHECKPOINTS[checkpoint.slot + 1];
    if (next) assert.equal(scheduledOrderSlotAt(START, START + (next.seconds - 1) * 1000), checkpoint.slot);
  }
  assert.equal(scheduledOrderSlotAt(START, START + 2_999), -1);
  assert.equal(scheduledOrderSlotAt(START, START + 160_000), -1);
});

test('cheapest taker side uses the lower fresh ask and sensible tie breakers', () => {
  const quotes = {
    UP: { bestAsk: .31, midpoint: .30, updatedAt: START + 5_000 },
    DOWN: { bestAsk: .68, midpoint: .67, updatedAt: START + 5_000 },
  };
  assert.deepEqual(selectCheapestAskSide(quotes, START + 5_000, 5_000), {
    status: 'READY',
    cheapSide: 'UP',
    expensiveSide: 'DOWN',
    cheapestSide: 'UP',
    otherSide: 'DOWN',
    selectionReason: 'LOWER_BEST_ASK',
    asks: { UP: .31, DOWN: .68 },
    midpoints: { UP: .30, DOWN: .67 },
  });
  const midpointTieBreak = selectCheapestAskSide({
    UP: { bestAsk: .4, midpoint: .35, updatedAt: START },
    DOWN: { bestAsk: .4, midpoint: .39, updatedAt: START },
  }, START, 5_000);
  assert.equal(midpointTieBreak.cheapSide, 'UP');
  assert.equal(midpointTieBreak.selectionReason, 'LOWER_MIDPOINT_TIE_BREAK');
  const fullTie = selectCheapestAskSide({
    UP: { bestAsk: .4, midpoint: .39, updatedAt: START },
    DOWN: { bestAsk: .4, midpoint: .39, updatedAt: START },
  }, START, 5_000, 'DOWN');
  assert.equal(fullTie.cheapSide, 'DOWN');
  assert.equal(fullTie.selectionReason, 'ALTERNATING_FULL_TIE_BREAK');
  assert.equal(selectCheapestAskSide({
    UP: { bestAsk: .3, midpoint: .29, updatedAt: START - 5_001 },
    DOWN: { bestAsk: .7, midpoint: .69, updatedAt: START },
  }, START, 5_000).status, 'WAITING_FOR_FRESH_ASKS');
});

test('taker buy sweeps visible asks, charges fees, and records partial depth or cash fills', () => {
  const estimateFee = (price, shares) => price * (1 - price) * shares * .001;
  const fill = simulateTakerBuy([
    { price: .24, size: 20 },
    { price: .25, size: 50 },
    { price: .26, size: 500 },
  ], 100, 100, estimateFee);
  assert.ok(fill);
  assert.equal(fill.shares, 100);
  assert.equal(fill.remainingShares, 0);
  assert.ok(Math.abs(fill.cost - 25.1) < 1e-10);
  assert.equal(fill.fills.length, 3);
  assert.ok(fill.fees > 0);
  const partial = simulateTakerBuy([{ price: .24, size: 20 }, { price: .25, size: 40 }], 100, 100, estimateFee);
  assert.equal(partial.shares, 60);
  assert.equal(partial.remainingShares, 40);
  const cashLimited = simulateTakerBuy([{ price: .24, size: 100 }], 100, .5, estimateFee);
  assert.ok(cashLimited && cashLimited.shares < 100);
  assert.equal(simulateTakerBuy([], 100, 100, estimateFee), null);
  assert.equal(simulateTakerBuy([{ price: .2, size: 100 }], 100, 0, estimateFee), null);
});
