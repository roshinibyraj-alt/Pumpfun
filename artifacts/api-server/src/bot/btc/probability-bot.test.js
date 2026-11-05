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
    setup: side === 'UP' ? 'PREVIOUS_GREEN' : 'PREVIOUS_RED',
    confirmed: true,
    signalAt: START,
    reason: `${side} selected by the previous closed candle.`,
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
  test(`a valid ${side} closed-candle signal buys at the first qualifying tick in each minute stage`, () => {
    const { bot, at } = fixture();
    bot.applyTechnicalSignal(technicalSignal(side));
    for (const seconds of [1, 61, 121, 181]) {
      bot.processSignals(at(seconds, .4, .3));
    }
    assert.equal(bot.activeSide, side);
    assert.equal(bot.trades.length, 4);
    assert.equal(bot.trades.reduce((n, t) => n + t.shares, 0), 2000);
    assert.deepEqual([...bot.trades].reverse().map(t => (t.openedAt - bot.market.start) / 1000),
      [1, 61, 121, 181]);
    assert.ok(bot.trades.every(t => t.side === side && t.shares === 500
      && t.modelProbability === null && t.edgeAtEntry === null && t.entryKind === 'SCHEDULED_SIGNAL'));
    assert.ok(Math.abs(bot.cash - (10000 - bot.trades.reduce((n, t) => n + t.totalCost, 0))) < 1e-8);
  });
}

test('price-filtered shares accumulate at stage end and join the next qualifying stage', () => {
  const { bot, at } = fixture();
  bot.applyTechnicalSignal(technicalSignal('UP'));
  bot.processSignals(at(1, .4, .40));
  assert.equal(bot.trades.length, 0);
  assert.equal(bot.pendingPriceFilteredShares, 0, 'carry is added when the stage ends');
  bot.processSignals(at(60.5, .4, .40));
  assert.equal(bot.pendingPriceFilteredShares, 0);
  bot.processSignals(at(61, .4, .59));
  assert.equal(bot.trades.length, 1);
  assert.equal(bot.trades[0].shares, 1000);
  assert.equal(bot.trades[0].priceFilteredSharesIncluded, 500);
  assert.equal(bot.pendingPriceFilteredShares, 0);
});

test('price-filter carry resets at a new window and non-price blocks do not add carry', () => {
  const { bot, at } = fixture();
  bot.applyTechnicalSignal(technicalSignal('UP'));
  bot.processSignals(at(1, .4, .5));
  bot.processSignals(at(61, .4, .60));
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

test('each stage keeps checking after a price-filter tick and fires once when the ask drops below its cap', () => {
  const { bot, at } = fixture();
  bot.applyTechnicalSignal(technicalSignal('UP'));
  bot.processSignals(at(.5, .4, .3));
  assert.equal(bot.trades.length, 0);
  bot.processSignals(at(1, .4, .40)); // Equal to the cap is filtered.
  assert.equal(bot.trades.length, 0);
  bot.processSignals(at(30, .4, .40));
  assert.equal(bot.trades.length, 0);
  bot.processSignals(at(30.5, .4, .399));
  assert.equal(bot.trades.length, 1);
  assert.equal(bot.trades[0].entrySlot, 0);
  assert.equal(bot.trades[0].shares, 500);
  bot.processSignals(at(45, .4, .30));
  assert.equal(bot.trades.length, 1, 'a stage cannot fire twice');
  bot.processSignals(at(61, .4, .60)); // Equal to the next cap is also filtered.
  assert.equal(bot.trades.length, 1);
  bot.processSignals(at(120.5, .4, .60));
  assert.equal(bot.trades.length, 1);
  bot.processSignals(at(121, .4, .69));
  assert.equal(bot.trades.length, 2);
  assert.equal(bot.trades[0].entrySlot, 2);
  assert.equal(bot.trades[0].shares, 1000, 'missed shares carry to the next qualifying stage');
});

test('cash, real depth, fresh book and the existing both-sides price floor remain enforced', () => {
  for (const reason of ['cash', 'depth', 'stale', 'price-floor']) {
    const { bot, at } = fixture();
    bot.applyTechnicalSignal(technicalSignal('UP'));
    const now = at(1, .4, .3);
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
    if (reason === 'stale') {
      assert.equal(bot.trades.length, 1, 'a stale quote can recover during the active stage');
      continue;
    }
    assert.equal(bot.trades.length, 0, 'a qualified stage is not retried after another execution gate blocks it');
    bot.processSignals(at(61, .4, .3));
    assert.equal(bot.trades.length, 1);
  }
});

test('take-profit at 0.99 closes during the active window and credits one dollar per share', () => {
  const { bot, at } = fixture();
  bot.applyTechnicalSignal(technicalSignal('UP'));
  bot.processSignals(at(1, .4, .3));
  bot.processSignals(at(61, .4, .3));
  bot.processPositionExits(at(121, .99));
  assert.ok(bot.trades.every(trade => trade.finalOutcome === 'TAKE_PROFIT'));
  assert.ok(bot.trades.every(trade => trade.exitPrice === 1));
  assert.ok(bot.trades.every(trade => trade.grossPayout === trade.shares));
  assert.ok(bot.trades.every(trade => trade.status === 'SETTLED'));
});

test('stop-loss remains blocked before 295 seconds and exits on a fresh own-side bid after', () => {
  const { bot, at } = fixture();
  bot.applyTechnicalSignal(technicalSignal('UP'));
  bot.processSignals(at(1, .4, .3));
  bot.processPositionExits(at(121, .01));
  bot.processPositionExits(at(294.999, .01));
  assert.equal(bot.trades[0].status, 'OPEN');
  bot.processPositionExits(at(295, .01));
  assert.equal(bot.trades[0].finalOutcome, 'STOP_LOSS');
  assert.equal(bot.trades[0].exitPrice, 0);
  assert.equal(bot.trades[0].status, 'SETTLED');
});

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

test('window expiry holds unsold trades for resolution and excludes them from active accumulation', () => {
  const { bot, at } = fixture();
  bot.applyTechnicalSignal(technicalSignal('UP'));
  bot.processSignals(at(60, .4, .3));
  bot.processPositionExits(at(299, .8));
  bot.processPositionExits(at(300, .1));
  assert.equal(bot.trades[0].status, 'OPEN');
  assert.equal(bot.trades[0].settlementStatus, 'AWAITING_SETTLEMENT');
  assert.equal(bot.trades[0].finalOutcome, undefined);
  assert.equal(bot.snapshot().paperAccount.positions.UP.shares, 0);
  assert.equal(bot.snapshot().paperAccount.awaitingSettlement, 1);
  assert.equal(bot.snapshot().paperAccount.activeWindowPositions, 0);
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
  assert.equal(bot.trades[0].settlementStatus, 'AWAITING_SETTLEMENT');
  bot.closeTrade(
    bot.trades[0], 1, bot.trades[0].shares, 'MARKET_RESOLUTION',
    'Test confirmed original-market resolution.', START + 300_000, 1, 0,
  );
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

test('active accumulation includes only current-window lots while pending-resolution shares stay separate', () => {
  const { bot, at } = fixture();
  bot.applyTechnicalSignal(technicalSignal('UP'));
  bot.processSignals(at(60, .4, .3));
  const currentTrade = bot.trades[0];
  bot.trades.push({
    ...currentTrade,
    id: 'expired-pending-lot',
    marketId: 'old-market',
    windowStart: START - 300_000,
    windowEnd: START,
    shares: 120,
    totalCost: 60,
    settlementStatus: 'AWAITING_SETTLEMENT',
  });

  const account = bot.snapshot().paperAccount;
  assert.equal(account.openPositions, 2);
  assert.equal(account.activeWindowPositions, 1);
  assert.equal(account.awaitingSettlement, 1);
  assert.equal(account.awaitingSettlementShares, 120);
  assert.equal(account.positions.UP.shares, 500);
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

function setMidpointBooks(bot, at, { upBid, upAsk, upSize = 500, downBid, downAsk, downSize = 500 }) {
  bot.quotes = {
    UP: bot.quote({ bids: [{ price: upBid, size: upSize }], asks: [{ price: upAsk, size: upSize }] }, at),
    DOWN: bot.quote({ bids: [{ price: downBid, size: downSize }], asks: [{ price: downAsk, size: downSize }] }, at),
  };
}

test('first-phase scheduled taker buys choose the lower best ask at each checkpoint', () => {
  const { bot, start } = fixture();
  const firstAt = start + 3_000;
  setMidpointBooks(bot, firstAt, { upBid: .28, upAsk: .30, downBid: .68, downAsk: .70 });
  bot.processScheduledTakerOrder(firstAt);
  bot.processScheduledTakerOrder(firstAt + 500);
  assert.equal(bot.takerOrders.length, 1);
  assert.equal(bot.takerOrders[0].phase, 'FIRST');
  assert.equal(bot.takerOrders[0].orderType, 'MARKET');
  assert.equal(bot.takerOrders[0].side, 'UP');
  assert.equal(bot.takerOrders[0].sideSelectionPolicy, 'LOWER_ASK');
  assert.equal(bot.takerOrders[0].requestedShares, 50);
  assert.equal(bot.takerOrders[0].filledShares, 50);
  assert.equal(bot.takerOrders[0].averageFillPrice, .30);
  assert.equal(bot.trades[0].entryKind, 'SCHEDULED_TAKER');
  assert.equal(bot.snapshot().paperAccount.openOrders, 0);
  assert.equal(bot.snapshot().openOrders.length, 0);

  const secondAt = start + 6_000;
  setMidpointBooks(bot, secondAt, { upBid: .68, upAsk: .70, downBid: .28, downAsk: .30 });
  bot.processScheduledTakerOrder(secondAt);
  assert.equal(bot.takerOrders.length, 2);
  assert.equal(bot.takerOrders[0].side, 'DOWN');
  assert.equal(bot.takerOrders[0].requestedShares, 50);
  assert.equal(bot.lastOrderSlot, 1);
});

test('later-phase buys switch to the higher ask without changing checkpoint sizes', () => {
  const { bot, start } = fixture();
  const beforeBoundary = start + 60_000;
  setMidpointBooks(bot, beforeBoundary, { upBid: .28, upAsk: .30, downBid: .68, downAsk: .70 });
  bot.processScheduledTakerOrder(beforeBoundary);
  assert.equal(bot.takerOrders[0].phase, 'FIRST');
  assert.equal(bot.takerOrders[0].side, 'UP');
  assert.equal(bot.takerOrders[0].sideSelectionPolicy, 'LOWER_ASK');
  assert.equal(bot.takerOrders[0].requestedShares, 50);
  assert.equal(bot.lastOrderSlot, 19);

  const secondPhase = start + 70_000;
  setMidpointBooks(bot, secondPhase, { upBid: .68, upAsk: .70, downBid: .28, downAsk: .30 });
  bot.processScheduledTakerOrder(secondPhase);
  assert.equal(bot.takerOrders[0].phase, 'SECOND');
  assert.equal(bot.takerOrders[0].side, 'UP', 'second phase buys the higher-ask side');
  assert.equal(bot.takerOrders[0].sideSelectionPolicy, 'HIGHER_ASK');
  assert.equal(bot.takerOrders[0].requestedShares, 150);
  assert.equal(bot.lastOrderSlot, 20);

  const finalAt = start + 150_000;
  setMidpointBooks(bot, finalAt, { upBid: .28, upAsk: .30, downBid: .68, downAsk: .70 });
  bot.processScheduledTakerOrder(finalAt);
  assert.equal(bot.takerOrders[0].side, 'DOWN', 'higher-ask selection is recalculated at each checkpoint');
  assert.equal(bot.takerOrders[0].sideSelectionPolicy, 'HIGHER_ASK');
  assert.equal(bot.takerOrders[0].requestedShares, 150);
  assert.equal(bot.lastOrderSlot, 36);
  assert.match(bot.snapshot().strategy.orderModel, /higher fresh best ask/);
  assert.equal(bot.snapshot().strategy.secondPhaseIntervalSeconds, 5);
  assert.equal(bot.snapshot().strategy.maxOrdersPerWindow, 37);
});

test('stale quotes may recover during the active checkpoint without duplicating the taker buy', () => {
  const { bot, start } = fixture();
  const firstAt = start + 3_000;
  setMidpointBooks(bot, firstAt - 6_000, { upBid: .28, upAsk: .30, downBid: .68, downAsk: .70 });
  bot.processScheduledTakerOrder(firstAt);
  assert.equal(bot.takerOrders.length, 0);
  assert.equal(bot.lastOrderSlot, -1);

  const recoveredAt = start + 5_000;
  setMidpointBooks(bot, recoveredAt, { upBid: .28, upAsk: .30, downBid: .68, downAsk: .70 });
  bot.processScheduledTakerOrder(recoveredAt);
  bot.processScheduledTakerOrder(recoveredAt + 500);
  assert.equal(bot.takerOrders.length, 1);
  assert.equal(bot.takerOrders[0].filledShares, 50);
  assert.equal(bot.lastOrderSlot, 0);
});

test('taker buys sweep visible ask depth and cancel any unfilled remainder immediately', () => {
  const { bot, start } = fixture();
  const placedAt = start + 3_000;
  bot.quotes = {
    UP: bot.quote({
      bids: [{ price: .28, size: 500 }],
      asks: [{ price: .29, size: 20 }, { price: .30, size: 10 }],
    }, placedAt),
    DOWN: bot.quote({
      bids: [{ price: .68, size: 500 }],
      asks: [{ price: .70, size: 500 }],
    }, placedAt),
  };
  bot.processScheduledTakerOrder(placedAt);
  const order = bot.takerOrders[0];
  assert.equal(order.orderType, 'MARKET');
  assert.equal(order.requestedShares, 50);
  assert.equal(order.filledShares, 30);
  assert.equal(order.cancelledRemainderShares, 20);
  assert.equal(order.remainingShares, 0);
  assert.equal(order.status, 'PARTIALLY_FILLED_CANCELLED');
  assert.equal(bot.trades[0].shares, 30);
  assert.ok(bot.trades[0].fees > 0);
  assert.equal(bot.snapshot().paperAccount.openOrders, 0);
  assert.equal(bot.snapshot().openOrders.length, 0);
});

test('taker-filled positions can take profit before the 295-second stop-loss gate', () => {
  const { bot, start } = fixture();
  const placedAt = start + 3_000;
  setMidpointBooks(bot, placedAt, { upBid: .3, upAsk: .3, downBid: .7, downAsk: .7 });
  bot.processScheduledTakerOrder(placedAt);
  assert.equal(bot.trades.length, 1);
  assert.equal(bot.trades[0].status, 'OPEN');

  const earlyTakeProfit = start + 4_000;
  setMidpointBooks(bot, earlyTakeProfit, { upBid: .99, upAsk: 1, downBid: .01, downAsk: .02 });
  bot.processPositionExits(earlyTakeProfit);
  assert.equal(bot.trades[0].finalOutcome, 'TAKE_PROFIT');
  assert.equal(bot.trades[0].status, 'SETTLED');

  bot.maybeFinalizeCompletedWindows(start + 300_000);
  assert.equal(bot.finalizedWindowStarts.has(start), true);
  assert.ok(bot.events.some(event => event.event === 'PAPER_WINDOW_COMPLETED'
    && event.windowStart === start && event.tradeCount === 1));
});
