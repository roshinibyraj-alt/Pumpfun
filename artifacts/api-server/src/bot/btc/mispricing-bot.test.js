'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  BtcMispricingBot,
  calculateVolatility,
  estimateUpProbability,
} = require('./mispricing-bot.cjs');
const { CANDLE_MS, STREAM_URL, parseClosedCandles } = require('./binance-tick-feed.cjs');

function makeClosedCandle(start, open, close) {
  return {
    start,
    end: start + CANDLE_MS,
    open,
    close,
    closed: true,
    logReturn: Math.log(close / open),
  };
}

function fixture({ price = 100_400, historyCount = 3 } = {}) {
  let currentTime = 960_000;
  const windowStart = 900_000;
  const candles = [
    makeClosedCandle(0, 100_000, 100_200),
    makeClosedCandle(300_000, 100_200, 100_100),
    makeClosedCandle(600_000, 100_100, 100_200),
  ].slice(-historyCount);
  const feed = {
    snapshot() {
      return {
        status: 'CONNECTED',
        historyStatus: historyCount === 3 ? 'READY' : 'INSUFFICIENT_HISTORY',
        price,
        tickAt: currentTime,
        tickAgeMs: 0,
        candles,
        currentCandle: {
          start: windowStart,
          end: windowStart + CANDLE_MS,
          open: 100_000,
          close: price,
          closed: false,
        },
      };
    },
    async start() {},
    stop() {},
  };
  const market = {
    id: 'market-current',
    slug: 'btc-updown-5m-current',
    title: 'BTC Up or Down',
    start: windowStart,
    end: windowStart + CANDLE_MS,
    tokens: { UP: 'token-up', DOWN: 'token-down' },
    raw: { feesEnabled: false },
  };
  const bot = new BtcMispricingBot({
    now: () => currentTime,
    priceFeed: feed,
    marketData: {
      async getMarket() {
        return null;
      },
    },
  });
  bot.market = market;
  bot.windowStart = windowStart;
  bot.windowEnd = windowStart + CANDLE_MS;
  bot.storageHealthy = true;

  function setBook(side, { asks = [], bids = [] }) {
    const tokenId = market.tokens[side];
    const normalizedAsks = asks.map(([bookPrice, size]) => ({
      price: bookPrice,
      size,
      availableSize: size,
    })).sort((a, b) => a.price - b.price);
    const normalizedBids = bids.map(([bookPrice, size]) => ({
      price: bookPrice,
      size,
      availableSize: size,
    })).sort((a, b) => b.price - a.price);
    bot.books.set(tokenId, {
      asks: normalizedAsks,
      bids: normalizedBids,
      updatedAt: currentTime,
      sourceTimestamp: currentTime,
    });
    const ask = normalizedAsks[0] || null;
    const bid = normalizedBids[0] || null;
    bot.quotes[side] = {
      side,
      tokenId,
      bestAsk: ask?.price ?? null,
      askSize: ask?.availableSize ?? 0,
      bestBid: bid?.price ?? null,
      bidSize: bid?.availableSize ?? 0,
      updatedAt: currentTime,
      sourceTimestamp: currentTime,
      status: 'LIVE',
    };
  }

  setBook('UP', {
    asks: [[0.6, 100]],
    bids: [[0.4, 100]],
  });
  setBook('DOWN', {
    asks: [[0.4, 100]],
    bids: [[0.3, 100]],
  });

  return {
    bot,
    feed,
    market,
    setBook,
    setPrice(value) { price = value; },
    setNow(value) { currentTime = value; },
    getNow() { return currentTime; },
  };
}

test('Binance ticks use the official public market-data WebSocket endpoint', () => {
  assert.equal(STREAM_URL, 'wss://data-stream.binance.vision/ws/btcusdt@aggTrade');
});

test('Binance history keeps three completed candles separate from the live candle', () => {
  const now = 4 * CANDLE_MS + 1_000;
  const rows = [
    [0, '100', '101', '99', '100.5'],
    [CANDLE_MS, '100.5', '102', '100', '101'],
    [2 * CANDLE_MS, '101', '102', '100', '101.5'],
    [3 * CANDLE_MS, '101.5', '102', '101', '101.75'],
    [4 * CANDLE_MS, '101.75', '102', '101.7', '101.8'],
  ];
  const parsed = parseClosedCandles(rows, now);
  assert.equal(parsed.filter(candle => candle.closed).length, 4);
  assert.equal(parsed.at(-1).closed, false);
  assert.equal(parsed.at(-1).start, 4 * CANDLE_MS);
});

test('volatility uses only the latest three closed candle returns', () => {
  const candles = [
    makeClosedCandle(0, 100, 200),
    makeClosedCandle(CANDLE_MS, 100, 101),
    makeClosedCandle(2 * CANDLE_MS, 100, 99),
    makeClosedCandle(3 * CANDLE_MS, 100, 102),
  ];
  const returns = candles.slice(-3).map(candle => Math.log(candle.close / candle.open));
  const expected = Math.sqrt(returns.reduce((sum, value) => sum + value ** 2, 0) / 3);
  assert.equal(calculateVolatility(candles, 3), expected);
  assert.equal(calculateVolatility(candles.slice(-2), 3), null);
});

test('estimated probability is balanced at the window open and follows price direction', () => {
  const base = { windowOpenPrice: 100, volatility5m: 0.01, secondsRemaining: 150 };
  assert.ok(Math.abs(estimateUpProbability({ ...base, currentPrice: 100 }) - 0.5) < 0.00001);
  assert.ok(estimateUpProbability({ ...base, currentPrice: 101 }) > 0.5);
  assert.ok(estimateUpProbability({ ...base, currentPrice: 99 }) < 0.5);
});

test('the bot waits when fewer than three closed candles are available', () => {
  const { bot } = fixture({ historyCount: 2 });
  assert.equal(bot.evaluate(), false);
  assert.equal(bot.trades.length, 0);
});

test('a qualifying signal posts one resting limit buy at the signaled best bid', () => {
  const { bot } = fixture();
  assert.equal(bot.evaluate(), true);
  assert.equal(bot.trades.length, 0);
  assert.equal(bot.pendingEntryOrder.side, 'UP');
  assert.equal(bot.pendingEntryOrder.limitPrice, 0.4);
  assert.equal(bot.pendingEntryOrder.targetShares, 100);
  assert.equal(bot.pendingEntryOrder.status, 'RESTING');
  assert.equal(bot.entryTriggeredThisWindow, true);
  assert.equal(bot.snapshot().strategy.entryOrderType, 'POST-ONLY LIMIT BUY AT BEST BID');
});

test('sell-side prints walk through the bid and fill maker orders after queue-ahead volume', () => {
  const { bot, market } = fixture();
  market.raw.feesEnabled = true;
  assert.equal(bot.evaluate(), true);
  const order = bot.pendingEntryOrder;
  assert.equal(order.queueAheadShares, 100);

  bot.handleMarketMessage({
    event_type: 'last_trade_price',
    asset_id: market.tokens.UP,
    side: 'SELL',
    price: '0.40',
    size: '100',
    timestamp: 960_000,
  });
  assert.equal(bot.trades.length, 0);
  assert.equal(order.queueAheadShares, 0);

  bot.handleMarketMessage({
    event_type: 'last_trade_price',
    asset_id: market.tokens.UP,
    side: 'SELL',
    price: '0.40',
    size: '40',
    timestamp: 960_001,
  });
  assert.equal(bot.trades[0].shares, 40);
  assert.equal(bot.trades[0].status, 'OPEN');
  assert.equal(bot.trades[0].executionRole, 'MAKER');
  assert.equal(bot.trades[0].fees, 0);
  assert.ok(bot.trades[0].estimatedMakerRebate > 0);
  assert.ok(bot.trades[0].totalCost < 16);

  bot.handleMarketMessage({
    event_type: 'last_trade_price',
    asset_id: market.tokens.UP,
    side: 'SELL',
    price: '0.39',
    size: '60',
    timestamp: 960_002,
  });
  assert.equal(bot.trades[0].shares, 100);
  assert.equal(bot.pendingEntryOrder, null);
  assert.equal(bot.trades[0].fees, 0);
  assert.ok(Math.abs(bot.trades[0].estimatedMakerRebate - 0.336) < 1e-10);
  assert.ok(Math.abs(bot.trades[0].totalCost - 39.664) < 1e-10);
  assert.ok(Math.abs(bot.accountSnapshot().estimatedMakerRebates - 0.336) < 1e-10);
  assert.equal(bot.accountSnapshot().takerFees, 0);
});

test('current next-entry size and sizing progression are retained for maker orders', () => {
  const { bot, setBook } = fixture();
  bot.nextEntryShares = 150;
  setBook('UP', {
    asks: [[0.6, 150]],
    bids: [[0.4, 150]],
  });
  assert.equal(bot.evaluate(), true);
  assert.equal(bot.pendingEntryOrder.targetShares, 150);
  assert.equal(bot.nextEntryShares, 150);
  assert.equal(bot.snapshot().strategy.baseShares, 100);
  assert.equal(bot.snapshot().strategy.lossSizeStepShares, 20);
  assert.equal(bot.snapshot().strategy.winSizeReductionShares, 30);
});

test('insufficient ask depth or insufficient net edge does not post an order', () => {
  const { bot, setBook } = fixture();
  setBook('UP', {
    asks: [[0.58, 50]],
    bids: [[0.4, 100]],
  });
  setBook('DOWN', {
    asks: [[0.9, 100]],
    bids: [[0.8, 100]],
  });
  assert.equal(bot.evaluate(), false);
  assert.equal(bot.pendingEntryOrder, null);
  assert.equal(bot.entryTriggeredThisWindow, false);

  setBook('UP', {
    asks: [[0.99, 100]],
    bids: [[0.95, 100]],
  });
  assert.equal(bot.evaluate(), false);
  assert.equal(bot.pendingEntryOrder, null);
});

test('an opposite model signal never sells or flips a filled maker position', () => {
  const { bot, market, setBook, setPrice, setNow } = fixture();
  assert.equal(bot.evaluate(), true);
  const order = bot.pendingEntryOrder;
  bot.applyLastTradePrice({
    asset_id: market.tokens.UP,
    side: 'SELL',
    price: order.limitPrice,
    size: order.queueAheadShares + order.targetShares,
    timestamp: 960_000,
  }, 960_000);
  const trade = bot.currentOpenTrade();
  assert.ok(trade);
  assert.equal(trade.side, 'UP');

  setPrice(99_600);
  setNow(961_000);
  setBook('UP', { asks: [[0.7, 100]], bids: [[0.8, 100]] });
  setBook('DOWN', { asks: [[0.1, 100]], bids: [[0.05, 100]] });
  assert.equal(bot.evaluate(), false);
  assert.equal(trade.status, 'OPEN');
  assert.equal(trade.exitFills, undefined);
  assert.equal(bot.flipsThisWindow, 0);
  assert.match(bot.currentSignal.reason, /flips and sells are disabled/);
});

test('positions settle only from the exact original market result', async () => {
  const context = fixture();
  const { bot, setNow } = context;
  const trade = {
    id: 'misprice-trade-1',
    status: 'AWAITING_RESOLUTION',
    marketId: 'market-old',
    tokenId: 'old-up-token',
    side: 'UP',
    shares: 100,
    totalCost: 50,
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
});

test('resolved outcomes adjust size once; the 100-share floor is preserved', () => {
  const { bot } = fixture();
  const record = (outcome, settledAt) => {
    const trade = {
      id: `sizing-${settledAt}`,
      outcome,
      settledAt,
      windowStart: settledAt,
      sizingAdjustmentApplied: false,
    };
    bot.trades.push(trade);
    bot.applyResolutionSizing(trade, settledAt);
  };

  record('LOSS', 1);
  assert.equal(bot.nextEntryShares, 120);
  record('LOSS', 2);
  assert.equal(bot.nextEntryShares, 140);
  record('WIN', 4);
  assert.equal(bot.nextEntryShares, 110);
  record('WIN', 5);
  assert.equal(bot.nextEntryShares, 100);
  record('WIN', 6);
  assert.equal(bot.nextEntryShares, 100);

  const state = bot.persistentStateSnapshot();
  const restored = fixture().bot;
  restored.restoreState(state);
  assert.equal(restored.nextEntryShares, 100);
});

test('a manual sizing reset preserves trade history and starts a fresh sizing progression', () => {
  const { bot } = fixture();
  bot.trades.push(
    {
      id: 'before-reset-loss-1',
      outcome: 'LOSS',
      sizingOutcome: 'LOSS',
      sizingAdjustmentApplied: true,
      sizingGeneration: 0,
      sizingAdjustedAt: 1,
      windowStart: 1,
    },
    {
      id: 'before-reset-loss-2',
      outcome: 'LOSS',
      sizingOutcome: 'LOSS',
      sizingAdjustmentApplied: true,
      sizingGeneration: 0,
      sizingAdjustedAt: 2,
      windowStart: 2,
    },
  );
  bot.events.push({ id: 'prior-event', type: 'OLD_EVENT' });
  bot.cash = 2_345;
  bot.realizedPnl = 678;
  assert.equal(bot.recalculateNextEntryShares(), 140);

  assert.equal(bot.applySizingResetRequest('manual-reset-100-2026-11-13-test'), true);
  assert.equal(bot.nextEntryShares, 100);
  assert.equal(bot.sizingGeneration, 1);
  assert.equal(bot.trades.length, 2);
  assert.equal(bot.events.some(event => event.id === 'prior-event'), true);
  assert.equal(bot.cash, 2_345);
  assert.equal(bot.realizedPnl, 678);
  assert.equal(
    bot.events[0].type,
    'NEXT_ENTRY_SIZE_RESET',
  );
  assert.equal(
    bot.applySizingResetRequest('manual-reset-100-2026-11-13-test'),
    false,
  );

  const restored = fixture().bot;
  restored.restoreState(bot.persistentStateSnapshot());
  assert.equal(restored.nextEntryShares, 100);
  assert.equal(restored.sizingGeneration, 1);
  assert.equal(restored.trades.length, 2);

  const laterLoss = {
    id: 'after-reset-loss',
    outcome: 'LOSS',
    settledAt: 3,
    windowStart: 3,
    sizingAdjustmentApplied: false,
  };
  restored.trades.push(laterLoss);
  restored.applyResolutionSizing(laterLoss, 3);
  assert.equal(restored.nextEntryShares, 120);
});

test('restoring the sizing state cancels any obsolete passive order', () => {
  const { bot } = fixture();
  bot.restoreState({
    startingCapital: 3_000,
    cash: 2_950,
    realizedPnl: -50,
    trades: [],
    events: [],
    tradeSequence: 0,
    eventSequence: 0,
    nextEntryShares: 120,
    windowStart: 900_000,
    entryTriggeredThisWindow: true,
    pendingEntryOrder: {
      id: 'misprice-order-old',
      windowStart: 900_000,
      side: 'UP',
      remainingShares: 100,
    },
    flipsThisWindow: 0,
  });
  assert.equal(bot.pendingEntryOrder, null);
  assert.equal(bot.nextEntryShares, 120);
  const state = bot.snapshot();
  assert.equal(state.strategy.entryOrderType, 'POST-ONLY LIMIT BUY AT BEST BID');
  assert.equal(Object.hasOwn(state, 'pendingEntryOrder'), false);
});
