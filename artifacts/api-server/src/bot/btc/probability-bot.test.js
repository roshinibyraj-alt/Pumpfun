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

test('a green Renko signal places the two UP limit buys and fills only touched depth', () => {
  const { bot, setNow, addCandle } = createBot();
  const candleAt = START;
  addCandle({ t: candleAt, o: 100, h: 102, l: 100, c: 102 });
  setNow(START + 60_000);
  bot.tickCount = 1;
  setAsks(bot, START + 60_000, 'UP', [{ price: 0.45, size: 200 }, { price: 0.55, size: 400 }]);
  bot.processRenkoStrategy(START + 60_000);
  bot.processLimitOrders(START + 60_000);
  assert.equal(bot.entryOrders.length, 2);
  assert.deepEqual(bot.entryOrders.map(order => [order.limitPrice, order.requestedShares]).sort(),
    [[0.3, 100], [0.4, 200]]);
  assert.ok(bot.entryOrders.every(order => order.status === 'RESTING'));
  assert.equal(bot.trades.length, 0);
  assert.equal(bot.renkoState.brickSize, 2);
  assert.equal(bot.renkoState.selectedSide, 'UP');

  setNow(START + 60_500);
  bot.tickCount = 2;
  setAsks(bot, START + 60_500, 'UP', [{ price: 0.39, size: 200 }]);
  bot.processRenkoStrategy(START + 60_500);
  bot.processLimitOrders(START + 60_500);

  const highRung = bot.entryOrders.find(order => order.limitPrice === 0.4);
  const lowRung = bot.entryOrders.find(order => order.limitPrice === 0.3);
  assert.equal(highRung.status, 'FILLED');
  assert.equal(highRung.filledShares, 200);
  assert.equal(highRung.averageFillPrice, 0.4);
  assert.equal(highRung.fees, 0);
  assert.equal(lowRung.status, 'RESTING');
  assert.equal(lowRung.filledShares, 0);

  setNow(START + 61_000);
  bot.tickCount = 3;
  setAsks(bot, START + 61_000, 'UP', [{ price: 0.39, size: 200 }, { price: 0.30, size: 100 }]);
  bot.processRenkoStrategy(START + 61_000);
  bot.processLimitOrders(START + 61_000);
  assert.equal(lowRung.status, 'FILLED');
  assert.equal(lowRung.filledShares, 100);
  assert.equal(lowRung.averageFillPrice, 0.3);
  assert.equal(bot.trades.length, 2);
  assert.ok(bot.trades.every(trade => trade.orderType === 'LIMIT' && trade.side === 'UP'));
  assert.equal(bot.trades.find(trade => trade.orderId === highRung.id).shares, 200);
  assert.equal(bot.trades.find(trade => trade.orderId === lowRung.id).shares, 100);
  assert.equal(bot.takeProfitOrders, undefined);
  assert.ok(Math.abs(bot.cash - (10_000 - 110)) < 1e-9);
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
  assert.equal(state.variants.signal.shareSize, 300);
  assert.equal(state.activeVariantId, 'signal');
  assert.equal(state.variants.against, undefined);
});

test('a marketable limit entry uses the visible ask and taker fee without exceeding its limit', () => {
  const { bot, setNow, addCandle } = createBot();
  addCandle({ t: START, o: 100, h: 102, l: 100, c: 102 });
  setNow(START + 60_000);
  bot.tickCount = 1;
  setAsks(bot, START + 60_000, 'UP', [{ price: 0.39, size: 50 }]);
  bot.processRenkoStrategy(START + 60_000);
  bot.processLimitOrders(START + 60_000);
  const highRung = bot.entryOrders.find(order => order.limitPrice === 0.4);
  assert.equal(highRung.executionRole, 'TAKER');
  assert.equal(highRung.status, 'PARTIALLY_FILLED_RESTING');
  assert.equal(highRung.filledShares, 50);
  assert.equal(highRung.averageFillPrice, 0.39);
  assert.ok(highRung.fees > 0);
  assert.equal(bot.trades[0].orderType, 'LIMIT');
  assert.ok(bot.trades[0].entryPrice <= 0.4);
});

test('a closed red Renko brick buys DOWN on the signal-following version', () => {
  const { bot, setNow, addCandle } = createBot();
  addCandle({ t: START, o: 100, h: 100, l: 98, c: 98 });
  setNow(START + 60_000);
  bot.tickCount = 1;
  bot.processRenkoStrategy(START + 60_000);
  assert.equal(bot.entrySignal.selectedSide, 'DOWN');
  assert.equal(bot.entryOrders.length, 2);
  assert.ok(bot.entryOrders.every(order => order.signalSide === 'DOWN'
    && order.side === 'DOWN' && order.tokenId === market.tokens.DOWN));
});

test('no new brick leaves the original limit ladder unchanged', () => {
  const { bot, setNow, addCandle } = createBot();
  addCandle({ t: START, o: 100, h: 102, l: 100, c: 102 });
  setNow(START + 60_000);
  bot.tickCount = 1;
  setAsks(bot, START + 60_000, 'UP', [{ price: 0.45, size: 100 }]);
  bot.processRenkoStrategy(START + 60_000);
  bot.processLimitOrders(START + 60_000);
  bot.tickCount = 2;
  setNow(START + 60_500);
  bot.processRenkoStrategy(START + 60_500);
  bot.processLimitOrders(START + 60_500);

  setNow(START + 70_000);
  bot.tickCount = 3;
  bot.processRenkoStrategy(START + 70_000);
  assert.equal(bot.renkoState.newBrickPrinted, false);
  assert.equal(bot.entryOrders.filter(order => order.action === 'SELL').length, 0);
  assert.ok(bot.entryOrders.every(order => order.side === 'UP' && order.status === 'RESTING'));
  assert.equal(bot.trades.length, 0);
});

test('opposite Renko bricks do not sell positions or move the entry side', () => {
  const { bot, setNow, addCandle } = createBot();
  addCandle({ t: START, o: 100, h: 102, l: 100, c: 102 });
  setNow(START + 60_000);
  bot.tickCount = 1;
  setAsks(bot, START + 60_000, 'UP', [{ price: 0.45, size: 200 }]);
  bot.processRenkoStrategy(START + 60_000);
  bot.processLimitOrders(START + 60_000);
  bot.tickCount = 2;
  setNow(START + 60_500);
  setAsks(bot, START + 60_500, 'UP', [{ price: 0.39, size: 200 }]);
  bot.processRenkoStrategy(START + 60_500);
  bot.processLimitOrders(START + 60_500);
  assert.equal(bot.trades.length, 1);
  assert.equal(bot.trades[0].status, 'OPEN');
  assert.equal(bot.trades[0].side, 'UP');

  addCandle({ t: START + 60_000, o: 102, h: 102, l: 98, c: 98 });
  setNow(START + 120_000);
  bot.tickCount = 3;
  setAsks(bot, START + 120_000, 'UP', [{ price: 0.39, size: 200 }]);
  bot.processRenkoStrategy(START + 120_000);
  bot.processLimitOrders(START + 120_000);
  assert.equal(bot.renkoState.selectedSide, 'DOWN');
  assert.equal(bot.entrySideForWindow, 'UP');
  assert.equal(bot.entryOrders.filter(order => order.action === 'SELL').length, 0);
  assert.ok(bot.entryOrders.every(order => order.action === 'BUY' && order.side === 'UP'));
  assert.equal(bot.trades[0].status, 'OPEN');
});

test('a limit buy does not fill above its price and cancels only at window end', () => {
  const { bot, setNow, addCandle } = createBot();
  addCandle({ t: START, o: 100, h: 102, l: 100, c: 102 });
  setNow(START + 60_000);
  bot.tickCount = 1;
  setAsks(bot, START + 60_000, 'UP', [{ price: 0.45, size: 500 }]);
  bot.processRenkoStrategy(START + 60_000);
  bot.processLimitOrders(START + 60_000);
  setNow(START + 60_500);
  bot.tickCount = 2;
  setAsks(bot, START + 60_500, 'UP', [{ price: 0.45, size: 500 }]);
  bot.processRenkoStrategy(START + 60_500);
  bot.processLimitOrders(START + 60_500);
  assert.ok(bot.entryOrders.every(order => order.status === 'RESTING'));
  assert.ok(bot.entryOrders.every(order => order.filledShares === 0));
  assert.equal(bot.trades.length, 0);

  setNow(START + 300_000);
  bot.processLimitOrders(START + 300_000);
  assert.ok(bot.entryOrders.every(order => order.status === 'CANCELLED_WINDOW_ENDED'));
});

test('partial resting fills use only newly visible depth and leave the remainder open', () => {
  const { bot, setNow, addCandle } = createBot();
  addCandle({ t: START, o: 100, h: 102, l: 100, c: 102 });
  setNow(START + 60_000);
  bot.tickCount = 1;
  setAsks(bot, START + 60_000, 'UP', [{ price: 0.45, size: 100 }]);
  bot.processRenkoStrategy(START + 60_000);
  bot.processLimitOrders(START + 60_000);

  setNow(START + 60_500);
  bot.tickCount = 2;
  setAsks(bot, START + 60_500, 'UP', [{ price: 0.39, size: 50 }]);
  bot.processLimitOrders(START + 60_500);
  const highRung = bot.entryOrders.find(order => order.limitPrice === 0.4);
  assert.equal(highRung.status, 'PARTIALLY_FILLED_RESTING');
  assert.equal(highRung.filledShares, 50);
  assert.equal(highRung.remainingShares, 150);
  assert.equal(bot.trades[0].shares, 50);

  setNow(START + 61_000);
  bot.tickCount = 3;
  setAsks(bot, START + 61_000, 'UP', [{ price: 0.39, size: 50 }]);
  bot.processLimitOrders(START + 61_000);
  assert.equal(highRung.filledShares, 50);

  setNow(START + 61_500);
  bot.tickCount = 4;
  setAsks(bot, START + 61_500, 'UP', [{ price: 0.39, size: 80 }]);
  bot.processLimitOrders(START + 61_500);
  assert.equal(highRung.filledShares, 80);
  assert.equal(highRung.remainingShares, 120);
  assert.equal(bot.trades[0].shares, 80);

  setNow(START + 300_000);
  bot.processLimitOrders(START + 300_000);
  assert.equal(highRung.status, 'CANCELLED_WINDOW_ENDED');
  assert.equal(highRung.cancelledRemainderShares, 120);
  assert.equal(bot.trades[0].status, 'OPEN');
  assert.equal(bot.trades[0].shares, 80);
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
