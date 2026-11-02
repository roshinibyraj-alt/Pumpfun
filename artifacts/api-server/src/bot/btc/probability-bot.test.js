'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ProbabilityBot, estimateLogReturnVolatility, normalCdf, probabilityUp, simulateBuy } = require('./probability-bot');

test('normal CDF is centered and monotonic', () => {
  assert.ok(Math.abs(normalCdf(0) - 0.5) < 1e-7);
  assert.ok(normalCdf(1) > normalCdf(0));
  assert.ok(normalCdf(-1) < normalCdf(0));
});

test('probability moves with signed gap and grows more sensitive near expiry', () => {
  const common = { openPrice: 100_000, volatility5m: 0.001 };
  const middle = probabilityUp({ ...common, spotPrice: 100_010, secondsRemaining: 120 });
  const late = probabilityUp({ ...common, spotPrice: 100_010, secondsRemaining: 2 });
  const below = probabilityUp({ ...common, spotPrice: 99_990, secondsRemaining: 120 });
  assert.ok(middle > 0.5);
  assert.ok(late > middle);
  assert.ok(below < 0.5);
});

test('probability remains near one half when BTC is at the reference', () => {
  assert.ok(Math.abs(probabilityUp({
    openPrice: 100_000, spotPrice: 100_000, secondsRemaining: 60, volatility5m: 0.002,
  }) - 0.5) < 1e-7);
});

test('volatility requires at least ten completed returns', () => {
  const short = Array.from({ length: 9 }, (_, i) => ({ close: 100 + i }));
  const long = Array.from({ length: 21 }, (_, i) => ({ close: 100 + i + (i % 2) }));
  assert.equal(estimateLogReturnVolatility(short), null);
  assert.ok(estimateLogReturnVolatility(long) > 0);
});

test('paper buy sweeps asks and rejects insufficient visible depth', () => {
  const fill = simulateBuy([
    { price: '0.40', size: '60' },
    { price: '0.42', size: '50' },
  ], 100);
  assert.equal(fill.shares, 100);
  assert.ok(Math.abs(fill.averagePrice - 0.408) < 1e-9);
  assert.ok(fill.totalCost > fill.cost);
  assert.equal(simulateBuy([{ price: 0.4, size: 99 }], 100), null);
});

test('one 100-share paper buy fires at an edge crossing and rearms after it clears', () => {
  const bot = new ProbabilityBot({
    now: () => 1_000,
    priceFeed: { start() {}, snapshot() { return { status: 'live', ageMs: 1 }; } },
  });
  bot.market = { start: 0, end: 300_000, title: 'BTC Up or Down' };
  bot.probabilityUp = 0.8;
  bot.quotes = {
    UP: { bestAsk: 0.70, asks: [{ price: 0.70, size: 100 }] },
    DOWN: { bestAsk: 0.30, asks: [{ price: 0.30, size: 100 }] },
  };
  bot.edges = bot.calculateEdges();
  bot.processSignals(1_000);
  bot.processSignals(1_000);
  assert.equal(bot.trades.length, 1);
  assert.equal(bot.trades[0].side, 'UP');
  assert.equal(bot.trades[0].shares, 100);

  bot.probabilityUp = 0.70;
  bot.edges = bot.calculateEdges();
  bot.processSignals(2_000);
  bot.probabilityUp = 0.8;
  bot.edges = bot.calculateEdges();
  bot.processSignals(3_000);
  assert.equal(bot.trades.length, 2);
});

test('any best ask below $0.02 blocks both sides; $0.02 is allowed', () => {
  const bot = new ProbabilityBot({
    now: () => 1_000,
    priceFeed: { start() {}, snapshot() { return { status: 'live', ageMs: 1 }; } },
  });
  bot.market = { start: 0, end: 300_000, title: 'BTC Up or Down' };
  bot.probabilityUp = 0.8;
  bot.quotes = {
    UP: { bestAsk: 0.02, asks: [{ price: 0.02, size: 100 }] },
    DOWN: { bestAsk: 0.01, asks: [{ price: 0.01, size: 100 }] },
  };
  bot.edges = bot.calculateEdges();
  bot.processSignals(1_000);

  assert.equal(bot.trades.length, 0);
  assert.deepEqual(bot.entryFilter.blockedSides, ['DOWN']);

  bot.quotes.DOWN = { bestAsk: 0.02, asks: [{ price: 0.02, size: 100 }] };
  bot.edges = bot.calculateEdges();
  bot.processSignals(2_000);

  assert.equal(bot.entryFilter.allowed, true);
  assert.equal(bot.trades.length, 1);
  assert.equal(bot.trades[0].side, 'UP');
});

test('blocks entries for the first 30 seconds of a window, then allows them', () => {
  const bot = new ProbabilityBot({
    now: () => 1_000,
    priceFeed: { start() {}, snapshot() { return { status: 'live', ageMs: 1 }; } },
  });
  bot.market = { start: 0, end: 300_000, title: 'BTC Up or Down' };
  bot.probabilityUp = 0.8;
  bot.quotes = {
    UP: { bestAsk: 0.70, asks: [{ price: 0.70, size: 100 }] },
    DOWN: { bestAsk: 0.30, asks: [{ price: 0.30, size: 100 }] },
  };
  bot.edges = bot.calculateEdges();

  bot.processSignals(29_999);
  assert.equal(bot.trades.length, 0);
  assert.equal(bot.entryFilter.openingDelayActive, true);
  assert.equal(bot.entryFilter.secondsSinceOpen, 29.999);
  assert.deepEqual(bot.entryFilter.blockedReasons, ['OPENING_DELAY']);

  bot.processSignals(30_000);
  assert.equal(bot.entryFilter.allowed, true);
  assert.equal(bot.trades.length, 1);
  assert.equal(bot.trades[0].side, 'UP');
  assert.equal(bot.snapshot().strategy.openingDelaySeconds, 30);
});

test('requires 10 percent net edge when the executable average ask is below $0.25', () => {
  const bot = new ProbabilityBot({
    now: () => 30_000,
    priceFeed: { start() {}, snapshot() { return { status: 'live', ageMs: 1 }; } },
  });
  bot.market = { start: 0, end: 300_000, title: 'BTC Up or Down' };
  bot.quotes = {
    UP: { bestAsk: 0.20, asks: [{ price: 0.20, size: 100 }] },
    DOWN: { bestAsk: 0.80, asks: [{ price: 0.80, size: 100 }] },
  };
  bot.probabilityUp = 0.27;
  bot.edges = bot.calculateEdges();
  bot.processSignals(30_000);
  assert.equal(bot.requiredNetEdge.UP, 0.10);
  assert.ok(bot.edges.UP > 0.05 && bot.edges.UP < 0.10);
  assert.equal(bot.trades.length, 0);

  bot.probabilityUp = 0.33;
  bot.edges = bot.calculateEdges();
  bot.processSignals(31_000);
  assert.equal(bot.trades.length, 1);
  assert.equal(bot.trades[0].requiredNetEdge, 0.10);
});

 test('returns independent open-share, average-cost, and live P&L summaries for each side', () => {
  const bot = new ProbabilityBot({
    now: () => 10_000,
    priceFeed: { start() {}, snapshot() { return { status: 'live', ageMs: 1 }; } },
  });
  bot.market = { id: 'market', start: 0, end: 300_000 };
  bot.quotes = {
    UP: { bestBid: 0.60, updatedAt: 10_000 },
    DOWN: { bestBid: 0.35, updatedAt: 10_000 },
  };
  bot.trades = [
    { id: 'up-a', marketId: 'market', side: 'UP', shares: 100, totalCost: 45.10, status: 'OPEN' },
    { id: 'up-b', marketId: 'market', side: 'UP', shares: 100, totalCost: 50.10, status: 'OPEN' },
    { id: 'down-a', marketId: 'market', side: 'DOWN', shares: 100, totalCost: 40.10, status: 'OPEN' },
    { id: 'up-closed', marketId: 'old', side: 'UP', shares: 100, totalCost: 30, status: 'SETTLED', realizedPnl: 5 },
  ];

  const positions = bot.snapshot().paperAccount.positions;
  assert.equal(positions.UP.shares, 200);
  assert.equal(positions.UP.costBasis, 95.2);
  assert.ok(Math.abs(positions.UP.averageCost - 0.476) < 1e-9);
  assert.equal(positions.UP.bestBid, 0.60);
  assert.ok(positions.UP.unrealizedPnl > 21.3);
  assert.equal(positions.UP.realizedPnl, 5);
  assert.equal(positions.DOWN.shares, 100);
  assert.equal(positions.DOWN.averageCost, 0.401);
  assert.equal(positions.DOWN.bestBid, 0.35);
  assert.ok(positions.DOWN.unrealizedPnl < -5);
  assert.equal(positions.DOWN.realizedPnl, 0);
});

 test('own-side bid at 0.99 takes profit and credits one dollar per share', () => {
  const bot = new ProbabilityBot({
    now: () => 1_000,
    priceFeed: { start() {}, snapshot() { return { status: 'live', ageMs: 1 }; } },
  });
  bot.market = { id: 'market', tokens: { UP: 'up-token', DOWN: 'down-token' } };
  bot.quotes = {
    UP: { bestBid: 0.99, updatedAt: 1_000 },
    DOWN: { bestBid: 0.50, updatedAt: 1_000 },
  };
  bot.trades = [{
    id: 'up-position', marketId: 'market', side: 'UP', windowEnd: 300_000,
    shares: 100, totalCost: 45, status: 'OPEN',
  }];

  bot.processPositionExits(1_000);

  assert.equal(bot.trades[0].status, 'SETTLED');
  assert.equal(bot.trades[0].finalOutcome, 'TAKE_PROFIT');
  assert.equal(bot.trades[0].closePrice, 1);
  assert.equal(bot.trades[0].grossPayout, 100);
  assert.ok(Math.abs(bot.trades[0].exitFees - 0.0693) < 1e-9);
  assert.ok(Math.abs(bot.trades[0].realizedPnl - 54.9307) < 1e-9);
  assert.ok(Math.abs(bot.cash - 10_099.9307) < 1e-9);
  assert.equal(bot.snapshot().strategy.pollIntervalMs, 500);
});

test('tracks the highest fresh own-side bid without blocking exits inside the cutoff', () => {
  const bot = new ProbabilityBot({
    now: () => 1_000,
    priceFeed: { start() {}, snapshot() { return { status: 'live', ageMs: 1 }; } },
  });
  bot.market = { id: 'market', tokens: { UP: 'up-token', DOWN: 'down-token' } };
  bot.trades = [{
    id: 'up-position', marketId: 'market', side: 'UP', windowEnd: 300_000,
    shares: 100, totalCost: 45, status: 'OPEN', openedAt: 500,
    peakBid: null, peakBidAt: null,
  }];

  bot.quotes = {
    UP: { bestBid: 0.60, updatedAt: 1_000 },
    DOWN: { bestBid: 0.40, updatedAt: 1_000 },
  };
  bot.processPositionExits(1_000);
  assert.equal(bot.trades[0].peakBid, 0.60);
  assert.equal(bot.trades[0].peakBidAt, 1_000);
  assert.equal(bot.trades[0].status, 'OPEN');

  bot.quotes.UP = { bestBid: 0.55, updatedAt: 1_500 };
  bot.processPositionExits(1_500);
  assert.equal(bot.trades[0].peakBid, 0.60);
  assert.equal(bot.trades[0].peakBidAt, 1_000);

  bot.quotes.UP = { bestBid: 0.99, updatedAt: 199_000 };
  bot.processPositionExits(200_000);
  assert.equal(bot.trades[0].peakBid, 0.99);
  assert.equal(bot.trades[0].peakBidAt, 199_000);
  assert.equal(bot.trades[0].status, 'SETTLED');
  assert.equal(bot.trades[0].finalOutcome, 'TAKE_PROFIT');
});

test('own-side bid at 0.01 stops out and credits zero per share', () => {
  const bot = new ProbabilityBot({
    now: () => 1_000,
    priceFeed: { start() {}, snapshot() { return { status: 'live', ageMs: 1 }; } },
  });
  bot.market = { id: 'market', tokens: { UP: 'up-token', DOWN: 'down-token' } };
  bot.quotes = {
    UP: { bestBid: 0.01, updatedAt: 1_000 },
    DOWN: { bestBid: 0.99, updatedAt: 1_000 },
  };
  bot.trades = [{
    id: 'up-position', marketId: 'market', side: 'UP', windowEnd: 300_000,
    shares: 100, totalCost: 45, status: 'OPEN',
  }];

  bot.processPositionExits(1_000);

  assert.equal(bot.trades[0].status, 'SETTLED');
  assert.equal(bot.trades[0].finalOutcome, 'STOP_LOSS');
  assert.equal(bot.trades[0].closePrice, 0);
  assert.equal(bot.trades[0].grossPayout, 0);
  assert.ok(Math.abs(bot.trades[0].exitFees - 0.0693) < 1e-9);
  assert.ok(Math.abs(bot.trades[0].realizedPnl + 45.0693) < 1e-9);
  assert.ok(Math.abs(bot.cash - 9_999.9307) < 1e-9);
});

test('missing or stale own-side bids do not trigger exits', () => {
  const bot = new ProbabilityBot({
    now: () => 10_000,
    priceFeed: { start() {}, snapshot() { return { status: 'live', ageMs: 1 }; } },
  });
  bot.market = { id: 'market', tokens: { UP: 'up-token', DOWN: 'down-token' } };
  bot.quotes = {
    UP: { bestBid: null, updatedAt: 10_000 },
    DOWN: { bestBid: 0.01, updatedAt: 4_999 },
  };
  bot.trades = [
    { id: 'missing', marketId: 'market', side: 'UP', windowEnd: 300_000, shares: 100, totalCost: 45, status: 'OPEN' },
    { id: 'stale', marketId: 'market', side: 'DOWN', windowEnd: 300_000, shares: 100, totalCost: 45, status: 'OPEN' },
  ];

  bot.processPositionExits(10_000);

  assert.ok(bot.trades.every(trade => trade.status === 'OPEN'));
  assert.equal(bot.cash, 10_000);
});

test('window-end paper mark uses the last own-side token bid, not BTC reference', () => {
  const bot = new ProbabilityBot({
    now: () => 300_100,
    priceFeed: { start() {}, snapshot() { return { status: 'live', ageMs: 1 }; } },
  });
  bot.market = { id: 'next-market', tokens: { UP: 'next-up', DOWN: 'next-down' } };
  bot.trades = [{
    id: 'expired-up', marketId: 'old-market', side: 'UP', windowEnd: 300_000,
    shares: 100, totalCost: 45, status: 'OPEN', lastOutcomeBid: 0.64, lastOutcomeBidAt: 299_000,
  }];

  bot.processPositionExits(300_100);

  assert.equal(bot.trades[0].status, 'SETTLED');
  assert.equal(bot.trades[0].finalOutcome, 'WINDOW_PRICE_EXIT');
  assert.equal(bot.trades[0].closePrice, 0.64);
  assert.equal(bot.trades[0].grossPayout, 64);
  assert.ok(Math.abs(bot.trades[0].exitFees - 1.6128) < 1e-9);
  assert.ok(Math.abs(bot.trades[0].realizedPnl - 17.3872) < 1e-9);
  assert.ok(Math.abs(bot.cash - 10_062.3872) < 1e-9);
});

test('CLOB exits run even when the Chainlink reference feed is unavailable', async () => {
  const bot = new ProbabilityBot({
    now: () => 1_000,
    fetchMarket: async () => ({
      id: 'market', start: 0, end: 300_000, title: 'BTC Up or Down',
      tokens: { UP: 'up-token', DOWN: 'down-token' },
    }),
    fetchBook: async tokenId => tokenId === 'up-token'
      ? { bids: [{ price: 0.99, size: 100 }], asks: [] }
      : { bids: [{ price: 0.50, size: 100 }], asks: [] },
    priceFeed: {
      start() {},
      getTicks() { return []; },
      snapshot() { return { status: 'connecting', ageMs: Infinity }; },
    },
  });
  bot.trades = [{
    id: 'up-position', marketId: 'market', side: 'UP', windowEnd: 300_000,
    shares: 100, totalCost: 45, status: 'OPEN',
  }];

  await bot.tick();

  assert.equal(bot.trades[0].status, 'SETTLED');
  assert.equal(bot.trades[0].finalOutcome, 'TAKE_PROFIT');
  assert.ok(Math.abs(bot.trades[0].realizedPnl - 54.9307) < 1e-9);
  assert.match(bot.error, /Chainlink/);
});
