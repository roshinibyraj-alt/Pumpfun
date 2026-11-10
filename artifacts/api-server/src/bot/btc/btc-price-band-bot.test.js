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

test('independent UP and DOWN asks at the inclusive band edges each buy 50 shares', () => {
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
  assert.equal(snapshot.account.openPositions, 2);
  assert.equal(snapshot.inventory.currentWindow.UP.shares, 50);
  assert.equal(snapshot.inventory.currentWindow.DOWN.shares, 50);
  assert.equal(snapshot.trades[0].shares, 50);
  assert.equal(snapshot.trades[1].shares, 50);
  assert.equal(snapshot.trades[0].fees, 0);
});

test('a fresh ask-side update can add another full 50-share buy after depth replenishes', () => {
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

  assert.equal(bot.trades.length, 2);
  assert.deepEqual(bot.trades.map(trade => trade.shares), [50, 50]);
  assert.equal(bot.inventoryBoxSnapshot(
    bot.trades, trade => trade.status === 'OPEN').UP.shares, 100);
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
