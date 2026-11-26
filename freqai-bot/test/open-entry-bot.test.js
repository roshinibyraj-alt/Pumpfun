'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const Bot = require('../freqai-open-entry-bot');
const { restoreOrResetLedger } = require('../index');

function fixture({ capital = 3000 } = {}) {
  const start = 1_800_000_000_000;
  let now = start + 45_000;
  let prediction = {
    candleStart: start - 60_000, candleCloseAt: start,
    writtenAt: start, windowStart: start, pUp: 0.7, pDown: 0.3,
    model: 'LightGBMClassifier',
  };
  const bot = new Bot({ now: () => now, marketData: {}, initialCapital: capital,
    freqaiWorker: { snapshot: () => ({ status: 'READY', lastPrediction: prediction }) } });
  const record = bot.records.get('BTC:5m');
  record.marketStatus = 'OPEN';
  record.market = {
    id: 'market', slug: 'btc-updown-5m-test', title: 'Test BTC',
    start, end: start + 300000, tokens: { UP: 'up', DOWN: 'down' },
    tickSize: 0.01, feesEnabled: true, feeSchedule: { rate: 0.05 },
  };
  for (const side of ['UP', 'DOWN']) {
    record.quotes[side] = {
      bestAsk: 0.7, bestBid: 0.69, asks: [{ price: 0.7, size: 1000 }],
      bids: [{ price: 0.69, size: 1000 }], updatedAt: now, sequence: 1,
      tokenId: record.market.tokens[side], marketId: 'market', windowStart: start,
    };
  }
  return {
    bot, record, start,
    now: () => now,
    time: value => { now = value; },
    score: (up, down = 1 - up) => { prediction = {
      ...prediction, pUp: up, pDown: down, candleStart: now - 60000,
      candleCloseAt: now, writtenAt: now,
    }; },
    book: (side, ask, size = 1000) => {
      const q = record.quotes[side];
      Object.assign(q, { bestAsk: ask, bestBid: ask == null ? null : ask - 0.01,
        asks: ask == null ? [] : [{ price: ask, size }], updatedAt: now, sequence: q.sequence + 1 });
    },
    check: () => { bot.processSide(record, 'UP', record.quotes.UP, record.quotes.UP.sequence); },
    advance: ms => { now += ms; },
  };
}

function place(f) { f.check(); return f.bot.shadowRestingOrders[0]; }
function fill(f, side = 'UP', amount = 100) {
  f.advance(10); f.book(side, 0.59, amount); f.check();
}

test('qualifying signal places exactly 100 shares at ask minus 0.10 without immediate execution', () => {
  const f = fixture(); const o = place(f);
  assert.equal(o.requestedShares, 100); assert.equal(o.limitPrice, 0.6);
  assert.equal(o.status, 'RESTING'); assert.equal(f.bot.shadowEntries.length, 0);
  assert.equal(f.bot.shadowSizing.currentShares, 100);
  assert.equal(f.bot.snapshot().restingOrderSummary.reservedCash, 60);
  assert.equal(f.bot.snapshot().shadowAccount.availableCash, 2940);
});

test('no orders before 45 seconds or at exactly 58% confidence', () => {
  const f = fixture(); f.time(f.start + 44999); f.check();
  assert.equal(f.bot.shadowRestingOrders.length, 0);
  f.time(f.start + 45000); f.score(0.58, 0.42); f.check();
  assert.equal(f.bot.shadowRestingOrders.length, 0);
  f.score(0.5801); f.check(); assert.equal(f.bot.shadowRestingOrders.length, 1);
});

test('same-side signals do not reprice even when ask moves or confidence strengthens', () => {
  const f = fixture(); const o = place(f);
  f.advance(1000); f.score(0.9); f.book('UP', 0.9); f.check();
  assert.equal(f.bot.shadowRestingOrders.length, 1); assert.equal(o.limitPrice, 0.6);
});

test('confidence falls or opposite 55% does not cancel an existing order', () => {
  const f = fixture(); const o = place(f);
  f.advance(1000); f.score(0.45); f.check();
  assert.equal(o.status, 'RESTING'); assert.equal(f.bot.shadowRestingOrders.length, 1);
});

test('opposite above 58% cancels remainder and places a new fixed opposite 100-share limit', () => {
  const f = fixture(); const old = place(f);
  f.advance(1000); f.score(0.3); f.book('DOWN', 0.82); f.check();
  const next = f.bot.shadowRestingOrders[0];
  assert.equal(old.status, 'CANCELLED_OPPOSITE_SIGNAL');
  assert.equal(old.cancelledShares, 100); assert.equal(old.remainingShares, 0);
  assert.equal(next.side, 'DOWN'); assert.equal(next.limitPrice, 0.72);
  assert.equal(next.remainingShares, 100); assert.equal(f.bot.shadowEntries.length, 0);
  assert.equal(f.bot.restingEngine.reserved(), 72);
});

test('opposite exactly 58% does not cancel', () => {
  const f = fixture(); const o = place(f); f.advance(1000); f.score(0.42, 0.58); f.check();
  assert.equal(o.status, 'RESTING');
});

test('strictly-through ask depth fills at the fixed maker price without maker fees', () => {
  const f = fixture(); const o = place(f); fill(f);
  const entry = f.bot.shadowEntries[0];
  assert.equal(o.status, 'FILLED'); assert.equal(entry.shares, 100);
  assert.equal(entry.entryPrice, 0.6); assert.equal(entry.totalCost, 60);
  assert.equal(entry.fees, 0); assert.equal(entry.fills[0].liquidity, 'MAKER');
  assert.equal(f.bot.shadowTotals[58].entries, 1);
});

test('bid touch or ask equality alone never fills a resting buy', () => {
  const f = fixture(); place(f);
  f.advance(10); f.book('UP', 0.6); f.record.quotes.UP.bestBid = 0.59; f.check();
  assert.equal(f.bot.shadowEntries.length, 0);
});

test('partial fill remains open and remainder remains resting', () => {
  const f = fixture(); const o = place(f); fill(f, 'UP', 40);
  assert.equal(o.status, 'PARTIAL'); assert.equal(o.remainingShares, 60);
  assert.equal(f.bot.shadowEntries[0].shares, 40);
  assert.equal(f.bot.restingEngine.reserved(), 36);
  assert.equal(f.bot.restingEngine.available(), 2940);
});

test('unchanged depth cannot be reused by ticks or bid-only updates; additional depth fills once', () => {
  const f = fixture(); const o = place(f); fill(f, 'UP', 40);
  f.check(); f.advance(10); f.book('UP', 0.59, 40); f.check();
  assert.equal(o.filledShares, 40);
  f.advance(10); f.book('UP', 0.59, 60); f.check();
  assert.equal(o.filledShares, 60);
  f.advance(10); f.book('UP', null); f.check();
  f.advance(10); f.book('UP', 0.59, 50); f.check();
  assert.equal(o.filledShares, 100);
  assert.equal(f.bot.shadowEntries.length, 1);
});

test('partial fill survives opposite cancellation; replacement still requests 100', () => {
  const f = fixture(); const o = place(f); fill(f, 'UP', 40);
  f.advance(10); f.score(0.2); f.book('DOWN', 0.8); f.check();
  assert.equal(o.status, 'CANCELLED_OPPOSITE_SIGNAL'); assert.equal(o.cancelledShares, 60);
  assert.equal(f.bot.shadowEntries[0].shares, 40); assert.equal(f.bot.shadowEntries[0].status, 'OPEN');
  assert.equal(f.bot.shadowRestingOrders[0].requestedShares, 100);
  f.advance(10); f.book('DOWN', 0.69); f.check();
  assert.equal(f.bot.shadowEntries.length, 2);
  assert.ok(f.bot.shadowEntries.every(e => e.status === 'OPEN'));
});

test('a fully filled order consumes the window; opposite signals never sell held shares', () => {
  const f = fixture(); place(f); fill(f);
  f.advance(1000); f.score(0.1); f.book('DOWN', 0.8); f.check();
  assert.equal(f.bot.shadowRestingOrders.length, 1);
  assert.equal(f.bot.shadowEntries[0].status, 'OPEN');
  assert.equal(f.bot.shadowEntries[0].shares, 100);
});

test('stale quotes and old token IDs cannot fill', () => {
  const f = fixture(); place(f); f.advance(5000);
  f.record.quotes.UP.bestAsk = 0.59; f.record.quotes.UP.asks = [{ price: 0.59, size: 1000 }]; f.check();
  assert.equal(f.bot.shadowEntries.length, 0);
  f.book('UP', 0.59); f.record.quotes.UP.tokenId = 'previous-window'; f.check();
  assert.equal(f.bot.shadowEntries.length, 0);
});

test('existing order may fill after the model score becomes stale; stale score cannot replace it', () => {
  const f = fixture(); const o = place(f);
  f.time(f.start + 120000); f.book('UP', 0.59); f.check();
  assert.equal(o.status, 'FILLED');
});

test('unfilled orders expire at the exact window boundary and release reserves', () => {
  const f = fixture(); const o = place(f);
  f.time(f.start + 300000); f.book('UP', 0.59); f.check();
  assert.equal(o.status, 'EXPIRED'); assert.equal(f.bot.shadowEntries.length, 0);
  assert.equal(f.bot.restingEngine.reserved(), 0);
  assert.equal(f.bot.restingEngine.available(), 3000);
});

test('expired partial inventory goes to official resolution, not a signal sale', () => {
  const f = fixture(); const o = place(f); fill(f, 'UP', 40);
  f.time(f.start + 300000); f.bot.expireMarket(f.record, f.now());
  assert.equal(o.status, 'EXPIRED');
  assert.equal(f.bot.shadowEntries[0].status, 'PENDING_RESOLUTION');
  f.bot.settleMarket('market', 'UP', f.now() + 10000);
  assert.equal(f.bot.shadowTotals[58].realizedPnl, 16);
  assert.equal(f.bot.shadowSizing.currentShares, 100);
});

test('flat sizing remains 100 after a win or loss and duplicate resolutions are ignored', () => {
  for (const winner of ['UP', 'DOWN']) {
    const f = fixture(); place(f); fill(f);
    f.time(f.start + 300000); f.bot.expireMarket(f.record, f.now());
    f.bot.settleMarket('market', winner, f.now() + 10000);
    const pnl = f.bot.shadowTotals[58].realizedPnl;
    assert.equal(pnl, winner === 'UP' ? 40 : -60);
    f.bot.settleMarket('market', winner, f.now() + 11000);
    assert.equal(f.bot.shadowTotals[58].realizedPnl, pnl);
    assert.equal(f.bot.shadowTotals[58].resolved, 1);
    assert.equal(f.bot.shadowSizing.currentShares, 100);
  }
});

test('restart preserves fixed price, partial inventory and consumed book liquidity', () => {
  const f = fixture(); place(f); fill(f, 'UP', 40);
  const ledger = f.bot.exportLedger();
  const restored = fixture(); restored.time(f.now() + 10);
  restored.bot.restoreLedger(ledger); restored.book('UP', 0.59, 40); restored.check();
  const o = restored.bot.shadowRestingOrders[0];
  assert.equal(o.limitPrice, 0.6); assert.equal(o.filledShares, 40);
  assert.equal(o.remainingShares, 60); assert.equal(restored.bot.shadowEntries[0].shares, 40);
});

test('restart after expiry cancels old orders and never applies them to a new window', () => {
  const f = fixture(); place(f); const ledger = f.bot.exportLedger();
  const restored = fixture(); restored.time(f.start + 301000);
  restored.bot.restoreLedger(ledger);
  assert.equal(restored.bot.shadowRestingOrders[0].status, 'EXPIRED');
  assert.equal(restored.bot.restingEngine.reserved(), 0);
  restored.record.market.start += 300000; restored.record.market.end += 300000;
  restored.book('UP', 0.59); restored.check();
  assert.equal(restored.bot.shadowEntries.length, 0);
});

test('zero or negative ask-minus-offset is skipped instead of clamped to a fake price', () => {
  const f = fixture(); f.book('UP', 0.1); f.check();
  assert.equal(f.bot.shadowRestingOrders.length, 0);
});

test('limits obey market tick precision', () => {
  const f = fixture(); f.book('UP', 0.725); const o = place(f);
  assert.equal(o.limitPrice, 0.62);
});

test('paper capital cannot be overcommitted', () => {
  const f = fixture({ capital: 50 }); f.check();
  assert.equal(f.bot.shadowRestingOrders.length, 0);
  assert.match(f.record.sideStates.UP.reason, /Insufficient/);
});

test('new strategy archives old ledger and resets history, capital and sizing exactly once', async () => {
  const f = fixture(); let archived = 0, saved;
  f.bot.ledgerStore = { archive: async () => { archived++; }, save: async v => { saved = v; } };
  const old = { strategyId: 'pumpfun-btc-5m-freqai-open-score-paper-v2',
    snapshot: { strategy: { id: 'pumpfun-btc-5m-freqai-open-score-paper-v2' } } };
  assert.equal(await restoreOrResetLedger(f.bot, old, Bot.STRATEGY.id), 'reset');
  assert.equal(archived, 1); assert.equal(saved.snapshot.shadowEntries.length, 0);
  assert.equal(saved.snapshot.shadowSizing.currentShares, 100);
  assert.equal(saved.snapshot.shadowAccount.initialCapital, 3000);
  assert.equal(saved.snapshot.shadowAccount.realizedPnl, 0);
  assert.equal(await restoreOrResetLedger(f.bot, saved, Bot.STRATEGY.id), 'restored');
  assert.equal(archived, 1);
});

test('corrupt saved size or orders fail explicitly', () => {
  const f = fixture(); const ledger = f.bot.exportLedger();
  ledger.snapshot.shadowSizing.currentShares = 200;
  assert.throws(() => f.bot.restoreLedger(ledger), /Invalid saved flat/);
});

test('production CLOB message path places and fills the new limit, not the archived taker strategy', () => {
  const f = fixture();
  f.bot.tokenRefs.set('up', { recordKey: 'BTC:5m', side: 'UP' });
  const send = (ask, size) => f.bot.handleMarketMessage({
    event_type: 'book', asset_id: 'up', timestamp: String(f.now()),
    bids: [{ price: String(ask - 0.01), size: '1000' }],
    asks: [{ price: String(ask), size: String(size) }],
  });
  send(0.7, 1000);
  assert.equal(f.bot.shadowRestingOrders[0].limitPrice, 0.6);
  assert.equal(f.bot.shadowEntries.length, 0);
  f.advance(10); send(0.59, 100);
  assert.equal(f.bot.shadowEntries[0].shares, 100);
  assert.equal(f.bot.shadowRestingOrders[0].status, 'FILLED');
  assert.equal(f.record.sideStates.UP.orderStatus, 'FILLED');
  assert.equal(f.bot.orders.length, 0, 'archived taker orders never execute');
});
