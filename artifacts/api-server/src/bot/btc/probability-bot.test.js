'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, START } = require('./window-test-fixture.cjs');
const { simulateBuy, normalCdf, probabilityUp, estimateLogReturnVolatility } = require('./probability-bot');
const { METHOD: SIGNAL_METHOD } = require('./technical-signal');

function technicalSignal(side) {
  return {
    method: SIGNAL_METHOD,
    timeframe: '5m',
    status: 'READY',
    side,
    setup: 'DIRECTIONAL_FALLBACK',
    confirmed: false,
    regime: 'MIXED',
    score: null,
    fallbackRule: '15M_EMA200_TREND',
    signalAt: START,
    reason: `Fallback selected ${side}.`,
  };
}

test('legacy probability utilities remain correct but are not entry requirements', () => {
  assert.ok(Math.abs(normalCdf(0) - .5) < 1e-6);
  assert.ok(probabilityUp({ openPrice: 100, spotPrice: 101, secondsRemaining: 100, volatility5m: .01 }) > .5);
  assert.equal(estimateLogReturnVolatility([]), null);
});

test('500-share paper buys sweep actual asks, include fees and reject a shortfall', () => {
  const fill = simulateBuy([{ price: .4, size: 200 }, { price: .5, size: 300 }]);
  assert.equal(fill.shares, 500);
  assert.equal(fill.cost, 230);
  assert.ok(fill.fees > 0);
  assert.equal(simulateBuy([{ price: .4, size: 499 }]), null);
});

for (const side of ['UP', 'DOWN']) {
  test(`a valid ${side} technical signal enables four 500-share minute checkpoints`, () => {
    const { bot, at } = fixture();
    bot.applyTechnicalSignal(technicalSignal(side));
    for (const seconds of [60, 120, 180, 240]) {
      bot.processSignals(at(seconds, .4, .3));
    }
    assert.equal(bot.activeSide, side);
    assert.equal(bot.trades.length, 4);
    assert.equal(bot.trades.reduce((n, t) => n + t.shares, 0), 2000);
    assert.deepEqual([...bot.trades].reverse().map(t => (t.openedAt - bot.market.start) / 1000),
      [60, 120, 180, 240]);
    assert.ok(bot.trades.every(t => t.side === side && t.shares === 500
      && t.modelProbability === null && t.edgeAtEntry === null && t.entryKind === 'SCHEDULED_SIGNAL'));
    assert.ok(Math.abs(bot.cash - (10000 - bot.trades.reduce((n, t) => n + t.totalCost, 0))) < 1e-8);
  });
}

test('price-filtered shares accumulate and join the next qualifying checkpoint', () => {
  const { bot, at } = fixture();
  bot.applyTechnicalSignal(technicalSignal('UP'));
  bot.processSignals(at(60, .4, .40));
  assert.equal(bot.trades.length, 0);
  assert.equal(bot.pendingPriceFilteredShares, 500);
  bot.processSignals(at(120, .4, .59));
  assert.equal(bot.trades.length, 1);
  assert.equal(bot.trades[0].shares, 1000);
  assert.equal(bot.trades[0].priceFilteredSharesIncluded, 500);
  assert.equal(bot.pendingPriceFilteredShares, 0);
});

test('price-filter carry resets at a new window and non-price blocks do not add carry', () => {
  const { bot, at } = fixture();
  bot.applyTechnicalSignal(technicalSignal('UP'));
  bot.processSignals(at(60, .4, .5));
  assert.equal(bot.pendingPriceFilteredShares, 500);
  bot.market = {
    ...bot.market,
    start: START + 300_000,
    end: START + 600_000,
  };
  bot.beginMarketWindow();
  assert.equal(bot.pendingPriceFilteredShares, 0);

  const next = START + 360_000;
  bot.quotes.UP = bot.quote({
    bids: [{ price: .4, size: 5000 }],
    asks: [{ price: .3, size: 5000 }],
  }, next);
  bot.cash = 0;
  bot.applyTechnicalSignal(technicalSignal('UP'));
  bot.processSignals(next);
  assert.equal(bot.trades.length, 0);
  assert.equal(bot.pendingPriceFilteredShares, 0);
});

test('checkpoint limits are strict and each minute slot can only be attempted once', () => {
  const { bot, at } = fixture();
  bot.applyTechnicalSignal(technicalSignal('UP'));
  bot.processSignals(at(59.999, .4, .3));
  bot.processSignals(at(60.5, .4, .40)); // Equal to the cap is filtered.
  assert.equal(bot.trades.length, 0);
  assert.equal(bot.pendingPriceFilteredShares, 500);
  bot.processSignals(at(61, .4, .3)); // No retry of the already checked minute.
  assert.equal(bot.trades.length, 0);
  assert.equal(bot.pendingPriceFilteredShares, 500);
  bot.processSignals(at(120.5, .4, .59));
  assert.equal(bot.trades.length, 1);
  assert.deepEqual(bot.trades.map(t => t.entrySlot), [1]);
  assert.equal(bot.trades[0].shares, 1000);
});

test('cash, real depth, fresh book and the existing both-sides price floor remain enforced', () => {
  for (const reason of ['cash', 'depth', 'stale', 'price-floor']) {
    const { bot, at } = fixture();
    bot.applyTechnicalSignal(technicalSignal('UP'));
    const now = at(60, .4, .3);
    if (reason === 'cash') bot.cash = 0;
    if (reason === 'depth') bot.quotes.UP.asks[0].size = 499;
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
    bot.processSignals(at(120, .4, .3));
    assert.equal(bot.trades.length, 1);
  }
});

for (const [bid, outcome, price] of [[.99, 'TAKE_PROFIT', 1], [.01, 'STOP_LOSS', 0]]) {
  test(`${outcome} stays blocked before 295 seconds, then exits on a fresh own-side bid`, () => {
    const { bot, at } = fixture();
    assert.equal(bot.snapshot().strategy.exitStartSeconds, 295);
    bot.applyTechnicalSignal(technicalSignal('UP'));
    bot.processSignals(at(60, .4, .3));
    bot.processSignals(at(120, .4, .3));
    bot.processPositionExits(at(121, bid));
    bot.processPositionExits(at(294.999, bid));
    assert.equal(bot.trades.length, 2, 'scheduled entries remain available before the exit window');
    assert.ok(bot.trades.every(trade => trade.status === 'OPEN'));
    bot.processPositionExits(at(295, bid));
    assert.ok(bot.trades.every(trade => trade.finalOutcome === outcome));
    assert.ok(bot.trades.every(trade => trade.exitPrice === price));
    assert.ok(bot.trades.every(trade => trade.status === 'SETTLED'));
    assert.equal(bot.activeSide, 'UP');
  });
}

test('missing or stale bid at the 295-second gate holds positions until a fresh bid arrives', () => {
  const { bot, at } = fixture();
  bot.applyTechnicalSignal(technicalSignal('UP'));
  bot.processSignals(at(60, .4, .3));

  const missingBidAt = at(295, .99);
  bot.quotes.UP.bestBid = null;
  bot.quotes.UP.midPrice = .99;
  bot.quotes.UP.updatedAt = missingBidAt;
  bot.processPositionExits(missingBidAt);
  assert.equal(bot.trades[0].status, 'OPEN', 'ask/mid data cannot substitute for a missing bid');

  const staleBidAt = at(296, .01);
  bot.quotes.UP.bestBid = .01;
  bot.quotes.UP.updatedAt = staleBidAt - 6000;
  bot.processPositionExits(staleBidAt);
  assert.equal(bot.trades[0].status, 'OPEN', 'a stale bid cannot trigger the stop loss');

  const freshBidAt = at(297, .99);
  bot.quotes.UP.bestBid = .99;
  bot.quotes.UP.updatedAt = freshBidAt;
  bot.processPositionExits(freshBidAt);
  assert.equal(bot.trades[0].finalOutcome, 'TAKE_PROFIT');
  assert.equal(bot.trades[0].status, 'SETTLED');
});

test('peak bid follows fresh own-side quotes only; stale/missing bids cannot trigger exits', () => {
  const { bot, at } = fixture();
  bot.applyTechnicalSignal(technicalSignal('UP'));
  bot.processSignals(at(60, .4, .3));
  bot.processPositionExits(at(61, .7));
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
  bot.applyTechnicalSignal(technicalSignal('UP'));
  bot.processSignals(at(60, .4, .3));
  bot.processPositionExits(at(299, .8));
  bot.processPositionExits(at(300, .1));
  assert.equal(bot.trades[0].finalOutcome, 'WINDOW_PRICE_EXIT');
  assert.equal(bot.trades[0].exitPrice, .8);
  assert.equal(bot.snapshot().paperAccount.positions.UP.shares, 0);
});

test('completed traded-window results persist only after all positions settle', async () => {
  const persisted = [];
  const store = {
    recordEvent: async () => {},
    recordWindowResult: async result => persisted.push(result),
    recordEquitySnapshot: async () => {},
  };
  const { bot, at } = fixture({ learningStore: store });
  bot.applyTechnicalSignal(technicalSignal('UP'));
  bot.processSignals(at(60, .4, .3));
  bot.processPositionExits(at(299, .8, .3));
  bot.processPositionExits(at(300, .1, .3));
  bot.maybeFinalizeCompletedWindows(START + 300_000);
  await bot.persistenceQueue;
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].windowStart, START);
  assert.equal(persisted[0].tradeCount, 1);
  assert.equal(persisted[0].outcome, 'WIN');
  assert.ok(persisted[0].netPnl > 0);
});

test('account equity includes fresh marked positions and is unavailable on stale marks', () => {
  const { bot, at } = fixture();
  bot.applyTechnicalSignal(technicalSignal('UP'));
  const now = at(60, .4, .3);
  bot.processSignals(now);
  const freshAccount = bot.snapshot().paperAccount;
  assert.ok(freshAccount.equity > freshAccount.cash);
  assert.equal(freshAccount.equityMarkStatus, 'FRESH');
  bot.quotes.UP.updatedAt = now - 6000;
  const staleAccount = bot.snapshot().paperAccount;
  assert.equal(staleAccount.equity, null);
  assert.equal(staleAccount.equityMarkStatus, 'WAITING_FOR_FRESH_MARKS');
});

test('position accounting includes every open lot even beyond dashboard history length', () => {
  const { bot, at } = fixture();
  bot.applyTechnicalSignal(technicalSignal('UP'));
  bot.processSignals(at(60, .4, .3));
  bot.trades = Array.from({ length: 220 }, (_, i) => ({ ...bot.trades[0], id: 'lot-' + i }));
  const state = bot.snapshot();
  assert.equal(state.trades.length, 50);
  assert.equal(state.paperAccount.positions.UP.shares, 110000);
  assert.equal(state.paperAccount.positions.DOWN.shares, 0);
});

test('realized P&L reconciles to cash after settled trade details are pruned', () => {
  const { bot } = fixture();
  for (let index = 0; index < 205; index++) {
    const trade = {
      id: `settled-${index}`, status: 'OPEN', side: 'UP',
      shares: 1, totalCost: 1,
    };
    bot.cash -= trade.totalCost;
    bot.closeTrade(trade, 0, 0, 'STOP_LOSS', 'test exit', START, 0, 0);
    bot.trades.unshift(trade);
  }
  bot.trades = bot.trades.slice(0, 200);

  const openTrade = {
    id: 'open-lot', marketId: 'm', status: 'OPEN', side: 'DOWN',
    shares: 50, totalCost: 50, openedAt: START,
  };
  bot.cash -= openTrade.totalCost;
  bot.trades.unshift(openTrade);

  const account = bot.snapshot().paperAccount;
  assert.equal(account.cash, 9745);
  assert.equal(account.openCost, 50);
  assert.equal(account.realizedPnl, -205);
  assert.equal(account.settled, 205);
  assert.equal(account.wins, 0);
  assert.equal(account.losses, 205);
  assert.equal(account.openPositions, 1);
  assert.equal(account.positions.UP.realizedPnl, -205);
  assert.equal(account.positions.DOWN.realizedPnl, 0);
});
