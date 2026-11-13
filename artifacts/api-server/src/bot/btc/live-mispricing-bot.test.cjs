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

test('live copy starts at 10 shares and sizes outcomes by +2/-3 with a 10-share floor', () => {
  const { bot } = createBot();
  assert.equal(bot.config.BASE_SHARES, 10);
  assert.equal(bot.config.LOSS_SIZE_STEP_SHARES, 2);
  assert.equal(bot.config.WIN_SIZE_REDUCTION_SHARES, 3);
  assert.equal(bot.sizeAfterOutcome(10, 'LOSS'), 12);
  assert.equal(bot.sizeAfterOutcome(20, 'WIN'), 17);
  assert.equal(bot.sizeAfterOutcome(11, 'WIN'), 10);
});

test('live entry records only the amount confirmed by the exchange', async () => {
  const trader = {
    async placeLimitOrder() { return { id: 'exchange-1', status: 'LIVE' }; },
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
  assert.equal(bot.liveHalted, false);
  assert.ok(saves.length >= 2);
});

test('a partial exchange fill cancels the remainder and records only filled shares', async () => {
  let canceled = 0;
  let fetches = 0;
  const trader = {
    async placeLimitOrder() { return { id: 'exchange-partial', status: 'LIVE' }; },
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
    async placeLimitOrder() { submissions += 1; return { id: 'never' }; },
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
    async placeLimitOrder() {
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
});

test('profitable live closes reduce the next order size but respect the 10-share floor', () => {
  const { bot } = createBot();
  bot.nextEntryShares = 12;
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
