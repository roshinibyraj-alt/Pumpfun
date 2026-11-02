'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyHistogram, detectMacdHistogram, ema, METHOD } = require('./macd-signal');
const { sweepBook } = require('./book-sweep');
const { ProbabilityBot } = require('./probability-bot');

const candles = closes => closes.map((close, i) => ({
  start: i * 60_000, end: (i + 1) * 60_000, close,
}));

test('all four histogram states and zero/unchanged bars match the requested directions', () => {
  for (const [current, previous, side, classification] of [
    [-1, -2, 'UP', 'SHRINKING_RED'], [2, 1, 'UP', 'SOLID_GREEN'],
    [1, 2, 'DOWN', 'SHRINKING_GREEN'], [-2, -1, 'DOWN', 'SOLID_RED'],
    [0, 1, null, 'NEUTRAL'], [1, 1, null, 'NEUTRAL'], [-1, -1, null, 'NEUTRAL'],
    [1, -1, 'UP', 'SOLID_GREEN'], [-1, 1, 'DOWN', 'SOLID_RED'],
  ]) assert.deepEqual(classifyHistogram(current, previous), { side, classification });
});

test('standard SMA-seeded EMA and analytic linear MACD values are correct', () => {
  assert.deepEqual(ema([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
  const state = detectMacdHistogram(candles(Array.from({ length: 100 }, (_, i) => 100 + i)), 6_000_000);
  assert.equal(state.method, METHOD);
  assert.equal(state.status, 'READY');
  assert.equal(state.chart.bars.length, 50);
  assert.ok(state.chart.bars.every(b => Math.abs(b.macd - 7) < 1e-10
    && Math.abs(b.signal - 7) < 1e-10 && Math.abs(b.histogram) < 1e-10));
});

test('MACD ignores forming candles and rejects stale, insufficient and discontinuous history', () => {
  const rows = candles(Array.from({ length: 60 }, (_, i) => 100 + i * i));
  const at = rows.at(-1).end;
  const state = detectMacdHistogram(rows, at);
  assert.equal(state.side, 'UP');
  assert.equal(state.classification, 'SOLID_GREEN');
  assert.deepEqual(detectMacdHistogram([...rows, { start: at, end: at + 60_000, close: 1 }], at), state);
  assert.equal(detectMacdHistogram(rows.slice(0, 34), at).status, 'WAITING_HISTORY');
  assert.equal(detectMacdHistogram(rows.slice(0, 35), 35 * 60_000).status, 'READY');
  assert.equal(detectMacdHistogram(rows, at + 90_001).side, null);
  assert.equal(detectMacdHistogram(rows, at + 90_001).status, 'STALE');
  assert.equal(detectMacdHistogram(rows.filter((_, i) => i !== 40), at).status, 'INVALID_HISTORY');
});

test('sweeps all real price levels with exact per-level fees and exposes a genuine shortfall', () => {
  const fill = sweepBook([{ price: .5, size: 100 }, { price: .3, size: 200 }], 400, 'sell');
  assert.equal(fill.shares, 300);
  assert.equal(fill.cost, 110);
  assert.equal(fill.remainingShares, 100);
  assert.ok(Math.abs(fill.fees - (100 * .07 * .5 * .5 + 200 * .07 * .3 * .7)) < 1e-10);
  assert.deepEqual(fill.remainingLevels, []);
  assert.equal(sweepBook([], 100, 'buy'), null);
});

function reversalBot(shares = 400) {
  const bot = new ProbabilityBot({ priceFeed: { start() {} }, activeSide: 'UP', now: () => 1_000 });
  bot.market = { id: 'm', start: 0, end: 300_000, tokens: { UP: 'u', DOWN: 'd' } };
  bot.beginMarketWindow();
  bot.trades = [{
    id: 'old', marketId: 'm', side: 'UP', windowStart: 0, windowEnd: 300_000,
    openedAt: 0, status: 'OPEN', shares, cost: shares * .4, fees: 0, totalCost: shares * .4,
  }];
  bot.quotes = {
    UP: { updatedAt: 1_000, bestBid: .5, bestAsk: .55,
      bids: [{ price: .5, size: 100 }, { price: .35, size: 300 }],
      asks: [{ price: .55, size: 1000 }] },
    DOWN: { updatedAt: 1_000, bestBid: .3, bestAsk: .2,
      bids: [{ price: .3, size: 1000 }],
      asks: [{ price: .2, size: 100 }, { price: .3, size: 100 }, { price: .4, size: 200 }] },
  };
  bot.applyPullbackSignal({ method: METHOD, side: 'DOWN', signalSource: 'CLOSED_CANDLE',
    signalAt: 60_000, signalReason: 'MACD_SHRINKING_GREEN' });
  bot.probabilityUp = .1;
  return bot;
}

test('reversal aggregates old-side shares and buys that exact quantity, not default100, across deep levels', () => {
  const bot = reversalBot();
  bot.processOppositeSignalExits(1_000);
  const old = bot.trades[0];
  assert.equal(old.status, 'SETTLED');
  assert.equal(old.grossPayout, 155);
  assert.ok(Math.abs(old.exitFees - (100 * .07 * .5 * .5 + 300 * .07 * .35 * .65)) < 1e-9);
  assert.equal(bot.pendingReversal.shares, 400);
  bot.edges = bot.calculateEdges();
  bot.processSignals(1_000);
  assert.equal(bot.trades[0].shares, 400);
  assert.equal(bot.trades[0].side, 'DOWN');
  assert.equal(bot.trades[0].entryPrice, .325);
  assert.equal(bot.trades[0].entryKind, 'MATCHED_REVERSAL');
  assert.equal(bot.pendingReversal, null);
  bot.processSignals(1_000);
  assert.equal(bot.trades.length, 2);
});

test('partial ask liquidity fills only actual shares and leaves exactly the remaining reversal pending', () => {
  const bot = reversalBot();
  bot.probabilityUp = .9; // Both partial reversal fills must bypass negative net edge.
  bot.quotes.DOWN.asks = [{ price: .2, size: 120 }];
  bot.processOppositeSignalExits(1_000);
  bot.edges = bot.calculateEdges();
  bot.processSignals(1_000);
  assert.equal(bot.trades[0].shares, 120);
  assert.equal(bot.pendingReversal.shares, 280);
  bot.edges = bot.calculateEdges();
  bot.processSignals(1_000);
  assert.equal(bot.trades.length, 2); // Consumed depth cannot be reused in this quote.
  bot.quotes.DOWN.asks = [{ price: .3, size: 280 }];
  bot.quotes.DOWN.updatedAt = 2_000;
  bot.edges = bot.calculateEdges();
  bot.processSignals(2_000);
  assert.equal(bot.pendingReversal, null);
  assert.equal(bot.trades.filter(t => t.side === 'DOWN').reduce((n, t) => n + t.shares, 0), 400);
});

test('partial bid liquidity preserves the remaining old position and cannot fabricate sold shares', () => {
  const bot = reversalBot();
  bot.quotes.UP.bids = [{ price: .5, size: 150 }];
  bot.processOppositeSignalExits(1_000);
  assert.equal(bot.pendingReversal.shares, 150);
  assert.equal(bot.trades.find(t => t.status === 'OPEN').shares, 250);
  assert.equal(bot.trades.find(t => t.status === 'OPEN').totalCost, 100);
  bot.edges = bot.calculateEdges();
  bot.processSignals(1_000);
  assert.equal(bot.trades.some(t => t.side === 'DOWN'), false);
  bot.quotes.UP.bids = [{ price: .35, size: 250 }];
  bot.processOppositeSignalExits(2_000);
  assert.equal(bot.pendingReversal.shares, 400);
  bot.edges = bot.calculateEdges();
  bot.processSignals(2_000);
  assert.equal(bot.trades[0].shares, 400);
  assert.equal(bot.trades.filter(t => t.finalOutcome === 'OPPOSITE_SIGNAL').reduce((n, t) => n + t.shares, 0), 400);
});

test('cash still blocks a matched reversal without losing its target even when edge is bypassed', () => {
  const bot = reversalBot();
  bot.processOppositeSignalExits(1_000);
  bot.probabilityUp = .9;
  bot.edges = bot.calculateEdges();
  bot.cash = 1;
  bot.processSignals(1_000);
  assert.equal(bot.pendingReversal.shares, 400);
  assert.equal(bot.trades.length, 1);
  bot.market = { id: 'next', start: 300_000, end: 600_000 };
  bot.beginMarketWindow();
  assert.equal(bot.pendingReversal, null);
  assert.equal(bot.activeSide, 'DOWN');
});

for (const probabilityUp of [.9, .63]) {
  test(`matched reversal buys all400 sold shares at sub-threshold edge with UP probability${probabilityUp}`, () => {
    const bot = reversalBot();
    bot.processOppositeSignalExits(1_000);
    bot.probabilityUp = probabilityUp;
    bot.edges = bot.calculateEdges();
    assert.ok(bot.edges.DOWN < .05);
    bot.armed.DOWN = false;
    bot.processSignals(1_000);
    assert.equal(bot.pendingReversal, null);
    assert.equal(bot.trades[0].side, 'DOWN');
    assert.equal(bot.trades[0].shares, 400);
    assert.equal(bot.trades[0].edgeGateBypassed, true);
    assert.equal(bot.trades[0].entryKind, 'MATCHED_REVERSAL');
    bot.quotes.DOWN.asks = [{ price: .3, size: 1000 }];
    bot.edges = bot.calculateEdges();
    bot.processSignals(2_000);
    assert.equal(bot.trades.length, 2); // No pending target: ordinary negative-edge entries still blocked.
  });
}

test('ordinary entries cannot use the reversal exemption without shares actually sold', () => {
  const bot = reversalBot();
  bot.trades = [];
  bot.probabilityUp = .9;
  bot.edges = bot.calculateEdges();
  bot.processSignals(1_000);
  assert.equal(bot.trades.length, 0);
  assert.equal(bot.pendingReversal, null);
});
