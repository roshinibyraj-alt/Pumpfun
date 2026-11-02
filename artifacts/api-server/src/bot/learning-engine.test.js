'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { detectPullback } = require('./btc/pullback-signal');
const {
  DEFAULT_SETTINGS,
  MIN_CLOSED_WINDOWS,
  choosePaperSettings,
} = require('./btc/learning-engine');

function candlesFromCloses(closes, now = closes.length * 300_000) {
  return closes.map((close, index) => ({
    start: index * 300_000,
    end: (index + 1) * 300_000,
    open: index ? closes[index - 1] : close,
    high: Math.max(index ? closes[index - 1] : close, close) + 2,
    low: Math.min(index ? closes[index - 1] : close, close) - 2,
    close,
  })).filter(candle => candle.end <= now);
}

test('detects a confirmed retracement from the rolling 15 closed candles after a rise', () => {
  const closes = Array.from({ length: 12 }, (_, index) => 100_000 + index * 6)
    .concat([100_060, 100_050, 100_040]);
  const pullback = detectPullback(candlesFromCloses(closes), 15 * 300_000, 0.0001);
  assert.equal(pullback.side, 'DOWN');
  assert.equal(pullback.regime, 'PULLBACK_AFTER_RISE');
  assert.ok(pullback.retracementRatio >= 0.35);
  assert.equal(pullback.lookbackCandles, 15);
});

test('detects an upward pullback after a decline in the rolling candle window', () => {
  const closes = Array.from({ length: 12 }, (_, index) => 100_000 - index * 6)
    .concat([99_950, 99_960, 99_970]);
  const pullback = detectPullback(candlesFromCloses(closes), 15 * 300_000, 0.0001);
  assert.equal(pullback.side, 'UP');
  assert.equal(pullback.regime, 'PULLBACK_AFTER_FALL');
});

test('does not signal without 15 completed candles or on a small move', () => {
  const small = Array.from({ length: 15 }, (_, index) => 100_000 + index);
  assert.equal(detectPullback(candlesFromCloses(small), 15 * 300_000, 0.001), null);
  assert.equal(detectPullback(candlesFromCloses(small.slice(0, 14)), 14 * 300_000, 0.001), null);
  assert.equal(detectPullback(candlesFromCloses(small, 14 * 300_000), 14 * 300_000, 0.001), null);
});

test('auto-tuner holds current settings until enough closed windows exist', () => {
  const windows = Array.from({ length: MIN_CLOSED_WINDOWS - 1 }, (_, index) => ({
    windowStart: index * 300_000,
    samples: [],
  }));
  const result = choosePaperSettings(windows, DEFAULT_SETTINGS);
  assert.equal(result.applied, false);
  assert.equal(result.reason, 'INSUFFICIENT_HISTORY');
  assert.deepEqual(result.settings, DEFAULT_SETTINGS);
});

test('auto-tuner evaluates only the latest 15 completed windows in chronological order', () => {
  const windows = Array.from({ length: 20 }, (_, windowIndex) => {
    const losingWindow = windowIndex % 2 === 0;
    const samples = Array.from({ length: 20 }, (_, index) => {
      const secondsSinceOpen = index * 15;
      const secondsRemaining = 300 - secondsSinceOpen;
      const zScore = index % 2 === 0 ? (losingWindow ? 0.06 : 0.13) : 0;
      const spotPrice = 100 * Math.exp(zScore * 0.005 * Math.sqrt(secondsRemaining / 300));
      const finalBid = index === 19 ? (losingWindow ? 0.01 : 0.99) : 0.45;
      return {
        ts: windowIndex * 300_000 + secondsSinceOpen * 1000,
        secondsSinceOpen,
        secondsRemaining,
        referencePrice: 100,
        spotPrice,
        volatility5m: 0.005,
        pullback: null,
        quotes: {
          UP: { bestAsk: 0.45, bestBid: finalBid, asks: [{ price: 0.45, size: 100 }] },
          DOWN: { bestAsk: 0.45, bestBid: finalBid, asks: [{ price: 0.45, size: 100 }] },
        },
      };
    });
    return { windowStart: windowIndex * 300_000, samples };
  });

  const result = choosePaperSettings(windows, DEFAULT_SETTINGS);
  assert.equal(result.applied, true);
  assert.equal(result.reason, 'HOLDOUT_IMPROVEMENT');
  assert.equal(result.windows, 15);
  assert.equal(result.settings.minimumNetEdge, 0.07);
  assert.ok(result.selected.averagePnlPerWindow > result.baseline.averagePnlPerWindow);
});
