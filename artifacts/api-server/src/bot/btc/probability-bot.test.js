'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ProbabilityBot } = require('./probability-bot');
const { STRATEGY_VERSION } = require('./signal-taker-strategy');

const START = 1_800_000_000_000;
const market = {
  id: 'btc-5m-market',
  title: 'BTC Up or Down',
  start: START,
  end: START + 300_000,
  tokens: { UP: 'up-token', DOWN: 'down-token' },
  raw: { feesEnabled: true, feeSchedule: { rate: 0.07, exponent: 1 } },
};

function createBot({ signalPrice = 101 } = {}) {
  let now = START - 10_000;
  const priceFeed = {
    start() {},
    snapshot() { return { status: 'live', ageMs: 1 }; },
    getMinuteCandles() {
      return [
        { t: START - 120_000, c: 100 },
        { t: START - 60_000, c: 105 }, // Not closed before the signal timestamp.
      ];
    },
    getTicks() { return [{ ts: now, price: signalPrice }]; },
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
  };
}

function setAsks(bot, now, side, asks, bid = 0.4) {
  bot.quotes[side] = bot.quote({
    bids: [{ price: bid, size: 10_000 }],
    asks,
  }, now);
}

test('one pre-open candle signal submits one taker buy at open and confirms on the next tick', () => {
  const { bot, setNow } = createBot();
  const signalAt = START - 3_000;
  setNow(signalAt + 500);
  bot.tickCount = 1;
  bot.processCandleSignalStrategy(signalAt + 500);
  assert.equal(bot.entrySignal.selectedSide, 'UP');
  assert.equal(bot.entryOrders.length, 0);

  setNow(START);
  bot.tickCount = 2;
  setAsks(bot, START, 'DOWN', [{ price: 0.45, size: 200 }, { price: 0.55, size: 400 }]);
  bot.processCandleSignalStrategy(START);
  bot.processPendingTakerOrders(START);
  assert.equal(bot.entryOrders.length, 1);
  assert.equal(bot.entryOrders[0].status, 'PENDING_CONFIRMATION');
  assert.equal(bot.trades.length, 0);

  setNow(START + 500);
  bot.tickCount = 3;
  setAsks(bot, START + 500, 'DOWN', [{ price: 0.55, size: 400 }, { price: 0.45, size: 200 }]);
  bot.processPendingTakerOrders(START + 500);

  const [order] = bot.entryOrders;
  const [trade] = bot.trades;
  assert.equal(order.status, 'FILLED');
  assert.equal(order.filledShares, 500);
  assert.equal(order.cancelledRemainderShares, 0);
  assert.equal(order.averageFillPrice, 0.51);
  assert.ok(Math.abs(order.fees - 8.6625) < 1e-12);
  assert.equal(order.signalSide, 'UP');
  assert.equal(order.side, 'DOWN');
  assert.equal(trade.signalSide, 'UP');
  assert.equal(trade.side, 'DOWN');
  assert.equal(trade.orderType, 'TAKER');
  assert.equal(trade.shares, 500);
  assert.equal(bot.takeProfitOrders, undefined);
  assert.ok(Math.abs(bot.cash - (10_000 - 263.6625)) < 1e-9);
  assert.equal(bot.snapshot().takeProfitOrders, undefined);
  assert.match(bot.snapshot().strategy.exitModel, /no take-profit or stop-loss/i);
  assert.equal(bot.snapshot().strategy.version, STRATEGY_VERSION);
});

test('the bot scans the upcoming market before open and confirms the entry one poll later', async () => {
  let now = START - 10_000;
  const priceFeed = {
    start() {},
    snapshot() { return { status: 'live', ageMs: 0 }; },
    getMinuteCandles() {
      return [
        { t: START - 120_000, c: 100 },
        { t: START - 60_000, c: 105 },
      ];
    },
    getTicks() { return [{ ts: now, price: 101 }]; },
  };
  const bot = new ProbabilityBot({
    now: () => now,
    priceFeed,
    fetchMarket: async start => ({ ...market, start, end: start + 300_000 }),
    fetchBook: async () => ({
      bids: [{ price: 0.4, size: 1000 }],
      asks: [{ price: 0.45, size: 500 }],
    }),
    fetchMarketDetails: async () => null,
  });

  await bot.tick();
  assert.equal(bot.market.start, START);
  assert.equal(bot.entrySideSelection.status, 'WAITING_FOR_PREOPEN_SIGNAL');

  now = START - 2_500;
  await bot.tick();
  assert.equal(bot.entrySideSelection.selectedSide, 'UP');
  assert.equal(bot.entryOrders.length, 0);

  now = START;
  await bot.tick();
  assert.equal(bot.entryOrders.length, 1);
  assert.equal(bot.entryOrders[0].status, 'PENDING_CONFIRMATION');
  assert.equal(bot.entryOrders[0].signalSide, 'UP');
  assert.equal(bot.entryOrders[0].side, 'DOWN');
  assert.equal(bot.trades.length, 0);

  now = START + 500;
  await bot.tick();
  assert.equal(bot.entryOrders[0].status, 'FILLED');
  assert.equal(bot.trades[0].shares, 500);
  assert.equal(bot.trades[0].side, 'DOWN');
  assert.equal(bot.trades[0].entryPrice, 0.45);
});

test('a DOWN signal buys UP and keeps the signal separate from the traded side', () => {
  const { bot, setNow } = createBot({ signalPrice: 99 });
  setNow(START - 2_500);
  bot.tickCount = 1;
  bot.processCandleSignalStrategy(START - 2_500);
  assert.equal(bot.entrySignal.selectedSide, 'DOWN');

  setNow(START);
  bot.tickCount = 2;
  setAsks(bot, START, 'UP', [{ price: 0.45, size: 10 }]);
  bot.processCandleSignalStrategy(START);
  assert.equal(bot.entryOrders[0].signalSide, 'DOWN');
  assert.equal(bot.entryOrders[0].side, 'UP');
  assert.equal(bot.entryOrders[0].tokenId, market.tokens.UP);
});

test('an UP signal buys DOWN, then next-tick taker fill books only visible shares and cancels remainder', () => {
  const { bot, setNow } = createBot();
  setNow(START - 2_500);
  bot.tickCount = 1;
  bot.processCandleSignalStrategy(START - 2_500);
  assert.equal(bot.entrySignal.selectedSide, 'UP');
  setNow(START);
  bot.tickCount = 2;
  setAsks(bot, START, 'DOWN', [{ price: 0.45, size: 100 }]);
  bot.processCandleSignalStrategy(START);
  bot.processPendingTakerOrders(START);

  setNow(START + 500);
  bot.tickCount = 3;
  setAsks(bot, START + 500, 'DOWN', [{ price: 0.45, size: 100 }]);
  bot.processPendingTakerOrders(START + 500);
  bot.processCandleSignalStrategy(START + 500);

  assert.equal(bot.entryOrders.length, 1);
  assert.equal(bot.entryOrders[0].signalSide, 'UP');
  assert.equal(bot.entryOrders[0].side, 'DOWN');
  assert.equal(bot.entryOrders[0].status, 'PARTIALLY_FILLED_REMAINDER_CANCELLED');
  assert.equal(bot.entryOrders[0].filledShares, 100);
  assert.equal(bot.entryOrders[0].cancelledRemainderShares, 400);
  assert.equal(bot.trades.length, 1);
  assert.equal(bot.trades[0].shares, 100);
  assert.equal(bot.trades[0].signalSide, 'UP');
  assert.equal(bot.trades[0].side, 'DOWN');
});

test('entry is not fabricated when the next-tick book is empty', () => {
  const { bot, setNow } = createBot();
  setNow(START - 2_500);
  bot.tickCount = 1;
  bot.processCandleSignalStrategy(START - 2_500);
  setNow(START);
  bot.tickCount = 2;
  bot.processCandleSignalStrategy(START);
  bot.processPendingTakerOrders(START);

  setNow(START + 500);
  bot.tickCount = 3;
  setAsks(bot, START + 500, 'DOWN', []);
  bot.processPendingTakerOrders(START + 500);
  bot.processCandleSignalStrategy(START + 500);

  assert.equal(bot.entryOrders[0].status, 'CANCELLED_NO_VISIBLE_ASKS');
  assert.equal(bot.entryOrders[0].filledShares, 0);
  assert.equal(bot.trades.length, 0);
  assert.equal(bot.entryOrders.length, 1);
});

test('a bot that starts after the window opens skips it rather than inventing a pre-open signal', () => {
  const { bot } = createBot();
  bot.beginMarketWindow(START, START + 1_000);
  bot.processCandleSignalStrategy(START + 1_000);
  assert.equal(bot.entryOrders.length, 0);
  assert.equal(bot.entrySideSelection.status, 'MISSED_PREOPEN_SIGNAL');
});

test('neither take profit nor stop loss closes positions before official resolution', () => {
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
    feeRate: 0.07,
    feeExponent: 1,
    openedAt: START,
    status: 'OPEN',
    settlementStatus: 'OPEN',
  };
  bot.trades = [trade];
  bot.cash -= trade.totalCost;

  setNow(START + 10_000);
  setAsks(bot, START + 10_000, 'UP', [], 0.99);
  bot.processPositionExits(START + 10_000);
  assert.equal(trade.status, 'OPEN');

  setNow(START + 20_000);
  setAsks(bot, START + 20_000, 'UP', [], 0.01);
  bot.processPositionExits(START + 20_000);
  assert.equal(trade.status, 'OPEN');
  assert.equal(trade.finalOutcome, undefined);
  assert.equal(trade.exitPrice, undefined);

  setNow(START + 300_000);
  bot.processPositionExits(START + 300_000);
  assert.equal(trade.status, 'OPEN');
  assert.equal(trade.settlementStatus, 'AWAITING_SETTLEMENT');
  assert.match(trade.settlementError, /original-market resolution/);
});
