'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_SETTINGS, choosePaperSettings, simulateWindow } = require('./btc/learning-engine');
const { METHOD } = require('./btc/macd-signal');
const { pair, START } = require('./btc/window-test-fixture.cjs');

function samples(first = 'SOLID_RED', second = 'SHRINKING_RED') {
  const bars = pair(first, second).chart.bars;
  return Array.from({ length: 600 }, (_, i) => ({
    ts: START + i * 500, windowStart: START,
    pullback: { method: METHOD },
    windowDecision: i < 240 ? null : { minute1: bars[0], minute2: bars[1] },
    quotes: Object.fromEntries(['UP', 'DOWN'].map(side => [side, {
      bestAsk: .5, bestBid: .4, updatedAt: START + i * 500,
      asks: [{ price: .5, size: 5000 }], bids: [{ price: .4, size: 5000 }],
    }])),
  }));
}

test('fixed-policy replay matches all 18 timed buys and exact own-side fee-adjusted P&L', () => {
  const result = simulateWindow(samples());
  assert.equal(result.trades, 18);
  assert.ok(Math.abs(result.pnl - (-120.87)) < 1e-8);
  assert.ok(Math.abs(result.finalCash - (10000 + result.pnl)) < 1e-8);
});

test('replay skips nonqualifying pairs and never uses old reversal-policy samples', () => {
  assert.equal(simulateWindow(samples('SHRINKING_RED', 'SOLID_GREEN')).trades, 0);
  for (const method of ['macd-1m-12-26-9-reversal-sweep-v2', 'macd-1m-12-26-9-window-pair-v1']) {
    const old = samples().map(s => ({ ...s, pullback: { method } }));
    assert.equal(simulateWindow(old), null, method);
  }
});

test('replay requires a real timely closing mark; never invents data for an open lot', () => {
  assert.equal(simulateWindow(samples().slice(0, 400)), null);
});

test('regression reports fixed-policy results but never applies adaptive sizes or timing', () => {
  const result = choosePaperSettings([{ windowStart: START, samples: samples() }], { sharesPerSignal: 999 });
  assert.equal(result.applied, false);
  assert.equal(result.settings.sharesPerSignal, 50);
  assert.equal(DEFAULT_SETTINGS.openingDelaySeconds, 120);
  assert.equal(result.windows, 1);
  assert.equal(result.baseline.trades, 18);
});
