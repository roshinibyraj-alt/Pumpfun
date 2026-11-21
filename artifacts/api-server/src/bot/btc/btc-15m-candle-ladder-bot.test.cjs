'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  Btc15mCandleLadderBot,
  MAX_LADDER_COST,
  RUNG_PRICES,
  RUNG_SPECS,
  SHARES_PER_RUNG,
  HISTORY_RESET_REQUEST_ID,
} = require('./btc-15m-candle-ladder-bot.cjs');

const WINDOW_MS = 15 * 60_000;

function candle(start, duration, open, high, low, close) {
  return { start, end: start + duration, open, high, low, close, closed: true };
}

function bullishHistory(windowStart) {
  const candles15m = [];
  for (let i = 21; i >= 1; i -= 1) {
    const start = windowStart - i * WINDOW_MS;
    candles15m.push(candle(start, WINDOW_MS, 100, 100.1, 99.9, 100));
  }
  candles15m[20] = candle(windowStart - WINDOW_MS, WINDOW_MS, 100, 100.2, 99.9, 100.1);
  return {
    '15m': candles15m,
    '1h': [candle(windowStart - 60 * 60_000, 60 * 60_000, 100, 100.3, 99.9, 100.2)],
    '4h': [candle(windowStart - 4 * 60 * 60_000, 4 * 60 * 60_000, 100, 100.4, 99.8, 100.3)],
  };
}

function fixture(options = {}) {
  let now = 21 * WINDOW_MS + 100;
  const windowStart = 21 * WINDOW_MS;
  const market = {
    id: 'market-15m',
    slug: `btc-updown-15m-${Math.floor(windowStart / 1000)}`,
    title: 'BTC Up or Down · 15 minutes',
    start: windowStart,
    end: windowStart + WINDOW_MS,
    tokens: { UP: 'token-up', DOWN: 'token-down' },
    raw: { feesEnabled: true },
  };
  const feedSnapshot = {
    status: 'READY',
    lastUpdatedAt: now,
    ageMs: 0,
    candles: bullishHistory(windowStart),
  };
  const candleFeed = {
    lastUpdatedAt: now,
    async start() { return this.snapshot(); },
    async refresh() {
      this.lastUpdatedAt = now;
      feedSnapshot.lastUpdatedAt = now;
      return true;
    },
    stop() {},
    snapshot() {
      return { ...feedSnapshot, ageMs: Math.max(0, now - feedSnapshot.lastUpdatedAt) };
    },
  };
  const bot = new Btc15mCandleLadderBot({
    now: () => now,
    candleFeed,
    stateStore: options.stateStore,
    marketData: {
      async getMarket() { return null; },
      async getBtcMarket(start, duration) {
        return {
          ...market,
          id: start === windowStart ? market.id : `market-${start}`,
          start,
          end: start + duration,
        };
      },
      async getBook() { return { asks: [], bids: [] }; },
      connectMarketStream() { return { close() {} }; },
    },
  });
  bot.market = market;
  bot.windowStart = windowStart;
  bot.windowEnd = windowStart + WINDOW_MS;
  bot.storageHealthy = true;

  function setAsk(side, ask, bid = Math.max(0.01, ask - 0.01)) {
    bot.quotes[side] = {
      ...bot.quotes[side],
      side,
      bestAsk: ask,
      bestBid: bid,
      askSize: 500,
      bidSize: 500,
      updatedAt: now,
      status: 'LIVE',
    };
  }

  return {
    bot,
    market,
    candleFeed,
    setAsk,
    setNow(value) {
      now = value;
      candleFeed.lastUpdatedAt = value;
      feedSnapshot.lastUpdatedAt = value;
    },
    getNow() { return now; },
  };
}

test('first startup resets the old paper ledger once before loading state', async () => {
  const calls = [];
  const priorResetRequest = process.env.BTC_PAPER_MISPRICING_HISTORY_RESET_REQUEST_ID;
  delete process.env.BTC_PAPER_MISPRICING_HISTORY_RESET_REQUEST_ID;
  const stateStore = {
    async initialize() { calls.push('initialize'); },
    async resetHistoryOnce(requestId, state) {
      calls.push('reset');
      assert.equal(requestId, HISTORY_RESET_REQUEST_ID);
      assert.equal(state.strategyVersion, 'btc-15m-candle-score-limit-ladder-v3');
      assert.equal(state.startingCapital, 3_000);
      assert.deepEqual(state.trades, []);
      return true;
    },
    async loadState() { calls.push('load'); return null; },
    async saveState() {},
  };
  const context = fixture({ stateStore });
  try {
    await context.bot.start();
    context.bot.stop();
    assert.ok(calls.indexOf('reset') > calls.indexOf('initialize'));
    assert.ok(calls.indexOf('reset') < calls.indexOf('load'));
    assert.equal(context.bot.startingCapital, 3_000);
    assert.equal(context.bot.trades.length, 0);
  } finally {
    context.bot.stop();
    if (priorResetRequest == null) delete process.env.BTC_PAPER_MISPRICING_HISTORY_RESET_REQUEST_ID;
    else process.env.BTC_PAPER_MISPRICING_HISTORY_RESET_REQUEST_ID = priorResetRequest;
  }
});

test('one candle signal arms eight mixed-size limits on only the selected side', () => {
  const context = fixture();
  context.setAsk('UP', 0.50);
  context.setAsk('DOWN', 0.60);

  assert.equal(context.bot.evaluate(context.getNow()), true);
  assert.equal(context.bot.modelResult.side, 'UP');
  assert.equal(context.bot.selectedSide, 'UP');
  assert.deepEqual(context.bot.ladderOrders.map(order => order.price), RUNG_PRICES);
  assert.deepEqual(context.bot.ladderOrders.map(order => order.requestedShares),
    [300, 300, 100, 100, 100, 100, 100, 100]);
  assert.ok(context.bot.ladderOrders.every(order => order.status === 'RESTING' && order.side === 'UP'));
  assert.equal(context.bot.ladderOrders.filter(order => order.side === 'DOWN').length, 0);
  assert.deepEqual(RUNG_SPECS.map(rung => [rung.price, rung.shares]), [
    [0.40, 300], [0.35, 300], [0.30, 100], [0.25, 100],
    [0.20, 100], [0.15, 100], [0.10, 100], [0.05, 100],
  ]);
  assert.equal(SHARES_PER_RUNG, 100);
  assert.equal(MAX_LADDER_COST, 330);
});

test('a downward ask move fills every crossed rung at its exact limit price', () => {
  const context = fixture();
  context.setAsk('UP', 0.50);
  context.setAsk('DOWN', 0.60);
  context.bot.evaluate(context.getNow());

  context.setNow(context.getNow() + 500);
  context.setAsk('UP', 0.30);
  context.bot.evaluate(context.getNow());
  assert.equal(context.bot.trades.length, 3, 'the move crosses $0.40, $0.35, and $0.30');

  context.setNow(context.getNow() + 500);
  context.setAsk('UP', 0.29);
  context.bot.evaluate(context.getNow());

  assert.equal(context.bot.trades.length, 3);
  assert.deepEqual(context.bot.trades.map(trade => [trade.rungPrice, trade.shares, trade.entryPrice]), [
    [0.40, 300, 0.40], [0.35, 300, 0.35], [0.30, 100, 0.30],
  ]);
  assert.ok(context.bot.trades.every(trade => trade.side === 'UP' && trade.fees === 0));
  assert.equal(context.bot.ladderOrders.find(order => order.price === 0.30).status, 'FILLED');
});

test('an ask already below a rung does not cause an immediate marketable fill', () => {
  const context = fixture();
  context.setAsk('UP', 0.08);
  context.setAsk('DOWN', 0.90);
  context.bot.evaluate(context.getNow());

  assert.equal(context.bot.selectedSide, 'UP');
  assert.equal(context.bot.trades.length, 0);

  context.setNow(context.getNow() + 500);
  context.setAsk('UP', 0.35);
  context.bot.evaluate(context.getNow());
  assert.equal(context.bot.trades.length, 0);

  context.setNow(context.getNow() + 500);
  context.setAsk('UP', 0.29);
  context.bot.evaluate(context.getNow());
  assert.equal(context.bot.trades.length, 1);
  assert.equal(context.bot.trades[0].entryPrice, 0.30);
});

test('a price jump fills every crossed qualifying rung exactly once', () => {
  const context = fixture();
  context.setAsk('UP', 0.50);
  context.setAsk('DOWN', 0.60);
  context.bot.evaluate(context.getNow());

  context.setNow(context.getNow() + 500);
  context.setAsk('UP', 0.14);
  context.bot.evaluate(context.getNow());

  const filled = context.bot.ladderOrders.filter(order => order.status === 'FILLED');
  assert.deepEqual(filled.map(order => order.price), [0.40, 0.35, 0.30, 0.25, 0.20, 0.15]);
  assert.equal(context.bot.trades.length, 6);
  assert.deepEqual(context.bot.trades.map(trade => trade.shares), [300, 300, 100, 100, 100, 100]);
  assert.ok(context.bot.trades.every(trade => trade.entryPrice === trade.rungPrice));
});

test('the $0.40 and $0.35 rungs each fill their configured 300 shares', () => {
  const context = fixture();
  context.setAsk('UP', 0.50);
  context.setAsk('DOWN', 0.60);
  context.bot.evaluate(context.getNow());

  context.setNow(context.getNow() + 500);
  context.setAsk('UP', 0.39);
  context.bot.evaluate(context.getNow());
  assert.deepEqual(context.bot.trades.map(trade => [trade.rungPrice, trade.shares]), [[0.40, 300]]);

  context.setNow(context.getNow() + 500);
  context.setAsk('UP', 0.34);
  context.bot.evaluate(context.getNow());
  assert.deepEqual(context.bot.trades.map(trade => [trade.rungPrice, trade.shares]), [
    [0.40, 300], [0.35, 300],
  ]);
  assert.equal(context.bot.sidePositionSnapshot('UP', context.getNow()).totalCost, 225);
});

test('unfilled limits expire at window end and filled shares await original-market resolution', async () => {
  const context = fixture();
  context.setAsk('UP', 0.50);
  context.setAsk('DOWN', 0.60);
  context.bot.evaluate(context.getNow());
  context.setNow(context.getNow() + 500);
  context.setAsk('UP', 0.29);
  context.bot.evaluate(context.getNow());

  const oldMarketId = context.bot.trades[0].marketId;
  context.setNow(context.bot.windowEnd);
  await context.bot.resetWindow(context.bot.windowEnd);

  assert.equal(context.bot.trades[0].status, 'AWAITING_RESOLUTION');
  assert.equal(context.bot.trades[0].marketId, oldMarketId);
  assert.ok(context.bot.events.some(event => event.type === 'LIMIT_ORDERS_CANCELLED'));
  assert.equal(context.bot.windowEnd - context.bot.windowStart, WINDOW_MS);
});

test('a restart restores the selected side, resting orders, filled shares, and original market IDs', () => {
  const context = fixture();
  context.setAsk('UP', 0.50);
  context.setAsk('DOWN', 0.60);
  context.bot.evaluate(context.getNow());
  context.setNow(context.getNow() + 500);
  context.setAsk('UP', 0.29);
  context.bot.evaluate(context.getNow());
  const saved = context.bot.persistentStateSnapshot();

  const restored = fixture();
  restored.setNow(context.getNow());
  restored.bot.restoreState(saved);

  assert.equal(restored.bot.selectedSide, 'UP');
  assert.equal(restored.bot.ladderOrders.find(order => order.price === 0.30).status, 'FILLED');
  assert.equal(restored.bot.trades[0].status, 'OPEN');
  assert.equal(restored.bot.trades[0].marketId, context.bot.trades[0].marketId);
  assert.equal(restored.bot.ladderOrders.filter(order => order.status === 'RESTING').length, 5);
});

test('the current v1 window keeps its old decision, fills, and six resting orders during upgrade', () => {
  const context = fixture();
  context.setAsk('UP', 0.50);
  context.setAsk('DOWN', 0.60);
  context.bot.evaluate(context.getNow());
  context.setNow(context.getNow() + 500);
  context.setAsk('UP', 0.29);
  context.bot.evaluate(context.getNow());
  const saved = context.bot.persistentStateSnapshot();
  saved.strategyVersion = 'btc-15m-candle-score-limit-ladder-v1';
  saved.sideStates.UP.rungs = saved.sideStates.UP.rungs
    .filter(rung => [0.30, 0.25, 0.20, 0.15, 0.10, 0.05].includes(rung.price));
  saved.ladderOrders = saved.ladderOrders
    .filter(order => [0.30, 0.25, 0.20, 0.15, 0.10, 0.05].includes(order.price));
  saved.modelResult = {
    ...saved.modelResult,
    factors: [...saved.modelResult.factors, {
      timeframe: '4h', direction: 'DOWN', points: -2, explanation: 'Prior 4h score.',
    }],
  };

  const restored = fixture();
  restored.setNow(context.getNow());
  restored.bot.restoreState(saved);

  assert.equal(restored.bot.selectedSide, 'UP');
  assert.equal(restored.bot.trades[0].status, 'OPEN');
  assert.equal(restored.bot.ladderOrders.length, 6);
  assert.equal(restored.bot.ladderOrders.find(order => order.price === 0.30).status, 'FILLED');
  assert.equal(restored.bot.sideStates.UP.rungs.find(rung => rung.price === 0.40).status, 'AVAILABLE');
  assert.match(restored.bot.modelResult.scorePolicyNote, /effect next window/);
});

test('the current v2 window keeps its decision and orders during streak-selector upgrade', () => {
  const context = fixture();
  context.setAsk('UP', 0.50);
  context.setAsk('DOWN', 0.60);
  context.bot.evaluate(context.getNow());
  context.setNow(context.getNow() + 500);
  context.setAsk('UP', 0.29);
  context.bot.evaluate(context.getNow());
  const saved = context.bot.persistentStateSnapshot();
  saved.strategyVersion = 'btc-15m-candle-score-limit-ladder-v2';

  const restored = fixture();
  restored.setNow(context.getNow());
  restored.bot.restoreState(saved);

  assert.equal(restored.bot.selectedSide, 'UP');
  assert.equal(restored.bot.trades.length, context.bot.trades.length);
  assert.deepEqual(restored.bot.ladderOrders, context.bot.ladderOrders);
  assert.match(restored.bot.modelResult.scorePolicyNote, /streak selector takes effect next window/);
});

test('old strategy open positions are preserved for resolution during version migration', () => {
  const context = fixture();
  context.bot.restoreState({
    strategyVersion: 'btc-5m-clob-independent-double-rungs-tp099-v1',
    startingCapital: 3_000,
    cash: 2_900,
    realizedPnl: 0,
    trades: [{
      id: 'old-open',
      status: 'OPEN',
      side: 'UP',
      marketId: 'original-five-minute-market',
      windowStart: context.getNow() - 1_000,
      shares: 100,
      totalCost: 100,
      fees: 1,
    }],
    events: [],
    windowStart: context.getNow() - 1_000,
    sideStates: null,
  });

  assert.equal(context.bot.trades[0].status, 'AWAITING_RESOLUTION');
  assert.equal(context.bot.trades[0].marketId, 'original-five-minute-market');
  assert.equal(context.bot.windowStart, null);
});
