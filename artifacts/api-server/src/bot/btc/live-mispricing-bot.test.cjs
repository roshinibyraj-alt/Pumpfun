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

test('live copy starts at 10 and sizes outcomes by +2/−3 with a 10 floor', () => {
  const { bot } = createBot();
  assert.equal(bot.config.BASE_SHARES, 10);
  assert.equal(bot.config.LOSS_SIZE_STEP_SHARES, 2);
  assert.equal(bot.config.WIN_SIZE_REDUCTION_SHARES, 3);
  assert.equal(bot.sizeAfterOutcome(10, 'LOSS'), 12);
  assert.equal(bot.sizeAfterOutcome(16, 'WIN'), 13);
  assert.equal(bot.sizeAfterOutcome(11, 'WIN'), 10);
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

test('order matching reads CLOB response aliases and terminal states', () => {
  assert.equal(matchedShares({ size_matched: '4.5' }), 4.5);
  assert.equal(isTerminalOrder({ status: 'CANCELED', shares: 10, matchedShares: 0 }), true);
  assert.equal(isTerminalOrder({ status: 'LIVE', shares: 10, matchedShares: 10 }), true);
  assert.equal(isTerminalOrder({ status: 'LIVE', shares: 10, matchedShares: 3 }), false);
  assert.equal(isTerminalOrder({ status: 'UNFILLED', shares: 10, matchedShares: 0 }), true);
});

test('profitable live closes reduce the next size but respect the 10 floor', () => {
  const { bot } = createBot();
  bot.nextEntryShares = 13;
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
  assert.equal(bot.nextEntryShares, 10);
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
