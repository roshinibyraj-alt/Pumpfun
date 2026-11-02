'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { METHOD } = require('./btc/macd-signal');
const { DEFAULT_SETTINGS, MIN_CLOSED_WINDOWS, choosePaperSettings, simulateWindow } = require('./btc/learning-engine');

test('replay keeps edge-reset cadence and matches total sold shares when reversing', () => {
  const samples = Array.from({ length: 20 }, (_, i) => ({
    ts: i * 2000, secondsSinceOpen: i * 2, secondsRemaining: 300 - i * 2,
    referencePrice: 100, spotPrice: 100, volatility5m: 0.005,
    pullback: { method: METHOD, side: i < 10 ? 'UP' : 'DOWN' },
    quotes: Object.fromEntries(['UP', 'DOWN'].map(side => {
      const price = i === (side === 'UP' ? 5 : 15) ? .55 : .3;
      return [side, { bestAsk: price, bestBid: .35,
        bids: [{ price: .35, size: 1000 }], asks: [{ price, size: 500 }] }];
    })),
  }));
  const result = simulateWindow(samples, DEFAULT_SETTINGS);
  assert.equal(result.trades, 4);
  // Two100-share UP entries, a matched200-share DOWN reversal, then one100-share add.
  assert.ok(Math.abs(result.pnl - 9.6875) < 1e-8);
  assert.ok(Math.abs(result.finalCash - 10_009.6875) < 1e-8);
});

test('replay takes profit without rearming a continuously qualifying edge', () => {
  const samples = Array.from({ length: 20 }, (_, i) => ({
    ts: i * 500, secondsSinceOpen: i / 2, secondsRemaining: 300 - i / 2,
    referencePrice: 100, spotPrice: 100, volatility5m: 0.005,
    pullback: { method: METHOD, side: 'UP' },
    quotes: {
      UP: { bestAsk: .3, bestBid: i === 19 ? .4 : i < 10 ? .99 : .01, asks: [{ price: .3, size: 100 }] },
      DOWN: { bestAsk: .7, bestBid: .6, asks: [{ price: .7, size: 100 }] },
    },
  }));
  const result = simulateWindow(samples, DEFAULT_SETTINGS);
  assert.equal(result.trades, 1);
  assert.ok(Math.abs(result.pnl - 68.4607) < 1e-8);
});

test('auto-tuner holds current settings until enough closed windows exist', () => {
  const windows = Array.from({ length: MIN_CLOSED_WINDOWS - 1 }, (_, i) => ({
    windowStart: i * 300_000, samples: [],
  }));
  const result = choosePaperSettings(windows, DEFAULT_SETTINGS);
  assert.equal(result.applied, false);
  assert.equal(result.reason, 'INSUFFICIENT_HISTORY');
  assert.deepEqual(result.settings, DEFAULT_SETTINGS);
});

test('auto-tuner excludes all previous trendline execution policies', () => {
  const windows = Array.from({ length: 15 }, (_, i) => ({
    windowStart: i * 300_000,
    samples: Array.from({ length: 20 }, () => ({
      pullback: { method: 'swing50-1m-edge-reset-tpsl-v8', side: 'UP' },
    })),
  }));
  const result = choosePaperSettings(windows, DEFAULT_SETTINGS);
  assert.equal(result.applied, false);
  assert.equal(result.reason, 'INSUFFICIENT_HISTORY');
  assert.equal(result.windows, 0);
});

test('auto-tuner evaluates only the latest15 MACD windows in chronological order', () => {
  const windows = Array.from({ length: 20 }, (_, windowIndex) => {
    const losingWindow = windowIndex % 2 === 0;
    const samples = Array.from({ length: 20 }, (_, index) => {
      const secondsSinceOpen = index * 15;
      const secondsRemaining = 300 - secondsSinceOpen;
      const zScore = index % 2 === 0 ? (losingWindow ? .06 : .13) : 0;
      const spotPrice = 100 * Math.exp(zScore * .005 * Math.sqrt(secondsRemaining / 300));
      const finalBid = index === 19 ? (losingWindow ? .01 : .99) : .45;
      return {
        ts: windowIndex * 300_000 + secondsSinceOpen * 1000,
        secondsSinceOpen, secondsRemaining, referencePrice: 100, spotPrice, volatility5m: .005,
        pullback: { method: METHOD, side: 'UP' },
        quotes: Object.fromEntries(['UP', 'DOWN'].map(side => [side, {
          bestAsk: .45, bestBid: finalBid,
          asks: [{ price: .45, size: 100 }], bids: [{ price: finalBid, size: 100 }],
        }])),
      };
    });
    return { windowStart: windowIndex * 300_000, samples };
  });
  const result = choosePaperSettings(windows, DEFAULT_SETTINGS);
  assert.equal(result.applied, true);
  assert.equal(result.reason, 'HOLDOUT_IMPROVEMENT');
  assert.equal(result.windows, 15);
  assert.ok(result.baseline.tradeCount >= 10);
  assert.ok(result.selected.averagePnlPerWindow > result.baseline.averagePnlPerWindow);
});
