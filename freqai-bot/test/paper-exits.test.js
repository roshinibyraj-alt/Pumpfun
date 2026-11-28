'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Bot = require('../freqai-martingale-btc-bot');
const W = 300000, START = 1800000000000;

function fixture() {
  let now = START + 60000, reply;
  const bot = new Bot({ now: () => now, marketData: {}, paperExecutionDelayMs: 0,
    getOrderBook: async () => reply,
    freqaiWorker: { snapshot: () => ({ status: 'READY', lastPrediction: {
      windowStart: Math.floor(now / W) * W, candleStart: Math.floor(now / W) * W,
      candleCloseAt: now, writtenAt: now, pUp: .7, pDown: .3,
    } }) },
  });
  const record = bot.records.get('BTC:5m');
  function open(n = 0) {
    now = START + n * W + 60000;
    record.marketStatus = 'OPEN';
    record.market = { id: `m${n}`, start: START + n * W, end: START + (n + 1) * W,
      tokens: { UP: `up${n}`, DOWN: `down${n}` }, feeSchedule: { rate: .05 } };
    quote(.59, .6);
  }
  function quote(bid, ask, at = now) {
    for (const side of ['UP', 'DOWN']) record.quotes[side] = {
      tokenId: record.market.tokens[side], marketId: record.market.id,
      windowStart: record.market.start, bestBid: bid, bestAsk: ask, updatedAt: at,
      bids: bid == null ? [] : [{ price: bid, size: 10000 }],
      asks: ask == null ? [] : [{ price: ask, size: 10000 }],
    };
  }
  open();
  return { bot, record, open, quote, now: () => now, time: t => { now = t; },
    reply: b => { reply = b; },
    buy: () => { bot.processShadowEntries(record); return bot.shadowEntries[0]; },
    observe: () => bot.observeRecordMarks(record, now) };
}

test('intra-window TP credits modeled $1, fees retained, and repeated quotes cannot pay again', () => {
  const f = fixture(), e = f.buy(), initialCash = f.bot.availablePaperCash();
  f.time(f.now() + 1000); f.quote(.99, .999); f.observe();
  assert.equal(e.exitReason, 'PAPER_TP');
  assert.equal(e.exitPrice, 1); assert.equal(e.triggerBid, .99);
  assert.equal(e.resolutionWinner, undefined, 'A paper TP is not official settlement');
  assert.equal(e.realizedPnl, 50 - e.totalCost - e.fees);
  assert.ok(e.resolvedAt < e.windowEnd);
  assert.equal(f.bot.availablePaperCash(), initialCash + 50);
  assert.equal(e.sizingSource, 'PAPER_TP');
  const recovery = structuredClone(f.bot.recovery);
  f.observe(); f.bot.settleMarket('m0', 'DOWN', f.now() + W);
  assert.equal(f.bot.shadowTotals[58].resolved, 1);
  assert.deepEqual(f.bot.recovery, recovery);
  assert.equal(f.bot.snapshot().shadowAccount.openPositions, 0);
});

test('SL credits actual one-cent bid sale net of fees, with recovery only next window', () => {
  const f = fixture(), e = f.buy();
  f.time(f.now() + 1000); f.quote(.01, .02); f.observe();
  assert.equal(e.exitReason, 'TAKER_SL');
  assert.equal(e.triggerBid, .01);
  assert.equal(e.exitPayout, .01); assert.ok(Math.abs(e.realizedPnl - (.5 - .02475 - 30.6)) < 1e-8);
  assert.equal(f.bot.recovery.active, true);
  assert.equal(f.bot.recovery.eligibleWindowStart, START + W);
  assert.equal(f.bot.entrySizing(f.record).role, 'BASE');
  f.buy(); assert.equal(f.bot.shadowEntries.length, 1);
  f.open(1); const next = f.buy();
  assert.equal(next.recoveryRole, 'RECOVERY'); assert.equal(next.shares, 104);
});

test('TP checks bid, not ask or midpoint; SL does not fire above the entry-derived stop', () => {
  const f = fixture(), e = f.buy();
  for (const [bid, ask] of [[.98, 1], [.200001, .21], [.989, .999]]) {
    f.quote(bid, ask); f.observe(); assert.equal(e.status, 'OPEN');
    assert.equal(e.sizingOutcome, undefined);
  }
  f.quote(.99, null); f.observe();
  assert.equal(e.exitReason, 'PAPER_TP', 'A valid one-sided bid can trigger TP');
});

test('empty, crossed, stale, pre-entry and future quotes cannot become terminal outcomes', () => {
  for (const invalid of ['empty', 'crossed', 'stale', 'preEntry', 'future', 'token', 'market', 'window']) {
    const f = fixture(), e = f.buy();
    f.time(f.now() + 10000); f.quote(.99, 1);
    const q = f.record.quotes.UP;
    if (invalid === 'empty') { q.bestBid = null; q.bids = []; }
    if (invalid === 'crossed') q.bestAsk = .98;
    if (invalid === 'stale') q.updatedAt = f.now() - 5001;
    if (invalid === 'preEntry') q.updatedAt = e.entryAt - 1;
    if (invalid === 'future') q.updatedAt = f.now() + 1001;
    if (invalid === 'token') q.tokenId = 'other';
    if (invalid === 'market') q.marketId = 'other';
    if (invalid === 'window') q.windowStart -= W;
    f.observe(); assert.equal(e.status, 'OPEN', invalid);
    assert.equal(e.sizingOutcome, undefined, invalid);
  }
});

test('next-window quotes cannot close an old token; its fresh pending-token book can', async () => {
  const f = fixture(), e = f.buy();
  f.time(START + W); f.quote(.4, .5); f.bot.expireMarket(f.record, f.now());
  f.open(1); f.quote(.99, 1); f.observe();
  assert.equal(e.status, 'PENDING_RESOLUTION');
  f.reply({ asset_id: 'up0', timestamp: String(f.now()),
    bids: [{ price: '.99', size: '50' }], asks: [] });
  await f.bot.pollUnclearMarks(f.now());
  assert.equal(e.exitReason, 'PAPER_TP');
  assert.equal(e.sizingMarkSource, 'PENDING_WINDOW_CLOB');
});

test('empty or wrong-token pending books remain pending; official settlement is fallback', async () => {
  const f = fixture(), e = f.buy();
  f.time(START + W); f.quote(null, null); f.bot.expireMarket(f.record, f.now());
  f.reply({ asset_id: 'up0', timestamp: String(f.now()), bids: [], asks: [] });
  await f.bot.pollUnclearMarks(f.now());
  assert.equal(e.sizingOutcome, undefined);
  f.time(f.now() + 5000);
  f.reply({ asset_id: 'wrong', timestamp: String(f.now()), bids: [{ price: '.99', size: 50 }] });
  await f.bot.pollUnclearMarks(f.now());
  assert.equal(e.status, 'PENDING_RESOLUTION');
  f.bot.settleMarket('m0', 'DOWN', f.now());
  assert.equal(e.exitReason, 'OFFICIAL_RESOLUTION');
  assert.equal(e.sizingSource, 'OFFICIAL_SETTLEMENT');
  assert.equal(e.realizedPnl, -30.6);
});

test('paper closes, recovery and historical official payouts survive restart without duplication', () => {
  const f = fixture(), e = f.buy();
  f.quote(.19, .20); f.observe();
  f.open(1); const next = f.buy();
  f.time(next.windowEnd); f.quote(null, null);
  f.bot.expireMarket(f.record, f.now());
  f.bot.settleMarket('m1', 'UP', f.now());
  const ledger = JSON.parse(JSON.stringify(f.bot.exportLedger()));
  const g = fixture(); g.time(f.now()); g.bot.restoreLedger(ledger);
  assert.deepEqual(g.bot.recovery, f.bot.recovery);
  assert.deepEqual(g.bot.shadowTotals, f.bot.shadowTotals);
  assert.equal(g.bot.availablePaperCash(), f.bot.availablePaperCash());
  assert.equal(g.bot.shadowEntries.find(p => p.id === e.id).exitReason, 'TAKER_SL');
  g.bot.settleMarket('m0', 'UP', f.now());
  assert.deepEqual(g.bot.shadowTotals, f.bot.shadowTotals);
});

test('WebSocket production path recognizes intra-window TP', () => {
  const f = fixture(), e = f.buy();
  f.bot.tokenRefs.set('up0', { recordKey: 'BTC:5m', side: 'UP' });
  f.bot.handleMarketMessage({ event_type: 'book', asset_id: 'up0', timestamp: String(f.now()),
    bids: [{ price: '.99', size: '1000' }], asks: [{ price: '.999', size: '1000' }] });
  assert.equal(e.exitReason, 'PAPER_TP');
});

test('WebSocket production path executes low-bid SL sales once with actual fees', () => {
  for (const bid of [.01, .009, .001]) {
    const f = fixture(), e = f.buy();
    f.bot.tokenRefs.set('up0', { recordKey: 'BTC:5m', side: 'UP' });
    const message = { event_type: 'book', asset_id: 'up0', timestamp: String(f.now()),
      bids: [{ price: String(bid), size: '1000' }], asks: [{ price: '.02', size: '1000' }] };
    f.bot.handleMarketMessage(message); f.bot.handleMarketMessage(message);
    assert.equal(e.exitReason, 'TAKER_SL'); assert.equal(e.triggerBid, bid);
    assert.equal(e.exitPrice, bid);
    const fee = Number((50 * .05 * bid * (1 - bid)).toFixed(5));
    assert.ok(Math.abs(e.realizedPnl - (50 * bid - 30.6 - fee)) < 1e-8);
    assert.equal(f.bot.shadowTotals[58].resolved, 1);
  }
});

test('current dashboard keeps orders last and describes realistic fixed SL sales', () => {
  const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '../public/freqai-dashboard.html'), 'utf8');
  const main = html.split('</main>')[0], card = main.indexOf('id="takerBuyOrdersCard"');
  assert.ok(card > main.indexOf('class="strategy"'));
  assert.ok(card > main.indexOf('id="events"'));
  assert.equal(main.indexOf('<section', card), -1);
  assert.match(main, /Fixed \$0\.60 SL sells at actual bids/);
  const CurrentBot = require('../price-resting-btc-bot');
  assert.equal(CurrentBot.STRATEGY.stopLossBid, .6);
  assert.equal(CurrentBot.STRATEGY.stopLossTiers, null);
});
