'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ProbabilityBot, estimateTakerFee } = require('./probability-bot');
const { STRATEGY_VERSION } = require('./midpoint-limit-strategy');
const { fixture } = require('./window-test-fixture.cjs');

function setBooks(bot, now, { upBids = [], upAsks = [], downBids = [], downAsks = [] } = {}) {
  bot.quotes = {
    UP: bot.quote({ bids: upBids, asks: upAsks }, now),
    DOWN: bot.quote({ bids: downBids, asks: downAsks }, now),
  };
}

function book(bid, ask, size = 10_000) {
  return {
    bids: [{ price: bid, size }],
    asks: [{ price: ask, size }],
  };
}

test('current strategy waits 120 seconds, latches the first qualifying midpoint, and records two limits', () => {
  const { bot, at } = fixture();
  const beforeTrigger = at(119);
  setBooks(bot, beforeTrigger, {
    ...book(0.79, 0.81),
    downBids: [{ price: 0.18, size: 10_000 }],
    downAsks: [{ price: 0.20, size: 10_000 }],
  });
  bot.processLimitOrderStrategy(beforeTrigger);
  assert.equal(bot.limitOrders.length, 0);

  const triggerAt = at(120);
  setBooks(bot, triggerAt, {
    upBids: [{ price: 0.79, size: 10_000 }],
    upAsks: [{ price: 0.81, size: 10_000 }],
    downBids: [{ price: 0.78, size: 10_000 }],
    downAsks: [{ price: 0.82, size: 10_000 }],
  });
  bot.processLimitOrderStrategy(triggerAt);

  assert.equal(bot.limitOrders.length, 2);
  assert.ok(bot.limitOrders.every(order => order.side === 'UP'));
  assert.deepEqual(bot.limitOrders.slice().sort((a, b) => a.slot - b.slot).map(order => [order.limitPrice, order.requestedShares]), [
    [0.4, 1000],
    [0.6, 2000],
  ]);
  assert.equal(bot.limitOrders.reduce((sum, order) => sum + order.reservedFunds, 0), 1600);
  assert.equal(bot.cash, 10_000);

  const state = bot.snapshot();
  assert.equal(state.strategy.version, STRATEGY_VERSION);
  assert.equal(state.strategy.makerFeeRate, 0);
  assert.equal(state.takerOrders, undefined);
  assert.equal(state.limitOrders.length, 2);
});

test('one observed share completes the full paper rung and estimates rebate on credited shares', () => {
  const { bot, at } = fixture();
  const triggerAt = at(120);
  setBooks(bot, triggerAt, {
    upBids: [{ price: 0.79, size: 10_000 }],
    upAsks: [{ price: 0.81, size: 10_000 }],
    downBids: [{ price: 0.19, size: 10_000 }],
    downAsks: [{ price: 0.21, size: 10_000 }],
  });
  bot.processLimitOrderStrategy(triggerAt);

  let now = at(121);
  setBooks(bot, now, {
    upBids: [{ price: 0.39, size: 5000 }],
    upAsks: [
      { price: 0.3999, size: 1000 },
      { price: 0.4001, size: 1000 },
      { price: 0.5999, size: 1000 },
      { price: 0.6, size: 1 },
      { price: 0.6001, size: 1000 },
    ],
  });
  bot.processRestingLimitOrders(now);

  const [lowRung, highRung] = bot.limitOrders.slice().sort((a, b) => a.slot - b.slot);
  assert.equal(lowRung.filledShares, 0);
  assert.equal(highRung.filledShares, 2000);
  assert.equal(highRung.observedFillShares, 1);
  assert.equal(highRung.remainingShares, 0);
  assert.equal(highRung.cancelledRemainderShares, 0);
  assert.equal(highRung.status, 'FILLED');
  assert.equal(highRung.averageFillPrice, 0.6);
  assert.equal(highRung.fees, 0);
  assert.equal(highRung.makerFees, 0);
  assert.equal(highRung.rebateStatus, 'PAPER_ESTIMATE_NOT_ACTUAL');
  assert.ok(highRung.rebateFeeEquivalent > 0);
  assert.equal(highRung.estimatedMakerRebate, highRung.rebateFeeEquivalent * 0.2);
  assert.equal(bot.trades.find(trade => trade.orderId === highRung.id).shares, 2000);
  assert.equal(bot.trades.find(trade => trade.orderId === highRung.id).observedFillShares, 1);
  assert.equal(bot.trades.find(trade => trade.orderId === highRung.id).simulatedFullOrderFill, true);
  assert.equal(highRung.filledCost, 1200);
  assert.equal(bot.cash, 8800);

  now = at(122);
  setBooks(bot, now, {
    upBids: [{ price: 0.39, size: 5000 }],
    upAsks: [
      { price: 0.4, size: 1000 },
      { price: 0.6, size: 1500 },
    ],
  });
  bot.processRestingLimitOrders(now);

  assert.equal(lowRung.filledShares, 1000);
  assert.equal(lowRung.averageFillPrice, 0.4);
  assert.equal(highRung.filledShares, 2000);
  assert.equal(highRung.averageFillPrice, 0.6);
  assert.equal(bot.cash, 8400);
  assert.equal(bot.trades.find(trade => trade.orderId === highRung.id).shares, 2000);
  assert.equal(bot.trades.reduce((sum, trade) => sum + trade.fees, 0), 0);
});

test('paper does not credit estimated rebates; exit taker fees remain modeled separately', () => {
  assert.ok(Math.abs(estimateTakerFee(0.5, 10) - 0.175) < 1e-12);
  assert.ok(Math.abs(estimateTakerFee(0.99, 10) - 0.00693) < 1e-12);
});

test('unfilled limits cancel at expiry and positions keep the existing resolution path', async () => {
  const savedResults = [];
  const { bot, at, start } = fixture({
    learningStore: {
      recordWindowResult: async result => savedResults.push(result),
      recordEvent: async () => {},
      recordSample: async () => {},
      recordEquitySnapshot: async () => {},
    },
  });
  let now = at(120);
  setBooks(bot, now, {
    upBids: [{ price: 0.79, size: 10_000 }],
    upAsks: [{ price: 0.81, size: 10_000 }],
    downBids: [{ price: 0.19, size: 10_000 }],
    downAsks: [{ price: 0.21, size: 10_000 }],
  });
  bot.processLimitOrderStrategy(now);
  bot.limitOrders[0].status = 'OPEN';
  bot.limitOrders[0].filledShares = 0;
  bot.limitOrders[0].remainingShares = 1000;
  bot.limitOrders[0].filledCost = 0;
  bot.trades.push({
    id: 'paper-position',
    marketId: bot.market.id,
    tokenId: 'u',
    windowStart: start,
    windowEnd: start + 300_000,
    marketTitle: 'BTC window',
    side: 'UP',
    shares: 1,
    entryPrice: 0.4,
    cost: 0.4,
    fees: 0,
    totalCost: 0.4,
    openedAt: now,
    status: 'OPEN',
    settlementStatus: 'OPEN',
  });

  now = at(300);
  bot.cancelExpiredLimitOrders(now);
  bot.processPositionExits(now);
  assert.equal(bot.limitOrders[0].status, 'CANCELLED_WINDOW_END');
  assert.equal(bot.limitOrders[1].status, 'CANCELLED_WINDOW_END');
  assert.equal(bot.trades[0].settlementStatus, 'AWAITING_SETTLEMENT');

  bot.market = null;
  bot.processPositionExits(start + 360_000);
  await bot.persistenceQueue;
  assert.equal(bot.trades[0].status, 'OPEN');
  assert.equal(savedResults.length, 0);
});

test('completed window analytics persist the current strategy version', async () => {
  const savedResults = [];
  const { bot, at, start } = fixture({
    learningStore: {
      recordWindowResult: async result => savedResults.push(result),
      recordEvent: async () => {},
      recordSample: async () => {},
      recordEquitySnapshot: async () => {},
    },
  });
  bot.windowResults.set(start, { entryCount: 1, settledCount: 1, netPnl: 1 });
  bot.finalizedWindowStarts.clear();
  bot.maybeFinalizeCompletedWindows(at(301));
  await bot.persistenceQueue;
  assert.equal(savedResults.length, 1);
  assert.equal(savedResults[0].strategyVersion, STRATEGY_VERSION);
  assert.equal(savedResults[0].outcome, 'WIN');
});
