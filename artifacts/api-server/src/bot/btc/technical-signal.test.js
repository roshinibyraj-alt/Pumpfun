'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  detectTechnicalSignal,
  chooseFallbackSide,
  selectScenarioSignal,
  volumeFlow,
  detectDivergence,
} = require('./technical-signal');

const NOW = Math.floor(1_700_000_000_000 / (15 * 60_000)) * (15 * 60_000);

function makeCandles(interval, count, now, closeAt, volumeAt = () => 10, buyRatioAt = () => 0.5) {
  const finalEnd = Math.floor(now / interval) * interval;
  return Array.from({ length: count }, (_, index) => {
    const end = finalEnd - (count - index - 1) * interval;
    const start = end - interval;
    const close = closeAt(index);
    const open = index > 0 ? closeAt(index - 1) : close;
    const volume = volumeAt(index);
    return {
      start, end, open,
      high: Math.max(open, close) + 0.2,
      low: Math.min(open, close) - 0.2,
      close,
      volume,
      takerBuyBaseVolume: volume * buyRatioAt(index),
    };
  });
}

test('Scenario A is selected before a conflicting range signal', () => {
  const selection = selectScenarioSignal({
    trendSignalUp: true,
    trendSignalDown: false,
    rangeSignalUp: false,
    rangeSignalDown: true,
    fallbackSide: 'DOWN',
    fallbackRule: '15M_EMA200_TREND',
    confluenceName: 'EMA21',
  });
  assert.equal(selection.side, 'UP');
  assert.equal(selection.setup, 'TREND_CONTINUATION_PULLBACK');
  assert.equal(selection.confirmed, true);
});

test('Scenario B selects the counter-trend side only after its range trigger', () => {
  const selection = selectScenarioSignal({
    trendSignalUp: false,
    trendSignalDown: false,
    rangeSignalUp: true,
    rangeSignalDown: false,
    fallbackSide: 'DOWN',
    fallbackRule: 'LAST_5M_CANDLE',
    targetPrice: 101.5,
    targetLabel: 'ROLLING_VWAP_20',
  });
  assert.equal(selection.side, 'UP');
  assert.equal(selection.setup, 'RANGE_MEAN_REVERSION');
  assert.equal(selection.targetPrice, 101.5);
});

test('fallback always returns a selected side when no setup confirms', () => {
  const selection = selectScenarioSignal({
    trendSignalUp: false,
    trendSignalDown: false,
    rangeSignalUp: false,
    rangeSignalDown: false,
    fallbackSide: 'DOWN',
    fallbackRule: '15M_EMA200_TREND',
  });
  assert.equal(selection.side, 'DOWN');
  assert.equal(selection.setup, 'DIRECTIONAL_FALLBACK');
  assert.equal(selection.fallbackRule, '15M_EMA200_TREND');
  assert.equal(selection.confirmed, false);
});

test('fallback prioritizes the latest 5m candle and uses aligned 15m trend on a doji', () => {
  const downCandle = chooseFallbackSide({
    price15m: 101, ema200: 100, ema200Slope: 1,
    previousSide: 'DOWN',
    last5m: { open: 102, close: 101 },
    last15m: { open: 99, close: 100 },
    last1m: null,
  });
  assert.deepEqual(downCandle, { side: 'DOWN', tieBreak: 'LAST_5M_CANDLE' });

  const upCandle = chooseFallbackSide({
    price15m: 99, ema200: 100, ema200Slope: -1,
    previousSide: 'DOWN',
    last5m: { open: 100, close: 101 },
    last15m: { open: 99, close: 100 },
    last1m: null,
  });
  assert.deepEqual(upCandle, { side: 'UP', tieBreak: 'LAST_5M_CANDLE' });

  const trendOnDoji = chooseFallbackSide({
    price15m: 99, ema200: 100, ema200Slope: -1,
    previousSide: 'UP',
    last5m: { open: 100, close: 100 },
    last15m: { open: 100, close: 100 },
    last1m: null,
  });
  assert.deepEqual(trendOnDoji, { side: 'DOWN', tieBreak: '15M_EMA200_TREND' });

  const previous = chooseFallbackSide({
    price15m: 100, ema200: 100, ema200Slope: 0,
    previousSide: 'DOWN',
    last5m: { open: 100, close: 100 },
    last15m: { open: 100, close: 100 },
    last1m: null,
  });
  assert.deepEqual(previous, { side: 'DOWN', tieBreak: 'PREVIOUS_SIDE' });
});

test('each valid window gets a deterministic side from closed candles', () => {
  const five = makeCandles(5 * 60_000, 100, NOW, index => 90 + index * 0.2);
  const fifteen = makeCandles(15 * 60_000, 250, NOW, index => 80 + index * 0.4);
  const minute = makeCandles(60_000, 100, NOW, index => 100 + index * 0.01);
  const signal = detectTechnicalSignal({
    candles5m: five,
    candles15m: fifteen,
    candles1m: minute,
    now: NOW + 1_000,
  });
  assert.equal(signal.status, 'READY');
  assert.ok(['UP', 'DOWN'].includes(signal.side));
  assert.equal(signal.setup, 'DIRECTIONAL_FALLBACK');
  assert.equal(signal.confirmed, false);
  assert.equal(signal.score, null);
  assert.equal(signal.fallbackRule, 'LAST_5M_CANDLE');
  assert.equal(signal.signalAt, Math.floor((NOW + 1_000) / (5 * 60_000)) * (5 * 60_000));
});

test('fallback tie keeps the prior side when all indicator votes are neutral', () => {
  const five = makeCandles(5 * 60_000, 100, NOW, () => 100);
  const fifteen = makeCandles(15 * 60_000, 250, NOW, () => 100);
  const minute = makeCandles(60_000, 100, NOW, () => 100);
  const signal = detectTechnicalSignal({
    candles5m: five,
    candles15m: fifteen,
    candles1m: minute,
    now: NOW + 1_000,
    previousSide: 'DOWN',
  });
  assert.equal(signal.status, 'READY');
  assert.equal(signal.score, null);
  assert.equal(signal.side, 'DOWN');
  assert.equal(signal.fallbackRule, 'PREVIOUS_SIDE');
  assert.equal(signal.tieBreak, 'PREVIOUS_SIDE');
});

test('missing current closed 5-minute candle blocks signal generation', () => {
  const five = makeCandles(5 * 60_000, 100, NOW, index => 90 + index * 0.1);
  const fifteen = makeCandles(15 * 60_000, 250, NOW, index => 90 + index * 0.2);
  five.pop();
  const signal = detectTechnicalSignal({
    candles5m: five,
    candles15m: fifteen,
    candles1m: [],
    now: NOW + 1_000,
  });
  assert.equal(signal.status, 'STALE');
  assert.equal(signal.side, null);
});

test('signed volume spike distinguishes buy and sell pressure', () => {
  const candles = makeCandles(
    60_000,
    23,
    NOW,
    index => 100 + index * 0.01,
    index => index >= 20 ? 20 : 10,
    index => index >= 20 ? 0.7 : 0.5,
  );
  const up = volumeFlow(candles, NOW + 1_000);
  assert.equal(up.status, 'READY');
  assert.equal(up.spike, true);
  assert.equal(up.direction, 'UP');

  const downCandles = candles.map(candle => ({
    ...candle,
    takerBuyBaseVolume: candle.volume * (candle.end > NOW - 3 * 60_000 ? 0.3 : 0.5),
  }));
  const down = volumeFlow(downCandles, NOW + 1_000);
  assert.equal(down.direction, 'DOWN');
});

test('closed-candle indicator pipeline confirms trend pullbacks in both directions', () => {
  const five = makeCandles(300_000, 100, NOW,
    index => 100 + index * .04 + .4 * Math.sin(index * .2 + 4.2))
    .map(candle => ({ ...candle, high: candle.high + .1, low: candle.low - .1 }));
  const fifteen = makeCandles(900_000, 250, NOW, index => 100 + index * .3);
  const minute = makeCandles(60_000, 100, NOW, index => 100 + index * .01,
    index => index >= 97 ? 20 : 10, () => .7);
  const up = detectTechnicalSignal({
    candles5m: five, candles15m: fifteen, candles1m: minute, now: NOW + 1_000,
  });
  assert.equal(up.setup, 'TREND_CONTINUATION_PULLBACK');
  assert.equal(up.side, 'UP');
  assert.ok(up.indicators.stochRsiKPrevious < 20 && up.indicators.stochRsiK >= 20);

  const invert = candle => ({
    ...candle, open: 300 - candle.open, close: 300 - candle.close,
    high: 300 - candle.low, low: 300 - candle.high,
    takerBuyBaseVolume: candle.volume - candle.takerBuyBaseVolume,
  });
  const down = detectTechnicalSignal({
    candles5m: five.map(invert), candles15m: fifteen.map(invert),
    candles1m: minute.map(invert), now: NOW + 1_000,
  });
  assert.equal(down.setup, 'TREND_CONTINUATION_PULLBACK');
  assert.equal(down.side, 'DOWN');

  const noVolume = detectTechnicalSignal({
    candles5m: five, candles15m: fifteen,
    candles1m: minute.map(candle => ({ ...candle, takerBuyBaseVolume: candle.volume / 2 })),
    now: NOW + 1_000,
  });
  assert.equal(noVolume.setup, 'DIRECTIONAL_FALLBACK');
  assert.equal(noVolume.confirmed, false);
});

test('RSI divergence requires lower-price/higher-RSI lows or higher-price/lower-RSI highs', () => {
  const candles = Array.from({ length: 15 }, () => ({ low: 12, high: 13 }));
  const rsi = Array(15).fill(50);
  candles[3].low = 10;
  candles[9].low = 9.7;
  rsi[3] = 20;
  rsi[9] = 28;
  candles[5].high = 14;
  candles[11].high = 14.3;
  rsi[5] = 80;
  rsi[11] = 70;
  const divergence = detectDivergence(candles, rsi, 1);
  assert.equal(divergence.bullish, true);
  assert.equal(divergence.bearish, true);
  rsi[9] = 18;
  rsi[11] = 82;
  assert.equal(detectDivergence(candles, rsi, 1).bullish, false);
  assert.equal(detectDivergence(candles, rsi, 1).bearish, false);
});

