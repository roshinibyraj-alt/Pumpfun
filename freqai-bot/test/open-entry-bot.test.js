'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const Bot = require('../freqai-open-entry-bot');

function fixture({ up = 0.51, down = 0.49, scoreDelay = 0 } = {}) {
  const start = 1_800_000_000_000;
  let now = start + scoreDelay;
  let prediction = {
    candleStart: start - 60_000,
    candleCloseAt: start,
    writtenAt: start + scoreDelay,
    windowStart: start,
    pUp: up,
    pDown: down,
    model: 'LightGBMClassifier',
  };
  const bot = new Bot({
    now: () => now,
    marketData: {},
    initialCapital: 3000,
    freqaiWorker: { snapshot: () => ({ status: 'READY', lastPrediction: prediction }) },
  });
  const record = bot.records.get('BTC:5m');
  record.marketStatus = 'OPEN';
  record.market = {
    id: 'test-market',
    slug: 'btc-updown-5m-test',
    title: 'Bitcoin Up or Down · test',
    start,
    end: start + 300_000,
    tokens: { UP: 'up-token', DOWN: 'down-token' },
    feesEnabled: true,
    feeSchedule: { rate: 0.05 },
  };
  let sequence = 0;
  const quotes = {
    UP: {
      bestBid: 0.49, bestAsk: 0.5, mid: 0.495,
      bids: [{ price: 0.49, size: 1000 }],
      asks: [{ price: 0.5, size: 1000 }],
      updatedAt: now, sequence: ++sequence,
    },
    DOWN: {
      bestBid: 0.49, bestAsk: 0.5, mid: 0.495,
      bids: [{ price: 0.49, size: 1000 }],
      asks: [{ price: 0.5, size: 1000 }],
      updatedAt: now, sequence: ++sequence,
    },
  };
  record.quotes = quotes;
  return {
    bot,
    record,
    start,
    quotes,
    setNow(value) {
      now = value;
      for (const quote of Object.values(quotes)) quote.updatedAt = now;
    },
    setPrediction(value) { prediction = value; },
    check(side) { bot.processSide(record, side, quotes[side], ++sequence); },
  };
}

test('takes one 50-share UP entry at exactly 51% using the latest boundary score', () => {
  const f = fixture();
  f.check('UP');
  f.check('DOWN');
  assert.equal(f.bot.orders.length, 0, 'no entry during the first 45 seconds');

  f.setNow(f.start + 44_999);
  f.check('UP');
  assert.equal(f.bot.orders.length, 0, 'the delay is still active at 44.999 seconds');

  f.setNow(f.start + 45_000);
  f.check('UP');
  assert.equal(f.bot.orders.length, 1);
  assert.equal(f.bot.orders[0].side, 'UP');
  assert.equal(f.bot.orders[0].requestedShares, 50);
  assert.equal(f.bot.positions[0].shares, 50);
  assert.equal(f.bot.positions[0].modelProbabilityUp, 0.51);
  assert.equal(f.record.sideStates.DOWN.orderStatus, 'WINDOW_ENTRY_CONSUMED');
});

test('takes the higher-probability DOWN side when it clears 51%', () => {
  const f = fixture({ up: 0.48, down: 0.52 });
  f.check('UP');
  f.setNow(f.start + 45_000);
  f.check('UP');
  f.check('DOWN');
  assert.equal(f.bot.orders.length, 1);
  assert.equal(f.bot.orders[0].side, 'DOWN');
});

test('skips the window when neither side reaches 51%', () => {
  const f = fixture({ up: 0.505, down: 0.495 });
  f.check('UP');
  f.setNow(f.start + 45_000);
  f.check('UP');
  f.check('DOWN');
  assert.equal(f.bot.orders.length, 0);
  assert.equal(f.record.sideStates.UP.orderStatus, 'NO_ENTRY_SCORE');
  assert.equal(f.record.sideStates.DOWN.orderStatus, 'NO_ENTRY_SCORE');
});

test('locks the opening score and never flips or adds on later model changes', () => {
  const f = fixture();
  f.check('UP');
  f.setNow(f.start + 45_000);
  f.check('UP');
  const cashAfterEntry = f.bot.cash;
  f.setPrediction({
    candleStart: f.start + 60_000,
    candleCloseAt: f.start + 120_000,
    writtenAt: f.start + 120_000,
    windowStart: f.start,
    pUp: 0.2,
    pDown: 0.8,
  });
  f.setNow(f.start + 120_000);
  f.check('DOWN');
  f.check('UP');
  assert.equal(f.bot.orders.length, 1);
  assert.equal(f.bot.positions.length, 1);
  assert.equal(f.bot.positions[0].side, 'UP');
  assert.equal(f.bot.cash, cashAfterEntry);
});

test('waits up to five seconds for the boundary score, then skips rather than entering late', () => {
  const f = fixture({ scoreDelay: 0 });
  f.setNow(f.start + 2_000);
  f.setPrediction(null);
  f.check('UP');
  assert.equal(f.record.sideStates.UP.orderStatus, 'WAITING_FOR_45_SECOND_DELAY');

  f.setNow(f.start + 6_000);
  f.check('UP');
  assert.equal(f.record.sideStates.UP.orderStatus, 'WAITING_FOR_45_SECOND_DELAY');

  f.setNow(f.start + 45_000);
  f.check('UP');
  assert.equal(f.record.sideStates.UP.orderStatus, 'NO_ENTRY_SCORE');
  f.setPrediction({
    candleStart: f.start - 60_000,
    candleCloseAt: f.start,
    writtenAt: f.start + 6_000,
    pUp: 0.8,
    pDown: 0.2,
  });
  f.check('UP');
  assert.equal(f.bot.orders.length, 0);
});

test('does not use a probability produced from a minute inside the new window', () => {
  const f = fixture();
  f.setPrediction({
    candleStart: f.start,
    candleCloseAt: f.start + 60_000,
    writtenAt: f.start + 2_000,
    windowStart: f.start,
    pUp: 0.9,
    pDown: 0.1,
  });
  f.check('UP');
  f.setNow(f.start + 45_000);
  f.check('UP');
  assert.equal(f.bot.orders.length, 0);
});

test('records actual partial visible-ask depth and modeled fees', () => {
  const f = fixture();
  f.quotes.UP.asks = [{ price: 0.4, size: 20 }];
  f.check('UP');
  f.setNow(f.start + 45_000);
  f.check('UP');
  assert.equal(f.bot.orders[0].status, 'PARTIALLY_FILLED');
  assert.equal(f.bot.orders[0].filledShares, 20);
  assert.equal(f.bot.positions[0].shares, 20);
  assert.ok(f.bot.orders[0].fees > 0);
});

test('opens each qualifying shadow tier at its first qualifying score during a window', () => {
  const f = fixture({ up: 0.56, down: 0.44 });
  const startingCash = f.bot.cash;
  f.setNow(f.start + 30_000);
  f.setPrediction({
    candleStart: f.start - 60_000,
    candleCloseAt: f.start,
    writtenAt: f.start + 500,
    windowStart: f.start,
    pUp: 0.56,
    pDown: 0.44,
  });
  f.check('UP');
  assert.deepEqual(f.bot.shadowEntries.map((entry) => entry.thresholdPct), []);
  assert.equal(f.bot.orders.length, 0);
  assert.equal(f.bot.positions.length, 0);
  assert.equal(f.bot.cash, startingCash);

  f.setNow(f.start + 45_000);
  f.check('UP');
  assert.deepEqual(f.bot.shadowEntries.map((entry) => entry.thresholdPct), [55]);
  assert.equal(f.bot.orders.length, 0);

  f.setNow(f.start + 61_000);
  f.setPrediction({
    candleStart: f.start,
    candleCloseAt: f.start + 60_000,
    writtenAt: f.start + 60_500,
    windowStart: f.start,
    pUp: 0.61,
    pDown: 0.39,
  });
  f.check('UP');
  f.setNow(f.start + 121_000);
  f.setPrediction({
    candleStart: f.start + 60_000,
    candleCloseAt: f.start + 120_000,
    writtenAt: f.start + 120_500,
    windowStart: f.start,
    pUp: 0.66,
    pDown: 0.34,
  });
  f.check('UP');

  assert.deepEqual(
    f.bot.shadowEntries.map((entry) => entry.thresholdPct).sort((a, b) => a - b),
    [55, 60, 65],
  );
  assert.equal(f.bot.shadowEntries.every((entry) => entry.shares === 50), true);
  assert.equal(f.bot.shadowEntries.length, 3);
  const tiers = f.bot.snapshot().shadowTiers;
  assert.deepEqual(tiers.map((tier) => tier.entries), [1, 1, 1]);
  assert.ok(tiers.every((tier) => tier.totalPnl < 0));
});

test('requires scores strictly above each shadow threshold', () => {
  const f = fixture({ up: 0.55, down: 0.45 });
  f.setNow(f.start + 45_000);
  f.setPrediction({
    candleStart: f.start - 60_000,
    candleCloseAt: f.start,
    writtenAt: f.start + 500,
    windowStart: f.start,
    pUp: 0.55,
    pDown: 0.45,
  });
  f.check('UP');
  assert.equal(f.bot.shadowEntries.length, 0);
});

test('settles shadow P&L independently at official resolution', () => {
  const f = fixture({ up: 0.66, down: 0.34 });
  f.setNow(f.start + 45_000);
  f.setPrediction({
    candleStart: f.start - 60_000,
    candleCloseAt: f.start,
    writtenAt: f.start + 500,
    windowStart: f.start,
    pUp: 0.66,
    pDown: 0.34,
  });
  f.check('UP');
  f.bot.expireMarket(f.record, f.start + 300_000);
  assert.ok(f.bot.shadowEntries.every((entry) => entry.status === 'PENDING_RESOLUTION'));
  f.bot.settleMarket('test-market', 'UP', f.start + 302_000);
  assert.ok(f.bot.shadowEntries.every((entry) => entry.status === 'RESOLVED_WIN'));
  const tiers = f.bot.snapshot().shadowTiers;
  assert.ok(tiers.every((tier) => tier.wins === 1 && tier.resolved === 1));
  assert.ok(tiers.every((tier) => tier.realizedPnl > 0));
});

function shadowFixture(up = 0.7) {
  const f = fixture({ up, down: 1 - up });
  f.setNow(f.start + 45_000);
  for (const quote of Object.values(f.quotes)) {
    quote.bestAsk = 0.8;
    quote.asks = [{ price: 0.8, size: 1000 }];
  }
  return f;
}

function ask(f, side, price, levels = [{ price, size: 1000 }]) {
  Object.assign(f.quotes[side], { bestAsk: price, asks: levels });
}

test('each shadow enters above its former price cap when confidence qualifies', () => {
  for (const threshold of [55, 60, 65]) {
    const f = shadowFixture(threshold / 100 + 0.001);
    f.check('UP');
    const entry = f.bot.shadowEntries.find(e => e.thresholdPct === threshold);
    assert.ok(entry);
    assert.equal(entry.shares, 50);
    assert.equal(entry.entryPrice, 0.8);
    f.check('UP');
    assert.equal(f.bot.shadowEntries.filter(e => e.thresholdPct === threshold).length, 1);
  }
});

test('a previous qualifying score does not latch after confidence falls', () => {
  const f = shadowFixture();
  ask(f, 'UP', 0.8, []);
  f.check('UP');
  assert.equal(f.bot.shadowEntries.length, 0);
  f.setNow(f.start + 61_000);
  f.setPrediction({ candleStart: f.start, candleCloseAt: f.start + 60_000,
    writtenAt: f.start + 60_500, windowStart: f.start, pUp: 0.48, pDown: 0.52 });
  ask(f, 'UP', 0.54);
  f.check('UP');
  assert.equal(f.bot.shadowEntries.length, 0);
});

test('the current qualifying score selects the side without an old waiting signal', () => {
  const f = shadowFixture();
  ask(f, 'UP', 0.8, []);
  f.check('UP');
  f.setNow(f.start + 61_000);
  f.setPrediction({ candleStart: f.start, candleCloseAt: f.start + 60_000,
    writtenAt: f.start + 60_500, windowStart: f.start, pUp: 0.42, pDown: 0.58 });
  ask(f, 'UP', 0.5);
  f.check('UP');
  assert.equal(f.bot.shadowEntries.length, 0);
  ask(f, 'DOWN', 0.8);
  f.check('DOWN');
  assert.equal(f.bot.shadowEntries.length, 1);
  assert.equal(f.bot.shadowEntries.find(e => e.thresholdPct === 55).side, 'DOWN');
});

test('shadow sweeps cross the removed price cap using visible depth only', () => {
  const f = shadowFixture(0.56);
  ask(f, 'UP', 0.54, [{ price: 0.54, size: 10 }, { price: 0.55, size: 1000 }]);
  f.check('UP');
  assert.equal(f.bot.shadowEntries.length, 1);
  assert.equal(f.bot.shadowEntries[0].shares, 50);
  assert.equal(f.bot.shadowEntries[0].fills.length, 2);
  assert.ok(Math.abs(f.bot.shadowEntries[0].entryPrice - 0.548) < 1e-9);
});

test('an old prediction cannot trigger a different window', () => {
  const f = shadowFixture();
  f.setNow(f.start + 345_000);
  f.record.market = { ...f.record.market, id: 'next-market',
    start: f.start + 300_000, end: f.start + 600_000 };
  ask(f, 'UP', 0.5);
  f.check('UP');
  assert.equal(f.bot.shadowEntries.length, 0);
});

test('stale books cannot fill shadow entries', () => {
  const f = shadowFixture();
  ask(f, 'UP', 0.5);
  f.quotes.UP.updatedAt = f.start;
  f.check('UP');
  assert.equal(f.bot.shadowEntries.length, 0);
});

test('restart preserves all history and totals while ignoring obsolete price-gate latches', () => {
  const f = shadowFixture();
  f.check('UP');
  f.bot.shadowTotals[55] = { entries: 50, resolved: 50, wins: 30,
    losses: 20, fees: 21, realizedPnl: 42 };
  const ledger = f.bot.exportLedger();
  ledger.snapshot.shadowSignals = [{ marketId: 'test-market', windowStart: f.start,
    windowEnd: f.start + 300_000, thresholdPct: 55, side: 'DOWN', probability: 0.9 }];
  const next = shadowFixture();
  next.bot.restoreLedger(ledger);
  assert.equal(next.bot.exportLedger().snapshot.shadowSignals, undefined);
  assert.deepEqual(next.bot.shadowTotals[55], f.bot.shadowTotals[55]);
  const history = bot => bot.shadowEntries.map(({ id, shares, entryPrice, totalCost, fees }) =>
    ({ id, shares, entryPrice, totalCost, fees }));
  assert.deepEqual(history(next.bot), history(f.bot));
  next.check('UP');
  assert.equal(next.bot.shadowEntries.length, 3);
  const afterFill = next.bot.exportLedger();
  const third = shadowFixture();
  third.bot.restoreLedger(afterFill);
  ask(third, 'UP', 0.5);
  third.check('UP');
  assert.equal(third.bot.shadowEntries.length, 3);
  assert.equal(third.bot.shadowTotals[55].entries, 50);
});

