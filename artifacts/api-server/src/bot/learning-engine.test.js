'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_SETTINGS, choosePaperSettings, simulateWindow } = require('./btc/learning-engine');
const { METHOD } = require('./btc/macd-signal');
const { closedCandleSignal, START } = require('./btc/window-test-fixture.cjs');

function samples(classification = 'SHRINKING_RED') {
  const previousCandle = closedCandleSignal(classification).chart.bars[0];
  return Array.from({ length: 600 }, (_, i) => ({
    ts: START + i * 500, windowStart: START,
    pullback: { method: METHOD },
    windowDecision: i < 2 ? null : {
      status: previousCandle.side ? 'LOCKED' : 'SKIP_WINDOW',
      side: previousCandle.side,
      previousCandle,
    },
    quotes: Object.fromEntries(['UP', 'DOWN'].map(side => [side, {
      bestAsk: .5, bestBid: .4, updatedAt: START + i * 500,
      asks: [{ price: .5, size: 5000 }], bids: [{ price: .4, size: 5000 }],
    }])),
  }));
}

test('fixed-policy replay matches all 29 timed buys and exact own-side fee-adjusted P&L', () => {
  const result = simulateWindow(samples());
  assert.equal(result.trades, 29);
  assert.ok(Math.abs(result.pnl - (-194.735)) < 1e-8);
  assert.ok(Math.abs(result.finalCash - (10000 + result.pnl)) < 1e-8);
});

test('replay skips a neutral previous candle and never uses old policy samples', () => {
  assert.equal(simulateWindow(samples('NEUTRAL')).trades, 0);
  for (const method of [
    'macd-1m-12-26-9-reversal-sweep-v2',
    'macd-1m-12-26-9-window-pair-v1',
    'macd-1m-12-26-9-window-pair-v2',
    'macd-1m-12-26-9-window-pair-v3',
  ]) {
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
  assert.equal(DEFAULT_SETTINGS.openingDelaySeconds, 10);
  assert.equal(result.windows, 1);
  assert.equal(result.baseline.trades, 29);
});
