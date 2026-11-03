'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CANDLE_MS, RSI_PERIOD, OVERBOUGHT, OVERSOLD, detectRsiSignal,
} = require('./rsi-signal');

const END = 1_800_000_000_000;

function candles(closes, end = END) {
  const firstStart = end - closes.length * CANDLE_MS;
  return closes.map((close, index) => ({
    start: firstStart + index * CANDLE_MS,
    end: firstStart + (index + 1) * CANDLE_MS,
    close,
  }));
}

test('Wilder RSI(14) selects UP below 30 and DOWN above 70', () => {
  const rising = detectRsiSignal(candles(Array.from({ length: 20 }, (_, i) => 100 + i)), END + 100);
  assert.equal(rising.status, 'READY');
  assert.equal(rising.value, 100);
  assert.equal(rising.bucket, 'OVERBOUGHT');
  assert.equal(rising.side, 'DOWN');
  assert.equal(rising.signalAt, END);

  const falling = detectRsiSignal(candles(Array.from({ length: 20 }, (_, i) => 200 - i)), END + 100);
  assert.equal(falling.value, 0);
  assert.equal(falling.bucket, 'OVERSOLD');
  assert.equal(falling.side, 'UP');
});

test('neutral RSI does not select a new side and reports the middle band', () => {
  const signal = detectRsiSignal(candles(Array(20).fill(100)), END + 100);
  assert.equal(signal.status, 'READY');
  assert.equal(signal.value, 50);
  assert.equal(signal.bucket, 'NEUTRAL');
  assert.equal(signal.side, null);
  assert.equal(signal.overbought, OVERBOUGHT);
  assert.equal(signal.oversold, OVERSOLD);
  assert.equal(signal.period, RSI_PERIOD);
  assert.equal(signal.lastExtreme, null);
});

test('neutral RSI exposes the latest extreme from the 50-reading chart history', () => {
  const closes = [
    ...Array.from({ length: 21 }, (_, i) => 100 + i),
    ...Array.from({ length: 7 }, (_, i) => 119 - i),
    ...Array(20).fill(113),
  ];
  const signal = detectRsiSignal(candles(closes), END + 100);
  assert.equal(signal.status, 'READY');
  assert.equal(signal.bucket, 'NEUTRAL');
  assert.equal(signal.side, null);
  assert.equal(signal.lastExtreme?.side, 'DOWN');
  assert.equal(signal.lastExtreme?.bucket, 'OVERBOUGHT');
  assert.ok(signal.history.length <= 50);
  assert.equal(signal.history.at(-1).value, signal.value);
});

test('unfinished or stale candles never drive the RSI signal', () => {
  const history = candles(Array.from({ length: 30 }, (_, i) => 100 + i));
  const unfinished = [...history, {
    start: END, end: END + CANDLE_MS, close: 999,
  }];
  assert.equal(detectRsiSignal(unfinished, END + 100).signalAt, END);
  assert.equal(detectRsiSignal(history.slice(0, -1), END + 100).status, 'STALE');
  assert.equal(detectRsiSignal(history, Number.NaN).status, 'INVALID_HISTORY');
});

test('RSI waits for 15 contiguous closed bars after a data gap', () => {
  const history = candles(Array.from({ length: 30 }, (_, i) => 100 + i));
  assert.equal(detectRsiSignal(history.slice(-14), END + 100).status, 'WAITING_HISTORY');
  const withGap = history.filter((_, index) => index !== 5);
  assert.equal(detectRsiSignal(withGap, END + 100).status, 'READY');

  const shortRecentRun = history.filter((_, index) => index < 20 || index >= 26);
  const signal = detectRsiSignal(shortRecentRun, END + 100);
  assert.equal(signal.status, 'WAITING_HISTORY');
  assert.match(signal.reason, /contiguous closed candles/);
});
