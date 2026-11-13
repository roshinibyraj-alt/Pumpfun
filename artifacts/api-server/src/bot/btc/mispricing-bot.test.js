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

  function confirmEntry() {
    const firstUpdate = bot.evaluate();
    currentTime += 500;
    const confirmed = bot.evaluate();
    return { firstUpdate, confirmed };
  }

  function printSell(side, price, size, transactionHash = `paper-print-${currentTime}-${side}`) {
    bot.handleMarketMessage({
      topic: 'market',
      type: 'last_trade_price',
      payload: {
        assetId: market.tokens[side],
        side: 'SELL',
        price: String(price),
        size: String(size),
        timestamp: String(currentTime),
        transactionHash,
      },
    });
  }

  function fillPendingOrder(extraShares = 0) {
    const order = bot.pendingEntryOrder;
    if (!order) return null;
    const printSize = order.queueAheadShares + order.remainingShares + extraShares;
    printSell(order.side, order.limitPrice, printSize, `fill-${order.id}`);
    return bot.trades.find(trade => trade.id === order.tradeId) || null;
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
    confirmEntry,
    printSell,
    fillPendingOrder,
    setPrice(value) { price = value; },
    setNow(value) { currentTime = value; },
    getNow() { return currentTime; },
  };
}

function openMakerPosition(context, expectedSide = 'UP') {
  const { bot, confirmEntry, fillPendingOrder } = context;
  const result = confirmEntry();
  assert.equal(result.firstUpdate, false);
  assert.equal(result.confirmed, true);
  assert.equal(bot.pendingEntryOrder.side, expectedSide);
  const trade = fillPendingOrder();
  assert.ok(trade);
  assert.equal(trade.status, 'OPEN');
  return trade;
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

test('entry requires two fresh confirmations and posts a post-only limit at the best bid', () => {
  const context = fixture();
  const { bot, confirmEntry } = context;
  const result = confirmEntry();
  assert.equal(result.firstUpdate, false);
  assert.equal(result.confirmed, true);
  assert.equal(bot.trades.length, 0);
  assert.equal(bot.pendingEntryOrder.side, 'UP');
  assert.equal(bot.pendingEntryOrder.limitPrice, 0.4);
  assert.equal(bot.pendingEntryOrder.targetShares, 100);
  assert.equal(bot.pendingEntryOrder.queueAheadShares, 100);
  assert.equal(bot.pendingEntryOrder.postOnly, true);
  assert.equal(bot.entryTriggeredThisWindow, true);
});

test('maker order fills only after sell prints clear displayed queue and may fill partially', () => {
  const context = fixture();
  const { bot, confirmEntry, printSell } = context;
  confirmEntry();
  const order = bot.pendingEntryOrder;
  assert.ok(order);

  printSell('UP', order.limitPrice, order.queueAheadShares + 30, 'partial-sell-print');
  const trade = bot.trades[0];
  assert.equal(trade.shares, 30);
  assert.equal(trade.fees, 0);
  assert.equal(order.remainingShares, 70);
  assert.equal(order.queueAheadShares, 0);

  printSell('UP', order.limitPrice, 70, 'final-sell-print');
  assert.equal(trade.shares, 100);
  assert.equal(trade.totalCost, 40);
  assert.equal(trade.status, 'OPEN');
  assert.equal(bot.pendingEntryOrder, null);
});

test('a buy-aggressor print does not fill a resting maker buy', () => {
  const context = fixture();
  const { bot, confirmEntry, market } = context;
  confirmEntry();
  const order = bot.pendingEntryOrder;
  bot.handleMarketMessage({
    event_type: 'last_trade_price',
    asset_id: market.tokens.UP,
    side: 'BUY',
    price: String(order.limitPrice),
    size: '1000',
    timestamp: String(context.getNow()),
    transaction_hash: 'buy-side-print',
  });
  assert.equal(bot.trades.length, 0);
  assert.equal(bot.pendingEntryOrder.remainingShares, 100);
});

test('no side enters when the passive bid fails the minimum edge filter', () => {
  const { bot, setBook } = fixture();
  setBook('UP', {
    asks: [[0.95, 100]],
    bids: [[0.9, 100]],
  });
  setBook('DOWN', {
    asks: [[0.9, 100]],
    bids: [[0.8, 100]],
  });
  assert.equal(bot.evaluate(), false);
  assert.equal(bot.evaluate(), false);
  assert.equal(bot.trades.length, 0);
  assert.equal(bot.entryTriggeredThisWindow, false);
  assert.equal(bot.pendingEntryOrder, null);
});

test('an opposite signal cannot flip a position that is not net profitable to sell', () => {
  const context = fixture();
  const { bot, setBook, setPrice } = context;
  openMakerPosition(context);
  setPrice(99_600);
  setBook('UP', {
    asks: [[0.7, 100]],
    bids: [[0.3, 100]],
  });
  setBook('DOWN', {
    asks: [[0.1, 100]],
    bids: [[0.05, 100]],
  });
  assert.equal(bot.evaluate(), false);
  assert.equal(bot.flipsThisWindow, 0);
  assert.equal(bot.trades.filter(trade => trade.status === 'OPEN').length, 1);
});

test('a profitable flip requires two fresh opposite updates at least 500 ms apart', () => {
  const context = fixture();
  const { bot, setBook, setPrice, setNow } = context;
  context.market.raw.feesEnabled = true;
  const strategy = bot.snapshot().strategy;
  assert.equal(strategy.baseShares, 100);
  assert.equal(strategy.nextEntryShares, 100);
  assert.equal(strategy.lossSizeStepShares, 20);
  assert.equal(strategy.winSizeReductionShares, 30);
  assert.equal(strategy.entryConfirmationUpdates, 2);
  assert.equal(strategy.minimumNetEdgePerShare, 0.05);
  assert.equal(strategy.minimumFlipNetEdgePerShare, 0.10);
  assert.equal(strategy.flipConfirmationUpdates, 2);
  assert.equal(strategy.flipConfirmationIntervalMs, 500);
  openMakerPosition(context);
  setPrice(99_600);
  setNow(960_500);
  setBook('UP', {
    asks: [[0.7, 100]],
    bids: [[0.8, 100]],
  });
  setBook('DOWN', {
    asks: [[0.1, 100]],
    bids: [[0.05, 100]],
  });
  assert.equal(bot.evaluate(), false);
  assert.equal(bot.flipsThisWindow, 0);
  assert.equal(bot.flipConfirmation.count, 1);
  assert.match(bot.currentSignal.reason, /1\/2 fresh Binance updates/);
  assert.equal(bot.trades.filter(trade => trade.status === 'OPEN').length, 1);

  assert.equal(bot.evaluate(), false);
  assert.equal(bot.flipConfirmation.count, 1);

  setNow(961_000);
  setBook('UP', {
    asks: [[0.7, 100]],
    bids: [[0.8, 100]],
  });
  setBook('DOWN', {
    asks: [[0.1, 100]],
    bids: [[0.05, 100]],
  });
  assert.equal(bot.evaluate(), true);
  assert.equal(bot.flipsThisWindow, 1);
  assert.equal(bot.trades[0].status, 'CLOSED');
  assert.ok(bot.trades[0].realizedPnl > 0);
  assert.equal(bot.trades[0].fees, 0);
  assert.ok(bot.trades[0].estimatedMakerRebate > 0);
  assert.ok(bot.trades[0].exitFees > 0);
  assert.ok(Math.abs(bot.accountSnapshot().takerFees - bot.trades[0].exitFees) < 1e-9);
  assert.equal(bot.trades.length, 1);
  assert.equal(bot.pendingEntryOrder.side, 'DOWN');
  assert.equal(bot.pendingEntryOrder.targetShares, 100);
  context.printSell('DOWN', 0.05, 200, 'opposite-maker-fill');
  assert.equal(bot.trades[1].side, 'DOWN');
  assert.equal(bot.trades[1].shares, 100);
  assert.equal(bot.flipConfirmation.count, 0);

  setPrice(100_400);
  setNow(961_500);
  setBook('UP', {
    asks: [[0.6, 100]],
    bids: [[0.5, 100]],
  });
  setBook('DOWN', {
    asks: [[0.2, 100]],
    bids: [[0.8, 100]],
  });
  assert.equal(bot.evaluate(), false);
  assert.equal(bot.flipsThisWindow, 1);
  assert.equal(bot.trades.filter(trade => trade.status === 'OPEN').length, 1);
  assert.equal(bot.trades.find(trade => trade.status === 'OPEN').side, 'DOWN');
});

test('a profitable position does not flip when opposite edge is below ten cents', () => {
  const context = fixture();
  const { bot, setBook, setPrice, setNow, getNow } = context;
  openMakerPosition(context);
  setPrice(99_600);
  setNow(961_000);
  const downProbability = bot.modelSnapshot(getNow()).probabilityDown;
  const downBid = downProbability - 0.08;
  assert.ok(downBid > 0 && downBid < 1);
  setBook('UP', {
    asks: [[0.7, 100]],
    bids: [[0.8, 100]],
  });
  setBook('DOWN', {
    asks: [[downBid + 0.01, 100]],
    bids: [[downBid, 100]],
  });

  assert.equal(bot.evaluate(), false);
  assert.equal(bot.flipsThisWindow, 0);
  assert.equal(bot.flipConfirmation.count, 0);
  assert.ok(bot.currentSignal.edgePerShare < 0.10);
  assert.match(bot.currentSignal.reason, /below the \$0\.10 flip threshold/);
  assert.equal(bot.trades.filter(trade => trade.status === 'OPEN').length, 1);
});

test('flip confirmation resets when the opposite edge breaks before confirmation', () => {
  const context = fixture();
  const { bot, setBook, setPrice, setNow } = context;
  openMakerPosition(context);
  setPrice(99_600);
  setNow(961_000);
  setBook('UP', {
    asks: [[0.7, 100]],
    bids: [[0.8, 100]],
  });
  setBook('DOWN', {
    asks: [[0.1, 100]],
    bids: [[0.05, 100]],
  });
  assert.equal(bot.evaluate(), false);
  assert.equal(bot.flipConfirmation.count, 1);

  setPrice(100_400);
  setNow(961_250);
  setBook('UP', {
    asks: [[0.7, 100]],
    bids: [[0.8, 100]],
  });
  setBook('DOWN', {
    asks: [[0.1, 100]],
    bids: [[0.05, 100]],
  });
  assert.equal(bot.evaluate(), false);
  assert.equal(bot.flipConfirmation.count, 0);

  setPrice(99_600);
  setNow(961_500);
  setBook('UP', {
    asks: [[0.7, 100]],
    bids: [[0.8, 100]],
  });
  setBook('DOWN', {
    asks: [[0.1, 100]],
    bids: [[0.05, 100]],
  });
  assert.equal(bot.evaluate(), false);
  assert.equal(bot.flipsThisWindow, 0);
  assert.equal(bot.flipConfirmation.count, 1);
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

test('only resolved wins and losses change size; the 100-share floor is preserved', () => {
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
  record('WIN', 3);
  assert.equal(bot.nextEntryShares, 110);
  record('WIN', 4);
  assert.equal(bot.nextEntryShares, 100);
  record('WIN', 5);
  assert.equal(bot.nextEntryShares, 100);
  record('EXIT', 6);
  assert.equal(bot.nextEntryShares, 100);

  const state = bot.persistentStateSnapshot();
  const restored = fixture().bot;
  restored.restoreState(state);
  assert.equal(restored.nextEntryShares, 100);
});

test('a resting order is canceled when its edge filter stops qualifying', () => {
  const context = fixture();
  const { bot, confirmEntry, setPrice, setBook } = context;
  confirmEntry();
  assert.ok(bot.pendingEntryOrder);
  setPrice(99_600);
  context.setNow(context.getNow() + 500);
  setBook('UP', { asks: [[0.45, 100]], bids: [[0.4, 100]] });
  setBook('DOWN', { asks: [[0.35, 100]], bids: [[0.3, 100]] });
  bot.evaluate();
  assert.equal(bot.pendingEntryOrder, null);
  assert.equal(bot.trades.length, 0);
  assert.ok(bot.events.some(event => event.type === 'MAKER_ORDER_CANCELLED'));
});
