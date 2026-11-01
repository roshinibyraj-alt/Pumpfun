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
