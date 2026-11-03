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
    setup: 'FALLBACK_SCORE',
    confirmed: false,
    regime: 'MIXED',
    score: side === 'UP' ? 1 : -1,
    signalAt: START,
    reason: `Fallback selected ${side}.`,
  };
  return Array.from({ length: 600 }, (_, i) => ({
    ts: START + i * 500,
    windowStart: START,
    technicalSignal,
    pullback: { method: METHOD, side, signalSide: side, setup: 'FALLBACK_SCORE', timeframe: '5m' },
    rsi: { method: 'wilder-rsi-14-closed-5m-v1', status: 'READY', value: 50 },
    quotes: Object.fromEntries(['UP', 'DOWN'].map(tokenSide => [tokenSide, {
      bestAsk: .5,
      bestBid: .4,
      updatedAt: START + i * 500,
      asks: [{ price: .5, size: 5000 }],
      bids: [{ price: .4, size: 5000 }],
    }])),
  }));
}

test('hybrid-policy replay matches all 29 timed buys and own-side fee-adjusted P&L', () => {
  const result = simulateWindow(samples());
  assert.equal(result.trades, 29);
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
  assert.equal(result.settings.sharesPerSignal, 50);
  assert.equal(DEFAULT_SETTINGS.openingDelaySeconds, 10);
  assert.equal(result.windows, 1);
  assert.equal(result.baseline.trades, 29);
});

