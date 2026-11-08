'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  appendRenkoClose,
  buildRenko,
  calculateAtrBrickSize,
  combineClosedMinuteCandles,
  simulateTakerSellFill,
} = require('./renko-strategy');

const MINUTE = 60_000;

function candle(t, open, high, low, close) {
  return { t, o: open, h: high, l: low, c: close };
}

test('only closed one-minute candles are combined, with live candles taking precedence', () => {
  const now = 20 * MINUTE;
  const merged = combineClosedMinuteCandles({
    now,
    historical: [candle(18 * MINUTE, 100, 103, 99, 102)],
    live: [
      candle(18 * MINUTE, 100, 104, 99, 103),
      candle(19 * MINUTE, 103, 105, 102, 104),
    ],
  });
  assert.equal(merged.length, 2);
  assert.equal(merged[0].close, 103);
  assert.equal(merged[1].close, 104);
});

test('ATR brick size uses the preceding 14 true ranges and requires enough closed history', () => {
  const short = Array.from({ length: 14 }, (_, index) =>
    candle(index * MINUTE, 100, 102, 99, 101));
  assert.equal(calculateAtrBrickSize(short).status, 'WAITING_FOR_ATR_HISTORY');

  const full = Array.from({ length: 15 }, (_, index) =>
    candle(index * MINUTE, 100, 102, 99, 101));
  const atr = calculateAtrBrickSize(full);
  assert.equal(atr.status, 'READY');
  assert.equal(atr.period, 14);
  assert.equal(atr.brickSize, 3);
});

test('Renko prints green bricks, stays flat inside a box, and reverses after two boxes', () => {
  const { state, bricks } = buildRenko([
    candle(0, 100, 100, 100, 100),
    candle(MINUTE, 100, 101, 100, 101),
    candle(2 * MINUTE, 101, 101.5, 100.5, 100.8),
  ], 1);
  assert.equal(bricks.length, 1);
  assert.equal(bricks[0].color, 'GREEN');
  assert.equal(state.lastBrickClose, 101);

  const reversed = appendRenkoClose(state, candle(3 * MINUTE, 100, 100, 99, 99));
  assert.deepEqual(reversed.bricks.map(brick => brick.color), ['RED', 'RED']);
  assert.equal(state.direction, 'RED');
  assert.equal(state.lastBrickClose, 99);
});

test('sell sweep uses visible bid depth, weighted average, and configured taker fees', () => {
  const fill = simulateTakerSellFill([
    { price: 0.4, size: 3 },
    { price: 0.5, size: 2 },
  ], 6, { feesEnabled: true, feeSchedule: { rate: 0.07, exponent: 1 } });
  assert.equal(fill.shares, 5);
  assert.equal(fill.remainingShares, 1);
  assert.ok(Math.abs(fill.averagePrice - 0.44) < 1e-12);
  assert.ok(Math.abs(fill.grossPayout - 2.2) < 1e-12);
  assert.ok(Math.abs(fill.fees - 0.0854) < 1e-12);
  assert.equal(simulateTakerSellFill([], 5), null);
});
