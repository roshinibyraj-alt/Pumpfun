'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ChainlinkPriceFeed } = require('./chainlink-price-feed');
const { ProbabilityBot, estimateLogReturnVolatility } = require('./probability-bot');
const { detectMacdHistogram } = require('./macd-signal');

const quietFeed = { start() {}, snapshot() { return { status: 'live', ageMs: 0 }; } };

for (const side of ['UP', 'DOWN']) {
  test(`${side} carries across full scan windows without a new MACD change, retains edge-reset gates, and reverses on an opposite signal`, async () => {
    let now = 300_001;
    const bot = new ProbabilityBot({
      now: () => now,
      fetchMarket: async start => ({
        id: `market-${start}`, start, end: start + 300_000,
        tokens: { UP: `u-${start}`, DOWN: `d-${start}` },
      }),
      fetchMarketDetails: async () => null,
      fetchBook: async () => ({
        bids: [{ price: 0.4, size: 1000 }], asks: [{ price: 0.4, size: 1000 }],
      }),
      priceFeed: {
        ...quietFeed,
        getTicks: () => [{ ts: Math.floor(now / 300_000) * 300_000, price: 100_000 },
          { ts: now, price: 100_000 }],
        getHistoricalCandles: () => Array.from({ length: 20 }, (_, i) => ({
          close: 100_000 + i * 9 + (i % 2) * 10,
        })),
        getHistoricalMinuteCandles: () => [], // No new closed histogram signal in either window.
      },
    });
    bot.applyPullbackSignal({ side, signalSource: 'CLOSED_CANDLE', signalAt: 0, signalReason: 'INITIAL_MACD' });
    await bot.tick();
    assert.equal(bot.error, null);
    assert.equal(bot.trades.length, 1);
    assert.equal(bot.trades[0].side, side);
    assert.equal(bot.armed[side], false);
    now = 600_001;
    await bot.tick();
    assert.equal(bot.error, null);
    assert.equal(bot.activeSide, side);
    assert.equal(bot.activeSignalReason, 'INITIAL_MACD');
    assert.equal(bot.pullback.detectedSide, null);
    assert.equal(bot.pullback.side, side);
    assert.equal(bot.trades.filter(t => t.windowStart === 600_000).length, 1);
    assert.equal(bot.trades[0].side, side);
    now += 1000;
    await bot.tick();
    assert.equal(bot.trades.filter(t => t.windowStart === 600_000).length, 1);
    const carryEvents = bot.events.filter(e => e.event === 'PULLBACK_BIAS_CARRIED');
    assert.equal(carryEvents.length, 1);
    assert.equal(carryEvents[0].side, side);
    const opposite = side === 'UP' ? 'DOWN' : 'UP';
    bot.applyPullbackSignal({
      method: 'test', side: opposite, signalSource: 'CLOSED_CANDLE',
      signalReason: 'CONFIRMED_OPPOSITE_BREAKOUT', signalAt: now,
    });
    bot.processSignals(now);
    assert.equal(bot.activeSide, opposite);
    assert.equal(bot.trades[0].side, opposite);
    assert.equal(bot.trades.find(t => t.windowStart === 600_000 && t.side === side).finalOutcome, 'OPPOSITE_SIGNAL');
  });
}

for (const [bid, outcome] of [[0.99, 'TAKE_PROFIT'], [0.01, 'STOP_LOSS']]) {
  test(`${outcome} closes a position without clearing its signal or rearming a same-window entry`, () => {
    const bot = new ProbabilityBot({ priceFeed: quietFeed, activeSide: 'UP' });
    bot.market = { id: 'market', start: 0, end: 300_000 };
    bot.beginMarketWindow();
    bot.armed.UP = false;
    bot.trades = [{
      id: 'position', marketId: 'market', side: 'UP', windowEnd: 300_000,
      openedAt: 0, shares: 100, totalCost: 40, status: 'OPEN',
    }];
    bot.quotes.UP = { bestBid: bid, updatedAt: 1_000 };
    bot.processPositionExits(1_000);
    assert.equal(bot.trades[0].finalOutcome, outcome);
    assert.equal(bot.activeSide, 'UP');
    assert.equal(bot.armed.UP, false);
    bot.market = { id: 'next', start: 300_000, end: 600_000 };
    bot.beginMarketWindow();
    assert.equal(bot.activeSide, 'UP');
    assert.equal(bot.armed.UP, true);
  });
}

test('a window transition carries bias even while the opening reference is unavailable', async () => {
  const bot = new ProbabilityBot({
    now: () => 650_000, activeSide: 'DOWN',
    fetchMarket: async start => ({ id: 'next', start, end: start + 300_000, tokens: { UP: 'u', DOWN: 'd' } }),
    fetchBook: async () => ({ bids: [{ price: 0.4, size: 100 }], asks: [{ price: 0.4, size: 100 }] }),
    priceFeed: { ...quietFeed, getTicks: () => [{ ts: 650_000, price: 100_000 }],
      getHistoricalCandles: () => [], getHistoricalMinuteCandles: () => [] },
  });
  bot.entryWindowStart = 300_000;
  bot.armed.DOWN = false;
  await bot.tick();
  assert.equal(bot.error, null);
  assert.equal(bot.entryWindowStart, 600_000);
  assert.equal(bot.activeSide, 'DOWN');
  assert.equal(bot.armed.DOWN, true);
  assert.equal(bot.trades.length, 0); // Carrying a signal never bypasses model-data gates.
  assert.match(bot.statusReason, /opening reference/);
});

test('stale one-minute candle history cannot issue a new direction', () => {
  const candles = Array.from({ length: 50 }, (_, i) => ({
    start: i * 60_000, end: (i + 1) * 60_000,
    open: 100_000 + i, high: 100_010 + i, low: 99_990 + i, close: 100_001 + i,
  }));
  const result = detectMacdHistogram(candles, 50 * 60_000 + 90_001);
  assert.equal(result.status, 'STALE');
  assert.equal(result.side, null);
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

test('a previously handled closed-candle event cannot undo a newer closed MACD reversal', () => {
  const bot = new ProbabilityBot({ priceFeed: quietFeed });
  const closed = { method: 'test', side: 'UP', signalReason: 'MACD_SOLID_GREEN',
    signalSource: 'CLOSED_CANDLE', signalAt: 60_000 };
  bot.applyPullbackSignal(closed);
  assert.equal(bot.activeSide, 'UP');
  bot.applyPullbackSignal({ method: 'test', side: 'DOWN', signalSource: 'CLOSED_CANDLE',
    signalAt: 120_000, signalReason: 'MACD_SHRINKING_GREEN' });
  assert.equal(bot.activeSide, 'DOWN');
  bot.applyPullbackSignal(closed);
  bot.applyPullbackSignal(null);
  assert.equal(bot.activeSide, 'DOWN');
  bot.applyPullbackSignal({ ...closed, signalAt: 180_000 });
  assert.equal(bot.activeSide, 'UP');
});

test('reversal exit waits for a fresh bid, then sells even when the opposite entry fails its edge gate', () => {
  const bot = new ProbabilityBot({ priceFeed: quietFeed, activeSide: 'DOWN' });
  bot.market = { id: 'market', start: 0, end: 300_000 };
  bot.trades = [{ id: 'old', marketId: 'market', side: 'UP', status: 'OPEN',
    windowEnd: 300_000, shares: 100, totalCost: 50 }];
  bot.quotes = {
    UP: { bestBid: 0.4, updatedAt: -10_000, bids: [{ price: 0.4, size: 100 }], bestAsk: 0.5, asks: [{ price: 0.5, size: 100 }] },
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

test('tick takes MACD candles from the one-minute series while keeping probability volatility on five-minute data', async () => {
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
  assert.equal(bot.macd.chart.bars.length, 17);
  assert.equal(bot.macd.chart.bars[1].start - bot.macd.chart.bars[0].start, 60_000);
  assert.equal(bot.macd.method, 'macd-1m-12-26-9-reversal-sweep-v1');
  assert.equal(bot.pullback, bot.macd);
  assert.equal(bot.volatility5m, estimateLogReturnVolatility(fiveMinutes));
});
