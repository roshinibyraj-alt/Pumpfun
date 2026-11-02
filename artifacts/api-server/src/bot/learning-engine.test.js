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

test('50-candle HH break chooses UP on a live crossing', () => {
  const closes = Array.from({ length: 50 }, (_, index) =>
    100_000 + index * 5 + [0, 50, 10, -40][index % 4]);
  const candles = candlesFromCloses(closes);
  const state = detectPullback(candles, 50 * 300_000, 0.0001);
  assert.equal(state.lookbackCandles, 50);
  assert.equal(state.trendDirection, 'UPTREND');
  assert.equal(state.structure, 'HH / HL');
  const breakout = detectPullback(candles, 50 * 300_000, 0.0001,
    state.breakoutLevels.UP + 10, state.breakoutLevels.UP - 10);
  assert.equal(breakout.side, 'UP');
  assert.equal(breakout.crossed, true);
  assert.equal(breakout.regime, 'HIGHER_HIGH_BREAKOUT');
});

test('50-candle LL break chooses DOWN on a live crossing', () => {
  const closes = Array.from({ length: 50 }, (_, index) =>
    100_000 - index * 5 + [0, 50, 10, -40][index % 4]);
  const candles = candlesFromCloses(closes);
  const state = detectPullback(candles, 50 * 300_000, 0.0001);
  assert.equal(state.trendDirection, 'DOWNTREND');
  assert.equal(state.structure, 'LH / LL');
  const breakout = detectPullback(candles, 50 * 300_000, 0.0001,
    state.breakoutLevels.DOWN - 10, state.breakoutLevels.DOWN + 10);
  assert.equal(breakout.side, 'DOWN');
  assert.equal(breakout.crossed, true);
  assert.equal(breakout.regime, 'LOWER_LOW_BREAKOUT');
});

test('a trendline lower-low touch chooses UP and a higher-high touch chooses DOWN', () => {
  const upCloses = Array.from({ length: 50 }, (_, index) =>
    100_000 + index * 5 + [0, 50, 10, -40][index % 4]);
  const downCloses = Array.from({ length: 50 }, (_, index) =>
    100_000 - index * 5 + [0, 50, 10, -40][index % 4]);
  const now = 50 * 300_000;
  const upState = detectPullback(candlesFromCloses(upCloses), now, 0.0001);
  const downState = detectPullback(candlesFromCloses(downCloses), now, 0.0001);
  const highTouch = upState.chart.trendline.end;
  const lowTouch = downState.chart.trendline.end;

  const downSignal = detectPullback(candlesFromCloses(upCloses), now, 0.0001, highTouch, highTouch + 100);
  const upSignal = detectPullback(candlesFromCloses(downCloses), now, 0.0001, lowTouch, lowTouch - 100);
  assert.equal(downSignal.side, 'DOWN');
  assert.equal(downSignal.signalReason, 'HIGHER_HIGH_TRENDLINE_TOUCH');
  assert.equal(upSignal.side, 'UP');
  assert.equal(upSignal.signalReason, 'LOWER_LOW_TRENDLINE_TOUCH');
});

test('waits when there is no matching touch or structure is unavailable', () => {
  const flat = Array.from({ length: 50 }, () => 100_000);
  const mixed = detectPullback(candlesFromCloses(flat), 50 * 300_000, 0.0001, 100_000, 99_999);
  assert.equal(mixed.trendDirection, 'MIXED');
  assert.equal(mixed.side, null);
  assert.equal(detectPullback(candlesFromCloses(flat.slice(0, 49)), 49 * 300_000, 0.0001), null);
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

test('auto-tuner ignores windows logged with the previous pullback rule', () => {
  const windows = Array.from({ length: 15 }, (_, index) => ({
    windowStart: index * 300_000,
    samples: Array.from({ length: 20 }, () => ({ pullback: { method: 'swing50-live-cross-v1', side: 'UP' } })),
  }));
  const result = choosePaperSettings(windows, DEFAULT_SETTINGS);
  assert.equal(result.applied, false);
  assert.equal(result.reason, 'INSUFFICIENT_HISTORY');
  assert.equal(result.windows, 0);
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
        pullback: { method: 'swing50-touch-break-v2', side: 'UP' },
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
