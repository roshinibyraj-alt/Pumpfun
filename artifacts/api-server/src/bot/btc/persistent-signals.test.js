'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ProbabilityBot } = require('./probability-bot');
const { detectMacdHistogram } = require('./macd-signal');
const { fixture, pair, START } = require('./window-test-fixture.cjs');

test('signal never carries across windows and persisted legacy bias/settings are ignored', () => {
  const { bot, at } = fixture({
    activeSide: 'DOWN', strategySettings: { sharesPerSignal: 999, openingDelaySeconds: 0, sideMode: 'down-only' },
  });
  assert.equal(bot.activeSide, null);
  assert.equal(bot.strategySettings.sharesPerSignal, 50);
  bot.applyPullbackSignal(pair());
  bot.processSignals(at(120));
  assert.equal(bot.activeSide, 'UP');
  bot.market = { ...bot.market, id: 'next', start: START + 300000, end: START + 600000 };
  bot.beginMarketWindow();
  assert.equal(bot.activeSide, null);
  assert.equal(bot.windowDecision.status, 'OBSERVING');
  bot.processSignals(at(420));
  assert.equal(bot.trades.length, 1);
  bot.applyPullbackSignal(pair());
  assert.equal(bot.activeSide, null, 'previous-window candles cannot create a new-window signal');
});

test('later histogram changes cannot flip the locked side or sell existing positions', () => {
  const { bot, at } = fixture();
  bot.applyPullbackSignal(pair());
  bot.processSignals(at(120));
  at(180);
  bot.applyPullbackSignal(pair('SOLID_GREEN', 'SHRINKING_GREEN'));
  bot.processOppositeSignalExits(at(180));
  assert.equal(bot.activeSide, 'UP');
  assert.equal(bot.trades[0].status, 'OPEN');
  assert.equal(bot.pendingReversal, null);
  bot.processSignals(at(180));
  assert.ok(bot.trades.every(t => t.side === 'UP'));
});

test('a nonqualifying pair skips the entire window, even if later bars suggest a side', () => {
  const { bot, at } = fixture();
  bot.applyPullbackSignal(pair('SHRINKING_RED', 'SOLID_GREEN'));
  assert.equal(bot.windowDecision.status, 'SKIP_WINDOW');
  at(180);
  bot.applyPullbackSignal(pair());
  bot.processSignals(at(180));
  assert.equal(bot.activeSide, null);
  assert.equal(bot.trades.length, 0);
});

test('full tick buys without a window opening reference, probability history or live spot feed', async () => {
  let now = START + 119500;
  const candles = Array.from({ length: 102 }, (_, i) => ({
    start: START + (i - 100) * 60000, end: START + (i - 99) * 60000,
    close: i < 100 ? 100 : i === 100 ? 90 : 105,
  }));
  const signal = detectMacdHistogram(candles, START + 120000);
  assert.equal(signal.chart.bars.at(-2).classification, 'SOLID_RED');
  assert.equal(signal.chart.bars.at(-1).classification, 'SHRINKING_RED');
  const bot = new ProbabilityBot({
    now: () => now,
    fetchMarket: async start => ({ id: 'm', start, end: start + 300000, tokens: { UP: 'u', DOWN: 'd' } }),
    fetchBook: async () => ({ asks: [{ price: .6, size: 1000 }], bids: [{ price: .4, size: 1000 }] }),
    priceFeed: {
      start() {}, getTicks: () => [], snapshot: () => ({ status: 'stale' }),
      getHistoricalMinuteCandles: () => candles,
      getHistoricalCandles() { throw Error('Probability history must not be requested'); },
    },
  });
  await bot.tick();
  assert.equal(bot.activeSide, null);
  assert.equal(bot.trades.length, 0);
  now = START + 120000;
  await bot.tick();
  assert.equal(bot.error, null);
  assert.equal(bot.activeSide, 'UP');
  assert.equal(bot.trades.length, 1);
  assert.equal(bot.probabilityUp, null);
  now += 500;
  await bot.tick();
  assert.equal(bot.trades.length, 1);
  now = START + 300000;
  await bot.tick();
  assert.equal(bot.activeSide, null);
  assert.equal(bot.windowDecision.status, 'OBSERVING');
});

test('window resets before market discovery even if the next market is missing', async () => {
  const { bot, at } = fixture();
  bot.applyPullbackSignal(pair());
  bot.fetchMarket = async () => null;
  at(300);
  await bot.tick();
  assert.equal(bot.activeSide, null);
});

test('persistent samples include the causal two-bar decision and fixed-policy method', async () => {
  const samples = [];
  const { bot, at } = fixture({ learningStore: { recordEvent: async () => {}, recordSample: async s => samples.push(s) } });
  bot.applyPullbackSignal(pair());
  await bot.captureLearningSample(at(120));
  await bot.captureLearningSample(at(120));
  await bot.captureLearningSample(at(120.5));
  await bot.persistenceQueue;
  assert.equal(samples.length, 2);
  assert.equal(samples[0].windowDecision.minute2.end, START + 120000);
});

test('regression cannot change fixed settings even if a supplied evaluator asks to apply changes', async () => {
  const { bot, at } = fixture({
    learningStore: { recordEvent: async () => {}, getCompletedWindows: async () => [], saveTuning: async () => {} },
    choosePaperSettings: () => ({ applied: true, windows: 15, settings: { sharesPerSignal: 999 } }),
  });
  await bot.maybeTune(at(120));
  assert.equal(bot.strategySettings.sharesPerSignal, 50);
  assert.equal(bot.learningStatus.enabled, false);
});
