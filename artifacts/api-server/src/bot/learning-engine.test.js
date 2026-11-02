'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { detectPullback } = require('./btc/pullback-signal');
const {
  DEFAULT_SETTINGS,
  MIN_CLOSED_WINDOWS,
  choosePaperSettings,
  simulateWindow,
} = require('./btc/learning-engine');

test('regression replay accumulates every eligible sample and sells all on reversal', () => {
  const samples = Array.from({ length: 20 }, (_, i) => ({
    ts: i * 2000, secondsSinceOpen: i * 2, secondsRemaining: 300 - i * 2,
    referencePrice: 100, spotPrice: 100, volatility5m: 0.005,
    pullback: { side: i < 10 ? 'UP' : 'DOWN' },
    quotes: {
      UP: { bestAsk: 0.3, bestBid: 0.35, asks: [{ price: 0.3, size: 100 }] },
      DOWN: { bestAsk: 0.3, bestBid: 0.35, asks: [{ price: 0.3, size: 100 }] },
    },
  }));
  const result = simulateWindow(samples, DEFAULT_SETTINGS);
  assert.equal(result.trades, 20);
  // Each side: $30 + $1.47 entry fee, sold for $35 - $1.5925 exit fee.
  assert.ok(Math.abs(result.pnl - 38.75) < 1e-8);
});

test('regression replay holds accumulated positions through extreme bids until expiry', () => {
  const samples = Array.from({ length: 20 }, (_, i) => ({
    ts: i * 500, secondsSinceOpen: i / 2, secondsRemaining: 300 - i / 2,
    referencePrice: 100, spotPrice: 100, volatility5m: 0.005,
    pullback: { side: 'UP' },
    quotes: {
      UP: { bestAsk: 0.3, bestBid: i === 19 ? 0.4 : i < 10 ? 0.99 : 0.01, asks: [{ price: 0.3, size: 100 }] },
      DOWN: { bestAsk: 0.7, bestBid: 0.6, asks: [{ price: 0.7, size: 100 }] },
    },
  }));
  const result = simulateWindow(samples, DEFAULT_SETTINGS);
  assert.equal(result.trades, 20);
  assert.ok(Math.abs(result.pnl - 137) < 1e-8);
});

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

test('50-candle HH breakout needs a closed candle and chooses UP', () => {
  const closes = Array.from({ length: 50 }, (_, index) =>
    100_000 + index * 5 + [0, 50, 10, -40][index % 4]);
  const candles = candlesFromCloses(closes);
  const state = detectPullback(candles, 50 * 300_000, 0.0001);
  assert.equal(state.lookbackCandles, 50);
  assert.equal(state.trendDirection, 'UPTREND');
  assert.equal(state.structure, 'HH / HL');
  const noBreakCandles = candles.map(candle => ({ ...candle }));
  noBreakCandles.at(-1).close = state.breakoutLevels.UP - 10;
  const liveOnly = detectPullback(noBreakCandles, 50 * 300_000, 0.0001,
    state.breakoutLevels.UP + 10, state.breakoutLevels.UP - 10);
  assert.equal(liveOnly.side, null);
  const breakoutCandles = candles.map(candle => ({ ...candle }));
  breakoutCandles.at(-1).close = state.breakoutLevels.UP + 10;
  breakoutCandles.at(-1).high = breakoutCandles.at(-1).close + 1;
  const breakout = detectPullback(breakoutCandles, 50 * 300_000, 0.0001,
    state.breakoutLevels.UP - 10, state.breakoutLevels.UP - 20);
  assert.equal(breakout.side, 'UP');
  assert.equal(breakout.crossed, true);
  assert.equal(breakout.regime, 'HIGHER_HIGH_BREAKOUT');
});

test('50-candle LL breakout needs a closed candle and chooses DOWN', () => {
  const closes = Array.from({ length: 50 }, (_, index) =>
    100_000 - index * 5 + [0, 50, 10, -40][index % 4]);
  const candles = candlesFromCloses(closes);
  const state = detectPullback(candles, 50 * 300_000, 0.0001);
  assert.equal(state.trendDirection, 'DOWNTREND');
  assert.equal(state.structure, 'LH / LL');
  const noBreakCandles = candles.map(candle => ({ ...candle }));
  noBreakCandles.at(-1).close = state.breakoutLevels.DOWN + 10;
  const liveOnly = detectPullback(noBreakCandles, 50 * 300_000, 0.0001,
    state.breakoutLevels.DOWN - 10, state.breakoutLevels.DOWN + 10);
  assert.equal(liveOnly.side, null);
  const breakoutCandles = candles.map(candle => ({ ...candle }));
  breakoutCandles.at(-1).close = state.breakoutLevels.DOWN - 10;
  breakoutCandles.at(-1).low = breakoutCandles.at(-1).close - 1;
  const breakout = detectPullback(breakoutCandles, 50 * 300_000, 0.0001,
    state.breakoutLevels.DOWN + 10, state.breakoutLevels.DOWN + 20);
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
  const highTouchCandles = candlesFromCloses(upCloses);
  const upState = detectPullback(highTouchCandles, now, 0.0001);
  highTouchCandles.at(-1).close = upState.breakoutLevels.UP - 10;
  const highTouchState = detectPullback(highTouchCandles, now, 0.0001);

  const lowTouchCandles = candlesFromCloses(downCloses);
  const downState = detectPullback(lowTouchCandles, now, 0.0001);
  lowTouchCandles.at(-1).close = downState.breakoutLevels.DOWN + 10;
  const lowTouchState = detectPullback(lowTouchCandles, now, 0.0001);

  const highTouch = highTouchState.chart.trendline.end;
  const lowTouch = lowTouchState.chart.trendline.end;
  const downSignal = detectPullback(highTouchCandles, now, 0.0001, highTouch, highTouch + 100);
  const upSignal = detectPullback(lowTouchCandles, now, 0.0001, lowTouch, lowTouch - 100);
  assert.equal(downSignal.side, 'DOWN');
  assert.equal(downSignal.signalReason, 'HIGHER_HIGH_TRENDLINE_TOUCH');
  assert.equal(upSignal.side, 'UP');
  assert.equal(upSignal.signalReason, 'LOWER_LOW_TRENDLINE_TOUCH');
});

test('closed-candle wick rejection recovers missed trendline touches', () => {
  const downCloses = Array.from({ length: 50 }, (_, index) =>
    100_000 - index * 5 + [0, 50, 10, -40][index % 4]);
  const upCloses = Array.from({ length: 50 }, (_, index) =>
    100_000 + index * 5 + [0, 50, 10, -40][index % 4]);
  const now = 50 * 300_000;
  const lowCandles = candlesFromCloses(downCloses);
  const downState = detectPullback(lowCandles, now, 0.0001);
  const support = downState.chart.trendline.end;
  Object.assign(lowCandles.at(-1), {
    low: support - 3,
    close: support + 100,
    high: support + 110,
  });
  const upSignal = detectPullback(lowCandles, now, 0.0001, support + 1_000, support + 900);

  const highCandles = candlesFromCloses(upCloses);
  const upState = detectPullback(highCandles, now, 0.0001);
  const resistance = upState.chart.trendline.end;
  Object.assign(highCandles.at(-1), {
    high: resistance + 3,
    close: resistance - 100,
    low: resistance - 110,
  });
  const downSignal = detectPullback(highCandles, now, 0.0001, resistance - 1_000, resistance - 900);

  assert.equal(upSignal.side, 'UP');
  assert.equal(upSignal.signalReason, 'LOWER_LOW_CANDLE_REJECTION');
  assert.equal(downSignal.side, 'DOWN');
  assert.equal(downSignal.signalReason, 'HIGHER_HIGH_CANDLE_REJECTION');
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

test('auto-tuner ignores windows logged with the previous single-entry execution rule', () => {
  const windows = Array.from({ length: 15 }, (_, index) => ({
    windowStart: index * 300_000,
    samples: Array.from({ length: 20 }, () => ({ pullback: { method: 'swing50-1m-persistent-flip-v5', side: 'UP' } })),
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
        pullback: { method: 'swing50-1m-accumulate-v6', side: 'UP' },
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
  assert.ok(result.baseline.tradeCount >= 10);
  assert.ok(result.selected.averagePnlPerWindow > result.baseline.averagePnlPerWindow);
  assert.ok(result.selected.tradeCount >= 10);
});
