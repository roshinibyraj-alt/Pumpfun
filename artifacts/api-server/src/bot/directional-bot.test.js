'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const Bot = require('./directional-bot');

class FakeTrader {
  constructor(asks = {}) {
    this.demoMode = true;
    this.asks = { up: 0.5, down: 0.5, ...asks };
    this.executionOrder = [];
    this.holdFirstOrder = false;
    this.firstOrderStarted = null;
    this.releaseFirstOrder = null;
  }

  async getOrderBook(tokenId) {
    const ask = this.asks[tokenId];
    return {
      asks: [{ price: String(ask), size: '1000' }],
      bids: [{ price: String(Math.max(0.01, ask - 0.01)), size: '1000' }],
    };
  }

  async placeFakMarketOrder(tokenId, side, _amount, options = {}) {
    const orderNumber = this.executionOrder.length;
    this.executionOrder.push({ tokenId, side });
    if (this.holdFirstOrder && orderNumber === 0) {
      this.firstOrderStarted();
      await new Promise((resolve) => { this.releaseFirstOrder = resolve; });
    }
    const shares = Number(options.targetShares) || 100;
    const notional = shares * this.asks[tokenId];
    return {
      id: 'test-' + orderNumber,
      status: 'matched',
      isFilled: true,
      avgPrice: this.asks[tokenId],
      raw: { takingAmount: String(shares), makingAmount: String(notional) },
    };
  }

  async getBalance() { return null; }
}

function makeBot(asks) {
  const trader = new FakeTrader(asks);
  const feed = { exchangeId: 'coinbase', symbol: 'BTC/USD', pollMs: 500 };
  const bot = new Bot(trader, { ccxtFeed: feed });
  const openTs = Math.floor(Date.now() / 1000) - 30;
  bot.w = Bot.makeWindowState('btc-updown-5m-' + openTs, openTs);
  bot.w.window = {
    slug: bot.w.slug,
    tokenUp: 'up',
    tokenDown: 'down',
    openTs,
    closeTs: openTs + 300,
  };
  bot.w.status = 'watching_signal';
  return { bot, trader };
}

function move(side, ts = Date.now()) {
  return {
    changeUsd: side === 'UP' ? 2 : -2,
    thresholdUsd: 1,
    lookbackMs: 1000,
    receivedAt: ts,
  };
}

test('ask band is inclusive, positions accumulate without a window cap, and both sides coexist', async () => {
  const { bot, trader } = makeBot({ up: 0.2, down: 0.8 });

  assert.equal(await bot._buyPosition(bot.w, 'UP', move('UP')), true);
  assert.equal(await bot._buyPosition(bot.w, 'DOWN', move('DOWN')), true);

  trader.asks.up = 0.5;
  for (let i = 0; i < 7; i += 1) {
    assert.equal(await bot._buyPosition(bot.w, 'UP', move('UP')), true);
  }

  assert.equal(bot.w.entriesThisWindow, 9);
  assert.deepEqual(bot.pending.map((position) => position.side), [
    'UP', 'DOWN', 'UP', 'UP', 'UP', 'UP', 'UP', 'UP', 'UP',
  ]);

  trader.asks.up = 0.19;
  trader.asks.down = 0.81;
  assert.equal(await bot._buyPosition(bot.w, 'UP', move('UP')), false);
  assert.equal(await bot._buyPosition(bot.w, 'DOWN', move('DOWN')), false);
  assert.equal(bot.pending.length, 9);
});

test('signals accepted at least ten seconds apart queue during an order in poll order', async () => {
  const { bot, trader } = makeBot();
  bot._running = true;
  trader.holdFirstOrder = true;
  const realNow = Date.now;
  let fakeNow = realNow();
  Date.now = () => fakeNow;
  let markFirstOrderStarted;
  const firstOrderStarted = new Promise((resolve) => { markFirstOrderStarted = resolve; });
  trader.firstOrderStarted = markFirstOrderStarted;

  try {
    const firstPoll = bot._handleSignal('UP', move('UP', fakeNow));
    await firstOrderStarted;
    fakeNow += 10_000;
    await bot._handleSignal('DOWN', move('DOWN', fakeNow));
    fakeNow += 10_000;
    await bot._handleSignal('UP', move('UP', fakeNow));

    assert.equal(trader.executionOrder.length, 1);
    trader.releaseFirstOrder();
    await firstPoll;

    assert.deepEqual(trader.executionOrder.map((order) => order.tokenId), ['up', 'down', 'up']);
    assert.equal(bot.pending.length, 3);
    assert.equal(bot.w.entriesThisWindow, 3);
  } finally {
    Date.now = realNow;
  }
});

test('signal cooldown skips either side until ten seconds have elapsed', async () => {
  const { bot, trader } = makeBot();
  bot._running = true;
  const realNow = Date.now;
  let fakeNow = realNow();
  Date.now = () => fakeNow;

  try {
    await bot._handleSignal('UP', move('UP', fakeNow));
    assert.deepEqual(trader.executionOrder.map((order) => order.tokenId), ['up']);

    fakeNow += 4_000;
    await bot._handleSignal('DOWN', move('DOWN', fakeNow));
    fakeNow += 5_999;
    await bot._handleSignal('UP', move('UP', fakeNow));
    assert.deepEqual(trader.executionOrder.map((order) => order.tokenId), ['up']);
    assert.equal(bot.log.filter((entry) => entry.event === 'SIGNAL_COOLDOWN').length, 1);

    fakeNow += 1;
    await bot._handleSignal('DOWN', move('DOWN', fakeNow));
    assert.deepEqual(trader.executionOrder.map((order) => order.tokenId), ['up', 'down']);
    assert.equal(bot.log.filter((entry) => entry.event === 'SIGNAL_FIRED').length, 2);
  } finally {
    Date.now = realNow;
  }
});

test('each simultaneous position settles independently at the existing CLOB thresholds', async () => {
  const { bot } = makeBot();
  await bot._buyPosition(bot.w, 'UP', move('UP'));
  await bot._buyPosition(bot.w, 'DOWN', move('DOWN'));

  assert.equal(bot._settlePositionAtClobPrice(bot.pending[0], 0.99, 0.98), true);
  assert.equal(bot._settlePositionAtClobPrice(bot.pending[0], 0.02, 0.01), true);

  assert.equal(bot.pending.length, 0);
  assert.deepEqual(bot.trades.map((trade) => trade.outcome), ['WIN', 'LOSS']);
  assert.deepEqual(bot.trades.map((trade) => trade.winner), ['UP', 'UP']);
});