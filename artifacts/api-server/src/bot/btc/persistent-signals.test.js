'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ChainlinkPriceFeed } = require('./chainlink-price-feed');
const { ProbabilityBot, estimateLogReturnVolatility } = require('./probability-bot');
const { detectPullback } = require('./pullback-signal');

const quietFeed = { start() {}, snapshot() { return { status: 'live', ageMs: 0 }; } };

test('stale one-minute candle history cannot issue a new direction', () => {
  const candles = Array.from({ length: 50 }, (_, i) => ({
    start: i * 60_000, end: (i + 1) * 60_000,
    open: 100_000 + i, high: 100_010 + i, low: 99_990 + i, close: 100_001 + i,
  }));
  assert.equal(detectPullback(candles, 50 * 60_000 + 90_001, 0.001, 100_000), null);
});

test('one-minute history excludes the forming candle and leaves five-minute volatility history separate', async () => {
  const urls = [];
  const feed = new ChainlinkPriceFeed({
    now: () => 900_000,
    fetchImpl: async url => {
      urls.push(url);
      const interval = url.includes('interval=1m') ? 60_000 : 300_000;
      return { ok: true, json: async () => Array.from({ length: 16 }, (_, i) =>
        [i * interval, '100', '102', '99', '101', '0', (i + 1) * interval - 1]) };
    },
  });
  await Promise.all([feed.loadHistoricalCandles(), feed.loadHistoricalMinuteCandles()]);
  assert.equal(feed.getHistoricalMinuteCandles().length, 15);
  assert.equal(feed.getHistoricalCandles().length, 3);
  assert.equal(feed.getHistoricalMinuteCandles()[0].end, 60_000);
  assert.equal(feed.getHistoricalCandles()[0].end, 300_000);
  assert.ok(urls.some(url => url.includes('interval=1m')));
  assert.ok(urls.some(url => url.includes('interval=5m')));
});

test('a previously handled closed-candle event cannot undo a newer live reversal', () => {
  const bot = new ProbabilityBot({ priceFeed: quietFeed });
  const closed = { method: 'test', side: 'UP', signalReason: 'HIGHER_HIGH_BREAKOUT',
    signalSource: 'CLOSED_CANDLE', signalAt: 60_000 };
  bot.applyPullbackSignal(closed);
  assert.equal(bot.activeSide, 'UP');
  bot.applyPullbackSignal({ side: 'DOWN', signalSource: 'LIVE_TOUCH', signalReason: 'HIGHER_HIGH_TRENDLINE_TOUCH' });
  assert.equal(bot.activeSide, 'DOWN');
  bot.applyPullbackSignal(closed);
  bot.applyPullbackSignal(null);
  assert.equal(bot.activeSide, 'DOWN');
  bot.applyPullbackSignal({ ...closed, signalAt: 120_000 });
  assert.equal(bot.activeSide, 'UP');
});

test('reversal exit waits for a fresh bid, then sells even when the opposite entry fails its edge gate', () => {
  const bot = new ProbabilityBot({ priceFeed: quietFeed, activeSide: 'DOWN' });
  bot.market = { id: 'market', start: 0, end: 300_000 };
  bot.trades = [{ id: 'old', marketId: 'market', side: 'UP', status: 'OPEN',
    windowEnd: 300_000, shares: 100, totalCost: 50 }];
  bot.quotes = {
    UP: { bestBid: 0.4, updatedAt: -10_000, bestAsk: 0.5, asks: [{ price: 0.5, size: 100 }] },
    DOWN: { bestBid: 0.4, updatedAt: 1_000, bestAsk: 0.5, asks: [{ price: 0.5, size: 100 }] },
  };
  bot.probabilityUp = 0.9; // DOWN entry has negative edge.
  bot.edges = bot.calculateEdges();
  bot.processSignals(1_000);
  assert.equal(bot.trades[0].status, 'OPEN');
  bot.quotes.UP.updatedAt = 2_000;
  bot.processSignals(2_000);
  assert.equal(bot.trades.length, 1);
  assert.equal(bot.trades[0].finalOutcome, 'OPPOSITE_SIGNAL');
  assert.equal(bot.trades[0].grossPayout, 40);
});

test('tick takes trend candles from the one-minute series while keeping probability volatility on five-minute data', async () => {
  const now = 15_000_000;
  const minutes = Array.from({ length: 50 }, (_, i) => {
    const close = 100_000 + i * 5 + [0, 50, 10, -40][i % 4];
    return { start: now - (50 - i) * 60_000, end: now - (49 - i) * 60_000,
      open: close - 1, high: close + 2, low: close - 2, close };
  });
  const fiveMinutes = Array.from({ length: 20 }, (_, i) => ({ close: 100_000 + i * 9 + (i % 2) * 10 }));
  const bot = new ProbabilityBot({
    now: () => now,
    fetchMarket: async start => ({ id: 'market', start, end: start + 300_000, tokens: { UP: 'u', DOWN: 'd' } }),
    fetchBook: async () => ({ bids: [{ price: 0.4, size: 100 }], asks: [{ price: 0.5, size: 100 }] }),
    priceFeed: { ...quietFeed, getTicks: () => [{ ts: now, price: 100_100 }],
      getHistoricalCandles: () => fiveMinutes, getHistoricalMinuteCandles: () => minutes },
  });
  await bot.tick();
  assert.equal(bot.error, null);
  assert.equal(bot.pullback.chart.candles.length, 50);
  assert.equal(bot.pullback.chart.candles[1].start - bot.pullback.chart.candles[0].start, 60_000);
  assert.equal(bot.pullback.method, 'swing50-1m-edge-reset-v7');
  assert.equal(bot.volatility5m, estimateLogReturnVolatility(fiveMinutes));
});
