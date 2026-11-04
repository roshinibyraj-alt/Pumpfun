'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_SETTINGS, choosePaperSettings, simulateWindow } = require('./btc/learning-engine');
const { METHOD } = require('./btc/technical-signal');
const { START } = require('./btc/window-test-fixture.cjs');

function samples(side = 'UP') {
  const technicalSignal = {
    method: METHOD,
    timeframe: '5m',
    status: 'READY',
    side,
    setup: side === 'UP' ? 'PREVIOUS_GREEN' : 'PREVIOUS_RED',
    confirmed: true,
    signalAt: START,
    reason: `${side} selected by the previous closed candle.`,
  };
  return Array.from({ length: 600 }, (_, i) => ({
    ts: START + i * 500,
    windowStart: START,
    technicalSignal,
    pullback: { method: METHOD, side, signalSide: side, setup: technicalSignal.setup, timeframe: '5m' },
    quotes: Object.fromEntries(['UP', 'DOWN'].map(tokenSide => [tokenSide, {
      bestAsk: .5,
      bestBid: .4,
      updatedAt: START + i * 500,
      asks: [{ price: .5, size: 5000 }],
      bids: [{ price: .4, size: 5000 }],
    }])),
  }));
}

test('closed-candle-policy replay uses four price checkpoints and own-side fee-adjusted P&L', () => {
  const result = simulateWindow(samples());
  assert.equal(result.trades, 3);
  assert.ok(Number.isFinite(result.pnl));
  assert.ok(Math.abs(result.finalCash - (10000 + result.pnl)) < 1e-8);
});

test('replay ignores samples without the current technical-signal method', () => {
  const legacy = samples().map(sample => ({
    ...sample,
    technicalSignal: { ...sample.technicalSignal, method: 'old-rsi-policy' },
  }));
  assert.equal(simulateWindow(legacy), null);
});

test('replay requires a real timely closing mark; never invents data for an open lot', () => {
  assert.equal(simulateWindow(samples().slice(0, 400)), null);
});

test('regression uses logged technical decisions but never changes fixed execution settings', () => {
  const result = choosePaperSettings([{ windowStart: START, samples: samples() }], { sharesPerSignal: 999 });
  assert.equal(result.applied, false);
  assert.equal(result.settings.sharesPerSignal, 500);
  assert.equal(DEFAULT_SETTINGS.openingDelaySeconds, 1);
  assert.equal(result.windows, 1);
  assert.equal(result.baseline.trades, 3);
});

