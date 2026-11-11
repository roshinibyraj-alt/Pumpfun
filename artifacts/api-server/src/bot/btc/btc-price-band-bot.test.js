'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { BtcPriceBandBot } = require('./btc-price-band-bot.cjs');
const config = require('./btc-price-band-config.cjs');

function createBot() {
  let now = 600_001;
  const market = {
    id: 'btc-5m-market',
    slug: 'btc-updown-5m-600',
    title: 'Bitcoin Up or Down - 5 minutes',
    asset: 'BTC',
    start: 600_000,
    end: 900_000,
    tokens: { UP: 'up-token', DOWN: 'down-token' },
    raw: { feesEnabled: false },
  };
  const marketMessages = [];
  const statusUpdates = [];
  const marketData = {
    async getBtcMarket(start, windowMs) {
      assert.equal(start, 600_000);
      assert.equal(windowMs, 300_000);
      return market;
    },
    async getMarket() {
      return {
        id: market.id,
        closed: true,
        umaResolutionStatus: 'resolved',
        outcomePrices: ['1', '0'],
        outcomes: ['Up', 'Down'],
        clobTokenIds: ['up-token', 'down-token'],
      };
    },
    connectMarketStream(tokenIds, handlers) {
      assert.deepEqual(tokenIds, ['up-token', 'down-token']);
      statusUpdates.push(handlers.onStatus);
      marketMessages.push(handlers.onMessage);
      return { close() {} };
    },
  };
  const bot = new BtcPriceBandBot({ marketData, now: () => now });
  return {
    bot,
    market,
    marketData,
    marketMessages,
    statusUpdates,
    setNow(value) { now = value; },
  };
}

function book(tokenId, ask, askSize = 100, bid = 0.50) {
  return {
    event_type: 'book',
    asset_id: tokenId,
    timestamp: '600001',
    asks: [{ price: String(ask), size: String(askSize) }],
    bids: [{ price: String(bid), size: '100' }],
  };
}

function attachCurrentMarket(bot) {
  bot.windowStart = 600_000;
  bot.windowEnd = 900_000;
  bot.market = {
    id: 'btc-5m-market',
    slug: 'btc-updown-5m-600',
    title: 'Bitcoin Up or Down - 5 minutes',
    start: 600_000,
    end: 900_000,
    tokens: { UP: 'up-token', DOWN: 'down-token' },
    raw: { feesEnabled: false },
  };
}

test('config limits the active strategy to BTC 5-minute windows and scales flips by 1.2x', () => {
  assert.equal(config.WINDOW_MS, 5 * 60 * 1000);
  assert.match(config.STRATEGY_VERSION, /0\.59-0\.61/);
  assert.equal(config.SHARES_PER_BUY, 50);
  assert.equal(config.SELLS_ON_OPPOSITE_TRIGGER, true);
  assert.equal(config.OPPOSITE_TRIGGER_SIZE_MULTIPLIER, 1.2);
  assert.equal(config.SAME_SIDE_COOLDOWN_MS, 1_000);
  assert.equal(config.PENDING_TRIGGER_TTL_MS, 2_000);
  assert.equal(config.PENDING_RETRY_MAX_ASK, 1);
  assert.equal(config.MIN_ENTRY_ASK, 0.59);
  assert.equal(config.MAX_ENTRY_ASK, 0.61);
});

test('an explicit history reset creates a fresh durable ledger before restoring state', async () => {
  const previousRequestId = process.env.BTC_HISTORY_RESET_REQUEST_ID;
  process.env.BTC_HISTORY_RESET_REQUEST_ID = 'paper-reset-startup-test';
  const resetCalls = [];
  let savedState = {
    schemaVersion: 1,
    startingCapital: 3_000,
    cash: 2_900,
    realizedPnl: -100,
    trades: [{ id: 'old-trade' }],
    events: [{ id: 'old-event' }],
  };
  const stateStore = {
    async initialize() {},
    async resetHistoryOnce(requestId, initialState) {
      resetCalls.push({ requestId, initialState });
      savedState = initialState;
      return true;
    },
    async loadState() { return savedState; },
    async saveState(state) { savedState = state; },
  };
  const { bot } = createBot();
  bot.stateStore = stateStore;
  bot.requirePersistedState = true;
  bot.tick = async () => {};

  try {
    await bot.start();
    assert.equal(resetCalls.length, 1);
    assert.equal(resetCalls[0].requestId, 'paper-reset-startup-test');
    assert.equal(resetCalls[0].initialState.cash, config.STARTING_CAPITAL);
    assert.deepEqual(resetCalls[0].initialState.trades, []);
    assert.deepEqual(resetCalls[0].initialState.events, []);
    assert.equal(bot.snapshot().account.cash, config.STARTING_CAPITAL);
    assert.equal(bot.snapshot().account.openPositions, 0);
  } finally {
    bot.stop();
    if (previousRequestId === undefined) delete process.env.BTC_HISTORY_RESET_REQUEST_ID;
    else process.env.BTC_HISTORY_RESET_REQUEST_ID = previousRequestId;
  }
});

test('an opposite-side ask trigger sells the outgoing position and buys 1.2x shares', () => {
  const { bot } = createBot();
  bot.windowStart = 600_000;
  bot.windowEnd = 900_000;
  bot.market = {
    id: 'btc-5m-market',
    slug: 'btc-updown-5m-600',
    title: 'Bitcoin Up or Down - 5 minutes',
    start: 600_000,
    end: 900_000,
    tokens: { UP: 'up-token', DOWN: 'down-token' },
    raw: { feesEnabled: false },
  };

  bot.handleMarketMessage(book('up-token', 0.59));
  bot.handleMarketMessage(book('down-token', 0.61));

  const snapshot = bot.snapshot();
  assert.equal(snapshot.strategy.timeframe, '5m');
  assert.deepEqual(snapshot.strategy.assets, ['BTC']);
  assert.equal(snapshot.strategy.intraWindowSales, true);
  assert.equal(snapshot.strategy.oppositeTriggerSizeMultiplier, 1.2);
  assert.equal(snapshot.strategy.allOrNothingBuys, true);
  assert.equal(snapshot.strategy.sellsOnOppositeTrigger, true);
  assert.equal(snapshot.strategy.marketSweepMaxPrice, 1);
  assert.equal(snapshot.account.openPositions, 1);
  assert.equal(snapshot.account.closedPositions, 1);
  assert.equal(snapshot.inventory.currentWindow.UP.shares, 0);
  assert.equal(snapshot.inventory.currentWindow.DOWN.shares, 60);
  assert.equal(snapshot.trades.find(trade => trade.side === 'UP').status, 'CLOSED');
  const downTrade = snapshot.trades.find(trade => trade.side === 'DOWN');
  assert.equal(downTrade.status, 'OPEN');
  assert.equal(downTrade.shares, 60);
  assert.equal(downTrade.entryMode, 'OPPOSITE_SIGNAL_REVERSAL');
  assert.ok(snapshot.account.realizedPnl < 0);
});

test('same-side triggers stay locked while opposite triggers close and scale the position', () => {
  const { bot } = createBot();
  bot.windowStart = 600_000;
  bot.windowEnd = 900_000;
  bot.market = {
    id: 'btc-5m-market',
    start: 600_000,
    end: 900_000,
    tokens: { UP: 'up-token', DOWN: 'down-token' },
    raw: { feesEnabled: false },
  };

  bot.handleMarketMessage(book('up-token', 0.60, 200, 0.50));
  bot.handleMarketMessage({
    event_type: 'price_change',
    timestamp: '600002',
    price_changes: [{
      asset_id: 'up-token',
      price: '0.59',
      size: '200',
      side: 'SELL',
    }],
  });
  assert.equal(bot.inventoryBoxSnapshot(bot.trades, trade => trade.status === 'OPEN').UP.shares, 50);

  bot.handleMarketMessage(book('down-token', 0.60, 200, 0.49));
  const snapshot = bot.snapshot();
  const upTrades = snapshot.trades.filter(trade => trade.side === 'UP');
  const downTrades = snapshot.trades.filter(trade => trade.side === 'DOWN');
  assert.equal(upTrades.length, 1);
  assert.equal(upTrades[0].status, 'CLOSED');
  assert.equal(downTrades.length, 1);
  assert.equal(downTrades[0].shares, 60);
  assert.equal(downTrades[0].status, 'OPEN');
  assert.equal(snapshot.inventory.currentWindow.UP.shares, 0);
  assert.equal(snapshot.inventory.currentWindow.DOWN.shares, 60);
  assert.equal(snapshot.strategy.activeSide, 'DOWN');
  assert.equal(snapshot.strategy.oneBaseBuyPerActiveSide, true);
  assert.equal(snapshot.strategy.intraWindowSales, true);
  assert.equal(snapshot.account.closedPositions, 1);

  const legacyState = bot.persistentStateSnapshot();
  delete legacyState.activeSide;
  delete legacyState.lastBaseBuyAt;
  const restoredLegacy = new BtcPriceBandBot({ now: () => 600_002 });
  restoredLegacy.restorePersistentState(legacyState);
  assert.equal(restoredLegacy.activeSide, 'DOWN');
});

test('repeated opposite triggers sell the full outgoing side and compound the 1.2x size', () => {
  const { bot, setNow } = createBot();
  attachCurrentMarket(bot);
  const signals = [
    { side: 'UP', ask: 0.60 },
    { side: 'DOWN', ask: 0.60 },
    { side: 'UP', ask: 0.59 },
    { side: 'DOWN', ask: 0.59 },
    { side: 'UP', ask: 0.61 },
    { side: 'DOWN', ask: 0.61 },
    { side: 'UP', ask: 0.60 },
    { side: 'DOWN', ask: 0.60 },
  ];
  signals.forEach(({ side, ask }, index) => {
    const at = 600_001 + index;
    setNow(at);
    const message = book(
      side === 'UP' ? 'up-token' : 'down-token',
      ask,
      200,
      side === 'UP' ? 0.50 : 0.49,
    );
    message.bids[0].size = '2000';
    message.timestamp = String(at);
    bot.handleMarketMessage(message);
  });

  const snapshot = bot.snapshot();
  assert.equal(snapshot.trades.length, 8);
  const expectedSizes = [50, 60, 72, 86.4, 103.68, 124.416, 149.2992, 179.15904];
  assert.deepEqual(snapshot.trades.map(trade => trade.shares), expectedSizes.slice().reverse());
  assert.equal(snapshot.trades[0].status, 'OPEN');
  assert.ok(snapshot.trades.slice(1).every(trade => trade.status === 'CLOSED'));
  assert.equal(snapshot.inventory.currentWindow.UP.shares, 0);
  assert.equal(snapshot.inventory.currentWindow.DOWN.shares, 179.15904);
  assert.equal(snapshot.account.closedPositions, 7);
  assert.ok(snapshot.account.realizedPnl < 0);
  assert.equal(snapshot.strategy.activeSide, 'DOWN');
});

test('opposite trigger waits for full 60-share depth before selling and buying', () => {
  const { bot, setNow } = createBot();
  attachCurrentMarket(bot);
  bot.handleMarketMessage(book('up-token', 0.60, 100, 0.50));

  setNow(600_002);
  const shortBook = book('down-token', 0.60, 49, 0.49);
  shortBook.timestamp = '600002';
  bot.handleMarketMessage(shortBook);
  assert.equal(bot.trades.length, 1);
  assert.equal(bot.inventoryBoxSnapshot(bot.trades, trade => trade.status === 'OPEN').UP.shares, 50);
  assert.equal(bot.inventoryBoxSnapshot(bot.trades, trade => trade.status === 'OPEN').DOWN.shares, 0);
  assert.equal(bot.pendingTrigger.mode, 'OPPOSITE_SIGNAL_REVERSAL');
  assert.equal(bot.pendingTrigger.requestedShares, 60);

  setNow(600_003);
  bot.handleMarketMessage({
    event_type: 'book',
    asset_id: 'down-token',
    timestamp: '600003',
    asks: [
      { price: '0.60', size: '20' },
      { price: '0.90', size: '40' },
    ],
    bids: [{ price: '0.49', size: '100' }],
  });

  const snapshot = bot.snapshot();
  const downTrade = snapshot.trades.find(trade => trade.side === 'DOWN');
  assert.equal(snapshot.trades.length, 2);
  assert.equal(downTrade.shares, 60);
  assert.equal(downTrade.entryPrice, 0.8);
  assert.equal(downTrade.status, 'OPEN');
  assert.deepEqual(downTrade.fills.map(fill => fill.price), [0.60, 0.90]);
  assert.equal(snapshot.inventory.currentWindow.UP.shares, 0);
  assert.equal(snapshot.inventory.currentWindow.DOWN.shares, 60);
  assert.equal(snapshot.account.closedPositions, 1);
  assert.equal(snapshot.pendingTrigger, null);
});

test('opposite trigger does not partially sell when visible bid depth is short', () => {
  const { bot, setNow } = createBot();
  attachCurrentMarket(bot);
  bot.handleMarketMessage(book('up-token', 0.60, 100, 0.50));

  setNow(600_002);
  const shortBidBook = book('up-token', 0.60, 100, 0.50);
  shortBidBook.bids[0].size = '49';
  shortBidBook.timestamp = '600002';
  bot.handleMarketMessage(shortBidBook);

  const oppositeBook = book('down-token', 0.60, 100, 0.49);
  oppositeBook.timestamp = '600002';
  bot.handleMarketMessage(oppositeBook);

  const snapshot = bot.snapshot();
  assert.equal(snapshot.trades.length, 1);
  assert.equal(snapshot.trades[0].side, 'UP');
  assert.equal(snapshot.trades[0].status, 'OPEN');
  assert.equal(snapshot.trades[0].shares, 50);
  assert.equal(snapshot.inventory.currentWindow.UP.shares, 50);
  assert.equal(snapshot.inventory.currentWindow.DOWN.shares, 0);
  assert.equal(snapshot.account.closedPositions, 0);
  assert.equal(bot.pendingTrigger.mode, 'OPPOSITE_SIGNAL_REVERSAL');
});

test('an all-or-nothing buy does not consume asks when paper cash is insufficient', () => {
  const { bot } = createBot();
  attachCurrentMarket(bot);
  bot.cash = 0;
  bot.handleMarketMessage(book('up-token', 0.60, 100, 0.50));

  assert.equal(bot.trades.length, 0);
  assert.equal(bot.books.get('up-token').asks[0].availableSize, 100);
  assert.equal(bot.sideState.UP.status, 'INSUFFICIENT_CAPITAL');
  assert.equal(bot.pendingTrigger.mode, 'BASE_ENTRY');
});

test('same-side ask-size and price changes do not add while the direction is locked', () => {
  const { bot } = createBot();
  bot.windowStart = 600_000;
  bot.windowEnd = 900_000;
  bot.market = {
    id: 'btc-5m-market',
    start: 600_000,
    end: 900_000,
    tokens: { UP: 'up-token', DOWN: 'down-token' },
    raw: { feesEnabled: false },
  };
  bot.handleMarketMessage(book('up-token', 0.60, 100));
  bot.handleMarketMessage({
    event_type: 'price_change',
    timestamp: '600002',
    price_changes: [{
      asset_id: 'up-token',
      price: '0.60',
      size: '150',
      side: 'SELL',
    }],
  });

  assert.equal(bot.trades.length, 1);
  assert.deepEqual(bot.trades.map(trade => trade.shares), [50]);

  bot.handleMarketMessage({
    event_type: 'price_change',
    timestamp: '600003',
    price_changes: [{
      asset_id: 'up-token',
      price: '0.59',
      size: '60',
      side: 'SELL',
    }],
  });

  assert.equal(bot.trades.length, 1);
  assert.equal(bot.inventoryBoxSnapshot(
    bot.trades, trade => trade.status === 'OPEN').UP.shares, 50);
});

test('best-bid-ask updates can trigger buys without double-counting the matching price change', () => {
  const { bot } = createBot();
  bot.windowStart = 600_000;
  bot.windowEnd = 900_000;
  bot.market = {
    id: 'btc-5m-market',
    start: 600_000,
    end: 900_000,
    tokens: { UP: 'up-token', DOWN: 'down-token' },
    raw: { feesEnabled: false },
  };
  bot.books.set('up-token', {
    asks: [{ price: 0.60, size: 100, availableSize: 100 }],
    bids: [{ price: 0.50, size: 100, availableSize: 100 }],
    updatedAt: 600_001,
  });
  bot.quotes.UP = {
    side: 'UP',
    tokenId: 'up-token',
    bestAsk: 0.62,
    bestBid: 0.50,
    updatedAt: 600_000,
    status: 'LIVE',
  };
  bot.handleMarketMessage({
    event_type: 'best_bid_ask',
    asset_id: 'up-token',
    best_ask: '0.60',
    best_bid: '0.50',
    timestamp: '600002',
  });
  bot.handleMarketMessage({
    event_type: 'price_change',
    timestamp: '600002',
    price_changes: [{
      asset_id: 'up-token',
      price: '0.60',
      size: '150',
      side: 'SELL',
    }],
  });
  assert.equal(bot.trades.length, 1);
  assert.equal(bot.trades[0].shares, 50);

  bot.handleMarketMessage({
    event_type: 'price_change',
    timestamp: '600003',
    price_changes: [{
      asset_id: 'up-token',
      price: '0.60',
      size: '200',
      side: 'SELL',
    }],
  });
  assert.equal(bot.trades.length, 1);

  bot.handleMarketMessage({
    event_type: 'price_change',
    timestamp: '600004',
    price_changes: [{
      asset_id: 'up-token',
      price: '0.59',
      size: '60',
      side: 'SELL',
    }],
  });
  assert.equal(bot.trades.length, 1);
  assert.equal(bot.activeSide, 'UP');
});

test('prices outside the ask band do not buy; bid-only changes do not trigger buys', () => {
  const { bot } = createBot();
  bot.windowStart = 600_000;
  bot.windowEnd = 900_000;
  bot.market = {
    id: 'btc-5m-market',
    start: 600_000,
    end: 900_000,
    tokens: { UP: 'up-token', DOWN: 'down-token' },
    raw: { feesEnabled: false },
  };
  bot.handleMarketMessage(book('up-token', 0.58));
  bot.handleMarketMessage(book('down-token', 0.62));
  assert.equal(bot.trades.length, 0);

  bot.handleMarketMessage(book('up-token', 0.60, 100));
  bot.handleMarketMessage({
    event_type: 'price_change',
    timestamp: '600003',
    price_changes: [{
      asset_id: 'up-token',
      price: '0.50',
      size: '120',
      side: 'BUY',
    }],
  });
  assert.equal(bot.trades.length, 1);
  assert.equal(bot.trades[0].side, 'UP');
  assert.equal(bot.trades[0].shares, 50);
});

test('an in-range ask waits for full 50-share depth, then fills once', () => {
  const { bot } = createBot();
  bot.windowStart = 600_000;
  bot.windowEnd = 900_000;
  bot.market = {
    id: 'btc-5m-market',
    start: 600_000,
    end: 900_000,
    tokens: { UP: 'up-token', DOWN: 'down-token' },
    raw: { feesEnabled: false },
  };
  bot.handleMarketMessage(book('up-token', 0.60, 49));
  assert.equal(bot.trades.length, 0);
  assert.equal(bot.sideState.UP.status, 'WAITING_FOR_FULL_DEPTH');
  bot.handleMarketMessage({
    event_type: 'price_change',
    timestamp: '600002',
    price_changes: [{
      asset_id: 'up-token',
      price: '0.60',
      size: '100',
      side: 'SELL',
    }],
  });
  assert.equal(bot.trades.length, 1);
  assert.equal(bot.trades[0].shares, 50);
  bot.handleMarketMessage({
    event_type: 'price_change',
    timestamp: '600003',
    price_changes: [{
      asset_id: 'up-token',
      price: '0.59',
      size: '60',
      side: 'SELL',
    }],
  });
  assert.equal(bot.trades.length, 1);
  assert.equal(bot.trades[0].shares, 50);
});

test('a missed entry retries above the previous price ceiling with a full 50-share sweep', () => {
  const { bot, setNow } = createBot();
  attachCurrentMarket(bot);
  bot.handleMarketMessage(book('up-token', 0.60, 49));
  assert.equal(bot.trades.length, 0);
  assert.equal(bot.pendingTrigger.mode, 'BASE_ENTRY');

  setNow(600_002);
  bot.handleMarketMessage(book('up-token', 0.90, 100));
  assert.equal(bot.trades.length, 1);
  assert.equal(bot.trades[0].shares, 50);
  assert.equal(bot.trades[0].triggerAsk, 0.60);
  assert.equal(bot.trades[0].bestAskAtFill, 0.90);
  assert.equal(bot.trades[0].entryPrice, 0.90);
  assert.equal(bot.activeSide, 'UP');
});

test('a missed entry can catch up below the lower trigger-band edge', () => {
  const { bot, setNow } = createBot();
  attachCurrentMarket(bot);
  bot.handleMarketMessage(book('up-token', 0.60, 49));
  setNow(600_002);
  bot.handleMarketMessage(book('up-token', 0.58, 100));

  assert.equal(bot.trades.length, 1);
  assert.equal(bot.trades[0].triggerAsk, 0.60);
  assert.equal(bot.trades[0].bestAskAtFill, 0.58);
  assert.equal(bot.trades[0].shares, 50);
});

test('a newer opposite trigger replaces an unfilled first-entry trigger', () => {
  const { bot } = createBot();
  attachCurrentMarket(bot);
  bot.handleMarketMessage(book('up-token', 0.60, 49));
  assert.equal(bot.pendingTrigger.side, 'UP');

  bot.handleMarketMessage(book('down-token', 0.60, 100));

  assert.equal(bot.pendingTrigger, null);
  assert.equal(bot.trades.length, 1);
  assert.equal(bot.trades[0].side, 'DOWN');
  assert.equal(bot.trades[0].shares, 50);
  assert.equal(bot.sideState.UP.status, 'PENDING_TRIGGER_SUPERSEDED');
});

test('a pending trigger expires after two seconds without creating a late fill', () => {
  const { bot, setNow } = createBot();
  attachCurrentMarket(bot);
  bot.handleMarketMessage(book('up-token', 0.60, 49));
  assert.equal(bot.pendingTrigger.mode, 'BASE_ENTRY');

  setNow(602_001);
  bot.retryPendingTrigger(602_001);
  assert.equal(bot.pendingTrigger, null);
  assert.equal(bot.trades.length, 0);
  assert.equal(bot.sideState.UP.status, 'PENDING_TRIGGER_EXPIRED');
});

test('terminal settlement cancels any still-pending entry before it can fill', () => {
  const { bot } = createBot();
  attachCurrentMarket(bot);
  bot.handleMarketMessage(book('up-token', 0.60, 49));
  bot.terminalEvidence.UP.winnerHitAt = 897_000;
  bot.terminalEvidence.DOWN.loserHitAt = 897_000;

  bot.maybeSettleAtTerminalPrice(897_000);
  bot.retryPendingTrigger(897_000);

  assert.equal(bot.terminalObservation.winner, 'UP');
  assert.equal(bot.pendingTrigger, null);
  assert.equal(bot.trades.length, 0);
});

test('active side and pending retry survive paper-state persistence', () => {
  const { bot } = createBot();
  attachCurrentMarket(bot);
  bot.handleMarketMessage(book('up-token', 0.60, 49));
  const saved = bot.persistentStateSnapshot();
  const restored = new BtcPriceBandBot({ now: () => 600_002 });

  restored.restorePersistentState(saved);

  assert.equal(restored.activeSide, null);
  assert.equal(restored.pendingTrigger.id, bot.pendingTrigger.id);
  assert.equal(restored.pendingTrigger.expiresAt, 602_001);

  bot.handleMarketMessage(book('up-token', 0.60, 100));
  const afterFill = bot.persistentStateSnapshot();
  const restoredAfterFill = new BtcPriceBandBot({ now: () => 600_003 });
  restoredAfterFill.restorePersistentState(afterFill);
  assert.equal(restoredAfterFill.activeSide, 'UP');
  assert.equal(restoredAfterFill.lastBaseBuyAt, 600_001);
});

test('a saved opposite-trigger retry resumes by selling and buying 1.2x shares', () => {
  const { bot } = createBot();
  attachCurrentMarket(bot);
  bot.handleMarketMessage(book('up-token', 0.60, 100, 0.50));
  const saved = bot.persistentStateSnapshot();
  saved.pendingTrigger = {
    id: 'trigger-2',
    side: 'DOWN',
    mode: 'OPPOSITE_SIGNAL_REVERSAL',
    triggerType: 'BEST_ASK_PRICE_CHANGE',
    triggerAsk: 0.60,
    createdAt: 600_001,
    expiresAt: 602_001,
    windowStart: 600_000,
    attempts: 0,
    requestedShares: 50,
    sharesToSell: 50,
    sharesSold: 0,
    sharesBought: 0,
    rebuyTargetShares: 60,
    unmatchedShares: 0,
    grossProceeds: 0,
    saleFees: 0,
    netProceeds: 0,
  };

  const restored = new BtcPriceBandBot({ now: () => 600_002 });
  restored.restorePersistentState(saved);
  attachCurrentMarket(restored);
  assert.equal(restored.pendingTrigger.mode, 'OPPOSITE_SIGNAL_REVERSAL');
  assert.equal(restored.pendingTrigger.requestedShares, 50);

  restored.handleMarketMessage(book('up-token', 0.60, 100, 0.50));
  restored.handleMarketMessage(book('down-token', 0.60, 100, 0.49));
  const snapshot = restored.snapshot();
  assert.equal(snapshot.trades.filter(trade => trade.status === 'OPEN').length, 1);
  assert.equal(snapshot.trades.find(trade => trade.side === 'UP').status, 'CLOSED');
  assert.equal(snapshot.trades.find(trade => trade.side === 'DOWN').shares, 60);
  assert.equal(snapshot.inventory.currentWindow.UP.shares, 0);
  assert.equal(snapshot.inventory.currentWindow.DOWN.shares, 60);
  assert.equal(snapshot.account.closedPositions, 1);
});

test('opposite triggers bypass the one-second guard and sell the outgoing leg', () => {
  const { bot, setNow } = createBot();
  attachCurrentMarket(bot);
  bot.handleMarketMessage(book('up-token', 0.60, 100, 0.50));
  assert.equal(bot.activeSide, 'UP');
  assert.equal(bot.lastBaseBuyAt, 600_001);

  setNow(600_002);
  bot.handleMarketMessage(book('down-token', 0.60, 100, 0.49));
  assert.equal(bot.inventoryBoxSnapshot(bot.trades, trade => trade.status === 'OPEN').UP.shares, 0);
  assert.equal(bot.inventoryBoxSnapshot(bot.trades, trade => trade.status === 'OPEN').DOWN.shares, 60);
  assert.equal(bot.snapshot().account.closedPositions, 1);
  assert.equal(bot.lastBaseBuyAt, 600_001);
  assert.equal(bot.activeSide, 'DOWN');
});

test('expired positions settle only from their exact original market resolution', async () => {
  const { bot, setNow } = createBot();
  bot.windowStart = 600_000;
  bot.windowEnd = 900_000;
  bot.market = {
    id: 'btc-5m-market',
    slug: 'btc-updown-5m-600',
    start: 600_000,
    end: 900_000,
    tokens: { UP: 'up-token', DOWN: 'down-token' },
    raw: { feesEnabled: false },
  };
  bot.handleMarketMessage(book('up-token', 0.60, 100));
  setNow(900_001);
  bot.resetWindow(900_000);
  await bot.resolveDue(900_001, { force: true });

  assert.equal(bot.trades[0].status, 'SETTLED');
  assert.equal(bot.trades[0].outcome, 'WIN');
  assert.equal(bot.cash, 3_020);
});

test('297-second bid thresholds settle winner at one dollar and loser at zero', () => {
  const { bot, setNow } = createBot();
  bot.windowStart = 600_000;
  bot.windowEnd = 900_000;
  bot.market = {
    id: 'btc-5m-market',
    slug: 'btc-updown-5m-600',
    start: 600_000,
    end: 900_000,
    tokens: { UP: 'up-token', DOWN: 'down-token' },
    raw: { feesEnabled: false },
  };
  bot.handleMarketMessage(book('up-token', 0.60, 100));
  setNow(897_000);
  bot.handleMarketMessage(book('up-token', 0.995, 100, 0.99));
  bot.handleMarketMessage(book('down-token', 0.01, 100, 0.009));

  const trade = bot.trades[0];
  assert.equal(bot.terminalObservation.winner, 'UP');
  assert.equal(trade.status, 'SETTLED');
  assert.equal(trade.settlementSource, 'TERMINAL_PRICE_297S');
  assert.equal(trade.resolutionPayout, 1);
  assert.equal(trade.proceeds, 50);
  assert.equal(trade.realizedPnl, 20);
});

test('in-window threshold evidence settles at 297 seconds even when both books are empty', () => {
  const { bot, setNow } = createBot();
  bot.windowStart = 600_000;
  bot.windowEnd = 900_000;
  bot.market = {
    id: 'btc-5m-market',
    slug: 'btc-updown-5m-600',
    start: 600_000,
    end: 900_000,
    tokens: { UP: 'up-token', DOWN: 'down-token' },
    raw: { feesEnabled: false },
  };
  bot.handleMarketMessage(book('up-token', 0.60, 100));
  setNow(800_000);
  bot.handleMarketMessage(book('up-token', 0.995, 100, 0.99));
  bot.handleMarketMessage(book('down-token', 0.01, 100, 0.009));
  bot.quotes = { UP: null, DOWN: null };
  bot.books.clear();

  setNow(897_000);
  bot.maybeSettleAtTerminalPrice(897_000);

  assert.equal(bot.terminalObservation.winner, 'UP');
  assert.equal(bot.terminalObservation.evidence.UP.winnerBid, 0.99);
  assert.equal(bot.terminalObservation.evidence.DOWN.loserBid, 0.009);
  assert.equal(bot.trades[0].status, 'SETTLED');
  assert.equal(bot.trades[0].resolutionPayout, 1);
});

test('conflicting threshold evidence in both directions waits for official resolution', () => {
  const { bot, setNow } = createBot();
  bot.windowStart = 600_000;
  bot.windowEnd = 900_000;
  bot.market = {
    id: 'btc-5m-market',
    slug: 'btc-updown-5m-600',
    start: 600_000,
    end: 900_000,
    tokens: { UP: 'up-token', DOWN: 'down-token' },
    raw: { feesEnabled: false },
  };
  bot.handleMarketMessage(book('up-token', 0.60, 100));
  setNow(800_000);
  bot.handleMarketMessage(book('up-token', 0.995, 100, 0.99));
  bot.handleMarketMessage(book('down-token', 0.01, 100, 0.009));
  setNow(850_000);
  bot.handleMarketMessage(book('down-token', 0.995, 100, 0.99));
  bot.handleMarketMessage(book('up-token', 0.01, 100, 0.009));
  setNow(897_000);
  bot.maybeSettleAtTerminalPrice(897_000);

  assert.equal(bot.terminalObservation.winner, null);
  assert.equal(bot.terminalObservation.ambiguous, true);
  assert.equal(bot.trades[0].status, 'OPEN');
});

test('297-second prices outside the thresholds keep positions for official resolution', () => {
  const { bot, setNow } = createBot();
  bot.windowStart = 600_000;
  bot.windowEnd = 900_000;
  bot.market = {
    id: 'btc-5m-market',
    slug: 'btc-updown-5m-600',
    start: 600_000,
    end: 900_000,
    tokens: { UP: 'up-token', DOWN: 'down-token' },
    raw: { feesEnabled: false },
  };
  bot.handleMarketMessage(book('up-token', 0.60, 100));
  setNow(897_000);
  bot.handleMarketMessage(book('up-token', 0.90, 100, 0.90));
  bot.handleMarketMessage(book('down-token', 0.10, 100, 0.10));
  assert.equal(bot.terminalObservation.winner, null);
  assert.equal(bot.trades[0].status, 'OPEN');

  setNow(900_001);
  bot.resetWindow(900_000);
  assert.equal(bot.trades[0].status, 'AWAITING_RESOLUTION');
});
