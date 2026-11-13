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

function openTakerPosition(context, expectedSide = 'UP') {
  const { bot } = context;
  assert.equal(bot.evaluate(), true);
  const trade = bot.currentOpenTrade();
  assert.ok(trade);
  assert.equal(trade.side, expectedSide);
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

test('a taker entry sweeps exactly 100 shares and never records a partial fill', () => {
  const { bot, setBook } = fixture();
  setBook('UP', {
    asks: [[0.58, 40], [0.6, 60]],
    bids: [[0.4, 100]],
  });
  assert.equal(bot.evaluate(), true);
  assert.equal(bot.trades.length, 1);
  assert.equal(bot.trades[0].shares, 100);
  assert.equal(bot.trades[0].fills.length, 2);
  assert.equal(bot.trades[0].status, 'OPEN');
  assert.equal(bot.trades[0].executionRole, 'TAKER');
  assert.equal(bot.entryTriggeredThisWindow, true);
});

test('insufficient ask depth does not create a partial position', () => {
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
  assert.equal(bot.trades.length, 0);
  assert.equal(bot.entryTriggeredThisWindow, false);
});

test('resolution-adjusted share size is used for the next taker entry', () => {
  const { bot, setBook } = fixture();
  bot.nextEntryShares = 120;
  setBook('UP', {
    asks: [[0.6, 120]],
    bids: [[0.4, 120]],
  });
  assert.equal(bot.evaluate(), true);
  assert.equal(bot.trades[0].shares, 120);
  assert.equal(bot.nextEntryShares, 120);
});

test('no side enters when full ask-sweep costs miss the minimum edge', () => {
  const { bot, setBook } = fixture();
  setBook('UP', {
    asks: [[0.99, 100]],
    bids: [[0.95, 100]],
  });
  setBook('DOWN', {
    asks: [[0.9, 100]],
    bids: [[0.8, 100]],
  });
  assert.equal(bot.evaluate(), false);
  assert.equal(bot.trades.length, 0);
  assert.equal(bot.entryTriggeredThisWindow, false);
});

test('an opposite signal cannot flip a position that is not net profitable to sell', () => {
  const context = fixture();
  const { bot, setBook, setPrice } = context;
  openTakerPosition(context);
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
  assert.equal(strategy.profitableIntrawindowCloseReducesSize, true);
  assert.equal(strategy.minimumNetEdgePerShare, 0.05);
  assert.equal(strategy.minimumFlipNetEdgePerShare, 0.10);
  assert.equal(strategy.flipConfirmationUpdates, 2);
  assert.equal(strategy.flipConfirmationIntervalMs, 500);
  openTakerPosition(context);
  bot.trades.push(
    { id: 'prior-loss-1', outcome: 'LOSS', sizingOutcome: 'LOSS', sizingAdjustmentApplied: true, sizingAdjustedAt: 1, windowStart: 1 },
    { id: 'prior-loss-2', outcome: 'LOSS', sizingOutcome: 'LOSS', sizingAdjustmentApplied: true, sizingAdjustedAt: 2, windowStart: 2 },
  );
  bot.recalculateNextEntryShares();
  assert.equal(bot.nextEntryShares, 140);
  setPrice(99_600);
  setNow(960_500);
  setBook('UP', {
    asks: [[0.7, 100]],
    bids: [[0.8, 100]],
  });
  setBook('DOWN', {
    asks: [[0.1, 110]],
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
    asks: [[0.1, 110]],
    bids: [[0.05, 100]],
  });
  assert.equal(bot.evaluate(), true);
  assert.equal(bot.flipsThisWindow, 1);
  assert.equal(bot.trades[0].status, 'CLOSED');
  assert.ok(bot.trades[0].realizedPnl > 0);
  assert.equal(bot.trades[0].sizingOutcome, 'WIN');
  assert.equal(bot.trades[0].sizingAdjustmentApplied, true);
  assert.equal(bot.nextEntryShares, 110);
  assert.ok(bot.trades[0].fees > 0);
  assert.ok(bot.trades[0].exitFees > 0);
  const flippedTrade = bot.trades.find(trade => trade.entryReason === 'PROFITABLE_MODEL_FLIP');
  assert.ok(flippedTrade);
  assert.equal(flippedTrade.side, 'DOWN');
  assert.equal(flippedTrade.shares, 110);
  assert.ok(flippedTrade.fees > 0);
  assert.equal(
    bot.applySizingAdjustment(bot.trades[0], 'WIN', 961_000, 'duplicate close', 'TEST'),
    false,
  );
  assert.equal(bot.nextEntryShares, 110);
  const expectedFees = bot.trades.reduce(
    (sum, trade) => sum + (Number(trade.fees) || 0) + (Number(trade.exitFees) || 0),
    0,
  );
  assert.equal(bot.accountSnapshot().takerFees, Math.round(expectedFees * 100) / 100);
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
  openTakerPosition(context);
  setPrice(99_600);
  setNow(961_000);
  const downProbability = bot.modelSnapshot(getNow()).probabilityDown;
  const downAsk = downProbability - 0.08;
  assert.ok(downAsk > 0 && downAsk < 1);
  setBook('UP', {
    asks: [[0.7, 100]],
    bids: [[0.8, 100]],
  });
  setBook('DOWN', {
    asks: [[downAsk, 100]],
    bids: [[0.05, 100]],
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
  openTakerPosition(context);
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

test('resolved outcomes and profitable closes adjust size once; the 100-share floor is preserved', () => {
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
  const profitableExit = {
    id: 'sizing-profit-close',
    status: 'OPEN',
    outcome: null,
    totalCost: 10,
  };
  bot.trades.push(profitableExit);
  bot.closePosition(profitableExit, {
    netProceeds: 20,
    gross: 20,
    fees: 0,
    averagePrice: 0.2,
    fills: [],
  }, 3, 'PROFITABLE_MODEL_FLIP', 'DOWN');
  assert.equal(profitableExit.outcome, 'EXIT');
  assert.equal(profitableExit.sizingOutcome, 'WIN');
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
  assert.equal(state.strategy.entryOrderType, 'TAKER SWEEP OF VISIBLE ASKS');
  assert.equal(Object.hasOwn(state, 'pendingEntryOrder'), false);
});
