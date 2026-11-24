'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { LiveCrossPairBot } = require('./live-cross-pair-bot.cjs');

const WINDOW_MS = 300_000;

function makeBot({ traderOverrides = {}, now = 1_800_000_000_000 } = {}) {
  let currentTime = now;
  const saved = [];
  const calls = [];
  const auditRecords = [];
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
    auditLogger: record => auditRecords.push(record),
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
    auditRecords,
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

test('audit stream records entry eligibility transitions without order or account secrets', () => {
  const { bot, calls, auditRecords, setNow } = makeBot();
  const start = bot.windowStart;
  setBook(bot, 'BTC', 'UP', { bid: 0.29, ask: 0.30, at: start });
  setBook(bot, 'ETH', 'DOWN', { bid: 0.39, ask: 0.40, at: start });
  setBook(bot, 'ETH', 'UP', { bid: 0.49, ask: 0.50, at: start });
  setBook(bot, 'BTC', 'DOWN', { bid: 0.49, ask: 0.50, at: start });
  bot.liveAccount.accountReady = false;

  bot.auditPairEvaluations(start);
  const evaluations = auditRecords.filter(record => record.type === 'PAIR_EVALUATION');
  const qualified = evaluations.find(record => record.pairId === 'btc-up-eth-down');
  assert.equal(qualified.askSum, 0.7);
  assert.equal(qualified.entryConditionMet, true);
  assert.equal(qualified.entryEligible, false);
  assert.equal(qualified.gateReason, 'ACCOUNT_NOT_READY');
  assert.equal(qualified.legs[0].marketId, `btc-${start}`);
  assert.equal(JSON.stringify(auditRecords).includes(`btc-up-${start}`), false);
  assert.equal(JSON.stringify(auditRecords).includes('tokenId'), false);
  assert.equal(JSON.stringify(auditRecords).includes('exchange-'), false);
  assert.equal(JSON.stringify(auditRecords).includes('collateral'), false);
  assert.equal(calls.length, 0);

  setNow(start + 1_000);
  bot.auditPairEvaluations(start + 1_000);
  assert.equal(auditRecords.filter(record => record.type === 'PAIR_EVALUATION').length, 2);

  setNow(start + 5_000);
  bot.auditPairEvaluations(start + 5_000);
  assert.equal(auditRecords.filter(record => record.type === 'PAIR_EVALUATION').length, 4);

  setBook(bot, 'BTC', 'UP', {
    bid: 0.44, ask: 0.45, at: start + 5_500,
  });
  setBook(bot, 'ETH', 'DOWN', {
    bid: 0.39, ask: 0.40, at: start + 5_500,
  });
  setNow(start + 5_500);
  bot.auditPairEvaluations(start + 5_500);
  assert.equal(auditRecords.filter(record => record.type === 'PAIR_EVALUATION').length, 4);

  setBook(bot, 'BTC', 'UP', {
    bid: 0.44, ask: 0.45, at: start + 10_000,
  });
  setBook(bot, 'ETH', 'DOWN', {
    bid: 0.39, ask: 0.40, at: start + 10_000,
  });
  setNow(start + 10_000);
  bot.auditPairEvaluations(start + 10_000);
  const last = auditRecords.filter(record => record.type === 'PAIR_EVALUATION')
    .findLast(record => record.pairId === 'btc-up-eth-down');
  assert.equal(last.askSum, 0.85);
  assert.equal(last.entryConditionMet, false);
  assert.equal(last.gateReason, 'ASK_SUM_NOT_BELOW_0_80');
  assert.equal(calls.length, 0);
});

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
  const { bot, calls, saved, auditRecords } = makeBot();
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
  const results = auditRecords.filter(record => record.type === 'ORDER_RESULT');
  assert.equal(results.length, 2);
  assert.ok(results.every(record => record.matchedShares === 7));
  assert.ok(results.every(record => !Object.hasOwn(record, 'orderId')));
  assert.ok(results.every(record => !Object.hasOwn(record, 'tokenId')));
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

test('a $0.99 bid does not sell a leg without the first-pair combined exit', async () => {
  const { bot, calls } = makeBot();
  const now = 1_800_000_000_000;
  setBook(bot, 'BTC', 'UP', { bid: 0.30, ask: 0.31, at: now });
  setBook(bot, 'ETH', 'DOWN', { bid: 0.30, ask: 0.31, at: now });
  setBook(bot, 'ETH', 'UP', { bid: 0.49, ask: 0.50, at: now });
  setBook(bot, 'BTC', 'DOWN', { bid: 0.49, ask: 0.50, at: now });
  await bot.evaluateNow(now);

  setBook(bot, 'BTC', 'UP', { bid: 0.99, ask: 0.99, at: now + 1_500 });
  setBook(bot, 'ETH', 'DOWN', { bid: 0.09, ask: 0.10, at: now + 1_500 });
  await bot.evaluateNow(now + 1_500);

  const sells = calls.filter(call => call.side === 'SELL');
  assert.equal(sells.length, 0);
  assert.ok(bot.positions.every(position => position.status === 'OPEN'));
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
  assert.equal(position.stopLossStatus, undefined);
  assert.equal(calls.filter(call => call.side === 'SELL').length, 0);
});

for (const firstPairId of ['btc-up-eth-down', 'eth-up-btc-down']) {
  test(`only the first triggered pair exits, including after restore: ${firstPairId}`, async () => {
    const { bot } = makeBot();
    const now = bot.windowStart;
    const pairs = require('./live-cross-pair-bot.cjs')._test.PAIRS;
    const first = pairs.find(pair => pair.id === firstPairId);
    const second = pairs.find(pair => pair.id !== firstPairId);
    for (const leg of second.legs) {
      setBook(bot, leg.asset, leg.side, { bid: 0.49, ask: 0.50, at: now });
    }
    await bot.evaluateNow(now);
    assert.equal(bot.cycles.length, 1);
    assert.equal(bot.cycles[0].pairId, firstPairId);
    for (const leg of second.legs) {
      setBook(bot, leg.asset, leg.side, { bid: 0.29, ask: 0.30, at: now + 100 });
    }
    await bot.evaluateNow(now + 100);
    assert.equal(bot.cycles.length, 2);
    assert.equal(bot.cycles.find(cycle => cycle.pairId === firstPairId).entryOrdinal, 1);
    assert.equal(bot.cycles.find(cycle => cycle.pairId === second.id).entryOrdinal, 2);

    const restored = makeBot();
    restored.bot.restoreState(bot.persistentStateSnapshot());
    const secondCycle = restored.bot.cycles.find(cycle => cycle.pairId === second.id);
    // Even a persisted legacy sell flag must not authorize selling pair two.
    secondCycle.reverseExitTriggeredAt = now + 100;
    for (const leg of second.legs) {
      setBook(restored.bot, leg.asset, leg.side, { bid: 0.99, ask: 0.99, at: now + 1_500 });
    }
    for (const leg of first.legs) {
      setBook(restored.bot, leg.asset, leg.side, { bid: 0.60, ask: 0.61, at: now + 1_500 });
    }
    await restored.bot.evaluateNow(now + 1_500);
    assert.equal(restored.calls.length, 0, 'exactly $1.22 is not above the exit threshold');
    setBook(restored.bot, first.legs[0].asset, first.legs[0].side,
      { bid: 0.61, ask: 0.62, at: now + 1_600 });
    await restored.bot.evaluateNow(now + 1_600);
    assert.equal(restored.calls.length, 2);
    assert.ok(restored.calls.every(call => call.side === 'SELL'
      && first.legs.some(leg => call.tokenId === restored.bot.marketContexts.get(leg.asset).tokens[leg.side])));
    assert.ok(restored.bot.positions.filter(position => position.cycleId === secondCycle.id)
      .every(position => position.status === 'OPEN'));

    // Existing ledgers without ordinals retain their chronological roles.
    for (const cycle of restored.bot.cycles) delete cycle.entryOrdinal;
    assert.equal(restored.bot.isFirstTriggeredPair(secondCycle), false);
    assert.equal(restored.bot.isFirstTriggeredPair(
      restored.bot.cycles.find(cycle => cycle.pairId === firstPairId)), true);
    const nextWindow = now + WINDOW_MS;
    await restored.bot.advanceWindow(nextWindow);
    restored.bot.earliestTradableWindowStart = nextWindow;
    await restored.bot.loadCurrentMarkets(nextWindow, nextWindow);
    // Trigger directly with a fresh preview to verify window-local rank reset.
    const quote = { askSum: 0.60, legs: second.legs.map(leg => ({
      ...leg, tokenId: restored.bot.marketContexts.get(leg.asset).tokens[leg.side],
      asks: [{ price: 0.30, size: 100 }],
    })) };
    await restored.bot.enterPair(second, quote, nextWindow);
    assert.equal(restored.bot.cycles[0].entryOrdinal, 1);
    assert.equal(restored.bot.isFirstTriggeredPair(restored.bot.cycles[0]), true);
  });
}

test('same-tick pair triggers retain first/second roles in older ledgers', async () => {
  const { bot } = makeBot();
  await bot.evaluateNow(bot.windowStart);
  assert.equal(bot.cycles.length, 2);
  for (const cycle of bot.cycles) delete cycle.entryOrdinal;
  assert.equal(bot.isFirstTriggeredPair(bot.cycles[1]), true);
  assert.equal(bot.isFirstTriggeredPair(bot.cycles[0]), false);
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
  const { bot, auditRecords } = makeBot();
  const now = 1_800_000_000_000;
  const marketLookups = [];
  bot.marketData.getMarket = async marketId => {
    marketLookups.push(marketId);
    return {
      id: marketId,
      conditionId: 'resolved-condition',
      outcomes: ['Up', 'Down'],
      outcomePrices: ['1', '0'],
    };
  };
  bot.positions = [{
    id: 'pending-leg',
    pairId: 'btc-up-eth-down',
    cycleId: 'cycle',
    pairLabel: 'BTC UP + ETH DOWN',
    asset: 'BTC',
    side: 'UP',
    marketId: '7279144',
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
  assert.deepEqual(marketLookups, ['7279144']);
  assert.ok(auditRecords.some(record => record.type === 'RESOLUTION_CHECK'
    && record.marketId === '7279144' && record.conditionId === 'resolved-condition'
    && record.status === 'RESOLVED'));
  assert.ok(auditRecords.some(record => record.type === 'RESOLUTION_POSITION_RESULT'
    && record.result === 'WIN' && record.payoutEstimate === 7
    && record.pnlBasis.includes('not confirmed collateral redemption')));
});
