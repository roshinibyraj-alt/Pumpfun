'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ENTRY_SHARES,
  POLL_INTERVAL_MS,
  VARIANT_PROFIT_TARGET,
  feeParameters,
  simulateTakerBuyFill,
} = require('./paper-trading');

test('paper trading retains the independent account size and target settings', () => {
  assert.equal(ENTRY_SHARES, 100);
  assert.equal(VARIANT_PROFIT_TARGET, 300);
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
