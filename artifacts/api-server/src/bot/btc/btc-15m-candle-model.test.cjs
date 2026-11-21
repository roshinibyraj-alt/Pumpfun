'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { analyze15mWindow } = require('./btc-15m-candle-model.cjs');
const { parseKlines } = require('./binance-multitimeframe-feed.cjs');

const FIFTEEN_MINUTES = 15 * 60_000;

function candle(start, duration, open, high, low, close) {
  return { start, end: start + duration, open, high, low, close, closed: true };
}

function flatHistory(windowStart) {
  const candles15m = [];
  for (let i = 21; i >= 1; i -= 1) {
    const start = windowStart - i * FIFTEEN_MINUTES;
    const close = i % 2 ? 100.05 : 99.95;
    candles15m.push(candle(start, FIFTEEN_MINUTES, 100, 100.1, 99.9, close));
  }
  candles15m[20] = candle(windowStart - FIFTEEN_MINUTES, FIFTEEN_MINUTES, 100, 100.1, 99.9, 100);
  return {
    '15m': candles15m,
    '1h': [candle(windowStart - 60 * 60_000, 60 * 60_000, 100, 100.1, 99.9, 100)],
    '4h': [candle(windowStart - 4 * 60 * 60_000, 4 * 60 * 60_000, 100, 100.1, 99.9, 100)],
  };
}

test('aligned closed 15m and 1h candles select UP without 4h points', () => {
  const windowStart = 21 * FIFTEEN_MINUTES;
  const candles = flatHistory(windowStart);
  candles['15m'][20] = candle(windowStart - FIFTEEN_MINUTES, FIFTEEN_MINUTES, 100, 100.2, 99.9, 100.1);
  candles['1h'][0] = candle(windowStart - 60 * 60_000, 60 * 60_000, 100, 100.3, 99.9, 100.2);
  candles['4h'][0] = candle(windowStart - 4 * 60 * 60_000, 4 * 60 * 60_000, 100, 100.4, 99.8, 100.3);

  const result = analyze15mWindow({
    candles, windowStart, feedUpdatedAt: windowStart, now: windowStart + 500,
  });

  assert.equal(result.status, 'SIGNAL');
  assert.equal(result.side, 'UP');
  assert.equal(result.score, 2);
  assert.equal(result.factors.find(factor => factor.timeframe === '4h context only').points, 0);
  assert.equal(result.slot.label, 'Quarter 2/4');
  assert.equal(result.factors.find(factor => factor.timeframe === 'Hour slot').points, 0);
});

test('an opposing 4h candle is informational and cannot change the score or direction', () => {
  const windowStart = 21 * FIFTEEN_MINUTES;
  const candles = flatHistory(windowStart);
  candles['15m'][20] = candle(windowStart - FIFTEEN_MINUTES, FIFTEEN_MINUTES, 100, 100.2, 99.9, 100.1);
  candles['1h'][0] = candle(windowStart - 60 * 60_000, 60 * 60_000, 100, 100.3, 99.9, 100.2);
  candles['4h'][0] = candle(windowStart - 4 * 60 * 60_000, 4 * 60 * 60_000, 100, 100.1, 98, 98.2);

  const result = analyze15mWindow({
    candles, windowStart, feedUpdatedAt: windowStart, now: windowStart + 500,
  });

  assert.equal(result.side, 'UP');
  assert.equal(result.score, 2);
  assert.equal(result.factors.find(factor => factor.timeframe === '4h context only').points, 0);
  assert.equal(result.factors.find(factor => factor.timeframe === '4h context only').direction, 'DOWN');
});

test('a missing 4h candle does not prevent a 15m and 1h score', () => {
  const windowStart = 21 * FIFTEEN_MINUTES;
  const candles = flatHistory(windowStart);
  candles['15m'][20] = candle(windowStart - FIFTEEN_MINUTES, FIFTEEN_MINUTES, 100, 100.2, 99.9, 100.1);
  candles['1h'][0] = candle(windowStart - 60 * 60_000, 60 * 60_000, 100, 100.3, 99.9, 100.2);
  candles['4h'] = [];

  const result = analyze15mWindow({
    candles, windowStart, feedUpdatedAt: windowStart, now: windowStart + 500,
  });

  assert.equal(result.status, 'SIGNAL');
  assert.equal(result.side, 'UP');
  assert.equal(result.score, 2);
  assert.equal(result.inputs['4h'], null);
});

test('an extended 15m candle with upper-wick rejection can produce a DOWN mean-reversion signal', () => {
  const windowStart = 21 * FIFTEEN_MINUTES;
  const candles = flatHistory(windowStart);
  candles['15m'][20] = candle(windowStart - FIFTEEN_MINUTES, FIFTEEN_MINUTES, 102, 106, 100, 101.8);

  const result = analyze15mWindow({
    candles, windowStart, feedUpdatedAt: windowStart, now: windowStart + 500,
  });

  assert.equal(result.inputs.meanReversion.side, 'DOWN');
  assert.equal(result.status, 'SIGNAL');
  assert.equal(result.side, 'DOWN');
  assert.equal(result.score, -3);
});

test('flat and conflicting evidence results in no order side', () => {
  const windowStart = 21 * FIFTEEN_MINUTES;
  const result = analyze15mWindow({
    candles: flatHistory(windowStart),
    windowStart,
    feedUpdatedAt: windowStart,
    now: windowStart + 500,
  });

  assert.equal(result.status, 'NO_SIGNAL');
  assert.equal(result.side, null);
  assert.equal(result.score, 0);
});

test('stale candle snapshots and an old last 15m close do not generate a signal', () => {
  const windowStart = 21 * FIFTEEN_MINUTES;
  const stale = analyze15mWindow({
    candles: flatHistory(windowStart),
    windowStart,
    feedUpdatedAt: windowStart - 121_000,
    now: windowStart,
  });
  assert.equal(stale.status, 'WAITING_DATA');

  const late = flatHistory(windowStart);
  late['15m'][20] = candle(windowStart - 2 * FIFTEEN_MINUTES, FIFTEEN_MINUTES, 100, 101, 99, 100.5);
  const delayed = analyze15mWindow({
    candles: late,
    windowStart,
    feedUpdatedAt: windowStart,
    now: windowStart,
  });
  assert.equal(delayed.status, 'WAITING_DATA');
});

test('future candles are excluded from the model inputs', () => {
  const windowStart = 21 * FIFTEEN_MINUTES;
  const candles = flatHistory(windowStart);
  candles['15m'].push(candle(windowStart, FIFTEEN_MINUTES, 100, 105, 99, 104));

  const result = analyze15mWindow({
    candles, windowStart, feedUpdatedAt: windowStart, now: windowStart,
  });

  assert.equal(result.inputs['15m'].end, windowStart);
});

test('hour slot is rendered in Brisbane local time as well as UTC', () => {
  const windowStart = Date.parse('2026-11-20T23:00:00.000Z');
  const result = analyze15mWindow({
    candles: flatHistory(windowStart),
    windowStart,
    feedUpdatedAt: windowStart,
    now: windowStart + 500,
  });
  assert.equal(result.slot.rangeBrisbane, '09:00–09:15 Brisbane');
});

test('Binance kline parser marks only fully closed valid candles', () => {
  const rows = [
    [0, '100', '102', '99', '101', '5', 899_999],
    [900_000, '101', '103', '100', '102', '6', 1_799_999],
    [1_800_000, '102', '103', '101', '102', '4', 2_699_999],
    [2_700_000, 'bad', '103', '101', '102', '4', 3_599_999],
  ];
  const parsed = parseKlines(rows, FIFTEEN_MINUTES, 2_700_000);

  assert.equal(parsed.length, 3);
  assert.deepEqual(parsed.map(item => item.closed), [true, true, true]);
  assert.ok(Math.abs(parsed[0].returnPct - 1) < 1e-9);
});
