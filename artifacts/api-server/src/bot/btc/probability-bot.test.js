'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ProbabilityBot } = require('./probability-bot');
const { STRATEGY_VERSION } = require('./renko-strategy');

const START = 1_800_000_000_000;
const market = {
  id: 'btc-5m-market',
  title: 'BTC Up or Down',
  start: START,
  end: START + 300_000,
  tokens: { UP: 'up-token', DOWN: 'down-token' },
  raw: { feesEnabled: true, feeSchedule: { rate: 0.07, exponent: 1 } },
};

function createBot() {
  let now = START;
  const historicalCandles = Array.from({ length: 16 }, (_, index) => ({
    t: START - ((16 - index) * 60_000),
    o: 100,
    h: 101,
    l: 99,
    c: 100,
  }));
  const liveCandles = [];
  const priceFeed = {
    start() {},
    snapshot() { return { status: 'live', ageMs: 1 }; },
    getHistoricalMinuteCandles() { return historicalCandles; },
    getMinuteCandles() { return liveCandles; },
    getTicks() { return [{ ts: now, price: 100 }]; },
  };
  const bot = new ProbabilityBot({
    now: () => now,
    priceFeed,
    fetchMarket: async () => market,
    fetchBook: async () => ({ bids: [], asks: [] }),
    fetchMarketDetails: async () => null,
  });
  bot.market = market;
  bot.beginMarketWindow(START, now);
  return {
    bot,
    setNow(value) { now = value; },
    getNow() { return now; },
    addCandle(candle) { liveCandles.push(candle); },
  };
}

function setAsks(bot, now, side, asks, bid = 0.4) {
  bot.quotes[side] = bot.quote({
    bids: bid == null ? [] : [{ price: bid, size: 10_000 }],
    asks,
  }, now);
}

test('a confirmed green Renko brick buys only UP in one $10,000 signal account', () => {
  const { bot, setNow, addCandle } = createBot();
  const candleAt = START;
  addCandle({ t: candleAt, o: 100, h: 102, l: 100, c: 102 });
  setNow(START + 60_000);
  bot.tickCount = 1;
  setAsks(bot, START + 60_000, 'UP', [{ price: 0.45, size: 200 }, { price: 0.55, size: 400 }]);
  bot.processRenkoStrategy(START + 60_000);
  assert.equal(bot.entryOrders.length, 1);
  assert.equal(bot.entryOrders[0].status, 'PENDING_CONFIRMATION');
  assert.equal(bot.trades.length, 0);
  assert.equal(bot.renkoState.brickSize, 2);
  assert.equal(bot.renkoState.selectedSide, 'UP');

  setNow(START + 60_500);
  bot.tickCount = 2;
  setAsks(bot, START + 60_500, 'UP', [{ price: 0.55, size: 400 }, { price: 0.45, size: 200 }]);
  bot.processRenkoStrategy(START + 60_500);
  bot.processPendingTakerOrders(START + 60_500);

  const [order] = bot.entryOrders;
  const [trade] = bot.trades;
  assert.equal(order.status, 'FILLED');
  assert.equal(order.filledShares, 100);
  assert.equal(order.cancelledRemainderShares, 0);
  assert.equal(order.averageFillPrice, 0.45);
  assert.ok(Math.abs(order.fees - 1.7325) < 1e-12);
  assert.equal(order.signalSide, 'UP');
  assert.equal(order.side, 'UP');
  assert.equal(trade.signalSide, 'UP');
  assert.equal(trade.side, 'UP');
  assert.equal(trade.orderType, 'TAKER');
  assert.equal(trade.shares, 100);
  assert.equal(bot.takeProfitOrders, undefined);
  assert.ok(Math.abs(bot.cash - (10_000 - 46.7325)) < 1e-9);
  assert.equal(bot.snapshot().takeProfitOrders, undefined);
  assert.equal(bot.snapshot().paperAccount.startingCash, 10_000);
  assert.deepEqual(Object.keys(bot.snapshot().variants), ['signal']);
  assert.match(bot.snapshot().strategy.exitModel, /best bid reaches \$0\.99/i);
  assert.match(bot.snapshot().strategy.exitModel, /credited at \$1 per share/i);
  assert.equal(bot.tradeSideFor('UP'), 'UP');
  assert.equal(bot.tradeSideFor('DOWN'), 'DOWN');
  assert.equal(bot.snapshot().strategy.version, STRATEGY_VERSION);
});

test('there is no against-signal account or strategy rotation', () => {
  const { bot } = createBot();
  const state = bot.snapshot();
  assert.equal(state.paperAccount.startingCash, 10_000);
  assert.deepEqual(Object.keys(state.variants), ['signal']);
  assert.equal(state.variants.signal.shareSize, 100);
  assert.equal(state.activeVariantId, 'signal');
  assert.equal(state.variants.against, undefined);
});

test('a closed red Renko brick buys DOWN on the signal-following version', () => {
  const { bot, setNow, addCandle } = createBot();
  addCandle({ t: START, o: 100, h: 100, l: 98, c: 98 });
  setNow(START + 60_000);
  bot.tickCount = 1;
  bot.processRenkoStrategy(START + 60_000);
  assert.equal(bot.entrySignal.selectedSide, 'DOWN');
  assert.equal(bot.entryOrders[0].signalSide, 'DOWN');
  assert.equal(bot.entryOrders[0].side, 'DOWN');
  assert.equal(bot.entryOrders[0].tokenId, market.tokens.DOWN);
});

test('a flat Renko interval holds an open position without placing a sell', () => {
  const { bot, setNow, addCandle } = createBot();
  addCandle({ t: START, o: 100, h: 102, l: 100, c: 102 });
  setNow(START + 60_000);
  bot.tickCount = 1;
  setAsks(bot, START + 60_000, 'UP', [{ price: 0.45, size: 100 }]);
  bot.processRenkoStrategy(START + 60_000);
  bot.tickCount = 2;
  setNow(START + 60_500);
  bot.processRenkoStrategy(START + 60_500);
  bot.processPendingTakerOrders(START + 60_500);
  assert.equal(bot.trades[0].status, 'OPEN');

  setNow(START + 70_000);
  bot.tickCount = 3;
  bot.processRenkoStrategy(START + 70_000);
  assert.equal(bot.renkoState.newBrickPrinted, false);
  assert.equal(bot.entryOrders.filter(order => order.action === 'SELL').length, 0);
  assert.equal(bot.trades[0].status, 'OPEN');
});

test('a failed reversal sell is not retried again until another opposite brick prints', () => {
  const { bot, setNow, addCandle } = createBot();
  addCandle({ t: START, o: 100, h: 102, l: 100, c: 102 });
  setNow(START + 60_000);
  bot.tickCount = 1;
  setAsks(bot, START + 60_000, 'UP', [{ price: 0.45, size: 100 }]);
  bot.processRenkoStrategy(START + 60_000);
  bot.tickCount = 2;
  setNow(START + 60_500);
  bot.processRenkoStrategy(START + 60_500);
  bot.processPendingTakerOrders(START + 60_500);
  assert.equal(bot.trades[0].status, 'OPEN');

  addCandle({ t: START + 60_000, o: 102, h: 102, l: 98, c: 98 });
  setNow(START + 120_000);
  bot.tickCount = 3;
  setAsks(bot, START + 120_000, 'UP', [], null);
  bot.processRenkoStrategy(START + 120_000);
  bot.tickCount = 4;
  setNow(START + 120_500);
  setAsks(bot, START + 120_500, 'UP', [], null);
  bot.processRenkoStrategy(START + 120_500);
  bot.processPendingTakerOrders(START + 120_500);
  assert.equal(bot.entryOrders.filter(order => order.action === 'SELL').length, 1);
  assert.equal(bot.entryOrders.find(order => order.action === 'SELL').status, 'CANCELLED_NO_VISIBLE_BIDS');

  setNow(START + 130_000);
  bot.tickCount = 5;
  bot.processRenkoStrategy(START + 130_000);
  assert.equal(bot.renkoState.newBrickPrinted, false);
  assert.equal(bot.entryOrders.filter(order => order.action === 'SELL').length, 1);
  assert.equal(bot.trades[0].status, 'OPEN');
});

test('an opposite red Renko brick sells UP first, then submits a DOWN buy', () => {
  const { bot, setNow, addCandle } = createBot();
  addCandle({ t: START, o: 100, h: 102, l: 100, c: 102 });
  setNow(START + 60_000);
  bot.tickCount = 1;
  setAsks(bot, START + 60_000, 'UP', [{ price: 0.45, size: 100 }]);
  bot.processRenkoStrategy(START + 60_000);
  bot.tickCount = 2;
  setNow(START + 60_500);
  bot.processRenkoStrategy(START + 60_500);
  bot.processPendingTakerOrders(START + 60_500);
  assert.equal(bot.trades[0].side, 'UP');
  assert.equal(bot.trades[0].status, 'OPEN');

  addCandle({ t: START + 60_000, o: 102, h: 102, l: 98, c: 98 });
  setNow(START + 120_000);
  bot.tickCount = 3;
  setAsks(bot, START + 120_000, 'UP', [], 0.4);
  setAsks(bot, START + 120_000, 'DOWN', [{ price: 0.45, size: 100 }]);
  bot.processRenkoStrategy(START + 120_000);
  const sell = bot.entryOrders.find(order => order.action === 'SELL');
  assert.ok(sell);
  assert.equal(sell.side, 'UP');
  assert.equal(sell.targetSide, 'DOWN');
  assert.equal(sell.status, 'PENDING_CONFIRMATION');

  setNow(START + 120_500);
  bot.tickCount = 4;
  bot.processRenkoStrategy(START + 120_500);
  bot.processPendingTakerOrders(START + 120_500);
  assert.equal(sell.status, 'FILLED');
  const closedUp = bot.trades.find(trade => trade.side === 'UP');
  assert.equal(closedUp.status, 'SETTLED');
  assert.equal(closedUp.finalOutcome, 'RENKO_SIGNAL_REVERSAL');
  assert.ok(closedUp.exitFees > 0);
  const downBuy = bot.entryOrders.find(order => order.action === 'BUY' && order.side === 'DOWN');
  assert.equal(downBuy.status, 'PENDING_CONFIRMATION');

  setNow(START + 121_000);
  bot.tickCount = 5;
  setAsks(bot, START + 121_000, 'DOWN', [{ price: 0.45, size: 100 }]);
  bot.processRenkoStrategy(START + 121_000);
  bot.processPendingTakerOrders(START + 121_000);
  assert.equal(downBuy.status, 'FILLED');
  assert.equal(bot.trades.find(trade => trade.side === 'DOWN').status, 'OPEN');
});

test('a Renko entry is not fabricated when the next-tick ask book is empty', () => {
  const { bot, setNow, addCandle } = createBot();
  addCandle({ t: START, o: 100, h: 102, l: 100, c: 102 });
  setNow(START + 60_000);
  bot.tickCount = 1;
  setAsks(bot, START + 60_000, 'UP', []);
  bot.processRenkoStrategy(START + 60_000);
  setNow(START + 60_500);
  bot.tickCount = 2;
  setAsks(bot, START + 60_500, 'UP', []);
  bot.processRenkoStrategy(START + 60_500);
  bot.processPendingTakerOrders(START + 60_500);
  assert.equal(bot.entryOrders[0].status, 'CANCELLED_NO_VISIBLE_ASKS');
  assert.equal(bot.entryOrders[0].filledShares, 0);
  assert.equal(bot.trades.length, 0);
  assert.equal(bot.entryOrders.length, 1);
});

test('no order is submitted before a closed one-minute candle prints a Renko brick', () => {
  const { bot } = createBot();
  bot.beginMarketWindow(START, START + 1_000);
  bot.processRenkoStrategy(START + 1_000);
  assert.equal(bot.entryOrders.length, 0);
  assert.equal(bot.entrySideSelection.status, 'WAITING_FOR_RENKO_BRICK');
});

test('a fresh $0.99 bid triggers take-profit and credits $1 per share without exit fees', () => {
  const { bot, setNow } = createBot();
  const trade = {
    id: 'test-trade',
    marketId: market.id,
    tokenId: market.tokens.UP,
    windowStart: START,
    windowEnd: START + 300_000,
    side: 'UP',
    shares: 10,
    entryPrice: 0.75,
    totalCost: 7.5,
    takeProfitPrice: 0.99,
    feeRate: 0.07,
    feeExponent: 1,
    openedAt: START,
    status: 'OPEN',
    settlementStatus: 'OPEN',
  };
  bot.trades = [trade];
  bot.cash -= trade.totalCost;

  setNow(START + 10_000);
  bot.quotes.UP = bot.quote({
    bids: [{ price: 0.99, size: 5 }],
    asks: [],
  }, START + 10_000);
  bot.processPositionExits(START + 10_000);
  assert.equal(trade.status, 'OPEN');
  assert.equal(trade.takeProfitOrder.status, 'RESTING');

  setNow(START + 10_500);
  bot.quotes.UP = bot.quote({
    bids: [{ price: 0.99, size: 10 }],
    asks: [],
  }, START + 10_500);
  bot.processPositionExits(START + 10_500);
  assert.equal(trade.status, 'SETTLED');
  assert.equal(trade.finalOutcome, 'TAKE_PROFIT_099');
  assert.equal(trade.takeProfitOrder.status, 'FILLED');
  assert.equal(trade.exitPrice, 0.99);
  assert.equal(trade.grossPayout, 10);
  assert.equal(trade.exitFees, 0);
  assert.equal(trade.realizedPnl, 2.5);
  assert.equal(trade.exitExecutionRole, 'MAKER');
});

test('if TP does not hit before expiry, position awaits exact original-market resolution', () => {
  const { bot, setNow } = createBot();
  const trade = {
    id: 'expiry-trade',
    marketId: market.id,
    tokenId: market.tokens.UP,
    windowStart: START,
    windowEnd: START + 300_000,
    side: 'UP',
    shares: 10,
    entryPrice: 0.75,
    totalCost: 7.5,
    takeProfitPrice: 0.99,
    feeRate: 0.07,
    feeExponent: 1,
    openedAt: START,
    status: 'OPEN',
    settlementStatus: 'OPEN',
  };
  bot.trades = [trade];
  bot.cash -= trade.totalCost;
  setNow(START + 299_000);
  setAsks(bot, START + 299_000, 'UP', [], 0.98);
  bot.processPositionExits(START + 299_000);
  assert.equal(trade.status, 'OPEN');

  setNow(START + 300_000);
  bot.processPositionExits(START + 300_000);
  assert.equal(trade.status, 'OPEN');
  assert.equal(trade.settlementStatus, 'AWAITING_SETTLEMENT');
  assert.match(trade.settlementError, /before the \$0\.99 take-profit/i);
});
