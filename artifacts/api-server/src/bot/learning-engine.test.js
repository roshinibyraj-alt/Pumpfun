'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { detectPullback } = require('./btc/pullback-signal');
const {
  DEFAULT_SETTINGS,
  MIN_CLOSED_WINDOWS,
  choosePaperSettings,
} = require('./btc/learning-engine');

test('detects a confirmed retracement after a sustained BTC rise', () => {
  const pullback = detectPullback([
    { ts: 0, price: 100_000 },
    { ts: 15_000, price: 100_020 },
    { ts: 20_000, price: 100_025 },
    { ts: 30_000, price: 100_060 },
    { ts: 40_000, price: 100_035 },
  ], 40_000, 0.001);
  assert.equal(pullback.side, 'DOWN');
  assert.equal(pullback.regime, 'PULLBACK_AFTER_RISE');
  assert.ok(pullback.retracementRatio >= 0.35);
});

test('detects an upward reversal after a sustained BTC fall', () => {
  const pullback = detectPullback([
    { ts: 0, price: 100_000 },
    { ts: 15_000, price: 99_980 },
    { ts: 20_000, price: 99_975 },
    { ts: 30_000, price: 99_940 },
    { ts: 40_000, price: 99_965 },
  ], 40_000, 0.001);
  assert.equal(pullback.side, 'UP');
  assert.equal(pullback.regime, 'PULLBACK_AFTER_FALL');
});

test('does not signal on a small move or too few ticks', () => {
  assert.equal(detectPullback([{ ts: 1_000, price: 100_000 }], 1_000, 0.001), null);
  assert.equal(detectPullback([
    { ts: 0, price: 100_000 },
    { ts: 15_000, price: 100_005 },
    { ts: 30_000, price: 100_008 },
    { ts: 40_000, price: 100_004 },
    { ts: 45_000, price: 100_003 },
  ], 45_000, 0.001), null);
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

test('auto-tuner accepts a threshold only when it improves chronological holdout results', () => {
  const windows = Array.from({ length: 100 }, (_, windowIndex) => {
    const losingWindow = windowIndex % 2 === 0;
    const zScore = losingWindow ? 0.06 : 0.13;
    const samples = Array.from({ length: 20 }, (_, index) => {
      const secondsSinceOpen = index * 15;
      const secondsRemaining = 300 - secondsSinceOpen;
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
  assert.equal(result.settings.minimumNetEdge, 0.07);
  assert.ok(result.selected.averagePnlPerWindow > result.baseline.averagePnlPerWindow);
});
