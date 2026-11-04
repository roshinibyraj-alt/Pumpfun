'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { detectTechnicalSignal, METHOD } = require('./technical-signal');

const FIVE_MINUTES = 5 * 60_000;
const NOW = Math.floor(1_700_000_000_000 / FIVE_MINUTES) * FIVE_MINUTES;

function candle(color, end, { open, close, high, low } = {}) {
  if (color === 'GREEN') {
    open ??= 100;
    close ??= 101;
    high ??= 102;
    low ??= 99;
  } else if (color === 'RED') {
    open ??= 101;
    close ??= 100;
    high ??= 102;
    low ??= 99;
  } else {
    open ??= 100;
    close ??= 100.05;
    high ??= 101;
    low ??= 99;
  }
  return { start: end - FIVE_MINUTES, end, open, high, low, close };
}

function candles(colors, finalEnd = NOW) {
  return colors.map((color, index) =>
    candle(color, finalEnd - (colors.length - index - 1) * FIVE_MINUTES));
}

function detect(candles5m, extra = {}) {
  return detectTechnicalSignal({
    candles5m,
    now: NOW + 1_000,
    ...extra,
  });
}

test('latest closed green and red candles directly select their matching sides', () => {
  const green = detect(candles(['GREEN']));
  assert.equal(green.status, 'READY');
  assert.equal(green.side, 'UP');
  assert.equal(green.setup, 'PREVIOUS_GREEN');
  assert.match(green.reason, /green/);

  const red = detect(candles(['RED']));
  assert.equal(red.status, 'READY');
  assert.equal(red.side, 'DOWN');
  assert.equal(red.setup, 'PREVIOUS_RED');
  assert.match(red.reason, /red/);
});

test('doji after two or more consecutive green candles selects DOWN', () => {
  const signal = detect(candles(['GREEN', 'GREEN', 'GREEN', 'DOJI']));
  assert.equal(signal.status, 'READY');
  assert.equal(signal.side, 'DOWN');
  assert.equal(signal.setup, 'DOJI_AFTER_GREEN_RUN');
  assert.equal(signal.candle.color, 'DOJI');
  assert.equal(signal.candle.priorColor, 'GREEN');
  assert.equal(signal.candle.consecutivePriorCandles, 3);
});

test('doji after two or more consecutive red candles selects UP', () => {
  const signal = detect(candles(['RED', 'RED', 'DOJI']));
  assert.equal(signal.status, 'READY');
  assert.equal(signal.side, 'UP');
  assert.equal(signal.setup, 'DOJI_AFTER_RED_RUN');
  assert.equal(signal.candle.consecutivePriorCandles, 2);
});

test('doji without a two-candle same-color run produces no new side', () => {
  for (const history of [
    ['GREEN', 'DOJI'],
    ['RED', 'GREEN', 'DOJI'],
    ['DOJI'],
  ]) {
    const signal = detect(candles(history));
    assert.equal(signal.status, 'NO_SIGNAL');
    assert.equal(signal.side, null);
    assert.equal(signal.setup, 'DOJI_NO_DIRECTION');
  }
});

test('a candle-color change breaks the doji streak', () => {
  const signal = detect(candles(['GREEN', 'GREEN', 'RED', 'DOJI']));
  assert.equal(signal.status, 'NO_SIGNAL');
  assert.equal(signal.side, null);
  assert.equal(signal.candle.priorColor, 'RED');
  assert.equal(signal.candle.consecutivePriorCandles, 1);
});

test('a 10% body-to-range candle uses the existing doji classification', () => {
  const series = [
    candle('GREEN', NOW - 2 * FIVE_MINUTES),
    candle('GREEN', NOW - FIVE_MINUTES),
    candle('GREEN', NOW, { open: 100, close: 101, high: 105, low: 95 }),
  ];
  const signal = detect(series);
  assert.equal(signal.candle.color, 'DOJI');
  assert.equal(signal.side, 'DOWN');
});

test('only the latest closed 5m candle is used; other timeframes and prior side are ignored', () => {
  const closedRed = candle('RED', NOW);
  const inProgressGreen = {
    ...candle('GREEN', NOW + FIVE_MINUTES),
    start: NOW,
  };
  const signal = detect([closedRed, inProgressGreen], {
    candles15m: candles(['GREEN']),
    candles1m: candles(['GREEN']),
    previousSide: 'UP',
  });
  assert.equal(signal.side, 'DOWN');
  assert.equal(signal.signalAt, NOW);
  assert.equal(signal.method, METHOD);
  assert.equal(Object.hasOwn(signal, 'indicators'), false);
  assert.equal(Object.hasOwn(signal, 'regime'), false);
});

test('a missing or stale latest 5m close blocks signal selection', () => {
  const signal = detect(candles(['GREEN'], NOW - FIVE_MINUTES));
  assert.equal(signal.status, 'STALE');
  assert.equal(signal.side, null);
});

test('a non-finite clock produces an explicit invalid-history state', () => {
  const signal = detectTechnicalSignal({ candles5m: candles(['GREEN']), now: NaN });
  assert.equal(signal.status, 'INVALID_HISTORY');
  assert.equal(signal.side, null);
});
