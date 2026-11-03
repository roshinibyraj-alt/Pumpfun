'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyHistogram, detectMacdHistogram, windowSignal, ema } = require('./macd-signal');
const { CANDLE_MS, closedCandleSignal, START } = require('./window-test-fixture.cjs');

test('histogram classifications use sign and comparison with the previous bar', () => {
  for (const [value, previous, classification, side] of [
    [-1, -2, 'SHRINKING_RED', 'UP'], [2, 1, 'SOLID_GREEN', 'UP'],
    [1, 2, 'SHRINKING_GREEN', 'DOWN'], [-2, -1, 'SOLID_RED', 'DOWN'],
    [0, -1, 'NEUTRAL', null], [1, 1, 'NEUTRAL', null],
  ]) assert.deepEqual(classifyHistogram(value, previous), { classification, side });
});

test('MACD EMA seeds and analytic linear-series values remain standard 12/26/9', () => {
  assert.deepEqual(ema([1, 2, 3, 4], 3), [null, null, 2, 3]);
  const candles = Array.from({ length: 80 }, (_, i) => ({
    start: i * CANDLE_MS, end: (i + 1) * CANDLE_MS, close: 100 + i,
  }));
  const signal = detectMacdHistogram(candles, 80 * CANDLE_MS);
  assert.equal(signal.status, 'READY');
  assert.equal(signal.timeframe, '5m');
  assert.equal(signal.signalAt, 80 * CANDLE_MS);
  assert.ok(Math.abs(signal.chart.bars.at(-1).macd - 7) < 1e-8);
  assert.ok(Math.abs(signal.latestHistogram) < 1e-8);
  assert.equal(
    detectMacdHistogram(candles, 80 * CANDLE_MS + CANDLE_MS - 1).status,
    'READY',
    'a closed five-minute candle remains valid until its window ends',
  );
  assert.equal(detectMacdHistogram(candles, 83 * CANDLE_MS).status, 'STALE');
  assert.equal(detectMacdHistogram(candles.slice(0, 20), 80 * CANDLE_MS).status, 'WAITING_HISTORY');
  assert.equal(detectMacdHistogram(candles.filter((_, i) => i !== 50), 80 * CANDLE_MS).status, 'INVALID_HISTORY');
  assert.equal(detectMacdHistogram([...candles, {
    start: 80 * CANDLE_MS, end: 81 * CANDLE_MS, close: 10000,
  }], 80 * CANDLE_MS).latestHistogram, signal.latestHistogram);
});

test('one prior closed 5-minute candle selects direction from its classification', () => {
  for (const [classification, expected] of [
    ['SOLID_RED', 'DOWN'], ['SHRINKING_RED', 'UP'],
    ['SOLID_GREEN', 'UP'], ['SHRINKING_GREEN', 'DOWN'],
  ]) {
    const result = windowSignal(closedCandleSignal(classification), START, START);
    assert.equal(result.side, expected, classification);
    assert.equal(result.status, 'LOCKED');
    assert.equal(result.previousCandle.end, START);
  }
  const neutral = windowSignal(closedCandleSignal('NEUTRAL'), START, START);
  assert.equal(neutral.side, null);
  assert.equal(neutral.status, 'SKIP_WINDOW');
});

test('unfinished, stale, missing and non-immediately-prior candles cannot choose a side', () => {
  const signal = closedCandleSignal();
  assert.equal(windowSignal(signal, START, START - 1).status, 'WAITING_HISTORY');
  assert.equal(windowSignal({ ...signal, status: 'STALE' }, START, START).status, 'WAITING_HISTORY');
  assert.equal(windowSignal({ ...signal, timeframe: '1m' }, START, START).status, 'WAITING_HISTORY');
  assert.equal(windowSignal({
    ...signal, method: 'macd-1m-12-26-9-window-pair-v3',
  }, START, START).status, 'WAITING_HISTORY');
  assert.equal(windowSignal(signal, START + CANDLE_MS, START + CANDLE_MS).side, null);
  const missing = { ...signal, chart: { bars: [] } };
  assert.equal(windowSignal(missing, START, START).status, 'WAITING_HISTORY');
  const older = closedCandleSignal('SOLID_GREEN', START - CANDLE_MS);
  assert.equal(windowSignal(older, START, START).status, 'WAITING_HISTORY');
});
