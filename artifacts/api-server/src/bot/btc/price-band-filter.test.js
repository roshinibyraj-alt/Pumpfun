'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, closedCandleSignal, START, CANDLE_MS } = require('./window-test-fixture.cjs');
const { simulateBuy } = require('./probability-bot');
const { simulateWindow } = require('./learning-engine');
const { compareStrategies } = require('./strategy-comparison');

function setup(options = {}) {
  const f = fixture({ priceBandFilter: true, ...options });
  f.bot.applyPullbackSignal(closedCandleSignal());
  const fire = (seconds, ask = .5) => f.bot.processSignals(f.at(seconds, .4, ask));
  return { ...f, fire };
}

test('entry band includes exactly 20 and 60 cents but blocks prices outside', () => {
  for (const ask of [.2, .6]) {
    const { bot, fire } = setup();
    fire(10, ask);
    assert.equal(bot.trades[0].shares, 50);
    assert.equal(bot.trades[0].entryPrice, ask);
    assert.equal(bot.priceBandState().skippedTriggers, 0);
  }
  for (const ask of [.199, .601]) {
    const { bot, fire } = setup();
    fire(10, ask);
    assert.equal(bot.trades.length, 0);
    assert.equal(bot.priceBandState().pendingShares, 50);
    assert.equal(bot.priceBandState().skippedTriggers, 1);
  }
});

test('three price skips buy 200 shares at the next qualifying slot, then return to 50', () => {
  const { bot, fire } = setup();
  for (const seconds of [10, 20, 30]) fire(seconds, .8);
  assert.equal(bot.priceBandState().pendingShares, 150);
  fire(40, .5);
  assert.equal(bot.trades[0].shares, 200);
  assert.equal(bot.trades[0].recoveredPriceTriggers, 3);
  assert.deepEqual([bot.priceSkippedTriggers, bot.pendingPriceTriggers, bot.recoveredPriceTriggers], [3, 0, 3]);
  fire(50, .5);
  assert.equal(bot.trades[0].shares, 50);
});

test('polls between scheduled triggers cannot accrue or execute recovery shares', () => {
  const { bot, fire } = setup();
  fire(10, .8);
  for (const seconds of [10.2, 10.8, 11, 15, 19.5]) fire(seconds, .5);
  assert.equal(bot.priceSkippedTriggers, 1);
  assert.equal(bot.trades.length, 0);
  fire(30, .5); // Missing the 20-second observation does not add debt.
  assert.equal(bot.trades[0].shares, 100);
  fire(30.5, .5);
  assert.equal(bot.trades.length, 1);
});

test('all consumed ask levels must be in band, not merely the average price', () => {
  const levels = [{ price: .5, size: 100 }, { price: .61, size: 100 }];
  assert.ok(simulateBuy(levels, 150).averagePrice < .6);
  assert.equal(simulateBuy(levels, 150, { minimumPrice: .2, maximumPrice: .6 }), null);
  assert.equal(simulateBuy([{ price: .19, size: 50 }], 50,
    { minimumPrice: .2, maximumPrice: .6 }), null);
  const { bot, fire, at } = setup();
  fire(10, .8); fire(20, .8);
  const now = at(30);
  bot.quotes.UP = bot.quote({ bids: [{ price: .4, size: 5000 }], asks: levels }, now);
  bot.processSignals(now);
  assert.equal(bot.trades.length, 0);
  assert.equal(bot.pendingPriceTriggers, 2, 'depth failure preserves old debt but does not add a trigger');
  fire(40, .6);
  assert.equal(bot.trades[0].shares, 150);
});

test('depth, cash and stale-book failures preserve backlog without adding skipped triggers', () => {
  const { bot, fire, at } = setup();
  fire(10, .8);
  let now = at(20);
  bot.quotes.UP.asks = [{ price: .5, size: 50 }];
  bot.processSignals(now);
  now = at(30);
  bot.cash = 30; // Can afford the base 50 but not the 100-share catch-up.
  bot.processSignals(now);
  bot.cash = 10000;
  now = at(40, .4, .8);
  bot.quotes.UP.updatedAt = now - 6000;
  bot.processSignals(now);
  assert.equal(bot.priceSkippedTriggers, 1);
  assert.equal(bot.pendingPriceTriggers, 1);
  fire(50, .5);
  assert.equal(bot.trades[0].shares, 100);
});

test('a price-outside trigger that also lacks base liquidity or cash never adds debt', () => {
  const { bot, at } = setup();
  let now = at(10, .4, .8);
  bot.quotes.UP.asks[0].size = 49;
  bot.processSignals(now);
  now = at(20, .4, .8);
  bot.cash = 1;
  bot.processSignals(now);
  assert.equal(bot.pendingPriceTriggers, 0);
  assert.equal(bot.priceSkippedTriggers, 0);
});

test('four-bar-skipped windows never build a price queue or force an opposite side', () => {
  const { bot, at } = fixture({ priceBandFilter: true, fourBarFilter: true });
  const signal = closedCandleSignal('SOLID_GREEN');
  signal.chart.bars = Array.from({ length: 4 }, (_, i) =>
    closedCandleSignal('SOLID_GREEN', START - (3 - i) * CANDLE_MS).chart.bars[0]);
  bot.applyPullbackSignal(signal);
  for (let seconds = 10; seconds <= 290; seconds += 10) bot.processSignals(at(seconds, .4, .8));
  assert.equal(bot.windowDecision.status, 'SKIP_WINDOW');
  assert.equal(bot.pendingPriceTriggers, 0);
  assert.equal(bot.trades.length, 0);
});

test('queue expires at the window boundary and cannot trigger after second 290', () => {
  const { bot, fire, at } = setup();
  fire(290, .8);
  fire(291, .5);
  fire(300, .5);
  assert.equal(bot.trades.length, 0);
  bot.market = { ...bot.market, id: 'next', start: START + CANDLE_MS, end: START + 2 * CANDLE_MS };
  at(310);
  bot.applyPullbackSignal(closedCandleSignal('SHRINKING_RED', START + CANDLE_MS));
  fire(310, .5);
  assert.equal(bot.trades[0].shares, 50);
  assert.equal(bot.priceSkippedTriggers, 0);
});

test('28 skipped triggers recover as 1450 shares at second 290, with no duplicate buy; exits remain active', () => {
  const { bot, fire, at } = setup();
  for (let seconds = 10; seconds <= 280; seconds += 10) fire(seconds, .8);
  fire(290, .6);
  fire(290.5, .6);
  assert.equal(bot.trades.length, 1);
  assert.equal(bot.trades[0].shares, 1450);
  assert.equal(bot.recoveredPriceTriggers, 28);
  bot.processPositionExits(at(291, .995, .999));
  assert.equal(bot.trades[0].status, 'SETTLED');
  assert.equal(bot.trades[0].finalOutcome, 'TAKE_PROFIT');
});

test('learning reproduces the band policy and historical comparison excludes the new entry model', () => {
  const { bot, at } = setup();
  const signal = closedCandleSignal();
  const samples = [];
  for (let index = 0; index < 30; index++) {
    const seconds = index === 29 ? 299 : (index + 1) * 10;
    const now = at(seconds, index === 29 ? .995 : .4, index < 3 ? .8 : .5);
    samples.push({ ts: now, observedAt: now, windowStart: START,
      pullback: { method: signal.method }, windowDecision: bot.windowDecision,
      entryPriceBand: { enabled: true }, quotes: structuredClone(bot.quotes) });
  }
  assert.equal(simulateWindow(samples).trades, 26);
  assert.equal(compareStrategies([{ windowStart: START, samples }]).usableWindows, 0);
});
