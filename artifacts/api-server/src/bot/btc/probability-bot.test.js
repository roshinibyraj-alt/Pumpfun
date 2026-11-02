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

test('volatility uses only the latest fifteen closed five-minute candles', () => {
  const short = Array.from({ length: 9 }, (_, i) => ({ close: 100 + i }));
  const long = Array.from({ length: 21 }, (_, i) => ({ close: 100 + i + (i % 2) }));
  assert.equal(estimateLogReturnVolatility(short), null);
  assert.equal(estimateLogReturnVolatility(long), estimateLogReturnVolatility(long.slice(-15)));
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

test('continuous qualifying edge buys once; a real edge reset or new window permits another entry', () => {
  const bot = new ProbabilityBot({
    now: () => 1_000,
    priceFeed: { start() {}, snapshot() { return { status: 'live', ageMs: 1 }; } },
  });
  bot.market = { start: -30_000, end: 300_000, title: 'BTC Up or Down' };
  bot.pullback = { side: 'UP' };
  bot.probabilityUp = 0.8;
  bot.quotes = {
    UP: { bestAsk: 0.70, asks: [{ price: 0.70, size: 100 }] },
    DOWN: { bestAsk: 0.30, asks: [{ price: 0.30, size: 100 }] },
  };
  bot.edges = bot.calculateEdges();
  bot.processSignals(1_000);
  for (let i = 1; i <= 20; i++) bot.processSignals(1_000 + i * 25);
  assert.equal(bot.trades.length, 1);
  bot.edges.UP = null;
  bot.processSignals(1_600);
  bot.edges = bot.calculateEdges();
  bot.processSignals(1_700);
  assert.equal(bot.trades.length, 1);
  assert.equal(bot.trades[0].side, 'UP');
  assert.equal(bot.trades[0].shares, 100);

  bot.probabilityUp = 0.70;
  bot.edges = bot.calculateEdges();
  bot.processSignals(2_000);
  assert.equal(bot.trades.length, 1);
  bot.probabilityUp = 0.8;
  bot.edges = bot.calculateEdges();
  bot.processSignals(3_000);
  assert.equal(bot.trades.length, 2);
  bot.pullback = { side: null };
  bot.market = { start: 300_000, end: 600_000, title: 'Next window' };
  bot.processSignals(301_000);
  assert.equal(bot.trades.length, 3);
  assert.equal(bot.activeSide, 'UP');
  assert.ok(bot.trades.every(trade => trade.status === 'OPEN'));

  bot.probabilityUp = 0.70;
  bot.edges = bot.calculateEdges();
  bot.processSignals(301_250);
  bot.probabilityUp = 0.8;
  bot.edges = bot.calculateEdges();
  bot.cash = 0;
  bot.processSignals(301_500);
  assert.equal(bot.trades.length, 3);
  assert.equal(bot.armed.UP, true);
  bot.cash = 10_000;
  bot.quotes.UP.asks = [{ price: 0.70, size: 99 }];
  bot.processSignals(302_000);
  assert.equal(bot.trades.length, 3);
  bot.quotes.UP.asks = [{ price: 0.70, size: 100 }];
  bot.processSignals(302_500);
  assert.equal(bot.trades.length, 4);
  assert.equal(new Set(bot.trades.map(trade => trade.id)).size, 4);
  assert.equal(bot.snapshot().entryArmed.UP, false);
});

test('an opposite signal sells all accumulated positions before opening the other side', () => {
  const bot = new ProbabilityBot({
    now: () => 1_000,
    priceFeed: { start() {}, snapshot() { return { status: 'live', ageMs: 1 }; } },
  });
  bot.market = { id: 'market', start: -30_000, end: 300_000, title: 'BTC Up or Down' };
  bot.pullback = { side: 'UP' };
  bot.probabilityUp = 0.8;
  bot.quotes = {
    UP: { bestAsk: 0.70, asks: [{ price: 0.70, size: 100 }] },
    DOWN: { bestAsk: 0.30, asks: [{ price: 0.30, size: 100 }] },
  };
  bot.edges = bot.calculateEdges();
  bot.processSignals(1_000);
  bot.probabilityUp = 0.70;
  bot.edges = bot.calculateEdges();
  bot.processSignals(1_250);
  bot.probabilityUp = 0.8;
  bot.edges = bot.calculateEdges();
  bot.processSignals(1_500);

  bot.quotes.UP.bestBid = 0.65;
  bot.quotes.UP.updatedAt = 2_000;
  bot.pullback = { side: 'DOWN' };
  bot.probabilityUp = 0.4;
  bot.edges = bot.calculateEdges();
  bot.processSignals(2_000);

  assert.deepEqual(bot.trades.map(trade => [trade.side, trade.status]), [
    ['DOWN', 'OPEN'],
    ['UP', 'SETTLED'],
    ['UP', 'SETTLED'],
  ]);
  assert.equal(bot.trades[1].finalOutcome, 'OPPOSITE_SIGNAL');
  assert.equal(bot.trades[1].grossPayout, 65);
  assert.ok(bot.trades[1].exitFees > 0);
  assert.ok(bot.trades.slice(1).every(trade => trade.finalOutcome === 'OPPOSITE_SIGNAL'));

  bot.quotes.DOWN.bestBid = 0.35;
  bot.quotes.DOWN.updatedAt = 3_000;
  bot.pullback = { side: 'UP' };
  bot.probabilityUp = 0.8;
  bot.edges = bot.calculateEdges();
  bot.processSignals(3_000);
  assert.equal(bot.trades.length, 4);
  assert.equal(bot.trades[0].side, 'UP');
  assert.equal(bot.trades.filter(trade => trade.status === 'OPEN').length, 1);
  assert.equal(bot.trades[1].finalOutcome, 'OPPOSITE_SIGNAL');
});

test('a transient missing signal preserves bias and keeps accumulating eligible entries', () => {
  const bot = new ProbabilityBot({
    now: () => 1_000,
    priceFeed: { start() {}, snapshot() { return { status: 'live', ageMs: 1 }; } },
  });
  bot.market = { id: 'market', start: -30_000, end: 300_000, title: 'BTC Up or Down' };
  bot.pullback = { side: 'UP' };
  bot.probabilityUp = 0.8;
  bot.quotes = {
    UP: { bestAsk: 0.70, asks: [{ price: 0.70, size: 100 }] },
    DOWN: { bestAsk: 0.30, asks: [{ price: 0.30, size: 100 }] },
  };
  bot.edges = bot.calculateEdges();
  bot.processSignals(1_000);
  assert.equal(bot.trades.length, 1);

  bot.pullback = { side: null };
  bot.probabilityUp = 0.5;
  bot.edges = bot.calculateEdges();
  bot.processSignals(2_000);
  bot.pullback = { side: 'UP' };
  bot.probabilityUp = 0.8;
  bot.edges = bot.calculateEdges();
  bot.processSignals(3_000);

  assert.equal(bot.trades.length, 2);
  assert.equal(bot.activeSide, 'UP');
});

test('learning samples follow the 500ms repeated-entry scan cadence', async () => {
  const samples = [];
  const bot = new ProbabilityBot({
    learningStore: { recordSample: async sample => samples.push(sample) },
    priceFeed: { start() {}, snapshot() { return { status: 'live', ageMs: 1 }; } },
  });
  bot.market = { start: 0, end: 300_000 };
  await bot.captureLearningSample(1_000);
  await bot.captureLearningSample(1_250);
  await bot.captureLearningSample(1_500);
  await bot.persistenceQueue;
  assert.deepEqual(samples.map(sample => sample.ts), [1_000, 1_500]);
});

test('any best ask below $0.02 blocks both sides; $0.02 is allowed', () => {
  const bot = new ProbabilityBot({
    now: () => 1_000,
    priceFeed: { start() {}, snapshot() { return { status: 'live', ageMs: 1 }; } },
  });
  bot.market = { start: -30_000, end: 300_000, title: 'BTC Up or Down' };
  bot.pullback = { side: 'UP' };
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

test('allows a confirmed signal immediately with no opening delay', () => {
  const bot = new ProbabilityBot({
    now: () => 1_000,
    priceFeed: { start() {}, snapshot() { return { status: 'live', ageMs: 1 }; } },
  });
  bot.market = { start: 0, end: 300_000, title: 'BTC Up or Down' };
  bot.pullback = { side: 'UP' };
  bot.probabilityUp = 0.8;
  bot.quotes = {
    UP: { bestAsk: 0.70, asks: [{ price: 0.70, size: 100 }] },
    DOWN: { bestAsk: 0.30, asks: [{ price: 0.30, size: 100 }] },
  };
  bot.edges = bot.calculateEdges();

  bot.processSignals(1_000);
  assert.equal(bot.entryFilter.allowed, true);
  assert.equal(bot.entryFilter.openingDelayActive, false);
  assert.equal(bot.trades.length, 1);
  assert.equal(bot.trades[0].side, 'UP');
  assert.equal(bot.snapshot().strategy.openingDelaySeconds, 0);
});

test('requires 10 percent net edge when the executable average ask is below $0.25', () => {
  const bot = new ProbabilityBot({
    now: () => 30_000,
    priceFeed: { start() {}, snapshot() { return { status: 'live', ageMs: 1 }; } },
    strategySettings: { sideMode: 'UP-only' },
  });
  bot.market = { start: 0, end: 300_000, title: 'BTC Up or Down' };
  bot.pullback = { side: 'UP' };
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

  bot.probabilityUp = 0.52;
  bot.edges = bot.calculateEdges();
  bot.processSignals(31_000);
  assert.equal(bot.trades.length, 1);
  assert.equal(bot.trades[0].requiredNetEdge, 0.10);
});

test('allows a positive-edge paper buy below 50% and keeps logging its probability', () => {
  const bot = new ProbabilityBot({
    now: () => 30_000,
    priceFeed: { start() {}, snapshot() { return { status: 'live', ageMs: 1 }; } },
    strategySettings: { sideMode: 'UP-only' },
  });
  bot.market = { start: 0, end: 300_000, title: 'BTC Up or Down' };
  bot.pullback = { side: 'UP' };
  bot.quotes = {
    UP: { bestAsk: 0.30, asks: [{ price: 0.30, size: 100 }] },
    DOWN: { bestAsk: 0.30, asks: [{ price: 0.30, size: 100 }] },
  };

  bot.probabilityUp = 0.49;
  bot.edges = bot.calculateEdges();
  bot.processSignals(30_000);
  assert.equal(bot.trades.length, 1);
  assert.equal(bot.trades[0].modelProbability, 0.49);
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

test('keeps every open share in the side totals after the trade-history limit', () => {
  const bot = new ProbabilityBot({
    now: () => 30_000,
    priceFeed: { start() {}, snapshot() { return { status: 'live', ageMs: 1 }; } },
  });
  bot.market = { id: 'market', start: 0, end: 300_000, title: 'BTC Up or Down' };
  bot.pullback = { side: 'UP' };
  bot.probabilityUp = 0.8;
  bot.quotes = {
    UP: { bestAsk: 0.70, asks: [{ price: 0.70, size: 100 }] },
    DOWN: { bestAsk: 0.30, asks: [{ price: 0.30, size: 100 }] },
  };
  bot.edges = bot.calculateEdges();
  bot.trades = Array.from({ length: 200 }, (_, index) => ({
    id: `open-${index}`, marketId: 'market', side: 'UP', shares: 100,
    totalCost: 70, status: 'OPEN',
  }));

  bot.processSignals(30_000);

  assert.equal(bot.trades.filter(trade => trade.status === 'OPEN').length, 201);
  assert.equal(bot.snapshot().paperAccount.positions.UP.shares, 20_100);
});

test('own-side bid at 0.99 keeps the position open without take-profit', () => {
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

  assert.equal(bot.trades[0].status, 'OPEN');
  assert.equal(bot.trades[0].peakBid, 0.99);
  assert.equal(bot.cash, 10_000);
  assert.equal(bot.snapshot().strategy.takeProfitBid, null);
  assert.equal(bot.snapshot().strategy.pollIntervalMs, 500);
});

test('tracks the highest fresh own-side bid while exits remain active', () => {
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
  assert.equal(bot.trades[0].status, 'OPEN');
});

test('own-side bid at 0.01 keeps the position open without stop-loss', () => {
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

  assert.equal(bot.trades[0].status, 'OPEN');
  assert.equal(bot.trades[0].lastOutcomeBid, 0.01);
  assert.equal(bot.cash, 10_000);
  assert.equal(bot.snapshot().strategy.stopLossBid, null);
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

test('CLOB bid tracking continues without early exits when the reference feed is unavailable', async () => {
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

  assert.equal(bot.trades[0].status, 'OPEN');
  assert.equal(bot.trades[0].peakBid, 0.99);
  assert.match(bot.error, /Chainlink/);
});
