'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { METHOD, CANDLE_MS } = require('./macd-signal');
const { compareStrategies, replay, historyIndex, strengtheningRun, sellDepth, sampleTime } = require('./strategy-comparison');
const { comparisonService } = require('./comparison-service');

const START = 1_800_000_000_000;
function fixture(number = 0, { depth = 100000, reversal = false, lateBid = .20 } = {}) {
  const start = START + number * CANDLE_MS;
  const bars = Array.from({ length: 4 }, (_, i) => ({
    start: start - (4 - i) * CANDLE_MS, end: start - (3 - i) * CANDLE_MS,
    histogram: number + i + 1,
    classification: reversal && i === 3 ? 'SHRINKING_GREEN' : 'SOLID_GREEN',
    side: reversal && i === 3 ? 'DOWN' : 'UP',
  }));
  const samples = Array.from({ length: 300 }, (_, second) => {
    const ts = start + second * 1000;
    const bid = second < 30 ? .29 : second < 40 ? .55 : lateBid;
    const quote = { bestBid: bid, bestAsk: .30, updatedAt: ts,
      asks: [{ price: .30, size: 100000 }], bids: [{ price: bid, size: depth }] };
    return { ts, observedAt: ts, windowStart: start, pullback: { method: METHOD },
      windowDecision: { previousCandle: bars.at(-1) },
      macd: second === 0 ? { closedBars: bars } : {},
      quotes: { UP: structuredClone(quote), DOWN: structuredClone(quote) } };
  });
  return { windowStart: start, samples };
}

test('four strengthening closed bars pause the same direction, not shrinking bars', () => {
  const window = fixture();
  const index = historyIndex([window]);
  assert.equal(strengtheningRun(START, START, index), 'UP');
  assert.equal(replay(window, 'fourBar', null, index).trades, 0);
  const reversal = fixture(1, { reversal: true });
  const reversalIndex = historyIndex([reversal]);
  assert.equal(strengtheningRun(reversal.windowStart, reversal.windowStart, reversalIndex), false);
  assert.ok(replay(reversal, 'fourBar', null, reversalIndex).trades > 0);
});

test('history observed later cannot be used for an earlier decision', () => {
  const window = fixture();
  const index = historyIndex([window]);
  assert.equal(strengtheningRun(START, START - 1, index), null);
  index.delete(START - 2 * CANDLE_MS);
  assert.equal(strengtheningRun(START, START + 10000, index), null);
});

test('trailing exits protect net profit and prohibit later scheduled re-entry', () => {
  const window = fixture();
  for (const sample of window.samples) {
    const elapsed = (sample.ts - window.windowStart) / 1000;
    const bid = elapsed >= 60 && elapsed < 90 ? .70 : .20;
    for (const quote of Object.values(sample.quotes)) {
      quote.bestBid = bid;
      quote.bids = [{ price: bid, size: 100000 }];
    }
  }
  const index = historyIndex([window]);
  const baseline = replay(window, 'baseline', null, index);
  const trailing = replay(window, 'trailing', { activation: .10, retracement: .05 }, index);
  assert.equal(baseline.trades, 4);
  assert.equal(trailing.trades, 2, 'the second stage can qualify before the trailing exit triggers');
  assert.equal(trailing.trailingExits, 1);
  assert.equal(trailing.stopAfterExit, true);
  assert.ok(trailing.pnl > baseline.pnl);
  assert.ok(trailing.giveback < baseline.giveback);
});

test('insufficient full-position bid depth never invents a trailing fill', () => {
  const window = fixture(0, { depth: 1 });
  const result = replay(window, 'trailing', { activation: .10, retracement: .05 }, historyIndex([window]));
  assert.equal(result.trailingExits, 0);
  assert.equal(result.trades, 4, 'cannot arm without executable net liquidation profit');
  assert.equal(sellDepth([{ price: .5, size: 1 }], 5), null);
});

test('visible-depth sell computes fees for each level', () => {
  const result = sellDepth([{ price: .5, size: 2 }, { price: .4, size: 3 }], 5);
  assert.ok(Math.abs(result.gross - 2.2) < 1e-10);
  assert.ok(result.fees > 0);
  assert.ok(Math.abs(result.price - .44) < 1e-10);
});

test('future and stale quotes cannot create entries', () => {
  for (const offset of [-6000, 100]) {
    const window = fixture();
    for (const sample of window.samples) for (const quote of Object.values(sample.quotes)) {
      quote.updatedAt = sample.observedAt + offset;
    }
    assert.equal(replay(window, 'baseline', null, historyIndex([window])).trades, 0);
  }
  assert.equal(sampleTime({ ts: 1000 }), 1499);
  assert.equal(sampleTime({ ts: 1000, observedAt: 1250 }), 1250);
});

test('insufficient data and missing near-close coverage are explicit, never a recommendation', () => {
  const window = fixture();
  window.samples = window.samples.slice(0, 200);
  const result = compareStrategies([window, fixture(1)]);
  assert.equal(result.status, 'insufficient-data');
  assert.equal(result.excluded.incompleteQuotes, 1);
  assert.deepEqual(result.variants, {});
  assert.equal(result.applied, false);
});

test('four variants share a chronological holdout; holdout changes cannot select parameters', () => {
  const windows = Array.from({ length: 34 }, (_, i) => fixture(i));
  const input = JSON.stringify(windows);
  const report = compareStrategies(windows);
  assert.equal(report.status, 'ready');
  assert.equal(report.split.trainingWindows, 23);
  assert.equal(report.split.holdoutWindows, 11);
  assert.equal(report.variants.baseline.holdout.windows, 11);
  assert.equal(report.variants.fourBar.holdout.windows, 11);
  const changed = windows.map((window, i) => i < 23 ? window : fixture(i, { lateBid: .52 }));
  const second = compareStrategies(changed);
  assert.deepEqual(report.variants.trailing.parameters, second.variants.trailing.parameters);
  assert.deepEqual(report.variants.combined.parameters, second.variants.combined.parameters);
  assert.equal(JSON.stringify(windows), input, 'replay must not mutate stored samples');
  assert.equal(report.tradingChanged, false);
});

test('comparison worker coalesces concurrent requests and caches the read-only result', async () => {
  let reads = 0;
  const get = comparisonService({ getCompletedWindows: async () => { reads++; return []; } });
  const [first, second] = await Promise.all([get(), get()]);
  assert.equal(first.status, 'insufficient-data');
  assert.deepEqual(first, second);
  await get();
  assert.equal(reads, 1);
});
