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

test('config limits the active strategy to BTC 5-minute windows and 50-share buys', () => {
  assert.equal(config.WINDOW_MS, 5 * 60 * 1000);
  assert.equal(config.SHARES_PER_BUY, 50);
  assert.equal(config.MIN_ENTRY_ASK, 0.52);
  assert.equal(config.MAX_ENTRY_ASK, 0.54);
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

test('opposite trigger reverses the full accumulated quantity, not only 50 shares', () => {
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
  assert.equal(bot.inventoryBoxSnapshot(bot.trades, trade => trade.status === 'OPEN').UP.shares, 100);

  bot.handleMarketMessage(book('down-token', 0.53, 200, 0.49));
  const snapshot = bot.snapshot();
  const upTrades = snapshot.trades.filter(trade => trade.side === 'UP');
  const downTrades = snapshot.trades.filter(trade => trade.side === 'DOWN');
  assert.equal(upTrades.length, 2);
  assert.ok(upTrades.every(trade => trade.status === 'CLOSED'));
  assert.equal(downTrades.length, 1);
  assert.equal(downTrades[0].shares, 100);
  assert.equal(downTrades[0].status, 'OPEN');
  assert.equal(snapshot.inventory.currentWindow.DOWN.shares, 100);
});

test('reversal waits instead of buying when visible bids cannot sell all held shares', () => {
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
  upBook.bids[0].availableSize = 49;
  bot.handleMarketMessage(book('down-token', 0.53, 100, 0.49));

  assert.equal(bot.trades.length, 1);
  assert.equal(bot.trades[0].status, 'OPEN');
  assert.equal(bot.inventoryBoxSnapshot(bot.trades, trade => trade.status === 'OPEN').UP.shares, 50);
  assert.equal(bot.inventoryBoxSnapshot(bot.trades, trade => trade.status === 'OPEN').DOWN.shares, 0);
  assert.equal(bot.sideState.DOWN.status, 'WAITING_FOR_REVERSAL_DEPTH');
});

test('ask-size updates do not buy again unless the best-ask price changes', () => {
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

  assert.equal(bot.trades.length, 2);
  assert.equal(bot.trades[1].triggerAsk, 0.52);
  assert.equal(bot.trades[1].shares, 50);
  assert.equal(bot.inventoryBoxSnapshot(
    bot.trades, trade => trade.status === 'OPEN').UP.shares, 100);
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
  assert.equal(bot.trades.length, 2);
  assert.equal(bot.trades[1].triggerAsk, 0.52);
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

test('an in-range ask without 50 shares of visible depth never creates a partial fill', () => {
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
  assert.equal(bot.trades.length, 0);
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
