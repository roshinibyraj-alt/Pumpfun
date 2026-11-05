'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ENTRY_TRIGGER_SECONDS,
  ENTRY_TRIGGER_PRICE,
  LIMIT_ORDER_LADDER,
  selectTriggeredSide,
  filterAskLevelsForLimit,
  simulateLimitBuyFill,
} = require('./midpoint-limit-strategy');

const START = 1_800_000_000_000;
const fee = (price, shares) => price * (1 - price) * shares * 0.001;

test('new strategy waits 120 seconds and places the fixed two-rung limit ladder', () => {
  assert.equal(ENTRY_TRIGGER_SECONDS, 120);
  assert.equal(ENTRY_TRIGGER_PRICE, 0.80);
  assert.deepEqual(LIMIT_ORDER_LADDER.map(({ price, shares }) => [price, shares]), [
    [0.40, 1000],
    [0.60, 2000],
  ]);
});

test('trigger picks the highest fresh qualifying midpoint and uses UP for a tie', () => {
  const selection = selectTriggeredSide({
    UP: { midpoint: 0.80, updatedAt: START },
    DOWN: { midpoint: 0.83, updatedAt: START },
  }, START, 5000);
  assert.equal(selection.status, 'READY');
  assert.equal(selection.selectedSide, 'DOWN');
  assert.equal(selection.triggeringPrice, 0.83);

  const tie = selectTriggeredSide({
    UP: { midpoint: 0.82, updatedAt: START },
    DOWN: { midpoint: 0.82, updatedAt: START },
  }, START, 5000);
  assert.equal(tie.selectedSide, 'UP');
});

test('stale or sub-threshold midpoint cannot trigger, while one fresh side is sufficient', () => {
  assert.equal(selectTriggeredSide({
    UP: { midpoint: 0.90, updatedAt: START - 5001 },
    DOWN: { midpoint: 0.30, updatedAt: START },
  }, START, 5000).status, 'WAITING_FOR_TRIGGER');
  const oneSide = selectTriggeredSide({
    UP: { midpoint: 0.81, updatedAt: START },
    DOWN: null,
  }, START, 5000);
  assert.equal(oneSide.selectedSide, 'UP');
});

test('limit fill filters out asks above the order price and preserves partial remainder', () => {
  const asks = [
    { price: 0.60, size: 20 },
    { price: 0.40, size: 30 },
    { price: 0.4001, size: 50 },
  ];
  assert.deepEqual(filterAskLevelsForLimit(asks, 0.40), [
    { price: 0.40, size: 30 },
  ]);

  const partial = simulateLimitBuyFill(asks, 0.40, 100, fee);
  assert.equal(partial.shares, 30);
  assert.equal(partial.remainingShares, 70);
  assert.equal(partial.averagePrice, 0.40);
  assert.ok(partial.fees > 0);
  assert.equal(simulateLimitBuyFill(asks, 0.39, 100, fee), null);
});

test('limit matcher applies price improvement across eligible visible ask levels', () => {
  const fill = simulateLimitBuyFill([
    { price: 0.55, size: 500 },
    { price: 0.60, size: 1500 },
    { price: 0.6001, size: 3000 },
  ], 0.60, 2000, fee);
  assert.equal(fill.shares, 2000);
  assert.equal(fill.remainingShares, 0);
  assert.equal(fill.averagePrice, 0.5875);
  assert.equal(fill.fills.length, 2);
  assert.ok(fill.fees > 0);
});
