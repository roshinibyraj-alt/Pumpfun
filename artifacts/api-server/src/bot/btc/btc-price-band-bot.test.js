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

test('config limits the active strategy to BTC 5-minute windows and 50-share buys', () => {
  assert.equal(config.WINDOW_MS, 5 * 60 * 1000);
  assert.equal(config.SHARES_PER_BUY, 50);
  assert.equal(config.FLIP_ESCALATION_AFTER, 4);
  assert.equal(config.FLIP_ESCALATION_REBUY_SHARES, 100);
  assert.equal(config.SAME_SIDE_COOLDOWN_MS, 1_000);
  assert.equal(config.PENDING_TRIGGER_TTL_MS, 2_000);
  assert.equal(config.PENDING_RETRY_MAX_ASK, 0.56);
  assert.equal(config.MIN_ENTRY_ASK, 0.52);
  assert.equal(config.MAX_ENTRY_ASK, 0.54);
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

test('an opposite-side ask trigger sells held shares then buys the same count', () => {
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

  bot.handleMarketMessage(book('up-token', 0.52));
  bot.handleMarketMessage(book('down-token', 0.54));

  const snapshot = bot.snapshot();
  assert.equal(snapshot.strategy.timeframe, '5m');
  assert.deepEqual(snapshot.strategy.assets, ['BTC']);
  assert.equal(snapshot.strategy.intraWindowSales, true);
  assert.equal(snapshot.account.openPositions, 1);
  assert.equal(snapshot.account.closedPositions, 1);
  assert.equal(snapshot.inventory.currentWindow.UP.shares, 0);
  assert.equal(snapshot.inventory.currentWindow.DOWN.shares, 50);
  assert.equal(snapshot.trades[0].side, 'UP');
  assert.equal(snapshot.trades[0].status, 'CLOSED');
  assert.equal(snapshot.trades[0].exitReason, 'OPPOSITE_SIGNAL');
  assert.equal(snapshot.trades[0].exitPrice, 0.5);
  assert.equal(snapshot.trades[1].side, 'DOWN');
  assert.equal(snapshot.trades[1].shares, 50);
  assert.equal(snapshot.trades[1].entryMode, 'OPPOSITE_SIGNAL_REVERSAL');
  assert.equal(snapshot.account.realizedPnl, -1);
  assert.equal(snapshot.trades[0].fees, 0);
});

test('same-side triggers do not add shares and the opposite trigger flips the active 50-share position', () => {
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

  bot.handleMarketMessage(book('up-token', 0.53, 200, 0.50));
  bot.handleMarketMessage({
    event_type: 'price_change',
    timestamp: '600002',
    price_changes: [{
      asset_id: 'up-token',
      price: '0.52',
      size: '200',
      side: 'SELL',
    }],
  });
  assert.equal(bot.inventoryBoxSnapshot(bot.trades, trade => trade.status === 'OPEN').UP.shares, 50);

  bot.handleMarketMessage(book('down-token', 0.53, 200, 0.49));
  const snapshot = bot.snapshot();
  const upTrades = snapshot.trades.filter(trade => trade.side === 'UP');
  const downTrades = snapshot.trades.filter(trade => trade.side === 'DOWN');
  assert.equal(upTrades.length, 1);
  assert.ok(upTrades.every(trade => trade.status === 'CLOSED'));
  assert.equal(downTrades.length, 1);
  assert.equal(downTrades[0].shares, 50);
  assert.equal(downTrades[0].status, 'OPEN');
  assert.equal(snapshot.inventory.currentWindow.DOWN.shares, 50);
  assert.equal(snapshot.strategy.activeSide, 'DOWN');
  assert.deepEqual(snapshot.strategy.flipEscalation, {
    threshold: 4,
    rebuyShares: 100,
    consecutiveCompletedFlips: 1,
    nextRebuyShares: 50,
  });

  const legacyState = bot.persistentStateSnapshot();
  delete legacyState.activeSide;
  delete legacyState.lastBaseBuyAt;
  const restoredLegacy = new BtcPriceBandBot({ now: () => 600_002 });
  restoredLegacy.restorePersistentState(legacyState);
  assert.equal(restoredLegacy.activeSide, 'DOWN');
});

test('the next reversal targets 100 shares after four completed flips in the same window', () => {
  const { bot, setNow } = createBot();
  attachCurrentMarket(bot);
  bot.handleMarketMessage(book('up-token', 0.53, 200, 0.50));

  const flips = [
    { side: 'DOWN', ask: 0.53 },
    { side: 'UP', ask: 0.52 },
    { side: 'DOWN', ask: 0.52 },
    { side: 'UP', ask: 0.53 },
  ];
  flips.forEach(({ side, ask }, index) => {
    const at = 600_002 + index;
    setNow(at);
    const message = book(
      side === 'UP' ? 'up-token' : 'down-token',
      ask,
      200,
      side === 'UP' ? 0.50 : 0.49,
    );
    message.timestamp = String(at);
    bot.handleMarketMessage(message);
  });

  assert.equal(bot.consecutiveFlipCount, 4);
  assert.equal(bot.snapshot().strategy.flipEscalation.nextRebuyShares, 100);
  const saved = bot.persistentStateSnapshot();
  const restored = new BtcPriceBandBot({ now: () => 600_006 });
  restored.restorePersistentState(saved);
  assert.equal(restored.consecutiveFlipCount, 4);
  restored.resetWindow(900_000);
  assert.equal(restored.consecutiveFlipCount, 0);

  bot.books.get('up-token').bids[0].availableSize = 100;
  setNow(600_006);
  const escalatedFlip = book('down-token', 0.53, 200, 0.49);
  escalatedFlip.timestamp = '600006';
  bot.handleMarketMessage(escalatedFlip);
  const snapshot = bot.snapshot();
  assert.equal(snapshot.inventory.currentWindow.UP.shares, 0);
  assert.equal(snapshot.inventory.currentWindow.DOWN.shares, 100);
  assert.equal(snapshot.strategy.flipEscalation.consecutiveCompletedFlips, 5);
  assert.equal(snapshot.strategy.flipEscalation.nextRebuyShares, 100);
  assert.equal(snapshot.pendingTrigger, null);
});

test('an escalated rebuy waits for the extra visible ask depth and survives as one pending flip', () => {
  const { bot, setNow } = createBot();
  attachCurrentMarket(bot);
  bot.handleMarketMessage(book('up-token', 0.53, 200, 0.50));

  const flips = [
    { side: 'DOWN', ask: 0.53 },
    { side: 'UP', ask: 0.52 },
    { side: 'DOWN', ask: 0.52 },
    { side: 'UP', ask: 0.53 },
  ];
  flips.forEach(({ side, ask }, index) => {
    const at = 600_002 + index;
    setNow(at);
    const message = book(
      side === 'UP' ? 'up-token' : 'down-token',
      ask,
      200,
      side === 'UP' ? 0.50 : 0.49,
    );
    message.timestamp = String(at);
    bot.handleMarketMessage(message);
  });

  bot.books.get('up-token').bids[0].availableSize = 100;
  setNow(600_006);
  const limitedDepth = book('down-token', 0.53, 50, 0.49);
  limitedDepth.timestamp = '600006';
  bot.handleMarketMessage(limitedDepth);
  assert.equal(bot.inventoryBoxSnapshot(bot.trades, trade => trade.status === 'OPEN').UP.shares, 0);
  assert.equal(bot.inventoryBoxSnapshot(bot.trades, trade => trade.status === 'OPEN').DOWN.shares, 50);
  assert.equal(bot.pendingTrigger.rebuyTargetShares, 100);
  assert.equal(bot.pendingTrigger.sharesBought, 50);
  assert.equal(bot.consecutiveFlipCount, 4);

  setNow(600_007);
  const addedDepth = book('down-token', 0.54, 50, 0.49);
  addedDepth.timestamp = '600007';
  bot.handleMarketMessage(addedDepth);
  assert.equal(bot.pendingTrigger, null);
  assert.equal(bot.inventoryBoxSnapshot(bot.trades, trade => trade.status === 'OPEN').DOWN.shares, 100);
  assert.equal(bot.consecutiveFlipCount, 5);
});

test('partial reversal buys exactly the shares sold and retains the unsold remainder', () => {
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
  bot.handleMarketMessage(book('up-token', 0.53, 100, 0.50));
  bot.handleMarketMessage(book('up-token', 0.53, 100, 0.50));
  const upBook = bot.books.get('up-token');
  upBook.bids[0].availableSize = 20;
  bot.handleMarketMessage(book('down-token', 0.53, 100, 0.49));

  const openInventory = bot.inventoryBoxSnapshot(bot.trades, trade => trade.status === 'OPEN');
  assert.equal(openInventory.UP.shares, 30);
  assert.equal(openInventory.DOWN.shares, 20);
  assert.equal(bot.activeSide, 'DOWN');
  assert.equal(bot.pendingTrigger.mode, 'OPPOSITE_SIGNAL_REVERSAL');
  assert.equal(bot.pendingTrigger.sharesSold, 20);
  assert.equal(bot.pendingTrigger.sharesBought, 20);
});

test('a failed matched buy is retried before any further shares are sold', () => {
  const { bot, setNow } = createBot();
  attachCurrentMarket(bot);
  bot.handleMarketMessage(book('up-token', 0.53, 100, 0.50));
  const tryBuy = bot.tryBuy.bind(bot);
  bot.tryBuy = () => false;

  setNow(600_002);
  bot.handleMarketMessage(book('down-token', 0.53, 100, 0.49));
  assert.equal(bot.pendingTrigger.unmatchedShares, 50);
  assert.equal(bot.inventoryBoxSnapshot(bot.trades, trade => trade.status === 'OPEN').UP.shares, 0);

  bot.tryBuy = tryBuy;
  setNow(600_003);
  bot.retryPendingTrigger(600_003);

  assert.equal(bot.pendingTrigger, null);
  assert.equal(bot.inventoryBoxSnapshot(bot.trades, trade => trade.status === 'OPEN').DOWN.shares, 50);
  assert.equal(bot.activeSide, 'DOWN');
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
  bot.handleMarketMessage(book('up-token', 0.53, 100));
  bot.handleMarketMessage({
    event_type: 'price_change',
    timestamp: '600002',
    price_changes: [{
      asset_id: 'up-token',
      price: '0.53',
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
      price: '0.52',
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
    asks: [{ price: 0.53, size: 100, availableSize: 100 }],
    bids: [{ price: 0.50, size: 100, availableSize: 100 }],
    updatedAt: 600_001,
  });
  bot.quotes.UP = {
    side: 'UP',
    tokenId: 'up-token',
    bestAsk: 0.55,
    bestBid: 0.50,
    updatedAt: 600_000,
    status: 'LIVE',
  };
  bot.handleMarketMessage({
    event_type: 'best_bid_ask',
    asset_id: 'up-token',
    best_ask: '0.53',
    best_bid: '0.50',
    timestamp: '600002',
  });
  bot.handleMarketMessage({
    event_type: 'price_change',
    timestamp: '600002',
    price_changes: [{
      asset_id: 'up-token',
      price: '0.53',
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
      price: '0.53',
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
      price: '0.52',
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
  bot.handleMarketMessage(book('up-token', 0.51));
  bot.handleMarketMessage(book('down-token', 0.55));
  assert.equal(bot.trades.length, 0);

  bot.handleMarketMessage(book('up-token', 0.53, 100));
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
  bot.handleMarketMessage(book('up-token', 0.53, 49));
  assert.equal(bot.trades.length, 0);
  assert.equal(bot.sideState.UP.status, 'WAITING_FOR_FULL_DEPTH');
  bot.handleMarketMessage({
    event_type: 'price_change',
    timestamp: '600002',
    price_changes: [{
      asset_id: 'up-token',
      price: '0.53',
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
      price: '0.52',
      size: '60',
      side: 'SELL',
    }],
  });
  assert.equal(bot.trades.length, 1);
  assert.equal(bot.trades[0].shares, 50);
});

test('a missed entry retries after leaving the band, but never above the $0.56 ceiling', () => {
  const { bot, setNow } = createBot();
  attachCurrentMarket(bot);
  bot.handleMarketMessage(book('up-token', 0.53, 49));
  assert.equal(bot.trades.length, 0);
  assert.equal(bot.pendingTrigger.mode, 'BASE_ENTRY');

  setNow(600_002);
  bot.handleMarketMessage(book('up-token', 0.57, 100));
  assert.equal(bot.trades.length, 0);
  assert.equal(bot.sideState.UP.status, 'WAITING_FOR_RETRY_PRICE');

  setNow(600_003);
  bot.handleMarketMessage(book('up-token', 0.55, 100));
  assert.equal(bot.trades.length, 1);
  assert.equal(bot.trades[0].shares, 50);
  assert.equal(bot.trades[0].triggerAsk, 0.53);
  assert.equal(bot.trades[0].bestAskAtFill, 0.55);
  assert.equal(bot.activeSide, 'UP');
});

test('a missed entry can catch up below the lower trigger-band edge', () => {
  const { bot, setNow } = createBot();
  attachCurrentMarket(bot);
  bot.handleMarketMessage(book('up-token', 0.53, 49));
  setNow(600_002);
  bot.handleMarketMessage(book('up-token', 0.51, 100));

  assert.equal(bot.trades.length, 1);
  assert.equal(bot.trades[0].triggerAsk, 0.53);
  assert.equal(bot.trades[0].bestAskAtFill, 0.51);
  assert.equal(bot.trades[0].shares, 50);
});

test('a newer opposite trigger replaces an unfilled first-entry trigger', () => {
  const { bot } = createBot();
  attachCurrentMarket(bot);
  bot.handleMarketMessage(book('up-token', 0.53, 49));
  assert.equal(bot.pendingTrigger.side, 'UP');

  bot.handleMarketMessage(book('down-token', 0.53, 100));

  assert.equal(bot.pendingTrigger, null);
  assert.equal(bot.trades.length, 1);
  assert.equal(bot.trades[0].side, 'DOWN');
  assert.equal(bot.trades[0].shares, 50);
  assert.equal(bot.sideState.UP.status, 'PENDING_TRIGGER_SUPERSEDED');
});

test('a pending trigger expires after two seconds without creating a late fill', () => {
  const { bot, setNow } = createBot();
  attachCurrentMarket(bot);
  bot.handleMarketMessage(book('up-token', 0.53, 49));
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
  bot.handleMarketMessage(book('up-token', 0.53, 49));
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
  bot.handleMarketMessage(book('up-token', 0.53, 49));
  const saved = bot.persistentStateSnapshot();
  const restored = new BtcPriceBandBot({ now: () => 600_002 });

  restored.restorePersistentState(saved);

  assert.equal(restored.activeSide, null);
  assert.equal(restored.pendingTrigger.id, bot.pendingTrigger.id);
  assert.equal(restored.pendingTrigger.expiresAt, 602_001);

  bot.handleMarketMessage(book('up-token', 0.53, 100));
  const afterFill = bot.persistentStateSnapshot();
  const restoredAfterFill = new BtcPriceBandBot({ now: () => 600_003 });
  restoredAfterFill.restorePersistentState(afterFill);
  assert.equal(restoredAfterFill.activeSide, 'UP');
  assert.equal(restoredAfterFill.lastBaseBuyAt, 600_001);
});

test('opposite-side flips bypass the one-second same-side duplicate guard', () => {
  const { bot, setNow } = createBot();
  attachCurrentMarket(bot);
  bot.handleMarketMessage(book('up-token', 0.53, 100, 0.50));
  assert.equal(bot.activeSide, 'UP');
  assert.equal(bot.lastBaseBuyAt, 600_001);

  setNow(600_002);
  bot.handleMarketMessage(book('down-token', 0.53, 100, 0.49));
  assert.equal(bot.inventoryBoxSnapshot(bot.trades, trade => trade.status === 'OPEN').UP.shares, 0);
  assert.equal(bot.inventoryBoxSnapshot(bot.trades, trade => trade.status === 'OPEN').DOWN.shares, 50);
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
  bot.handleMarketMessage(book('up-token', 0.53, 100));
  setNow(900_001);
  bot.resetWindow(900_000);
  await bot.resolveDue(900_001, { force: true });

  assert.equal(bot.trades[0].status, 'SETTLED');
  assert.equal(bot.trades[0].outcome, 'WIN');
  assert.equal(bot.cash, 3_023.5);
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
  bot.handleMarketMessage(book('up-token', 0.53, 100));
  setNow(897_000);
  bot.handleMarketMessage(book('up-token', 0.995, 100, 0.99));
  bot.handleMarketMessage(book('down-token', 0.01, 100, 0.009));

  const trade = bot.trades[0];
  assert.equal(bot.terminalObservation.winner, 'UP');
  assert.equal(trade.status, 'SETTLED');
  assert.equal(trade.settlementSource, 'TERMINAL_PRICE_297S');
  assert.equal(trade.resolutionPayout, 1);
  assert.equal(trade.proceeds, 50);
  assert.equal(trade.realizedPnl, 23.5);
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
  bot.handleMarketMessage(book('up-token', 0.53, 100));
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
  bot.handleMarketMessage(book('up-token', 0.53, 100));
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
  bot.handleMarketMessage(book('up-token', 0.53, 100));
  setNow(897_000);
  bot.handleMarketMessage(book('up-token', 0.90, 100, 0.90));
  bot.handleMarketMessage(book('down-token', 0.10, 100, 0.10));
  assert.equal(bot.terminalObservation.winner, null);
  assert.equal(bot.trades[0].status, 'OPEN');

  setNow(900_001);
  bot.resetWindow(900_000);
  assert.equal(bot.trades[0].status, 'AWAITING_RESOLUTION');
});
