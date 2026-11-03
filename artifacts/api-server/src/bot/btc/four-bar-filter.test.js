'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { windowSignal, strengtheningSide } = require('./macd-signal');
const { fixture, closedCandleSignal, START, CANDLE_MS } = require('./window-test-fixture.cjs');
const { simulateWindow } = require('./learning-engine');

function history(classes, start = START) {
  const signal = closedCandleSignal(classes.at(-1), start);
  signal.chart.bars = classes.map((classification, i) => ({
    ...closedCandleSignal(classification, start - (classes.length - i - 1) * CANDLE_MS).chart.bars[0],
  }));
  return signal;
}
const enabled = { fourBarFilter: true };

test('live four-bar rule skips four or more strengthening bars in either direction, never reverses', () => {
  for (const [classification, side] of [['SOLID_GREEN', 'UP'], ['SOLID_RED', 'DOWN']]) {
    for (const length of [4, 5, 8]) {
      const signal = history(Array(length).fill(classification));
      const result = windowSignal(signal, START, START, enabled);
      assert.equal(result.status, 'SKIP_WINDOW');
      assert.equal(result.side, null);
      assert.equal(result.candidateSide, side);
      assert.equal(result.reason, 'FOUR_BAR_STRENGTHENING_STREAK');
      assert.equal(result.fourBarFilter.blocked, true);
      assert.equal(strengtheningSide(signal.chart.bars, START, START), side);
      assert.equal(windowSignal(signal, START, START).side, side, 'unfiltered historical baseline stays available');
    }
  }
});

test('three strengthening bars or shrinking bars do not trigger the four-bar filter', () => {
  for (const [classes, side] of [
    [['SHRINKING_RED', 'SOLID_GREEN', 'SOLID_GREEN', 'SOLID_GREEN'], 'UP'],
    [['SHRINKING_GREEN', 'SOLID_RED', 'SOLID_RED', 'SOLID_RED'], 'DOWN'],
    [['SOLID_RED', 'SOLID_RED', 'SOLID_RED', 'SHRINKING_RED'], 'UP'],
    [['SOLID_GREEN', 'SOLID_GREEN', 'SOLID_GREEN', 'SHRINKING_GREEN'], 'DOWN'],
    [Array(4).fill('SHRINKING_RED'), 'UP'],
    [Array(4).fill('SHRINKING_GREEN'), 'DOWN'],
  ]) {
    const result = windowSignal(history(classes), START, START, enabled);
    assert.equal(result.status, 'LOCKED');
    assert.equal(result.side, side);
    assert.equal(result.fourBarFilter.blocked, false);
  }
});

test('missing, duplicate, gapped or unclosed filter history waits rather than guessing', () => {
  const signal = history(Array(4).fill('SOLID_GREEN'));
  const variants = [
    signal.chart.bars.slice(1),
    [...signal.chart.bars, signal.chart.bars[0]],
    signal.chart.bars.map((bar, i) => i === 0 ? { ...bar, start: bar.start - 1 } : bar),
    signal.chart.bars.map((bar, i) => i === 0 ? { ...bar, classification: undefined } : bar),
  ];
  for (const bars of variants) {
    const result = windowSignal({ ...signal, chart: { bars } }, START, START, enabled);
    assert.equal(result.status, 'WAITING_HISTORY');
    assert.equal(result.reason, 'FOUR_BAR_HISTORY_REQUIRED');
    assert.equal(result.side, null);
  }
  assert.equal(windowSignal(signal, START, START - 1, enabled).status, 'WAITING_HISTORY');
  const future = history(Array(4).fill('SOLID_RED'), START + CANDLE_MS).chart.bars.at(-1);
  assert.equal(windowSignal({ ...signal, chart: { bars: [...signal.chart.bars, future] } },
    START, START, enabled).candidateSide, 'UP', 'future bars do not change the closed streak');
});

test('a filtered window stays skipped for all 29 slots and the next window independently resumes', () => {
  for (const classification of ['SOLID_GREEN', 'SOLID_RED']) {
    const { bot, at } = fixture(enabled);
    bot.applyPullbackSignal(history(Array(4).fill(classification)));
    for (let seconds = 10; seconds <= 290; seconds += 10) {
      bot.processSignals(at(seconds));
      bot.applyPullbackSignal(history(['SOLID_GREEN', 'SOLID_GREEN', 'SOLID_GREEN', 'SHRINKING_GREEN']));
    }
    assert.equal(bot.entrySequence, 0);
    assert.equal(bot.cash, 10000);
    assert.equal(bot.windowDecision.status, 'SKIP_WINDOW');
    const nextStart = START + CANDLE_MS;
    bot.market = { ...bot.market, id: 'next', start: nextStart, end: nextStart + CANDLE_MS };
    at(310);
    bot.applyPullbackSignal(history(['SOLID_GREEN', 'SOLID_GREEN', 'SOLID_GREEN', 'SHRINKING_GREEN'], nextStart));
    bot.processSignals(START + 310000);
    assert.equal(bot.activeSide, 'DOWN');
    assert.equal(bot.trades.length, 1);
    assert.equal(bot.trades[0].shares, 50);
  }
});

test('allowed windows retain all 29 timed 50-share entries and native TP, with no intrawindow flip', () => {
  const { bot, at } = fixture(enabled);
  bot.applyPullbackSignal(history(['SOLID_RED', 'SHRINKING_RED', 'SOLID_GREEN', 'SOLID_GREEN']));
  for (let seconds = 10; seconds <= 290; seconds += 10) {
    bot.processSignals(at(seconds));
    bot.applyPullbackSignal(history(Array(4).fill('SOLID_RED')));
  }
  assert.equal(bot.entrySequence, 29);
  assert.ok(bot.trades.every(trade => trade.side === 'UP' && trade.shares === 50));
  assert.equal(bot.cash < 10000, true);
  at(291, .995, .999);
  bot.processPositionExits(START + 291000);
  assert.ok(bot.trades.every(trade => trade.status === 'SETTLED' && trade.finalOutcome === 'TAKE_PROFIT'));
  assert.equal(bot.activeSide, 'UP');
});

test('observational regression reproduces filtered decisions while preserving old unfiltered samples', () => {
  const signal = history(Array(4).fill('SOLID_GREEN'));
  const decision = windowSignal(signal, START, START, enabled);
  const samples = Array.from({ length: 30 }, (_, index) => {
    const ts = START + (index === 29 ? 299000 : (index + 1) * 10000);
    return {
      ts, windowStart: START, pullback: { method: signal.method }, windowDecision: decision,
      macd: index === 0 ? { closedBars: signal.chart.bars } : {},
      quotes: Object.fromEntries(['UP', 'DOWN'].map(side => [side, {
        updatedAt: ts, bestBid: index === 29 ? .995 : .4, bestAsk: .5,
        bids: [{ price: .4, size: 5000 }], asks: [{ price: .5, size: 5000 }],
      }])),
    };
  });
  assert.equal(simulateWindow(samples).trades, 0);
  assert.equal(simulateWindow(samples).pnl, 0);
  const oldDecision = windowSignal(signal, START, START);
  const unfiltered = samples.map(sample => ({ ...sample, windowDecision: oldDecision }));
  assert.equal(simulateWindow(unfiltered).trades, 29);
});

test('learning waits for the immediately preceding bar before recording its one-per-window history', async () => {
  const saved = [];
  const { bot, at } = fixture({ ...enabled,
    learningStore: { recordEvent: async () => {}, recordSample: async sample => saved.push(sample) } });
  bot.macd = history(Array(4).fill('SOLID_GREEN'), START - CANDLE_MS);
  await bot.captureLearningSample(at(10));
  bot.macd = history(Array(4).fill('SOLID_GREEN'));
  bot.applyPullbackSignal(bot.macd);
  await bot.captureLearningSample(at(11));
  await bot.persistenceQueue;
  assert.equal(saved[0].macd.closedBars, undefined);
  assert.equal(saved[1].macd.closedBars.at(-1).end, START);
  assert.equal(saved[1].windowDecision.fourBarFilter.blocked, true);
});
