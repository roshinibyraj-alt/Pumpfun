'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ENTRY_ORDER_LADDER,
  ENTRY_SHARES,
  POLL_INTERVAL_MS,
  feeParameters,
  simulateLimitBuyFill,
  simulateTakerBuyFill,
} = require('./paper-trading');

test('paper trading uses the configured entry size and polling interval', () => {
  assert.equal(ENTRY_SHARES, 300);
  assert.deepEqual(ENTRY_ORDER_LADDER, [
    { limitPrice: 0.40, shares: 200 },
    { limitPrice: 0.30, shares: 100 },
  ]);
  assert.equal(POLL_INTERVAL_MS, 500);
});

test('taker buy fill sweeps only visible asks and applies the market fee schedule', () => {
  const market = { feesEnabled: true, feeSchedule: { rate: 0.07, exponent: 1 } };
  const fill = simulateTakerBuyFill([
    { price: 0.55, size: 5 },
    { price: 0.45, size: 20 },
  ], 30, market);
  assert.equal(fill.shares, 25);
  assert.equal(fill.remainingShares, 5);
  assert.equal(fill.averagePrice, 0.47);
  assert.equal(fill.cost, 11.75);
  assert.ok(Math.abs(fill.fees - 0.433125) < 1e-12);
  assert.equal(feeParameters({ feesEnabled: false }).rate, 0);
});

test('limit buy fills only visible ask liquidity at or below the limit', () => {
  const fill = simulateLimitBuyFill([
    { price: 0.41, size: 100 },
    { price: 0.39, size: 60 },
  ], 0.40, 200, { feesEnabled: true, feeSchedule: { rate: 0.07, exponent: 1 } }, {
    executionRole: 'TAKER',
  });
  assert.equal(fill.shares, 60);
  assert.equal(fill.remainingShares, 140);
  assert.equal(fill.averagePrice, 0.39);
  assert.ok(fill.fees > 0);
});

test('resting limit buy fills at its limit without taker fees', () => {
  const fill = simulateLimitBuyFill([
    { price: 0.30, size: 80 },
    { price: 0.31, size: 100 },
  ], 0.40, 200, { feesEnabled: true, feeSchedule: { rate: 0.07, exponent: 1 } }, {
    executionRole: 'MAKER',
    availableByPrice: new Map([[0.30, 40], [0.31, 60]]),
  });
  assert.equal(fill.shares, 100);
  assert.equal(fill.remainingShares, 100);
  assert.equal(fill.averagePrice, 0.40);
  assert.equal(fill.fees, 0);
});
