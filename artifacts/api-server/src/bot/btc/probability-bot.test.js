'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { closedCandleSignal, fixture } = require('./window-test-fixture.cjs');
const { simulateBuy, normalCdf, probabilityUp, estimateLogReturnVolatility } = require('./probability-bot');

test('legacy probability utilities remain correct but are not entry requirements', () => {
  assert.ok(Math.abs(normalCdf(0) - .5) < 1e-6);
  assert.ok(probabilityUp({ openPrice: 100, spotPrice: 101, secondsRemaining: 100, volatility5m: .01 }) > .5);
  assert.equal(estimateLogReturnVolatility([]), null);
});

test('50-share paper buys sweep actual asks, include per-level fees and reject a shortfall', () => {
  const fill = simulateBuy([{ price: .4, size: 20 }, { price: .5, size: 30 }]);
  assert.equal(fill.shares, 50);
  assert.equal(fill.cost, 23);
  assert.ok(Math.abs(fill.fees - .861) < 1e-9);
  assert.equal(simulateBuy([{ price: .4, size: 49 }]), null);
});

for (const [classification, side] of [
  ['SHRINKING_RED', 'UP'], ['SOLID_GREEN', 'UP'],
  ['SHRINKING_GREEN', 'DOWN'], ['SOLID_RED', 'DOWN'],
]) {
  test(`${classification} prior 5m candle: exactly 29 buys of 50 ${side}`, () => {
    const { bot, at } = fixture();
    for (let elapsed = 0; elapsed < 300; elapsed += .5) {
      const now = at(elapsed);
      bot.applyPullbackSignal(closedCandleSignal(classification));
      bot.processSignals(now);
    }
    assert.equal(bot.activeSide, side);
    assert.equal(bot.trades.length, 29);
    assert.equal(bot.trades.reduce((n, t) => n + t.shares, 0), 1450);
    assert.deepEqual([...bot.trades].reverse().map(t => (t.openedAt - bot.market.start) / 1000),
      Array.from({ length: 29 }, (_, i) => 10 + 10 * i));
    assert.ok(bot.trades.every(t => t.side === side && t.shares === 50
      && t.modelProbability === null && t.edgeAtEntry === null && t.entryKind === 'SCHEDULED_MACD'));
    assert.ok(Math.abs(bot.cash - (10000 - bot.trades.reduce((n, t) => n + t.totalCost, 0))) < 1e-8);
  });
}

test('missing probability and strongly negative legacy edge do not block a scheduled entry', () => {
  const { bot, at } = fixture();
  bot.applyPullbackSignal(closedCandleSignal());
  bot.probabilityUp = null;
  bot.edges = { UP: -.99, DOWN: -.99 };
  bot.armed = { UP: false, DOWN: false };
  bot.processSignals(at(10));
  assert.equal(bot.trades.length, 1);
  assert.equal(bot.trades[0].shares, 50);
});

test('one-second polling grace, hard slot boundary and no catch-up bursts', () => {
  const { bot, at } = fixture();
  bot.applyPullbackSignal(closedCandleSignal());
  bot.processSignals(at(9.999));
  bot.processSignals(at(10.5));
  bot.processSignals(at(10.7));
  assert.equal(bot.trades.length, 1);
  bot.processSignals(at(31)); // missed 20 and the 30-second grace period
  assert.equal(bot.trades.length, 1);
  bot.processSignals(at(40));
  bot.processSignals(at(290.5));
  bot.processSignals(at(291));
  bot.processSignals(at(299));
  bot.processSignals(at(300));
  assert.equal(bot.trades.length, 3);
  assert.deepEqual(bot.trades.map(t => t.entrySlot), [28, 3, 0]);
});

test('cash, real depth, fresh book and the existing both-sides price floor remain enforced', () => {
  for (const reason of ['cash', 'depth', 'stale', 'price-floor']) {
    const { bot, at } = fixture();
    bot.applyPullbackSignal(closedCandleSignal());
    const now = at(10);
    if (reason === 'cash') bot.cash = 0;
    if (reason === 'depth') bot.quotes.UP.asks[0].size = 49;
    if (reason === 'stale') bot.quotes.UP.updatedAt -= 5001;
    if (reason === 'price-floor') bot.quotes.DOWN.bestAsk = .019;
    bot.processSignals(now);
    assert.equal(bot.trades.length, 0, reason);
    bot.cash = 10000;
    bot.quotes.UP.asks[0].size = 5000;
    bot.quotes.UP.updatedAt = now;
    bot.quotes.DOWN.bestAsk = .5;
    bot.processSignals(now + 500);
    assert.equal(bot.trades.length, 0, 'blocked slot must not retry');
    bot.processSignals(at(20));
    assert.equal(bot.trades.length, 1);
  }
});

for (const [bid, outcome, price] of [[.99, 'TAKE_PROFIT', 1], [.01, 'STOP_LOSS', 0]]) {
  test(`unchanged ${outcome} exits at ${price} and does not disable later scheduled buys`, () => {
    const { bot, at } = fixture();
    bot.applyPullbackSignal(closedCandleSignal());
    bot.processSignals(at(10));
    bot.processPositionExits(at(121, bid));
    assert.equal(bot.trades[0].finalOutcome, outcome);
    assert.equal(bot.trades[0].exitPrice, price);
    assert.equal(bot.trades[0].status, 'SETTLED');
    assert.equal(bot.activeSide, 'UP');
    bot.processSignals(at(20));
    assert.equal(bot.trades.filter(t => t.status === 'OPEN').length, 1);
  });
}

test('peak bid follows fresh own-side quotes only; stale/missing bids cannot trigger exits', () => {
  const { bot, at } = fixture();
  bot.applyPullbackSignal(closedCandleSignal());
  bot.processSignals(at(10));
  bot.processPositionExits(at(11, .7));
  assert.equal(bot.trades[0].peakBid, .7);
  const now = at(122, .99);
  bot.quotes.UP.updatedAt = now - 6000;
  bot.processPositionExits(now);
  assert.equal(bot.trades[0].status, 'OPEN');
  bot.quotes.UP.bestBid = null;
  bot.processPositionExits(now);
  assert.equal(bot.trades[0].status, 'OPEN');
});

test('window expiry settles using the old market own-side bid, not the BTC price', () => {
  const { bot, at } = fixture();
  bot.applyPullbackSignal(closedCandleSignal());
  bot.processSignals(at(10));
  bot.processPositionExits(at(299, .8));
  bot.processPositionExits(at(300, .1));
  assert.equal(bot.trades[0].finalOutcome, 'WINDOW_PRICE_EXIT');
  assert.equal(bot.trades[0].exitPrice, .8);
  assert.equal(bot.snapshot().paperAccount.positions.UP.shares, 0);
});

test('position accounting includes every open lot even beyond dashboard history length', () => {
  const { bot, at } = fixture();
  bot.applyPullbackSignal(closedCandleSignal());
  bot.processSignals(at(10));
  bot.trades = Array.from({ length: 220 }, (_, i) => ({ ...bot.trades[0], id: 'lot-' + i }));
  const state = bot.snapshot();
  assert.equal(state.trades.length, 50);
  assert.equal(state.paperAccount.positions.UP.shares, 11000);
  assert.equal(state.paperAccount.positions.DOWN.shares, 0);
});
