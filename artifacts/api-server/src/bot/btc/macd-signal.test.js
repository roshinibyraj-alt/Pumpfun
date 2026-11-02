'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyHistogram, detectMacdHistogram, windowSignal, ema } = require('./macd-signal');
const { pair, START } = require('./window-test-fixture.cjs');

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
    start: i * 60000, end: (i + 1) * 60000, close: 100 + i,
  }));
  const signal = detectMacdHistogram(candles, 80 * 60000);
  assert.equal(signal.status, 'READY');
  assert.ok(Math.abs(signal.chart.bars.at(-1).macd - 7) < 1e-8);
  assert.ok(Math.abs(signal.latestHistogram) < 1e-8);
  assert.equal(detectMacdHistogram(candles, 83 * 60000).status, 'STALE');
  assert.equal(detectMacdHistogram(candles.slice(0, 20), 80 * 60000).status, 'WAITING_HISTORY');
  assert.equal(detectMacdHistogram(candles.filter((_, i) => i !== 50), 80 * 60000).status, 'INVALID_HISTORY');
  assert.equal(detectMacdHistogram([...candles, { start: 80 * 60000, end: 81 * 60000, close: 10000 }], 80 * 60000).latestHistogram, signal.latestHistogram);
});

test('all 25 classification pairs enforce only the four requested transitions', () => {
  const states = ['SOLID_RED', 'SHRINKING_RED', 'SOLID_GREEN', 'SHRINKING_GREEN', 'NEUTRAL'];
  for (const first of states) for (const second of states) {
    const expected = first === 'SOLID_RED' && ['SHRINKING_RED', 'SOLID_GREEN', 'SOLID_RED'].includes(second)
      ? second === 'SOLID_RED' ? 'DOWN' : 'UP'
      : first === 'SOLID_GREEN' && ['SHRINKING_GREEN', 'SOLID_RED', 'SOLID_GREEN'].includes(second)
        ? second === 'SOLID_GREEN' ? 'UP' : 'DOWN' : null;
    const result = windowSignal(pair(first, second), START, START + 120000);
    assert.equal(result.side, expected, first + ' -> ' + second);
    assert.equal(result.status, expected ? 'LOCKED' : 'SKIP_WINDOW');
  }
});

test('both solid same-color opening pairs choose the newly requested direction', () => {
  assert.equal(windowSignal(pair('SOLID_GREEN', 'SOLID_GREEN'), START, START + 120000).side, 'UP');
  assert.equal(windowSignal(pair('SOLID_RED', 'SOLID_RED'), START, START + 120000).side, 'DOWN');
});

test('forming, stale, missing and wrong-window candles cannot choose a side', () => {
  assert.equal(windowSignal(pair(), START, START + 119999).side, null);
  assert.equal(windowSignal({ ...pair(), status: 'STALE' }, START, START + 120000).side, null);
  assert.equal(windowSignal(pair(), START + 300000, START + 420000).side, null);
  const missing = pair();
  missing.chart.bars.pop();
  assert.equal(windowSignal(missing, START, START + 120000).status, 'WAITING_HISTORY');
  const observing = windowSignal(pair(), START, START + 60000);
  assert.equal(observing.minute1.classification, 'SOLID_RED');
  assert.equal(observing.side, null);
});
