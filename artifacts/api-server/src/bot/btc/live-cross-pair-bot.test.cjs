'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { LiveCrossPairBot } = require('./live-cross-pair-bot.cjs');

const WINDOW_MS = 300_000;

function makeBot({ traderOverrides = {}, now = 1_800_000_000_000 } = {}) {
  let currentTime = now;
  const saved = [];
  const calls = [];
  const balances = new Map();
  const exchangeOrders = new Map();
  let orderNumber = 0;
  const trader = {
    async placeTakerOrder(tokenId, side, price, size) {
      const id = `exchange-${++orderNumber}`;
      calls.push({ tokenId, side, price, size, id });
      const requestedFill = traderOverrides.fillForOrder
        ? traderOverrides.fillForOrder({ tokenId, side, price, size, id })
        : 7;
      exchangeOrders.set(id, {
        id,
        status: traderOverrides.statusForOrder?.({ tokenId, side, price, size, id }) || 'MATCHED',
        sizeMatched: String(requestedFill),
      });
      if (side === 'SELL') {
        const before = balances.get(tokenId) ?? 7;
        balances.set(tokenId, Math.max(0, before - requestedFill));
      } else if (!balances.has(tokenId)) {
        balances.set(tokenId, requestedFill);
      } else {
        balances.set(tokenId, balances.get(tokenId) + requestedFill);
      }
      return { id, status: 'MATCHED' };
    },
    async fetchOrder(id) {
      return exchangeOrders.get(id);
    },
    async cancelOrder(id) {
      const order = exchangeOrders.get(id);
      if (order) order.status = 'CANCELLED';
      return { canceled: [id] };
    },
    async getSellableShares(tokenId) {
      return { tokenId, shares: balances.get(tokenId) ?? 7 };
    },
    ...traderOverrides,
  };
  const store = {
    async initialize() {},
    async loadState() { return null; },
    async saveState(state) { saved.push(state); },
  };
  const marketData = {
    async getAssetMarket(asset, start, windowMs) {
      return {
        id: `${asset}-${start}`,
        conditionId: `condition-${asset}-${start}`,
        asset: asset.toUpperCase(),
        slug: `${asset}-updown-5m-${start / 1000}`,
        title: `${asset.toUpperCase()} Up or Down`,
        start,
        end: start + windowMs,
        tokens: {
          UP: `${asset}-up-${start}`,
          DOWN: `${asset}-down-${start}`,
        },
      };
    },
    async getBook(tokenId) {
      return {
        bids: [{ price: '0.29', size: '100' }],
        asks: [{ price: '0.30', size: '100' }],
      };
    },
    connectMarketStream() {
      return { close() {} };
    },
    async getMarket() { return null; },
  };
  const bot = new LiveCrossPairBot({
    stateStore: store,
    trader,
    tradingEnabled: true,
    marketData,
    now: () => currentTime,
    orderTimeoutMs: 500,
    orderPollMs: 100,
  });
  const windowStart = Math.floor(now / WINDOW_MS) * WINDOW_MS;
  bot.windowStart = windowStart;
  bot.windowEnd = windowStart + WINDOW_MS;
  bot.earliestTradableWindowStart = windowStart;
  bot.storageHealthy = true;
  bot.liveAccount = { authenticated: true, accountReady: true, status: 'READY' };
  bot.marketContexts = new Map([
    ['BTC', {
      asset: 'BTC',
      id: `btc-${windowStart}`,
      conditionId: `condition-BTC-${windowStart}`,
      slug: `btc-updown-5m-${windowStart / 1000}`,
      start: windowStart,
      end: windowStart + WINDOW_MS,
      raw: { feesEnabled: false },
      tokens: { UP: `btc-up-${windowStart}`, DOWN: `btc-down-${windowStart}` },
    }],
    ['ETH', {
      asset: 'ETH',
      id: `eth-${windowStart}`,
      conditionId: `condition-ETH-${windowStart}`,
      slug: `eth-updown-5m-${windowStart / 1000}`,
      start: windowStart,
      end: windowStart + WINDOW_MS,
      raw: { feesEnabled: false },
      tokens: { UP: `eth-up-${windowStart}`, DOWN: `eth-down-${windowStart}` },
    }],
  ]);
  for (const [asset, market] of bot.marketContexts) {
    for (const side of ['UP', 'DOWN']) {
      const tokenId = market.tokens[side];
      bot.tokenRefs.set(tokenId, { asset, side, market });
      bot.books.set(tokenId, {
        bids: [{ price: 0.29, size: 100 }],
        asks: [{ price: 0.30, size: 100 }],
        updatedAt: currentTime,
        sourceTimestamp: currentTime,
      });
    }
  }
  bot.windowPairs = new Map();
  return {
    bot,
    calls,
    balances,
    saved,
    setNow(value) { currentTime = value; },
  };
}

function setBook(bot, asset, side, { bid, ask, bidSize = 100, askSize = 100, at }) {
  const market = bot.marketContexts.get(asset);
  const tokenId = market.tokens[side];
  bot.books.set(tokenId, {
    bids: bid == null ? [] : [{ price: bid, size: bidSize }],
    asks: ask == null ? [] : [{ price: ask, size: askSize }],
    updatedAt: at,
    sourceTimestamp: at,
  });
}

test('startup keeps health and market monitoring responsive while account authentication is pending', async () => {
  const neverAuthenticates = new Promise(() => {});
  const { bot } = makeBot({
    traderOverrides: { authenticate: () => neverAuthenticates },
  });
  bot.liveAccount = { authenticated: false, accountReady: false, status: 'CONNECTING' };

  const started = await bot.start();
  assert.equal(started.status, 'SEARCHING_MARKETS');
  assert.equal(bot.running, true);
  assert.equal(bot.accountAuthInFlight, true);
  assert.equal(bot.liveAccount.accountReady, false);
  await bot.stop();
});

test('enters the qualifying mixed pair only, sizes the buy from fresh asks, and stores actual fills', async () => {
  const { bot, calls, saved } = makeBot();
  const now = 1_800_000_000_000;
  setBook(bot, 'BTC', 'UP', { bid: 0.29, ask: 0.30, at: now });
  setBook(bot, 'ETH', 'DOWN', { bid: 0.38, ask: 0.40, at: now });
  setBook(bot, 'ETH', 'UP', { bid: 0.49, ask: 0.50, at: now });
  setBook(bot, 'BTC', 'DOWN', { bid: 0.49, ask: 0.50, at: now });

  await bot.evaluateNow(now);

  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(call => [call.tokenId, call.side]), [
    ['btc-up-1800000000000', 'BUY'],
    ['eth-down-1800000000000', 'BUY'],
  ]);
  assert.deepEqual(calls.map(call => call.price), [0.99, 0.99]);
  assert.deepEqual(calls.map(call => call.size), [2.1, 2.8]);
  assert.equal(bot.cycles.length, 1);
  assert.equal(bot.cycles[0].pairId, 'btc-up-eth-down');
  assert.deepEqual(bot.positions.map(position => position.shares), [7, 7]);
  assert.equal(bot.pairState(bot._test?.PAIRS?.[0] || { id: 'btc-up-eth-down' }).entered, true);
  assert.ok(saved.length > 0);
});

test('the $1.22 pair signal submits independent share-sized sells for both current tokens', async () => {
  const { bot, calls } = makeBot();
  const now = 1_800_000_000_000;
  setBook(bot, 'BTC', 'UP', { bid: 0.29, ask: 0.30, at: now });
  setBook(bot, 'ETH', 'DOWN', { bid: 0.29, ask: 0.30, at: now });
  setBook(bot, 'ETH', 'UP', { bid: 0.49, ask: 0.50, at: now });
  setBook(bot, 'BTC', 'DOWN', { bid: 0.49, ask: 0.50, at: now });
  await bot.evaluateNow(now);

  const cycle = bot.cycles.find(item => item.pairId === 'btc-up-eth-down');
  assert.ok(cycle);
  const legPositions = bot.positions.filter(position => position.cycleId === cycle.id);
  assert.equal(legPositions.length, 2);

  setBook(bot, 'BTC', 'UP', { bid: 0.55, ask: 0.70, at: now + 1_500 });
  setBook(bot, 'ETH', 'DOWN', { bid: 0.55, ask: 0.53, at: now + 1_500 });
  await bot.evaluateNow(now + 1_500);

  const sells = calls.filter(call => call.side === 'SELL');
  assert.deepEqual(sells.map(call => [call.tokenId, call.size]).sort((a, b) => a[0].localeCompare(b[0])), [
    ['btc-up-1800000000000', 7],
    ['eth-down-1800000000000', 7],
  ]);
  assert.deepEqual(sells.map(call => call.price), [0.01, 0.01]);
  assert.ok(legPositions.every(position => position.status === 'CLOSED'));
});

test('a take-profit signal sells only the leg whose bid reaches $0.99', async () => {
  const { bot, calls } = makeBot();
  const now = 1_800_000_000_000;
  setBook(bot, 'BTC', 'UP', { bid: 0.30, ask: 0.31, at: now });
  setBook(bot, 'ETH', 'DOWN', { bid: 0.30, ask: 0.31, at: now });
  setBook(bot, 'ETH', 'UP', { bid: 0.49, ask: 0.50, at: now });
  setBook(bot, 'BTC', 'DOWN', { bid: 0.49, ask: 0.50, at: now });
  await bot.evaluateNow(now);

  setBook(bot, 'BTC', 'UP', { bid: 0.99, ask: 0.99, at: now + 1_500 });
  await bot.evaluateNow(now + 1_500);

  const sells = calls.filter(call => call.side === 'SELL');
  assert.equal(sells.length, 1);
  assert.equal(sells[0].tokenId, 'btc-up-1800000000000');
  assert.equal(sells[0].price, 0.99);
  assert.equal(sells[0].size, 7);
  assert.equal(bot.positions.find(position => position.tokenId === sells[0].tokenId).status, 'TAKE_PROFIT');
});

test('an empty live bid is not falsely recorded as a completed $0 sale', async () => {
  const { bot, calls } = makeBot();
  const now = 1_800_000_000_000;
  setBook(bot, 'BTC', 'UP', { bid: 0.30, ask: 0.31, at: now });
  setBook(bot, 'ETH', 'DOWN', { bid: 0.30, ask: 0.31, at: now });
  setBook(bot, 'ETH', 'UP', { bid: 0.49, ask: 0.50, at: now });
  setBook(bot, 'BTC', 'DOWN', { bid: 0.49, ask: 0.50, at: now });
  await bot.evaluateNow(now);

  const position = bot.positions.find(item => item.asset === 'BTC' && item.side === 'UP');
  setBook(bot, 'BTC', 'UP', { bid: null, ask: 0.99, at: now + 1_500 });
  await bot.evaluateNow(now + 1_500);

  assert.equal(position.status, 'OPEN');
  assert.equal(position.stopLossStatus, 'NO_BID_CANNOT_SELL');
  assert.equal(calls.filter(call => call.side === 'SELL').length, 0);
});

test('an uncertain no-ID sell is not blindly duplicated on the next tick', async () => {
  const { bot, calls } = makeBot({
    traderOverrides: {
      async placeTakerOrder(tokenId, side, price, size) {
        calls.push({ tokenId, side, price, size });
        if (side === 'SELL') {
          const error = new Error('sell response timed out');
          error.submissionUncertain = true;
          throw error;
        }
        const id = `exchange-buy-${calls.length}`;
        return { id, status: 'MATCHED' };
      },
      async fetchOrder(id) {
        return { id, status: 'MATCHED', sizeMatched: '7' };
      },
      async getSellableShares(tokenId) {
        return { tokenId, shares: 7 };
      },
    },
  });
  const now = 1_800_000_000_000;
  setBook(bot, 'BTC', 'UP', { bid: 0.29, ask: 0.30, at: now });
  setBook(bot, 'ETH', 'DOWN', { bid: 0.29, ask: 0.30, at: now });
  setBook(bot, 'ETH', 'UP', { bid: 0.49, ask: 0.50, at: now });
  setBook(bot, 'BTC', 'DOWN', { bid: 0.49, ask: 0.50, at: now });
  await bot.evaluateNow(now);

  setBook(bot, 'BTC', 'UP', { bid: 0.55, ask: 0.70, at: now + 1_500 });
  setBook(bot, 'ETH', 'DOWN', { bid: 0.55, ask: 0.53, at: now + 1_500 });
  await bot.evaluateNow(now + 1_500);
  await bot.evaluateNow(now + 3_000);

  const sells = calls.filter(call => call.side === 'SELL');
  assert.equal(sells.length, 2);
  assert.ok(bot.orders.filter(order => order.action.startsWith('SELL'))
    .every(order => order.status === 'SUBMISSION_UNCERTAIN'));
});

test('a strict $0.80 ask-sum boundary does not enter', async () => {
  const { bot, calls } = makeBot();
  const now = 1_800_000_000_000;
  setBook(bot, 'BTC', 'UP', { bid: 0.39, ask: 0.40, at: now });
  setBook(bot, 'ETH', 'DOWN', { bid: 0.39, ask: 0.40, at: now });
  setBook(bot, 'ETH', 'UP', { bid: 0.49, ask: 0.50, at: now });
  setBook(bot, 'BTC', 'DOWN', { bid: 0.49, ask: 0.50, at: now });
  await bot.evaluateNow(now);
  assert.equal(calls.length, 0);
});

test('partial and missing leg fills are recorded from the exchange instead of inventing seven shares', async () => {
  const { bot } = makeBot({
    traderOverrides: {
      fillForOrder({ tokenId }) {
        return tokenId.startsWith('btc-up-') ? 3 : 0;
      },
    },
  });
  const now = 1_800_000_000_000;
  setBook(bot, 'BTC', 'UP', { bid: 0.29, ask: 0.30, at: now });
  setBook(bot, 'ETH', 'DOWN', { bid: 0.38, ask: 0.40, at: now });
  setBook(bot, 'ETH', 'UP', { bid: 0.49, ask: 0.50, at: now });
  setBook(bot, 'BTC', 'DOWN', { bid: 0.49, ask: 0.50, at: now });

  await bot.evaluateNow(now);

  assert.equal(bot.positions.length, 1);
  assert.equal(bot.positions[0].asset, 'BTC');
  assert.equal(bot.positions[0].shares, 3);
  const cycle = bot.cycles[0];
  assert.deepEqual(cycle.legs.map(leg => leg.filledShares), [3, 0]);
});

test('an ended market is checked for resolution immediately, not one full window later', async () => {
  const { bot } = makeBot();
  const now = 1_800_000_000_000;
  bot.marketData.getMarket = async () => ({
    outcomes: ['Up', 'Down'],
    outcomePrices: ['1', '0'],
  });
  bot.positions = [{
    id: 'pending-leg',
    pairId: 'btc-up-eth-down',
    cycleId: 'cycle',
    pairLabel: 'BTC UP + ETH DOWN',
    asset: 'BTC',
    side: 'UP',
    conditionId: 'resolved-condition',
    status: 'PENDING_RESOLUTION',
    shares: 7,
    totalCostEstimate: 2.1,
    entryFeesEstimate: 0,
    realizedPnlEstimate: 0,
  }];

  await bot.resolveDue(now);

  assert.equal(bot.positions[0].status, 'RESOLVED_WIN');
  assert.equal(bot.positions[0].resolutionPayoutEstimate, 7);
  assert.equal(bot.positions[0].realizedPnlEstimate, 4.9);
});
