'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, rsiSignal, START } = require('./window-test-fixture.cjs');
const { METHOD: RSI_METHOD } = require('./rsi-signal');

test('the middle RSI band retains the last side across windows', () => {
  const { bot, at } = fixture({ activeSide: 'DOWN' });
  assert.equal(bot.activeSide, null, 'legacy constructor side is not restored on process startup');

  bot.applyRsiSignal(rsiSignal(29));
  assert.equal(bot.activeSide, 'UP');
  bot.applyRsiSignal(rsiSignal(50));
  assert.equal(bot.activeSide, 'UP');
  assert.equal(bot.windowDecision.status, 'HELD');

  const nextStart = START + 300_000;
  bot.market = { ...bot.market, id: 'next-window', start: nextStart, end: nextStart + 300_000 };
  at(310);
  bot.beginMarketWindow();
  assert.equal(bot.activeSide, 'UP');
  bot.applyRsiSignal(rsiSignal(60, nextStart));
  assert.equal(bot.activeSide, 'UP');
  assert.equal(bot.windowDecision.status, 'HELD');

  bot.applyRsiSignal(rsiSignal(71, nextStart));
  assert.equal(bot.activeSide, 'DOWN');
  bot.applyRsiSignal(rsiSignal(45, nextStart));
  assert.equal(bot.activeSide, 'DOWN');
});

test('startup in the middle band waits until RSI reaches an extreme', () => {
  const { bot, at } = fixture();
  bot.applyRsiSignal(rsiSignal(50));
  bot.processSignals(at(10));
  assert.equal(bot.activeSide, null);
  assert.equal(bot.trades.length, 0);
  bot.applyRsiSignal(rsiSignal(29));
  bot.processSignals(at(20));
  assert.equal(bot.activeSide, 'UP');
  assert.equal(bot.trades.length, 1);
});

test('the removed 20–60¢ band no longer gates entries or queues shares', () => {
  const { bot, at } = fixture();
  bot.applyRsiSignal(rsiSignal(20));
  const now = at(10);
  bot.quotes.UP = bot.quote({
    bids: [{ price: .79, size: 5000 }],
    asks: [{ price: .80, size: 5000 }],
  }, now);
  bot.processSignals(now);
  assert.equal(bot.trades.length, 1);
  assert.equal(bot.trades[0].shares, 50);
  assert.equal(bot.trades[0].entryPrice, .8);
  assert.equal(bot.trades[0].entryKind, 'SCHEDULED_RSI');
  assert.equal(bot.trades[0].recoveredPriceTriggers, undefined);
  assert.equal(bot.entryFilter.blockedReasons.includes('PRICE_BAND'), false);
});

test('new RSI side affects later entries but never sells an opposite open position', () => {
  const { bot, at } = fixture();
  bot.applyRsiSignal(rsiSignal(20));
  bot.processSignals(at(10));
  const original = bot.trades[0];
  bot.applyRsiSignal(rsiSignal(80));
  assert.equal(bot.activeSide, 'DOWN');
  bot.processOppositeSignalExits(at(20));
  assert.equal(original.status, 'OPEN');
  bot.processSignals(at(20));
  assert.equal(bot.trades.length, 2);
  assert.equal(bot.trades.find(trade => trade.side === 'DOWN')?.side, 'DOWN');
  assert.equal(original.status, 'OPEN');
});

test('snapshot reports RSI policy, fixed timing, and no price-band filter', () => {
  const { bot } = fixture();
  bot.applyRsiSignal(rsiSignal(20));
  const state = bot.snapshot();
  assert.equal(state.strategy.sideMode, 'rsi-14-hysteresis');
  assert.match(state.strategy.signalPersistence, /across windows/);
  assert.match(state.strategy.model, /Wilder RSI\(14\)/);
  assert.equal(state.strategy.sharesPerSignal, 50);
  assert.equal(state.strategy.entryIntervalSeconds, 10);
  assert.equal(state.strategy.lastEntrySeconds, 290);
  assert.equal(state.entryPriceBand, undefined);
  assert.equal(state.macd, undefined);
  assert.equal(state.rsi.side, 'UP');
});

test('persistent learning samples include RSI and the selected side, not MACD data', async () => {
  const { bot, at } = fixture();
  let saved;
  bot.learningStore = {
    recordEvent: async () => {},
    recordSample: async sample => { saved = sample; },
  };
  bot.latestPrice = 95_000;
  bot.applyRsiSignal(rsiSignal(25));
  bot.pullback = {
    method: RSI_METHOD, timeframe: '5m', side: 'UP', signalSide: 'UP',
  };
  await bot.captureLearningSample(at(15));
  await bot.persistenceQueue;

  assert.equal(saved.pullback.method, RSI_METHOD);
  assert.equal(saved.rsi.status, 'READY');
  assert.equal(saved.rsi.value, 25);
  assert.equal(saved.rsi.side, 'UP');
  assert.equal(saved.rsi.activeSide, 'UP');
  assert.equal(saved.macd, undefined);
  assert.equal(saved.entryPriceBand, undefined);
});
