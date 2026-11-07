'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  STRATEGY_VERSION,
  SIGNAL_COMPARE_LEAD_MS,
  ENTRY_SHARES,
  TAKE_PROFIT_LIMIT_PRICE,
  getWindowToScan,
  selectClosedCandleSignal,
  simulateTakerBuyFill,
  estimateTakerFee,
} = require('./signal-taker-strategy');

const START = 1_800_000_000_000;

test('strategy is BTC five-minute only with a pre-open closed-candle comparison', () => {
  assert.equal(STRATEGY_VERSION, 'btc-5m-candle-signal-taker-v1');
  assert.equal(SIGNAL_COMPARE_LEAD_MS, 3_000);
  assert.equal(ENTRY_SHARES, 500);
  assert.equal(TAKE_PROFIT_LIMIT_PRICE, 0.99);
  assert.equal(getWindowToScan(START - 10_000), START);
  assert.equal(getWindowToScan(START - 10_001), START - 300_000);
});

test('uses only the last fully closed one-minute candle and selects UP above its close', () => {
  const signalAt = START - 3_000;
  const signal = selectClosedCandleSignal({
    candles: [
      { t: START - 120_000, c: 100 },
      { t: START - 60_000, c: 105 }, // Still open at signalAt.
    ],
    ticks: [{ ts: signalAt + 500, price: 101 }],
    signalAt,
    now: signalAt + 500,
  });
  assert.equal(signal.status, 'SIGNAL_LATCHED');
  assert.equal(signal.selectedSide, 'UP');
  assert.equal(signal.referenceClose, 100);
  assert.equal(signal.signalPrice, 101);
  assert.equal(signal.rule, 'BTC_ABOVE_PREVIOUS_1M_CLOSE');
});

test('equal or lower BTC price selects DOWN; a stale candle or missing tick cannot signal', () => {
  const signalAt = START - 3_000;
  const candles = [{ t: START - 120_000, c: 100 }];
  for (const price of [100, 99]) {
    const signal = selectClosedCandleSignal({
      candles, ticks: [{ ts: signalAt + 200, price }], signalAt, now: signalAt + 200,
    });
    assert.equal(signal.selectedSide, 'DOWN');
  }
  assert.equal(selectClosedCandleSignal({
    candles: [{ t: START - 240_000, c: 100 }],
    ticks: [{ ts: signalAt + 200, price: 101 }],
    signalAt,
    now: signalAt + 200,
  }).status, 'STALE_CLOSED_CANDLE');
  assert.equal(selectClosedCandleSignal({
    candles, ticks: [], signalAt, now: signalAt + 200,
  }).status, 'WAITING_FOR_SIGNAL_PRICE');
});

test('taker simulation sweeps asks in price order, books visible quantity, and applies fees', () => {
  const market = { raw: { feesEnabled: true, feeSchedule: { rate: 0.07, exponent: 1 } } };
  const fill = simulateTakerBuyFill([
    { price: 0.55, size: 400 },
    { price: 0.45, size: 200 },
  ], 500, market);
  assert.equal(fill.shares, 500);
  assert.equal(fill.remainingShares, 0);
  assert.equal(fill.cost, 255);
  assert.equal(fill.averagePrice, 0.51);
  assert.ok(Math.abs(fill.fees - 8.6625) < 1e-12);
  assert.ok(Math.abs(fill.totalCost - 263.6625) < 1e-12);
  assert.equal(fill.fills.length, 2);
});

test('taker simulation never invents shares when the next-tick book is shallow', () => {
  const fill = simulateTakerBuyFill([{ price: 0.4, size: 1 }], 500);
  assert.equal(fill.shares, 1);
  assert.equal(fill.remainingShares, 499);
  assert.equal(fill.averagePrice, 0.4);
});

test('market fee schedule can disable fees and default fee formula remains available', () => {
  assert.equal(estimateTakerFee(0.5, 10, { raw: { feesEnabled: false } }), 0);
  assert.ok(Math.abs(estimateTakerFee(0.5, 10) - 0.175) < 1e-12);
});
