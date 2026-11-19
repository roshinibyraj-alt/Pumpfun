'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { BtcMispricingBot } = require('./mispricing-bot.cjs');
const { CANDLE_MS } = require('./binance-tick-feed.cjs');

function fixture() {
  let currentTime = 960_000;
  const windowStart = 900_000;
  const market = {
    id: 'market-current',
    slug: 'btc-updown-5m-current',
    title: 'BTC Up or Down',
    start: windowStart,
    end: windowStart + CANDLE_MS,
    tokens: { UP: 'token-up', DOWN: 'token-down' },
    raw: { feesEnabled: false },
  };
  const feed = {
    snapshot() {
      return {
        status: 'DISCONNECTED',
        historyStatus: 'INSUFFICIENT_HISTORY',
        price: null,
        tickAt: null,
        candles: [],
      };
    },
    async start() {},
    stop() {},
  };
  const bot = new BtcMispricingBot({
    now: () => currentTime,
    priceFeed: feed,
    marketData: {
      async getMarket() { return null; },
      async getBtcMarket(start) {
        return { ...market, start, end: start + CANDLE_MS };
      },
      async getBook() {
        return { asks: [], bids: [], updatedAt: currentTime, sourceTimestamp: currentTime };
      },
    },
  });
  bot.market = market;
  bot.windowStart = windowStart;
  bot.windowEnd = windowStart + CANDLE_MS;
  bot.storageHealthy = true;

  function setQuote(side, { ask = null, bid = null } = {}) {
    const tokenId = market.tokens[side];
    const book = {
      asks: ask == null ? [] : [{ price: ask, size: 1_000, availableSize: 1_000 }],
      bids: bid == null ? [] : [{ price: bid, size: 1_000, availableSize: 1_000 }],
      updatedAt: currentTime,
      sourceTimestamp: currentTime,
    };
    bot.books.set(tokenId, book);
    bot.quotes[side] = {
      side,
      tokenId,
      bestAsk: ask,
      askSize: ask == null ? 0 : 1_000,
      bestBid: bid,
      bidSize: bid == null ? 0 : 1_000,
      updatedAt: currentTime,
      sourceTimestamp: currentTime,
      status: 'LIVE',
    };
  }

  setQuote('UP', { ask: 0.60, bid: 0.59 });
  setQuote('DOWN', { ask: 0.40, bid: 0.39 });

  return {
    bot,
    market,
    setQuote,
    setNow(value) { currentTime = value; },
    getNow() { return currentTime; },
  };
}

function armUp(context) {
  const { bot, setQuote, getNow } = context;
  setQuote('UP', { ask: 0.92, bid: 0.91 });
  assert.equal(bot.evaluate(getNow()), true);
  assert.equal(bot.activeLadder.side, 'UP');
}

test('the CLOB $0.92 trigger works without Binance history or model readiness', () => {
  const context = fixture();
  const { bot } = context;
  armUp(context);
  assert.equal(bot.trades.length, 0);
  assert.equal(bot.activeLadder.rungs.length, 8);
  assert.deepEqual(bot.activeLadder.rungs.map(rung => rung.limitPrice),
    [0.90, 0.80, 0.70, 0.60, 0.50, 0.40, 0.30, 0.20]);
  assert.ok(bot.activeLadder.rungs.every(rung => rung.targetShares === 100));
  assert.equal(bot.snapshot().strategy.entryOrderType, 'RESTING LIMIT BUY (PAPER)');
});

test('the first side to reach the trigger owns the window ladder', () => {
  const context = fixture();
  const { bot, setQuote, setNow, getNow } = context;
  setQuote('DOWN', { ask: 0.93, bid: 0.92 });
  assert.equal(bot.evaluate(getNow()), true);
  assert.equal(bot.activeLadder.side, 'DOWN');

  setNow(getNow() + 1_000);
  setQuote('UP', { ask: 0.99, bid: 0.98 });
  assert.equal(bot.evaluate(getNow()), false);
  assert.equal(bot.activeLadder.side, 'DOWN');
  assert.equal(bot.entryTriggeredThisWindow, true);
});

test('a $0.40 snapshot fills $0.90 through $0.50, but not the $0.40 rung', () => {
  const context = fixture();
  const { bot, setQuote, setNow, getNow } = context;
  armUp(context);

  setNow(getNow() + 1_000);
  setQuote('UP', { ask: 0.40, bid: 0.39 });
  assert.equal(bot.evaluate(getNow()), true);
  assert.deepEqual(
    bot.activeLadder.rungs.filter(rung => rung.status === 'FILLED').map(rung => rung.limitPrice),
    [0.90, 0.80, 0.70, 0.60, 0.50],
  );
  assert.equal(bot.activeLadder.lowestObservedPrice, 0.40);
  assert.equal(bot.trades.length, 5);
  assert.ok(bot.trades.every(trade => trade.shares === 100 && trade.fees === 0));
  assert.equal(bot.cash, 2_650);
});

test('the $0.40 rung fills only after a post-arm price reaches $0.39 or lower', () => {
  const context = fixture();
  const { bot, setQuote, setNow, getNow } = context;
  armUp(context);

  setNow(getNow() + 1_000);
  setQuote('UP', { ask: 0.40, bid: 0.39 });
  bot.evaluate(getNow());
  assert.equal(bot.activeLadder.rungs.find(rung => rung.limitPrice === 0.40).status, 'RESTING');

  setNow(getNow() + 1_000);
  setQuote('UP', { ask: 0.39, bid: 0.38 });
  bot.evaluate(getNow());
  assert.equal(bot.activeLadder.rungs.find(rung => rung.limitPrice === 0.40).status, 'FILLED');
});

test('fresh last-trade ticks can trigger and fill rungs without a fresh book snapshot', () => {
  const context = fixture();
  const { bot, setNow, getNow } = context;
  bot.quotes.UP.status = 'WAITING';
  bot.quotes.UP.updatedAt = null;
  assert.equal(bot.applyLastTradePrice({
    asset_id: 'token-up',
    price: '0.93',
    size: '10',
    timestamp: getNow(),
  }, getNow()), true);
  assert.equal(bot.evaluate(getNow()), true);
  assert.equal(bot.activeLadder.side, 'UP');

  setNow(getNow() + 1_000);
  bot.applyLastTradePrice({
    asset_id: 'token-up',
    price: '0.89',
    size: '10',
    timestamp: getNow(),
  }, getNow());
  assert.equal(bot.evaluate(getNow()), true);
  assert.equal(bot.trades.length, 1);
  assert.equal(bot.trades[0].entryPrice, 0.90);
});

test('a fast gap to $0.10 fills every rung once at its own limit price', () => {
  const context = fixture();
  const { bot, setQuote, setNow, getNow } = context;
  armUp(context);

  setNow(getNow() + 1_000);
  setQuote('UP', { ask: 0.10, bid: 0.09 });
  assert.equal(bot.evaluate(getNow()), true);
  assert.equal(bot.trades.length, 8);
  assert.ok(bot.activeLadder.rungs.every(rung => rung.status === 'FILLED'));
  assert.deepEqual(
    bot.trades.map(trade => trade.entryPrice),
    [0.90, 0.80, 0.70, 0.60, 0.50, 0.40, 0.30, 0.20],
  );
  assert.equal(bot.accountSnapshot().openCost, 440);
});

test('pre-trigger lows are not reused as post-trigger fills', () => {
  const context = fixture();
  const { bot, setQuote, setNow, getNow } = context;
  setQuote('UP', { ask: 0.40, bid: 0.39 });
  assert.equal(bot.evaluate(getNow()), false);
  assert.equal(bot.trades.length, 0);

  setNow(getNow() + 1_000);
  setQuote('UP', { ask: 0.92, bid: 0.91 });
  assert.equal(bot.evaluate(getNow()), true);
  assert.equal(bot.activeLadder.lowestObservedPrice, null);
  assert.equal(bot.trades.length, 0);

  assert.equal(bot.evaluate(getNow()), false);
  assert.equal(bot.trades.length, 0);
});

test('an opposite-side price tick never arms a second ladder in the same window', () => {
  const context = fixture();
  const { bot, setQuote, setNow, getNow } = context;
  armUp(context);

  setNow(getNow() + 1_000);
  setQuote('DOWN', { ask: 0.99, bid: 0.98 });
  assert.equal(bot.evaluate(getNow()), false);
  assert.equal(bot.activeLadder.side, 'UP');
  assert.equal(bot.trades.length, 0);
});

test('filled positions do not exit at $0.99 or $0.01 and wait for window resolution', async () => {
  const context = fixture();
  const { bot, setQuote, setNow, getNow } = context;
  armUp(context);
  setNow(getNow() + 1_000);
  setQuote('UP', { ask: 0.89, bid: 0.88 });
  bot.evaluate(getNow());
  const trade = bot.trades[0];
  assert.equal(trade.status, 'OPEN');

  setNow(getNow() + 1_000);
  setQuote('UP', { ask: 0.99, bid: 0.98 });
  bot.evaluate(getNow());
  assert.equal(trade.status, 'OPEN');
  assert.equal(trade.exitReason, undefined);

  await bot.resetWindow(bot.windowEnd);
  assert.equal(trade.status, 'AWAITING_RESOLUTION');
  assert.equal(bot.activeLadder, null);
});

test('window rollover cancels unfilled rungs but preserves filled positions', async () => {
  const context = fixture();
  const { bot, setQuote, setNow, getNow } = context;
  armUp(context);
  setNow(getNow() + 1_000);
  setQuote('UP', { ask: 0.89, bid: 0.88 });
  bot.evaluate(getNow());
  assert.equal(bot.trades.length, 1);

  await bot.resetWindow(bot.windowEnd);
  assert.equal(bot.trades[0].status, 'AWAITING_RESOLUTION');
  assert.equal(bot.activeLadder, null);
  assert.equal(bot.events.some(event => event.type === 'LADDER_EXPIRED'), true);
});

test('insufficient paper cash blocks a rung instead of recording a partial fill', () => {
  const context = fixture();
  const { bot, setQuote, setNow, getNow } = context;
  bot.cash = 10;
  armUp(context);
  setNow(getNow() + 1_000);
  setQuote('UP', { ask: 0.89, bid: 0.88 });
  bot.evaluate(getNow());
  assert.equal(bot.trades.length, 0);
  assert.equal(bot.activeLadder.rungs[0].status, 'BLOCKED_INSUFFICIENT_CASH');
});

test('an active ladder and existing paper history survive a service restart', () => {
  const context = fixture();
  const { bot, setQuote, setNow, getNow } = context;
  armUp(context);
  setNow(getNow() + 1_000);
  setQuote('UP', { ask: 0.89, bid: 0.88 });
  bot.evaluate(getNow());
  const before = bot.persistentStateSnapshot();

  const restored = fixture().bot;
  restored.restoreState(before);
  assert.equal(restored.activeLadder.side, 'UP');
  assert.equal(restored.activeLadder.rungs[0].status, 'FILLED');
  assert.equal(restored.trades.length, 1);
  assert.equal(restored.entryTriggeredThisWindow, true);
  assert.equal(restored.cash, bot.cash);
});

test('a strategy change discards an old pending order but keeps the paper ledger', () => {
  const { bot } = fixture();
  const oldTrade = {
    id: 'old-filled-position',
    strategyVersion: 'old-version',
    status: 'OPEN',
    marketId: 'market-current',
    tokenId: 'token-up',
    side: 'UP',
    shares: 5,
    totalCost: 2,
    windowStart: 900_000,
  };
  bot.restoreState({
    strategyVersion: 'old-version',
    startingCapital: 3_000,
    cash: 2_998,
    realizedPnl: 12,
    trades: [oldTrade],
    events: [{ id: 'old-history-event', type: 'OLD_EVENT', at: 1 }],
    tradeSequence: 1,
    eventSequence: 1,
    windowStart: 900_000,
    entryTriggeredThisWindow: true,
    pendingEntryOrder: {
      id: 'old-pending-order',
      side: 'DOWN',
      windowStart: 900_000,
      filledShares: 0,
      remainingShares: 100,
    },
  });

  assert.equal(bot.pendingEntryOrder, null);
  assert.equal(bot.activeLadder, null);
  assert.equal(bot.entryTriggeredThisWindow, false);
  assert.equal(bot.trades.length, 1);
  assert.equal(bot.trades[0].id, 'old-filled-position');
  assert.equal(bot.events.some(event => event.type === 'OLD_EVENT'), true);
  assert.equal(bot.events.some(event => event.type === 'LEGACY_ENTRY_ORDER_CANCELLED'), true);
  assert.equal(bot.cash, 2_998);
});

test('new-strategy positions settle only from their exact original market', async () => {
  const context = fixture();
  const { bot, setNow } = context;
  const trade = {
    id: 'ladder-trade-awaiting',
    strategyVersion: bot.config.STRATEGY_VERSION,
    status: 'AWAITING_RESOLUTION',
    marketId: 'market-old',
    tokenId: 'old-up-token',
    side: 'UP',
    shares: 100,
    totalCost: 50,
    fees: 0,
  };
  bot.trades.push(trade);
  bot.cash = 2_950;
  bot.marketData.getMarket = async marketId => ({
    id: marketId,
    closed: true,
    umaResolutionStatus: 'resolved',
    outcomePrices: '["1","0"]',
    outcomes: '["Up","Down"]',
    clobTokenIds: '["old-up-token","old-down-token"]',
  });
  setNow(10_000_000);
  await bot.resolveDue();
  assert.equal(trade.status, 'SETTLED');
  assert.equal(trade.settlementSource, 'ORIGINAL_MARKET_RESOLUTION');
  assert.equal(trade.realizedPnl, 50);
  assert.equal(bot.cash, 3_050);
  assert.equal(bot.nextEntryShares, 100);
});
