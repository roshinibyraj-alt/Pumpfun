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
    setHistoricalCandle(index, candle) { historicalCandles[index] = candle; },
  };
}

function setAsks(bot, now, side, asks, bid = 0.4) {
  bot.quotes[side] = bot.quote({
    bids: bid == null ? [] : [{ price: bid, size: 10_000 }],
    asks,
  }, now);
}

test('a window-start green signal sends one 300-share UP taker buy immediately', () => {
  const { bot, setHistoricalCandle } = createBot();
  setHistoricalCandle(15, { t: START - 60_000, o: 100, h: 102, l: 100, c: 102 });
  setAsks(bot, START, 'UP', [{ price: 0.40, size: 200 }, { price: 0.45, size: 100 }]);
  bot.processRenkoStrategy(START);
  bot.processTakerBuyOrders(START);

  assert.equal(bot.entryOrders.length, 1);
  const [order] = bot.entryOrders;
  assert.equal(order.orderType, 'MARKET');
  assert.equal(order.executionRole, 'TAKER');
  assert.equal(order.side, 'UP');
  assert.equal(order.signalSide, 'UP');
  assert.equal(order.requestedShares, 300);
  assert.equal(order.filledShares, 300);
  assert.equal(order.status, 'FILLED');
  assert.equal(order.placedAt, START);
  assert.ok(order.averageFillPrice > 0);
  assert.ok(order.fees > 0);
  assert.equal(bot.trades.length, 1);
  assert.equal(bot.trades[0].orderType, 'MARKET');
  assert.equal(bot.trades[0].side, 'UP');
  assert.equal(bot.trades[0].signalSide, 'UP');
  assert.equal(bot.trades[0].shares, 300);
  assert.equal(bot.renkoState.brickSize, 2);
  assert.equal(bot.renkoState.selectedSide, 'UP');
  assert.equal(bot.takeProfitOrders, undefined);
  assert.equal(bot.snapshot().takeProfitOrders, undefined);
  assert.equal(bot.snapshot().paperAccount.startingCash, 10_000);
  assert.deepEqual(Object.keys(bot.snapshot().variants), ['signal']);
  assert.match(bot.snapshot().strategy.exitModel, /best bid reaches \$0\.99/i);
  assert.match(bot.snapshot().strategy.exitModel, /credited at \$1 per share/i);
  assert.equal(bot.tradeSideFor('UP'), 'UP');
  assert.equal(bot.tradeSideFor('DOWN'), 'DOWN');
  assert.equal(bot.snapshot().orderSchedule.signalSide, 'UP');
  assert.equal(bot.snapshot().orderSchedule.tradeSide, 'UP');
  assert.equal(bot.snapshot().strategy.orderType, 'MARKET');
  assert.equal(bot.snapshot().strategy.entryExecutionRole, 'TAKER');
  assert.equal(bot.snapshot().strategy.version, STRATEGY_VERSION);
});

test('only the signal-side account is active; there is no strategy rotation', () => {
  const { bot } = createBot();
  const state = bot.snapshot();
  assert.equal(state.paperAccount.startingCash, 10_000);
  assert.deepEqual(Object.keys(state.variants), ['signal']);
  assert.equal(state.variants.signal.shareSize, 300);
  assert.equal(state.variants.signal.mode, 'SIGNAL_SIDE');
  assert.equal(state.activeVariantId, 'signal');
  assert.equal(state.variants.against, undefined);
});

test('a red Renko signal sends a DOWN taker buy on the signal side', () => {
  const { bot, setNow, addCandle } = createBot();
  addCandle({ t: START, o: 100, h: 100, l: 98, c: 98 });
  setNow(START + 60_000);
  bot.tickCount = 1;
  setAsks(bot, START + 60_000, 'DOWN', [{ price: 0.39, size: 300 }]);
  bot.processRenkoStrategy(START + 60_000);
  bot.processTakerBuyOrders(START + 60_000);
  assert.equal(bot.entrySignal.selectedSide, 'DOWN');
  assert.equal(bot.entryOrders.length, 1);
  assert.equal(bot.entryOrders[0].side, 'DOWN');
  assert.equal(bot.entryOrders[0].signalSide, 'DOWN');
  assert.equal(bot.entryOrders[0].tokenId, market.tokens.DOWN);
  assert.equal(bot.entryOrders[0].executionRole, 'TAKER');
  assert.equal(bot.trades[0].side, 'DOWN');
  assert.equal(bot.snapshot().orderSchedule.tradeSide, 'DOWN');
});

test('the first taker order waits for a fresh book and submits only once', () => {
  const { bot, setHistoricalCandle, setNow } = createBot();
  setHistoricalCandle(15, { t: START - 60_000, o: 100, h: 102, l: 100, c: 102 });
  bot.processRenkoStrategy(START);
  bot.processTakerBuyOrders(START);
  assert.equal(bot.entryOrders.length, 1);
  assert.equal(bot.entryOrders[0].status, 'PENDING_SUBMISSION');

  setNow(START + 500);
  bot.tickCount = 1;
  setAsks(bot, START + 500, 'UP', [{ price: 0.41, size: 300 }]);
  bot.processRenkoStrategy(START + 500);
  bot.processTakerBuyOrders(START + 500);
  assert.equal(bot.entryOrders.length, 1);
  assert.equal(bot.entryOrders[0].status, 'FILLED');
  assert.equal(bot.entryOrders[0].placedAt, START + 500);
  assert.equal(bot.entryOrders[0].filledShares, 300);
});

test('later opposite Renko bricks do not sell or submit another taker buy', () => {
  const { bot, setHistoricalCandle, setNow, addCandle } = createBot();
  setHistoricalCandle(15, { t: START - 60_000, o: 100, h: 102, l: 100, c: 102 });
  setAsks(bot, START, 'UP', [{ price: 0.4, size: 300 }]);
  bot.processRenkoStrategy(START);
  bot.processTakerBuyOrders(START);
  assert.equal(bot.trades[0].side, 'UP');

  addCandle({ t: START, o: 102, h: 102, l: 98, c: 98 });
  setNow(START + 60_000);
  bot.tickCount = 1;
  setAsks(bot, START + 60_000, 'DOWN', [{ price: 0.4, size: 300 }]);
  bot.processRenkoStrategy(START + 60_000);
  bot.processTakerBuyOrders(START + 60_000);
  assert.equal(bot.renkoState.selectedSide, 'DOWN');
  assert.equal(bot.entrySideForWindow, 'UP');
  assert.equal(bot.entryOrders.filter(order => order.action === 'SELL').length, 0);
  assert.ok(bot.entryOrders.every(order => order.action === 'BUY' && order.side === 'UP'));
  assert.equal(bot.entryOrders.length, 1);
  assert.equal(bot.trades[0].status, 'OPEN');
  assert.equal(bot.trades[0].shares, 300);
});

test('an empty ask book cancels the taker order without a later rearm', () => {
  const { bot, setHistoricalCandle, setNow } = createBot();
  setHistoricalCandle(15, { t: START - 60_000, o: 100, h: 102, l: 100, c: 102 });
  setAsks(bot, START, 'UP', []);
  bot.processRenkoStrategy(START);
  bot.processTakerBuyOrders(START);
  assert.equal(bot.entryOrders.length, 1);
  assert.equal(bot.entryOrders[0].status, 'CANCELLED_NO_VISIBLE_ASKS');

  setNow(START + 500);
  bot.tickCount = 1;
  setAsks(bot, START + 500, 'UP', [{ price: 0.4, size: 300 }]);
  bot.processRenkoStrategy(START + 500);
  bot.processTakerBuyOrders(START + 500);
  assert.equal(bot.entryOrders.length, 1);
  assert.equal(bot.trades.length, 0);
});

test('a partial taker sweep cancels the unfilled remainder and never re-arms', () => {
  const { bot, setHistoricalCandle, setNow } = createBot();
  setHistoricalCandle(15, { t: START - 60_000, o: 100, h: 102, l: 100, c: 102 });
  setAsks(bot, START, 'UP', [{ price: 0.39, size: 50 }]);
  bot.processRenkoStrategy(START);
  bot.processTakerBuyOrders(START);
  const order = bot.entryOrders[0];
  assert.equal(order.status, 'PARTIALLY_FILLED_CANCELLED');
  assert.equal(order.filledShares, 50);
  assert.equal(order.cancelledRemainderShares, 250);
  assert.equal(order.remainingShares, 0);
  assert.ok(order.fees > 0);
  assert.equal(bot.trades[0].shares, 50);

  setNow(START + 500);
  bot.tickCount = 1;
  setAsks(bot, START + 500, 'UP', [{ price: 0.39, size: 250 }]);
  bot.processRenkoStrategy(START + 500);
  bot.processTakerBuyOrders(START + 500);
  assert.equal(bot.entryOrders.length, 1);
  assert.equal(bot.trades[0].status, 'OPEN');
  assert.equal(bot.trades[0].shares, 50);
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
