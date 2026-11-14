'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  LiveBtcMispricingBot,
  isTerminalOrder,
  matchedShares,
} = require('./live-mispricing-bot.cjs');

function createBot({ tradingEnabled = true, trader = null } = {}) {
  const saves = [];
  const stateStore = {
    async saveState(state) { saves.push(structuredClone(state)); },
  };
  const bot = new LiveBtcMispricingBot({
    stateStore,
    trader,
    tradingEnabled,
    sleep: async () => {},
  });
  bot.storageHealthy = true;
  bot.liveAccount.authenticated = true;
  bot.liveAccount.accountReady = true;
  bot.liveAccount.status = 'ready';
  bot.market = {
    id: 'market-1',
    slug: 'btc-updown-5m-123',
    title: 'BTC Up or Down',
    tokens: { UP: 'up-token', DOWN: 'down-token' },
  };
  bot.windowStart = 1_000;
  bot.windowEnd = 301_000;
  bot.model = { ready: true, probabilityUp: 0.6, probabilityDown: 0.4, currentPrice: 100 };
  return { bot, saves };
}

function setFreshOrderSnapshot(bot, orders = []) {
  bot.liveAccount.status = 'READY';
  bot.liveAccount.orders = orders;
  bot.liveAccount.orderSnapshotStatus = 'READY';
  bot.liveAccount.ordersSnapshotAt = new Date(bot.now()).toISOString();
}

test('entry evaluates both outcomes and selects the stronger qualifying fair-value edge', async () => {
  let placed;
  const evaluated = [];
  const trader = {
    async placeTakerOrder(tokenId, action, price, size) {
      placed = { tokenId, action, price, size };
      return { id: 'source-entry', status: 'MATCHED' };
    },
    async fetchOrder() {
      return { id: 'source-entry', status: 'MATCHED', sizeMatched: '7.5' };
    },
  };
  const { bot } = createBot({ trader });
  const now = bot.now();
  bot.windowStart = Math.floor(now / bot.config.WINDOW_MS) * bot.config.WINDOW_MS;
  bot.windowEnd = bot.windowStart + bot.config.WINDOW_MS;
  bot.processStartedAt = bot.windowStart;
  bot.currentOpenTrade = () => null;
  bot.modelSnapshot = () => ({
    ready: true,
    probabilityUp: 0.7,
    probabilityDown: 0.3,
    currentPrice: 100,
  });
  bot.sideQuoteIsFresh = () => true;
  bot.buyPreviewForStake = (side, stakeUsd) => {
    evaluated.push(side);
    const shares = side === 'UP' ? 7.5 : 15;
    const price = side === 'UP' ? 0.4 : 0.2;
    return {
      complete: true,
      shares,
      gross: stakeUsd,
      totalCost: side === 'UP' ? 3.2 : 3.1,
      averagePrice: price,
      fills: [{ price, shares }],
    };
  };

  const entered = await bot.evaluateLive(now);

  assert.equal(entered, true);
  assert.deepEqual(evaluated, ['UP', 'DOWN']);
  assert.equal(placed.tokenId, 'up-token');
  assert.equal(placed.action, 'BUY');
  assert.equal(placed.size, 3);
  assert.equal(bot.trades[0].side, 'UP');
  assert.equal(bot.trades[0].shares, 7.5);
  assert.match(bot.currentSignal.reason, /strongest qualifying net edge/);
});

test('missing or doji candles do not gate fair-value entries', async () => {
  const trader = {
    async placeTakerOrder() { throw new Error('read-only test must not submit'); },
  };
  const { bot } = createBot({ trader, tradingEnabled: false });
  const now = bot.now();
  bot.windowStart = Math.floor(now / bot.config.WINDOW_MS) * bot.config.WINDOW_MS;
  bot.windowEnd = bot.windowStart + bot.config.WINDOW_MS;
  bot.processStartedAt = bot.windowStart;
  bot.currentOpenTrade = () => null;
  bot.modelSnapshot = () => ({
    ready: true,
    probabilityUp: 0.8,
    probabilityDown: 0.2,
    currentPrice: 100,
  });
  bot.priceFeed.snapshot = () => ({ candles: [] });
  bot.buyPreviewForStake = side => {
    if (side !== 'UP') return null;
    return {
      complete: true,
      shares: 7.5,
      gross: 3,
      totalCost: 3.1,
      averagePrice: 0.4,
      fills: [{ price: 0.4, shares: 7.5 }],
    };
  };

  assert.equal(await bot.evaluateLive(now), false);
  assert.equal(bot.currentSignal.side, 'UP');
  assert.equal(bot.trades.length, 0);
  assert.equal(bot.liveHalted, false);
});

test('live stake progression starts at $3 and adjusts by +$1/−$1.50 with a $3 floor', () => {
  const { bot } = createBot();
  assert.equal(bot.config.BASE_STAKE_USD, 3);
  assert.equal(bot.nextEntryStakeUsd, 3);
  assert.equal(bot.sizeAfterOutcome(3, 'LOSS'), 4);
  assert.equal(bot.sizeAfterOutcome(4, 'LOSS'), 5);
  assert.equal(bot.sizeAfterOutcome(6.5, 'WIN'), 5);
  assert.equal(bot.sizeAfterOutcome(4, 'WIN'), 3);
  assert.equal(bot.sizeAfterOutcome(3, 'WIN'), 3);
});

test('legacy share-sized history is kept while new USD sizing starts at its floor', () => {
  const { bot } = createBot();
  const oldTrade = {
    id: 'old-share-trade',
    outcome: 'LOSS',
    sizingAdjustmentApplied: true,
    sizingGeneration: 0,
  };
  bot.restoreState({
    trades: [oldTrade],
    nextEntryShares: 18,
    sizingGeneration: 0,
    liveOrders: [],
    liveHalted: false,
  });

  const saved = bot.persistentStateSnapshot();
  assert.equal(bot.trades.length, 1);
  assert.equal(bot.trades[0].id, 'old-share-trade');
  assert.equal(bot.sizingGeneration, 1);
  assert.equal(bot.nextEntryStakeUsd, 3);
  assert.equal(saved.stakeSizingVersion, 1);
  assert.equal(saved.nextEntryStakeUsd, 3);
});

test('live history reset request runs once through the durable state store', async () => {
  const previousRequestId = process.env.BTC_LIVE_MISPRICING_HISTORY_RESET_REQUEST_ID;
  process.env.BTC_LIVE_MISPRICING_HISTORY_RESET_REQUEST_ID = 'live-history-reset-test';
  try {
    const { bot } = createBot();
    const resetIds = [];
    bot.stateStore.resetHistoryOnce = async requestId => {
      resetIds.push(requestId);
      return true;
    };

    assert.equal(await bot.applyHistoryResetRequest(), true);
    assert.deepEqual(resetIds, ['live-history-reset-test']);
    assert.equal(bot.persistentStateSnapshot().historyResetRequestId, 'live-history-reset-test');
  } finally {
    if (previousRequestId === undefined) {
      delete process.env.BTC_LIVE_MISPRICING_HISTORY_RESET_REQUEST_ID;
    } else {
      process.env.BTC_LIVE_MISPRICING_HISTORY_RESET_REQUEST_ID = previousRequestId;
    }
  }
});

test('live entry records only the amount confirmed by the exchange', async () => {
  const trader = {
    async placeTakerOrder() { return { id: 'exchange-1', status: 'MATCHED' }; },
    async fetchOrder() {
      return { id: 'exchange-1', status: 'MATCHED', sizeMatched: '10' };
    },
  };
  const { bot, saves } = createBot({ trader });
  const order = await bot.submitSweepOrder({
    action: 'BUY_ENTRY',
    side: 'UP',
    shares: 10,
    preview: { fills: [{ price: 0.42 }] },
    model: bot.model,
    edgePerShare: 0.12,
    entryReason: 'MODEL_EDGE',
    windowStart: bot.windowStart,
    windowEnd: bot.windowEnd,
  });

  assert.equal(order.matchedShares, 10);
  assert.equal(order.processed, true);
  assert.equal(bot.trades.length, 1);
  assert.equal(bot.trades[0].shares, 10);
  assert.equal(bot.trades[0].orderId, 'exchange-1');
  assert.equal(bot.trades[0].status, 'OPEN');
  assert.equal(order.orderType, 'FAK');
  assert.equal(order.limitPrice, 0.99);
  assert.equal(order.priceLimitType, 'MAXIMUM');
  assert.equal(bot.liveHalted, false);
  assert.ok(saves.length >= 2);
});

test('normal live entry submits the $3 USD stake and records confirmed shares', async () => {
  let placed;
  const trader = {
    async placeTakerOrder(tokenId, action, price, size) {
      placed = { tokenId, action, price, size };
      return { id: 'usd-entry', status: 'MATCHED' };
    },
    async fetchOrder() {
      return { id: 'usd-entry', status: 'MATCHED', sizeMatched: '7.5' };
    },
  };
  const { bot } = createBot({ trader });
  const now = bot.now();
  bot.windowStart = Math.floor(now / bot.config.WINDOW_MS) * bot.config.WINDOW_MS;
  bot.windowEnd = bot.windowStart + bot.config.WINDOW_MS;
  bot.processStartedAt = bot.windowStart;
  bot.currentOpenTrade = () => null;
  bot.modelSnapshot = () => ({
    ready: true,
    probabilityUp: 0.9,
    probabilityDown: 0.1,
    currentPrice: 100,
  });
  bot.sideQuoteIsFresh = () => true;
  bot.buyPreviewForStake = (side, stakeUsd) => side === 'UP'
    ? {
      complete: true,
      shares: stakeUsd / 0.4,
      gross: stakeUsd,
      totalCost: stakeUsd + 0.08,
      averagePrice: 0.4,
      fills: [{ price: 0.4, shares: stakeUsd / 0.4 }],
    }
    : null;

  const entered = await bot.evaluateLive(now);

  assert.equal(entered, true);
  assert.deepEqual(placed, {
    tokenId: 'up-token',
    action: 'BUY',
    price: 0.99,
    size: 3,
  });
  assert.equal(bot.trades[0].shares, 7.5);
  assert.equal(bot.trades[0].side, 'UP');
  assert.equal(bot.liveOrders[0].amountUsd, 3);
});

test('a qualified profitable flip submits the share sell and USD buy independently', async () => {
  const submissions = [];
  const trader = {
    placeTakerOrder(tokenId, action, price, size) {
      submissions.push({ tokenId, action, price, size });
      return Promise.resolve({
        id: action === 'SELL' ? 'exchange-sell' : 'exchange-buy',
        status: 'MATCHED',
      });
    },
    async fetchOrder(id) {
      return id === 'exchange-sell'
        ? { id, status: 'MATCHED', sizeMatched: '7' }
        : { id, status: 'MATCHED', sizeMatched: '6' };
    },
  };
  const { bot } = createBot({ trader });
  const trade = {
    id: 'flip-trade',
    status: 'OPEN',
    side: 'UP',
    tokenId: 'up-token',
    shares: 7,
    totalCost: 3,
    windowStart: bot.windowStart,
    windowEnd: bot.windowEnd,
    marketId: String(bot.market.id),
  };
  bot.trades = [trade];
  bot.processStartedAt = bot.windowStart;
  bot.liveOrders = [
    {
      id: 'up-buy',
      action: 'BUY_ENTRY',
      side: 'UP',
      tokenId: 'up-token',
      marketId: 'market-1',
      windowStart: bot.windowStart,
      shares: 100,
      matchedShares: 7,
    },
    {
      id: 'down-buy-other-token',
      action: 'BUY_ENTRY',
      side: 'DOWN',
      tokenId: 'down-token',
      marketId: 'market-1',
      windowStart: bot.windowStart,
      shares: 100,
      matchedShares: 99,
    },
  ];
  bot.sideQuoteIsFresh = () => true;
  bot.sweep = (side, bookSide, shares) => bookSide === 'bids'
    ? {
      complete: true,
      shares,
      gross: shares * 0.6,
      netProceeds: shares * 0.6,
      averagePrice: 0.6,
      fills: [{ price: 0.6, shares }],
    }
    : null;
  bot.buyPreviewForStake = (side, stakeUsd) => side === 'DOWN'
    ? {
      complete: true,
      shares: 6,
      gross: stakeUsd,
      totalCost: stakeUsd + 0.08,
      averagePrice: 0.5,
      fills: [{ price: 0.5, shares: 6 }],
    }
    : null;
  bot.recordFlipConfirmation = () => ({ confirmed: true, count: 2 });
  bot.persist = async () => true;
  bot.currentOpenTrade = () => trade;
  bot.modelSnapshot = () => ({
    ready: true,
    probabilityUp: 0.2,
    probabilityDown: 0.8,
    currentPrice: 100,
  });
  const flipped = await bot.evaluateLive(bot.windowStart + 10_000);

  assert.equal(flipped, true);
  assert.equal(submissions.length, 2);
  assert.deepEqual(submissions.map(order => [order.tokenId, order.action, order.size]), [
    ['up-token', 'SELL', 7],
    ['down-token', 'BUY', 3],
  ]);
  assert.equal(trade.status, 'CLOSED');
  assert.equal(bot.trades.some(item => item.side === 'DOWN' && item.shares === 6), true);
});

test('an uncertain no-ID flip sell does not block the independent opposite buy', async () => {
  const submissions = [];
  const trader = {
    async placeTakerOrder(tokenId, action, price, size) {
      submissions.push({ tokenId, action, price, size });
      if (action === 'SELL') {
        const error = new Error('sell response timed out');
        error.submissionUncertain = true;
        throw error;
      }
      return { id: 'exchange-buy', status: 'MATCHED' };
    },
    async fetchOrder(id) {
      return { id, status: 'MATCHED', sizeMatched: '6' };
    },
  };
  const { bot } = createBot({ trader });
  const trade = {
    id: 'uncertain-flip-trade',
    status: 'OPEN',
    side: 'UP',
    tokenId: 'up-token',
    shares: 7,
    totalCost: 3,
    windowStart: bot.windowStart,
    windowEnd: bot.windowEnd,
    marketId: String(bot.market.id),
  };
  bot.trades = [trade];
  bot.liveOrders = [{
    id: 'up-entry',
    action: 'BUY_ENTRY',
    side: 'UP',
    tokenId: 'up-token',
    marketId: String(bot.market.id),
    windowStart: bot.windowStart,
    shares: 7,
    matchedShares: 7,
  }];
  bot.sideQuoteIsFresh = () => true;
  bot.sweep = (_side, bookSide, shares) => bookSide === 'bids'
    ? {
      complete: true,
      shares,
      gross: shares * 0.6,
      netProceeds: shares * 0.6,
      averagePrice: 0.6,
      fills: [{ price: 0.6, shares }],
    }
    : null;
  bot.buyPreviewForStake = (_side, stakeUsd) => ({
    complete: true,
    shares: 6,
    gross: stakeUsd,
    totalCost: stakeUsd + 0.08,
    averagePrice: 0.5,
    fills: [{ price: 0.5, shares: 6 }],
  });
  bot.recordFlipConfirmation = () => ({ confirmed: true, count: 2 });
  bot.persist = async () => true;
  bot.processStartedAt = bot.windowStart;

  const flipped = await bot.evaluateLiveFlip(trade, {
    ready: true,
    probabilityUp: 0.2,
    probabilityDown: 0.8,
    currentPrice: 100,
  }, bot.windowStart + 10_000);

  assert.equal(flipped, true);
  assert.deepEqual(submissions.map(order => order.action), ['SELL', 'BUY']);
  assert.equal(bot.liveOrders.find(order => order.action === 'SELL_FLIP').assumedFailedByPolicy, true);
  assert.equal(bot.liveHalted, false);
  assert.equal(bot.liveOrders.find(order => order.action === 'BUY_FLIP').matchedShares, 6);
});

test('live submitter accepts source-qualified flip order actions', async () => {
  let placed;
  const trader = {
    async placeTakerOrder(tokenId, side, price, size) {
      placed = { tokenId, side, price, size };
      return { id: 'sell-fak-1', status: 'MATCHED' };
    },
    async fetchOrder() {
      return { id: 'sell-fak-1', status: 'MATCHED', sizeMatched: '5' };
    },
  };
  const { bot } = createBot({ trader });
  const trade = {
    id: 'sell-trade',
    status: 'OPEN',
    side: 'UP',
    tokenId: 'up-token',
    shares: 10,
    totalCost: 3,
    grossCost: 3,
    fees: 0,
    windowStart: bot.windowStart,
    windowEnd: bot.windowEnd,
    marketId: String(bot.market.id),
  };
  bot.trades = [trade];

  const order = await bot.submitSweepOrder({
    action: 'SELL_FLIP',
    side: 'UP',
    shares: 5,
    preview: { fills: [{ price: 0.62, shares: 5 }] },
    model: bot.model,
    edgePerShare: 0.12,
    tradeId: trade.id,
    windowStart: bot.windowStart,
    windowEnd: bot.windowEnd,
  });
  const oppositeBuy = await bot.submitSweepOrder({
    action: 'BUY_FLIP',
    side: 'DOWN',
    shares: 5,
    preview: { fills: [{ price: 0.38, shares: 5 }] },
    model: bot.model,
    edgePerShare: 0.12,
    windowStart: bot.windowStart,
    windowEnd: bot.windowEnd,
  });

  assert.equal(order.status, 'MATCHED');
  assert.equal(oppositeBuy.status, 'MATCHED');
  assert.deepEqual(placed, {
    tokenId: 'down-token',
    side: 'BUY',
    price: 0.99,
    size: 3,
  });
});

test('a partial exchange fill cancels the remainder and records only filled shares', async () => {
  let canceled = 0;
  let fetches = 0;
  const trader = {
    async placeTakerOrder() { return { id: 'exchange-partial', status: 'LIVE' }; },
    async fetchOrder() {
      fetches += 1;
      return {
        id: 'exchange-partial',
        status: fetches === 1 ? 'LIVE' : 'CANCELED',
        sizeMatched: '4',
      };
    },
    async cancelOrder() { canceled += 1; },
  };
  const { bot } = createBot({ trader });
  const order = await bot.submitSweepOrder({
    action: 'BUY_ENTRY',
    side: 'UP',
    shares: 10,
    preview: { fills: [{ price: 0.42 }] },
    model: bot.model,
    edgePerShare: 0.12,
    entryReason: 'MODEL_EDGE',
    windowStart: bot.windowStart,
    windowEnd: bot.windowEnd,
  });
  assert.equal(canceled, 1);
  assert.equal(order.matchedShares, 4);
  assert.equal(bot.trades[0].shares, 4);
});

test('read-only mode never submits an order', async () => {
  let submissions = 0;
  const trader = {
    async placeTakerOrder() { submissions += 1; return { id: 'never' }; },
  };
  const { bot } = createBot({ trader, tradingEnabled: false });
  const order = await bot.submitSweepOrder({
    action: 'BUY_ENTRY',
    side: 'UP',
    shares: 10,
    preview: { fills: [{ price: 0.42 }] },
    model: bot.model,
    edgePerShare: 0.12,
    windowStart: bot.windowStart,
    windowEnd: bot.windowEnd,
  });
  assert.equal(order, null);
  assert.equal(submissions, 0);
});

test('uncertain submission halts future orders and is never retried', async () => {
  let submissions = 0;
  const trader = {
    async placeTakerOrder() {
      submissions += 1;
      const error = new Error('network timeout after submit');
      error.submissionUncertain = true;
      throw error;
    },
  };
  const { bot } = createBot({ trader });
  const first = await bot.submitSweepOrder({
    action: 'BUY_ENTRY',
    side: 'UP',
    shares: 10,
    preview: { fills: [{ price: 0.42 }] },
    model: bot.model,
    edgePerShare: 0.12,
    windowStart: bot.windowStart,
    windowEnd: bot.windowEnd,
  });
  const second = await bot.submitSweepOrder({
    action: 'BUY_ENTRY',
    side: 'UP',
    shares: 10,
    preview: { fills: [{ price: 0.42 }] },
    model: bot.model,
    edgePerShare: 0.12,
    windowStart: bot.windowStart,
    windowEnd: bot.windowEnd,
  });
  assert.equal(first.status, 'SUBMISSION_UNCERTAIN');
  assert.equal(second, null);
  assert.equal(submissions, 1);
  assert.equal(bot.liveHalted, true);
});

test('an uncertain standalone flip sell is assumed failed without halting', async () => {
  let submissions = 0;
  const trader = {
    async placeTakerOrder() {
      submissions += 1;
      const error = new Error('network timeout after sell submit');
      error.submissionUncertain = true;
      throw error;
    },
  };
  const { bot } = createBot({ trader });
  const trade = {
    id: 'sell-trade-1',
    status: 'OPEN',
    side: 'UP',
    shares: 10,
    totalCost: 4,
    windowStart: bot.windowStart,
    windowEnd: bot.windowEnd,
    marketId: String(bot.market.id),
  };
  bot.trades = [trade];
  const order = await bot.submitSweepOrder({
    action: 'SELL_FLIP',
    side: 'UP',
    shares: 10,
    preview: { fills: [{ price: 0.62 }] },
    model: bot.model,
    edgePerShare: 0.12,
    tradeId: trade.id,
    windowStart: bot.windowStart,
    windowEnd: bot.windowEnd,
  });

  assert.equal(order.status, 'SUBMISSION_UNCERTAIN');
  assert.equal(order.assumedFailedByPolicy, true);
  assert.equal(submissions, 1);
  assert.equal(bot.liveHalted, false);
});

test('restores a sell-only uncertain halt as assumed no-fill but preserves buy halts', () => {
  const { bot } = createBot();
  bot.restoreState({
    trades: [],
    liveOrders: [{
      localId: 'old-sell',
      id: null,
      action: 'SELL_FLIP',
      tradeId: 'old-trade',
      status: 'SUBMISSION_UNCERTAIN',
      processed: false,
      shares: 10,
      matchedShares: 0,
      windowStart: bot.windowStart,
    }],
    pendingFlip: {
      phase: 'SELL',
      tradeId: 'old-trade',
      windowStart: bot.windowStart,
    },
    liveHalted: true,
    liveHaltReason: 'Order submission outcome is uncertain; automatic retries are blocked.',
  });

  assert.equal(bot.liveOrders[0].assumedFailedByPolicy, true);
  assert.equal(bot.pendingFlip, null);
  assert.equal(bot.liveHalted, false);

  const { bot: buyBot } = createBot();
  buyBot.restoreState({
    trades: [],
    liveOrders: [{
      localId: 'old-buy',
      id: null,
      action: 'BUY_ENTRY',
      status: 'SUBMISSION_UNCERTAIN',
      processed: false,
      shares: 10,
      matchedShares: 0,
    }],
    liveHalted: true,
    liveHaltReason: 'Order submission outcome is uncertain; automatic retries are blocked.',
  });
  assert.equal(buyBot.liveHalted, true);
});

test('prepared flip sell orders can reach the exchange', async () => {
  let submissions = 0;
  const trader = {
    async placeTakerOrder() {
      submissions += 1;
      return { id: 'prepared-sell', status: 'UNFILLED' };
    },
    async fetchOrder(id) { return { id, status: 'UNFILLED', sizeMatched: '0' }; },
  };
  const { bot } = createBot({ trader });
  const order = await bot.submitPreparedSweepOrder({
    localId: 'prepared-sell-local',
    id: null,
    action: 'SELL_FLIP',
    side: 'UP',
    tokenId: 'up-token',
    limitPrice: 0.01,
    shares: 5,
    amountUsd: null,
    matchedShares: 0,
    status: 'SUBMITTING',
    processed: false,
    windowStart: bot.windowStart,
    windowEnd: bot.windowEnd,
  }, bot.model);
  assert.equal(order.status, 'UNFILLED');
  assert.equal(submissions, 1);
  assert.equal(bot.liveHalted, false);
});

test('order matching reads CLOB response aliases and terminal states', () => {
  assert.equal(matchedShares({ size_matched: '4.5' }), 4.5);
  assert.equal(isTerminalOrder({ status: 'CANCELED', shares: 10, matchedShares: 0 }), true);
  assert.equal(isTerminalOrder({ status: 'LIVE', shares: 10, matchedShares: 10 }), true);
  assert.equal(isTerminalOrder({ status: 'LIVE', shares: 10, matchedShares: 3 }), false);
  assert.equal(isTerminalOrder({ status: 'UNFILLED', shares: 10, matchedShares: 0 }), true);
  assert.equal(isTerminalOrder({ status: 'UNMATCHED', shares: 10, matchedShares: 0 }), true);
});

test('USD market-buy accounting scales gross spend to the confirmed fill fraction', () => {
  const { bot } = createBot();
  const execution = bot.executionFromOrder({
    action: 'BUY_ENTRY',
    amountUsd: 3,
    shares: 6,
    accountingPriceEstimate: 0.5,
    limitPrice: 0.99,
  }, 4);

  assert.equal(execution.gross, 2);
  assert.equal(execution.averagePrice, 0.5);
  assert.equal(execution.shares, 4);
});

test('profitable live closes reduce the next USD stake but respect the $3 floor', () => {
  const { bot } = createBot();
  bot.nextEntryStakeUsd = 4;
  const trade = {
    id: 'trade-1',
    status: 'OPEN',
    shares: 10,
    totalCost: 4,
    fees: 0,
    grossCost: 4,
    side: 'UP',
    windowStart: bot.windowStart,
  };
  bot.trades.push(trade);
  bot.closeLivePosition(trade, {
    shares: 10,
    gross: 6,
    fees: 0,
    netProceeds: 6,
    averagePrice: 0.6,
    fills: [],
  }, 10_000, 'PROFITABLE_MODEL_FLIP', 'DOWN');
  assert.equal(trade.realizedPnl, 2);
  assert.equal(bot.nextEntryStakeUsd, 3);
  assert.equal(trade.sizingOutcome, 'WIN');
});

test('successful account recovery clears only a resolved authentication halt', async () => {
  const { bot, saves } = createBot({ tradingEnabled: false });
  bot.liveHalted = true;
  bot.liveHaltReason = 'Polymarket authentication failed; live orders are disabled.';
  bot.liveAccount.accountReady = false;

  assert.equal(await bot.clearResolvedAuthHalt(), false);
  assert.equal(bot.liveHalted, true);

  bot.liveAccount.accountReady = true;
  assert.equal(await bot.clearResolvedAuthHalt(), true);
  assert.equal(bot.liveHalted, false);
  assert.equal(bot.liveHaltReason, null);
  assert.equal(bot.snapshot().status, 'READ_ONLY');
  assert.ok(saves.length > 0);
});

test('account recovery does not clear unrelated order safety halts', async () => {
  const { bot } = createBot({ tradingEnabled: false });
  bot.liveHalted = true;
  bot.liveHaltReason = 'An existing order could not be reconciled; new orders are blocked.';
  bot.liveAccount.accountReady = true;

  assert.equal(await bot.clearResolvedAuthHalt(), false);
  assert.equal(bot.liveHalted, true);
  assert.equal(bot.snapshot().status, 'HALTED');
});

test('submission halt clears only after every order is resolved and the exchange has no open orders', async () => {
  const { bot, saves } = createBot({ tradingEnabled: false });
  bot.liveHalted = true;
  bot.liveHaltReason = 'Order submission outcome is uncertain; automatic retries are blocked.';
  setFreshOrderSnapshot(bot);
  bot.liveOrders = [{
    id: 'exchange-confirmed',
    status: 'MATCHED',
    processed: true,
    shares: 10,
    matchedShares: 10,
  }];

  assert.equal(await bot.clearResolvedSubmissionHalt(), true);
  assert.equal(bot.liveHalted, false);
  assert.equal(bot.liveHaltReason, null);
  assert.ok(saves.length > 0);
});

test('reconciliation halt clears only after all orders are terminal and the exchange list is fresh and empty', async () => {
  const { bot, saves } = createBot({ tradingEnabled: false });
  bot.liveHalted = true;
  bot.liveHaltReason = 'An existing order could not be reconciled; new orders are blocked.';
  setFreshOrderSnapshot(bot);
  bot.liveOrders = [{
    id: 'exchange-confirmed',
    status: 'MATCHED',
    processed: true,
    shares: 10,
    matchedShares: 10,
  }, {
    id: 'exchange-canceled',
    status: 'UNFILLED',
    processed: true,
    shares: 10,
    matchedShares: 0,
  }];

  assert.equal(await bot.clearResolvedSubmissionHalt(), true);
  assert.equal(bot.liveHalted, false);
  assert.equal(bot.liveHaltReason, null);
  assert.ok(saves.length > 0);
});

test('missing-order-ID halt clears only after later exchange confirmation and stays blocked if an order is unresolved', async () => {
  const { bot } = createBot({ tradingEnabled: false });
  bot.liveHalted = true;
  bot.liveHaltReason = 'A saved submission has no exchange order ID; it must be reconciled manually.';
  setFreshOrderSnapshot(bot);
  bot.liveOrders = [{
    id: 'exchange-confirmed',
    status: 'MATCHED',
    processed: true,
    shares: 10,
    matchedShares: 10,
  }];

  assert.equal(await bot.clearResolvedSubmissionHalt(), true);
  assert.equal(bot.liveHalted, false);

  bot.liveHalted = true;
  bot.liveHaltReason = 'A saved submission has no exchange order ID; it must be reconciled manually.';
  bot.liveOrders = [{
    id: null,
    status: 'SUBMISSION_UNCERTAIN',
    processed: false,
    shares: 10,
    matchedShares: 0,
  }];
  assert.equal(await bot.clearResolvedSubmissionHalt(), false);
  assert.equal(bot.liveHalted, true);
  const diagnostics = bot.submissionHaltRecoveryDiagnostics();
  assert.ok(diagnostics.blockers.includes('LOCAL_ORDERS_UNRESOLVED'));
  assert.ok(diagnostics.blockers.includes('LOCAL_ORDER_ID_MISSING'));
  assert.equal(diagnostics.unresolvedOrderCount, 1);
  assert.equal(diagnostics.missingOrderIdCount, 1);
});

test('reconciles a processed LIVE record and clears halt after confirmed cancel despite stale fetch status', async () => {
  const { bot } = createBot({ tradingEnabled: false });
  bot.liveHalted = true;
  bot.liveHaltReason = 'A saved submission has no exchange order ID; it must be reconciled manually.';
  bot.liveAccount.authenticated = true;
  setFreshOrderSnapshot(bot, [{ id: 'stale-live-order' }]);
  const order = {
    id: 'stale-live-order',
    status: 'LIVE',
    processed: true,
    processedMatchedShares: 0,
    shares: 10,
    matchedShares: 0,
    windowStart: 1_000,
  };
  bot.liveOrders = [order];
  let cancelCalls = 0;
  bot.trader = {
    async fetchOrder() {
      return { id: 'stale-live-order', status: 'LIVE', sizeMatched: '0' };
    },
    async cancelOrder() {
      cancelCalls += 1;
      return { canceled: ['stale-live-order'] };
    },
  };

  await bot.reconcileLiveOrders();

  assert.equal(cancelCalls, 1);
  assert.equal(order.status, 'CANCELLED');
  assert.equal(order.exchangeStatus, 'LIVE');
  assert.ok(order.cancelConfirmedAt);
  setFreshOrderSnapshot(bot);
  assert.equal(await bot.clearResolvedSubmissionHalt(), true);
  assert.equal(bot.liveHalted, false);
});

test('books partial fills and clears the halt when a fresh authenticated order list confirms the FAK is closed', async () => {
  const { bot } = createBot({ tradingEnabled: false });
  bot.liveHalted = true;
  bot.liveHaltReason = 'An existing order could not be reconciled; new orders are blocked.';
  bot.liveAccount.authenticated = true;
  bot.liveAccount.accountReady = true;
  bot.liveAccount.status = 'READY';
  setFreshOrderSnapshot(bot);
  const order = {
    id: 'partial-fak-order',
    localId: 'local-partial-fak-order',
    action: 'BUY_ENTRY',
    side: 'UP',
    status: 'RECONCILIATION_REQUIRED',
    processed: false,
    shares: 23,
    matchedShares: 0,
    limitPrice: 0.61,
    accountingPriceEstimate: 0.61,
    submittedAt: new Date(bot.now() - 1_000).toISOString(),
    windowStart: bot.windowStart,
  };
  bot.liveOrders = [order];
  bot.trader = {
    async fetchOrder() {
      return { id: 'partial-fak-order', status: 'LIVE', sizeMatched: '3.64' };
    },
    async cancelOrder() {
      assert.fail('A fresh empty open-order snapshot should avoid a redundant cancel.');
    },
  };

  await bot.reconcileLiveOrders();

  assert.equal(order.status, 'CANCELLED');
  assert.equal(order.processed, true);
  assert.equal(order.processedMatchedShares, 3.64);
  assert.equal(bot.trades.length, 1);
  assert.equal(bot.trades[0].shares, 3.64);
  assert.equal(await bot.clearResolvedSubmissionHalt(), true);
  assert.equal(bot.liveHalted, false);
});

test('restores a legacy processed quantity only when the linked trade ledger proves the exact fill', async () => {
  const { bot } = createBot({ tradingEnabled: false });
  bot.liveHalted = true;
  bot.liveHaltReason = 'An existing order could not be reconciled; new orders are blocked.';
  setFreshOrderSnapshot(bot);
  const order = {
    id: 'legacy-partial-order',
    localId: 'local-legacy-partial-order',
    tradeId: 'legacy-trade',
    action: 'BUY_ENTRY',
    side: 'UP',
    status: 'RECONCILIATION_REQUIRED',
    processed: true,
    shares: 23,
    matchedShares: 3.64,
    limitPrice: 0.61,
    accountingPriceEstimate: 0.61,
    submittedAt: new Date(bot.now() - 1_000).toISOString(),
    windowStart: bot.windowStart,
  };
  bot.liveOrders = [order];
  bot.trades = [{
    id: 'legacy-trade',
    orderId: order.id,
    side: 'UP',
    shares: 3.64,
    fills: [{ price: 0.61, shares: 3.64 }],
    status: 'OPEN',
  }];
  bot.trader = {
    async fetchOrder() {
      assert.fail('Exact processed-fill ledger evidence and a fresh empty snapshot should be sufficient.');
    },
    async cancelOrder() {
      assert.fail('A fresh empty snapshot should avoid canceling an already-absent order.');
    },
  };

  await bot.reconcileLiveOrders();

  assert.equal(order.status, 'CANCELLED');
  assert.equal(order.processedMatchedShares, 3.64);
  assert.equal(bot.trades.length, 1);
  assert.equal(bot.trades[0].shares, 3.64);
  assert.equal(await bot.clearResolvedSubmissionHalt(), true);
  assert.equal(bot.liveHalted, false);
});

test('keeps processed legacy orders halted when the trade ledger does not match exchange fills', async () => {
  const { bot } = createBot({ tradingEnabled: false });
  bot.liveHalted = true;
  bot.liveHaltReason = 'An existing order could not be reconciled; new orders are blocked.';
  setFreshOrderSnapshot(bot);
  const order = {
    id: 'mismatched-legacy-order',
    tradeId: 'mismatched-trade',
    action: 'BUY_ENTRY',
    status: 'RECONCILIATION_REQUIRED',
    processed: true,
    shares: 23,
    matchedShares: 4.8,
    submittedAt: new Date(bot.now() - 1_000).toISOString(),
  };
  bot.liveOrders = [order];
  bot.trades = [{
    id: 'mismatched-trade',
    orderId: order.id,
    fills: [{ price: 0.56, shares: 3.64 }],
  }];

  assert.equal(await bot.clearResolvedSubmissionHalt(), false);
  assert.equal(bot.liveHalted, true);
  assert.equal(bot.submissionHaltRecoveryDiagnostics()
    .orderClosureStatusCounts.PROCESSED_FILL_MISMATCH, 1);
});

test('reconciliation halt stays active if the account snapshot is stale or any order is unresolved', async () => {
  const { bot } = createBot({ tradingEnabled: false });
  bot.liveHalted = true;
  bot.liveHaltReason = 'An existing order could not be reconciled; new orders are blocked.';
  setFreshOrderSnapshot(bot);
  bot.liveOrders = [{
    id: 'exchange-uncertain',
    status: 'RECONCILIATION_REQUIRED',
    processed: false,
    shares: 10,
    matchedShares: 0,
  }];

  bot.liveAccount.status = 'STALE';
  assert.equal(await bot.clearResolvedSubmissionHalt(), false);
  assert.equal(bot.liveHalted, true);

  bot.liveAccount.status = 'ready';
  assert.equal(await bot.clearResolvedSubmissionHalt(), false);
  assert.equal(bot.liveHalted, true);
});

test('submission halt stays active while any order state remains uncertain', async () => {
  const { bot } = createBot({ tradingEnabled: false });
  bot.liveHalted = true;
  bot.liveHaltReason = 'Order submission outcome is uncertain; automatic retries are blocked.';
  setFreshOrderSnapshot(bot);
  bot.liveOrders = [{
    id: null,
    status: 'SUBMISSION_UNCERTAIN',
    processed: false,
    shares: 10,
    matchedShares: 0,
  }];

  assert.equal(await bot.clearResolvedSubmissionHalt(), false);
  assert.equal(bot.liveHalted, true);

  bot.liveOrders = [];
  setFreshOrderSnapshot(bot, [{ id: 'open-exchange-order' }]);
  assert.equal(await bot.clearResolvedSubmissionHalt(), false);
  assert.equal(bot.liveHalted, true);
});

test('positions API failure does not gate live readiness or safe order-halt recovery', async () => {
  const trader = {
    async getTradingSnapshot() {
      return {
        status: 'READY',
        accountReady: true,
        collateral: 123.45,
        balanceStatus: 'READY',
        orders: [],
        orderSnapshotStatus: 'READY',
        ordersSnapshotAt: new Date().toISOString(),
      };
    },
    async refreshDisplaySnapshot() {
      return {
        positions: [],
        positionValue: 0,
        positionCount: 0,
        positionsStatus: 'RATE_LIMITED',
        positionsHttpStatus: 429,
        positionsRetryAfterMs: 30_000,
        transactions: [],
        activityStatus: 'READY',
      };
    },
  };
  const { bot } = createBot({ trader });
  bot.liveAccount.authenticated = true;
  bot.liveAccount.accountReady = false;
  bot.liveHalted = true;
  bot.liveHaltReason = 'A saved order has no exchange order ID; automatic resubmission is blocked.';
  bot.liveOrders = [{
    id: 'resolved-order',
    status: 'MATCHED',
    processed: true,
    shares: 10,
    matchedShares: 10,
  }];

  assert.equal(await bot.refreshAccountSnapshot(), true);
  await Promise.resolve();
  assert.equal(bot.liveAccount.accountReady, true);
  assert.equal(bot.liveAccount.status, 'READY');
  assert.equal(bot.liveAccount.positionsStatus, 'RATE_LIMITED');
  assert.equal(bot.liveAccount.orders.length, 0);
  assert.equal(await bot.clearResolvedSubmissionHalt(), true);
  assert.equal(bot.liveHalted, false);
});
