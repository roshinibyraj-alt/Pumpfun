'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  BtcMispricingBot,
  calculateVolatility,
  selectInitialSideFromCandles,
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

function fixture({ price = 100_400, historyCount = 3, candleSet = null } = {}) {
  let currentTime = 960_000;
  const windowStart = 900_000;
  const candles = (candleSet || [
    makeClosedCandle(0, 100_000, 100_200),
    makeClosedCandle(300_000, 100_200, 100_100),
    makeClosedCandle(600_000, 100_100, 100_120),
  ]).slice(-historyCount);
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

test('initial side is UP when candles 1 and 2 average above candle 3', () => {
  const selection = selectInitialSideFromCandles([
    makeClosedCandle(0, 100, 102),
    makeClosedCandle(CANDLE_MS, 100, 99),
    makeClosedCandle(2 * CANDLE_MS, 100, 100.2),
  ]);
  assert.equal(selection.side, 'UP');
  assert.ok(selection.averageFirstTwoReturnPct > selection.latestReturnPct);
});

test('initial side is DOWN when candles 1 and 2 average below candle 3', () => {
  const selection = selectInitialSideFromCandles([
    makeClosedCandle(0, 100, 99.8),
    makeClosedCandle(CANDLE_MS, 100, 99.9),
    makeClosedCandle(2 * CANDLE_MS, 100, 100.2),
  ]);
  assert.equal(selection.side, 'DOWN');
  assert.ok(selection.averageFirstTwoReturnPct < selection.latestReturnPct);
});

test('an exact candle comparison tie selects no initial side', () => {
  const selection = selectInitialSideFromCandles([
    makeClosedCandle(0, 100, 101),
    makeClosedCandle(CANDLE_MS, 100, 99),
    makeClosedCandle(2 * CANDLE_MS, 100, 100),
  ]);
  assert.equal(selection.side, null);
  assert.match(selection.reason, /exactly matches/);
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

test('a qualifying signal immediately sweeps asks with one taker buy', () => {
  const { bot } = fixture();
  assert.equal(bot.evaluate(), true);
  assert.equal(bot.trades.length, 1);
  assert.equal(bot.trades[0].side, 'UP');
  assert.equal(bot.trades[0].shares, 100);
  assert.equal(bot.trades[0].entryPrice, 0.6);
  assert.equal(bot.trades[0].executionRole, 'TAKER');
  assert.equal(bot.trades[0].status, 'OPEN');
  assert.equal(bot.pendingEntryOrder, null);
  assert.equal(bot.entryTriggeredThisWindow, true);
  assert.equal(bot.snapshot().strategy.entryOrderType, 'MARKET BUY (TAKER)');
});

test('the candle-selected DOWN side is the only side evaluated for entry', () => {
  const { bot } = fixture({
    price: 99_900,
    candleSet: [
      makeClosedCandle(0, 100_000, 99_800),
      makeClosedCandle(300_000, 100_000, 99_900),
      makeClosedCandle(600_000, 100_000, 100_200),
    ],
  });
  assert.equal(bot.evaluate(), true);
  assert.equal(bot.trades[0].side, 'DOWN');
  assert.equal(bot.snapshot().model.initialSideSelection.side, 'DOWN');
});

test('a qualifying opposite model side cannot bypass the candle-selected side', () => {
  const { bot, setBook } = fixture({
    price: 99_900,
    candleSet: [
      makeClosedCandle(0, 100_000, 99_800),
      makeClosedCandle(300_000, 100_000, 99_900),
      makeClosedCandle(600_000, 100_000, 100_200),
    ],
  });
  setBook('UP', {
    asks: [[0.05, 100]],
    bids: [[0.04, 100]],
  });
  setBook('DOWN', {
    asks: [[0.99, 100]],
    bids: [[0.98, 100]],
  });
  assert.equal(bot.evaluate(), false);
  assert.equal(bot.pendingEntryOrder, null);
  assert.equal(bot.snapshot().model.initialSideSelection.side, 'DOWN');
  assert.match(bot.currentSignal.reason, /DOWN was selected/);
});

test('only one taker entry is allowed in the window even if the model changes later', () => {
  const { bot, setPrice, setNow } = fixture();
  assert.equal(bot.evaluate(), true);
  const trade = bot.trades[0];
  assert.equal(trade.side, 'UP');

  setPrice(99_600);
  setNow(961_000);
  assert.equal(bot.evaluate(), false);
  assert.equal(bot.trades.length, 1);
  assert.equal(bot.trades[0], trade);
  assert.equal(bot.pendingEntryOrder, null);
  assert.equal(bot.entryTriggeredThisWindow, true);
});

test('taker entry records ask-sweep prices and modeled fees', () => {
  const { bot, market } = fixture();
  market.raw.feesEnabled = true;
  bot.books.set(market.tokens.UP, {
    asks: [
      { price: 0.6, size: 40, availableSize: 40 },
      { price: 0.61, size: 60, availableSize: 60 },
    ],
    bids: [{ price: 0.4, size: 100, availableSize: 100 }],
    updatedAt: bot.now(),
    sourceTimestamp: bot.now(),
  });
  bot.quotes.UP.bestAsk = 0.6;
  assert.equal(bot.evaluate(), true);
  const trade = bot.trades[0];
  assert.equal(trade.shares, 100);
  assert.equal(trade.grossCost, 60.6);
  assert.equal(trade.entryPrice, 0.606);
  assert.equal(trade.executionRole, 'TAKER');
  assert.ok(trade.fees > 0);
  assert.ok(trade.totalCost > trade.grossCost);
  assert.equal(trade.estimatedMakerRebate, undefined);
  assert.equal(bot.accountSnapshot().takerFees, Number(trade.fees.toFixed(2)));
  assert.equal(bot.accountSnapshot().estimatedMakerRebates, 0);
});

test('a $0.99 best bid records a $1 payout and reduces size for the next window', () => {
  const { bot, setBook, setNow } = fixture();
  bot.trades.push(
    { id: 'prior-loss-1', status: 'SETTLED', outcome: 'LOSS', sizingOutcome: 'LOSS', sizingAdjustmentApplied: true, sizingGeneration: 0, sizingAdjustedAt: 1, windowStart: 1 },
    { id: 'prior-loss-2', status: 'SETTLED', outcome: 'LOSS', sizingOutcome: 'LOSS', sizingAdjustmentApplied: true, sizingGeneration: 0, sizingAdjustedAt: 2, windowStart: 2 },
  );
  bot.recalculateNextEntryShares();
  setBook('UP', { asks: [[0.6, 140]], bids: [[0.4, 140]] });
  assert.equal(bot.evaluate(), true);
  const trade = bot.trades.at(-1);
  assert.equal(trade.shares, 140);
  setNow(961_000);
  setBook('UP', { asks: [[0.99, 100]], bids: [[0.99, 100]] });
  assert.equal(bot.evaluate(), false);
  assert.equal(trade.status, 'SETTLED');
  assert.equal(trade.outcome, 'WIN');
  assert.equal(trade.settlementSource, 'INTRAWINDOW_THRESHOLD');
  assert.equal(trade.exitReason, 'TAKE_PROFIT_BID');
  assert.equal(trade.exitPrice, 1);
  assert.equal(trade.proceeds, 140);
  assert.equal(bot.nextEntryShares, 110);
  assert.equal(bot.accountSnapshot().wins, 1);
  assert.equal(bot.snapshot().strategy.takeProfitBid, 0.99);
});

test('a $0.01 best bid records a zero payout and increases next-window size', () => {
  const { bot, setBook, setNow } = fixture();
  assert.equal(bot.evaluate(), true);
  const trade = bot.trades[0];
  setNow(961_000);
  setBook('UP', { asks: [[0.02, 100]], bids: [[0.01, 100]] });
  assert.equal(bot.evaluate(), false);
  assert.equal(trade.status, 'SETTLED');
  assert.equal(trade.outcome, 'LOSS');
  assert.equal(trade.settlementSource, 'INTRAWINDOW_THRESHOLD');
  assert.equal(trade.exitReason, 'STOP_LOSS_BID');
  assert.equal(trade.exitPrice, 0);
  assert.equal(trade.proceeds, 0);
  assert.equal(bot.nextEntryShares, 120);
  assert.equal(bot.accountSnapshot().losses, 1);
  assert.equal(bot.snapshot().strategy.stopLossBid, 0.01);
});

test('TP and SL do not book a threshold result after the market window ends', () => {
  const { bot, setBook, setNow } = fixture();
  assert.equal(bot.evaluate(), true);
  const trade = bot.trades[0];
  setBook('UP', { asks: [[0.99, 100]], bids: [[0.99, 100]] });
  setNow(bot.windowEnd);
  assert.equal(bot.evaluate(), false);
  assert.equal(trade.status, 'OPEN');
  assert.equal(bot.nextEntryShares, 100);
});

test('current next-entry size and sizing progression are retained for taker entries', () => {
  const { bot, setBook } = fixture();
  bot.nextEntryShares = 150;
  setBook('UP', {
    asks: [[0.6, 150]],
    bids: [[0.4, 150]],
  });
  assert.equal(bot.evaluate(), true);
  assert.equal(bot.trades[0].shares, 150);
  assert.equal(bot.nextEntryShares, 150);
  assert.equal(bot.snapshot().strategy.baseShares, 100);
  assert.equal(bot.snapshot().strategy.lossSizeStepShares, 20);
  assert.equal(bot.snapshot().strategy.winSizeReductionShares, 30);
});

test('insufficient ask depth or insufficient net edge does not submit a taker buy', () => {
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
  assert.equal(bot.pendingEntryOrder, null);
  assert.equal(bot.entryTriggeredThisWindow, false);

  setBook('UP', {
    asks: [[0.99, 100]],
    bids: [[0.95, 100]],
  });
  assert.equal(bot.evaluate(), false);
  assert.equal(bot.pendingEntryOrder, null);
  assert.equal(bot.trades.length, 0);
});

test('an opposite model signal does not flip or sell a taker-filled position', () => {
  const { bot, setBook, setPrice, setNow } = fixture();
  assert.equal(bot.evaluate(), true);
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
  assert.match(bot.currentSignal.reason, /flips are disabled/);
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

test('a paper history reset starts from fresh capital and base sizing exactly once', async () => {
  const previousRequestId = process.env.BTC_PAPER_MISPRICING_HISTORY_RESET_REQUEST_ID;
  process.env.BTC_PAPER_MISPRICING_HISTORY_RESET_REQUEST_ID = 'paper-history-reset-test';
  const { bot } = fixture();
  const resetCalls = [];
  let savedState = {
    schemaVersion: 2,
    startingCapital: 3_000,
    cash: 2_000,
    realizedPnl: -1_000,
    trades: [{ id: 'old-trade' }],
    events: [{ id: 'old-event' }],
    nextEntryShares: 280,
  };
  bot.stateStore = {
    async initialize() {},
    async resetHistoryOnce(requestId, initialState) {
      resetCalls.push({ requestId, initialState });
      savedState = initialState;
      return true;
    },
    async loadState() { return savedState; },
    async saveState(state) { savedState = state; },
  };
  bot.tick = async () => {};

  try {
    await bot.start();
    assert.equal(resetCalls.length, 1);
    assert.equal(resetCalls[0].requestId, 'paper-history-reset-test');
    assert.equal(resetCalls[0].initialState.schemaVersion, 1);
    assert.equal(bot.trades.length, 0);
    assert.equal(bot.events.length, 0);
    assert.equal(bot.cash, 3_000);
    assert.equal(bot.realizedPnl, 0);
    assert.equal(bot.nextEntryShares, 100);
    assert.equal(bot.sizingGeneration, 0);
  } finally {
    bot.stop();
    if (previousRequestId === undefined) {
      delete process.env.BTC_PAPER_MISPRICING_HISTORY_RESET_REQUEST_ID;
    } else {
      process.env.BTC_PAPER_MISPRICING_HISTORY_RESET_REQUEST_ID = previousRequestId;
    }
  }
});

test('restoring state preserves taker entry history and the one-entry window lock', () => {
  const { bot } = fixture();
  assert.equal(bot.evaluate(), true);
  const state = bot.persistentStateSnapshot();
  const restored = fixture().bot;
  restored.restoreState(state);
  assert.equal(restored.pendingEntryOrder, null);
  assert.equal(restored.entryTriggeredThisWindow, true);
  assert.equal(restored.trades.length, 1);
  assert.equal(restored.trades[0].executionRole, 'TAKER');
});

test('restoring an old passive order releases the entry lock for a fresh taker check', () => {
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
  assert.equal(bot.entryTriggeredThisWindow, false);
  const state = bot.snapshot();
  assert.equal(state.strategy.entryOrderType, 'MARKET BUY (TAKER)');
  assert.equal(Object.hasOwn(state, 'pendingEntryOrder'), false);
});
