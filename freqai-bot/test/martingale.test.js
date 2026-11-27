'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const Bot = require('../freqai-martingale-btc-bot');
const sizing = require('../martingale-sizing');
const { planTakerBuy } = require('../taker-fill');
const { restoreOrResetLedger } = require('../index');
const W = 300000, START = 1800000000000;

function fixture(capital = 3000) {
  let now = START + 60000, raw, bookReply = null;
  const lookedUp = [];
  const bot = new Bot({ initialCapital: capital, now: () => now, marketData: {},
    freqaiWorker: { snapshot: () => ({ status: 'READY', lastPrediction: raw }) },
    getOrderBook: async token => {
      lookedUp.push(token);
      if (bookReply instanceof Error) throw bookReply;
      return typeof bookReply === 'function' ? bookReply(token, now) : bookReply;
    } });
  const r = bot.records.get('BTC:5m');
  const quote = (bid = .59, ask = .6, at = now) => {
    for (const side of ['UP', 'DOWN']) r.quotes[side] = { bestBid: bid, bestAsk: ask,
      mid: bid == null || ask == null ? null : (bid + ask) / 2,
      asks: ask == null ? [] : [{ price: ask, size: 10000 }], updatedAt: at,
      tokenId: r.market.tokens[side], marketId: r.market.id, windowStart: r.market.start };
  };
  const open = n => {
    now = START + n * W + 60000;
    r.marketStatus = 'OPEN';
    r.market = { id: `m${n}`, slug: `btc-${n}`, start: START + n * W,
      end: START + (n + 1) * W, tokens: { UP: `up${n}`, DOWN: `down${n}` },
      feeSchedule: { rate: .05 } };
    raw = { windowStart: r.market.start, candleStart: r.market.start,
      candleCloseAt: now, writtenAt: now, pUp: .7, pDown: .3 };
    quote();
  };
  open(0);
  return { bot, r, open, quote, lookedUp, now: () => now,
    time: t => { now = t; },
    reply: b => { bookReply = b; },
    score: p => { raw.pUp = p; raw.pDown = 1 - p; raw.candleCloseAt = now; raw.writtenAt = now; },
    buy: () => { bot.processSide(r, 'UP', r.quotes.UP, 1); return bot.shadowEntries[0]; },
    end: (outcome = 'LOSS', age = 0) => {
      now = r.market.end;
      if (outcome === 'LOSS') quote(.005, .015, now - age);
      else if (outcome === 'WIN') quote(.985, .995, now - age);
      else quote(.49, .51, now - age);
      bot.expireMarket(r, now);
    },
  };
}

test('strict midpoint boundaries, including missing and non-finite marks', () => {
  for (const mid of [null, undefined, NaN, .02, .98, .5, -1, 2]) assert.equal(sizing.outcomeForMid(mid), null);
  assert.equal(sizing.outcomeForMid(.019999), 'LOSS');
  assert.equal(sizing.outcomeForMid(.980001), 'WIN');
});

test('100/200/400/800 recovery, every intervening window trades base, then capped loss resets', () => {
  const f = fixture(), requested = [];
  for (let n = 0; n < 8; n++) {
    f.open(n); const e = f.buy(); requested.push(e.requestedShares);
    assert.equal(e.recoveryRole, [2, 4, 6].includes(n) ? 'RECOVERY' : 'BASE');
    f.end();
  }
  assert.deepEqual(requested, [100, 100, 200, 100, 400, 100, 800, 100]);
  assert.equal(f.bot.shadowEntries.find(e => e.requestedShares === 800).sizingEffect, 'MAXIMUM_LOSS_RESET_TO_100');
  assert.ok(f.bot.availablePaperCash() >= 0);
  assert.equal(f.bot.shadowTotals[58].realizedPnl, 0);
});

test('an intervening base win cancels recovery; base loss never advances or postpones it', () => {
  const f = fixture(); f.buy(); f.end();
  const eligible = f.bot.recovery.eligibleWindowStart;
  f.open(1); const base = f.buy(); f.end();
  assert.equal(base.sizingEffect, 'INTERVENING_BASE_LOSS_NO_CHANGE');
  assert.equal(f.bot.recovery.step, 1); assert.equal(f.bot.recovery.eligibleWindowStart, eligible);
  const g = fixture(); g.buy(); g.end(); g.open(1); g.buy(); g.end('WIN');
  assert.equal(g.bot.recovery.step, 0);
  g.open(2); assert.equal(g.buy().requestedShares, 100);
});

test('unknown marks never block base entries, including while a recovery result is pending', () => {
  const f = fixture(); f.buy(); f.end('UNKNOWN');
  f.open(1); assert.equal(f.buy().requestedShares, 100);
  assert.equal(f.bot.recovery.step, 0);
  const g = fixture(); g.buy(); g.end(); g.open(2); assert.equal(g.buy().requestedShares, 200);
  g.end('UNKNOWN'); assert.equal(g.bot.recovery.step, 1);
  assert.ok(g.bot.recovery.awaitingEntryId);
  g.open(3); assert.equal(g.buy().requestedShares, 100);
  g.open(4); assert.equal(g.buy().requestedShares, 100);
  assert.equal(g.bot.snapshot().recovery.phase, 'WAITING_RESULT');
});

test('a recovery win resets, but mark guesses neither release cash nor create realized P&L', () => {
  const f = fixture(); f.buy(); f.end(); f.open(2); const e = f.buy();
  const cash = f.bot.availablePaperCash();
  f.end('WIN');
  assert.equal(e.sizingOutcome, 'WIN'); assert.equal(e.status, 'PENDING_RESOLUTION');
  assert.equal(f.bot.recovery.step, 0);
  assert.equal(f.bot.availablePaperCash(), cash);
  assert.equal(f.bot.shadowTotals[58].realizedPnl, 0);
  f.bot.settleMarket('m2', 'UP', f.now());
  assert.ok(Math.abs(e.realizedPnl - 77.6) < 1e-8);
  assert.equal(e.sizingSource, 'MARK');
  assert.equal(f.bot.recovery.step, 0);
});

test('missing, crossed, wrong-market and stale quotes never imply a win or loss', () => {
  for (const kind of ['missing', 'crossed', 'stale', 'token', 'market', 'window']) {
    const f = fixture(); const e = f.buy(); f.time(f.r.market.end);
    f.quote(.005, .015);
    if (kind === 'missing') f.r.quotes.UP.bestBid = null;
    if (kind === 'crossed') f.r.quotes.UP.bestBid = .9;
    if (kind === 'stale') f.r.quotes.UP.updatedAt -= 5001;
    if (kind === 'token') f.r.quotes.UP.tokenId = 'other';
    if (kind === 'market') f.r.quotes.UP.marketId = 'other';
    if (kind === 'window') f.r.quotes.UP.windowStart -= W;
    f.bot.expireMarket(f.r, f.now());
    assert.equal(e.sizingOutcome, undefined, kind);
  }
});

test('a clear intra-window mark alone cannot advance sizing before expiry', () => {
  const f = fixture(); const e = f.buy(); f.quote(.005, .015);
  f.bot.processSide(f.r, 'UP', f.r.quotes.UP, 2);
  assert.equal(e.sizingMidpoint, .01);
  assert.equal(e.sizingOutcome, undefined); assert.equal(f.bot.recovery.step, 0);
  f.end('UNKNOWN'); assert.equal(e.sizingOutcome, undefined);
});

test('pending book lookup uses the original token after rollover and is throttled', async () => {
  const f = fixture(); const old = f.buy(); f.end('UNKNOWN'); f.open(1); f.buy();
  f.reply((token, now) => ({ asset_id: token, timestamp: String(now),
    bids: [{ price: '.005', size: '100' }], asks: [{ price: '.015', size: '100' }] }));
  await f.bot.pollUnclearMarks(f.now());
  assert.deepEqual(f.lookedUp, ['up0']);
  assert.equal(old.sizingOutcome, 'LOSS'); assert.equal(old.sizingMarkSource, 'PENDING_WINDOW_CLOB');
  assert.equal(f.bot.recovery.step, 1);
  await f.bot.pollUnclearMarks(f.now()); assert.equal(f.lookedUp.length, 1);
});

test('failed or empty pending books stay unknown while base trading and official settlement can resolve', async () => {
  const f = fixture(); const old = f.buy(); f.end('UNKNOWN'); f.open(1);
  f.reply(new Error('temporary book outage')); await f.bot.pollUnclearMarks(f.now());
  assert.match(old.markLookupError, /outage/); assert.equal(old.sizingOutcome, undefined);
  assert.equal(f.buy().requestedShares, 100);
  f.bot.settleMarket('m0', 'DOWN', f.now());
  assert.equal(old.sizingOutcome, 'LOSS'); assert.equal(old.sizingSource, 'OFFICIAL_SETTLEMENT');
  assert.equal(f.bot.recovery.step, 1);
  const g = fixture(); const empty = g.buy(); g.end('UNKNOWN');
  g.reply({ timestamp: g.now(), bids: [], asks: [] }); await g.bot.pollUnclearMarks(g.now());
  assert.equal(empty.sizingOutcome, undefined);
});

test('official settlement cannot count a guessed loss twice, even if the guess was wrong', () => {
  const f = fixture(); const e = f.buy(); f.end();
  const state = structuredClone(f.bot.recovery);
  f.bot.settleMarket('m0', 'UP', f.now());
  f.bot.settleMarket('m0', 'UP', f.now() + 1);
  assert.deepEqual(f.bot.recovery, state);
  assert.equal(e.sizingDisagreesWithSettlement, true);
  assert.ok(Math.abs(e.realizedPnl - 38.8) < 1e-8);
});

test('late results from cancelled or older cycles cannot resurrect recovery', () => {
  const f = fixture(); const a = f.buy(); f.end('UNKNOWN');
  f.open(1); f.buy(); f.end('WIN');
  f.bot.decide(a, 'LOSS', 'MARK', f.now());
  assert.equal(f.bot.recovery.step, 0);
  assert.equal(a.sizingEffect, 'OLD_CYCLE_NO_CHANGE');
  const g = fixture(); g.buy(); g.end(); g.open(2); const recovery = g.buy(); g.end('UNKNOWN');
  g.open(3); g.buy(); g.end('WIN');
  g.bot.decide(recovery, 'LOSS', 'MARK', g.now());
  assert.equal(g.bot.recovery.step, 0);
});

test('restart preserves pending recovery size, pause, cash, outcomes and one entry per window', () => {
  const f = fixture(); f.buy(); f.end(); f.open(2); f.buy();
  const ledger = JSON.parse(JSON.stringify(f.bot.exportLedger()));
  const r = fixture(); r.open(2); r.bot.restoreLedger(ledger);
  assert.deepEqual(r.bot.recovery, f.bot.recovery);
  assert.equal(r.bot.availablePaperCash(), f.bot.availablePaperCash());
  r.buy(); assert.equal(r.bot.shadowEntries.length, 2);
  r.end(); assert.equal(r.bot.recovery.step, 2);
  r.open(3); assert.equal(r.buy().requestedShares, 100);
  r.end(); r.open(4); assert.equal(r.buy().requestedShares, 400);
  ledger.snapshot.recovery.step = 4;
  assert.throws(() => fixture().bot.restoreLedger(ledger), /Invalid saved martingale/);
});

test('requested recovery size uses real depth, partial-fill cancellation, fees and available capital', () => {
  const f = fixture(); f.buy(); f.end(); f.open(2);
  f.r.quotes.UP.asks = [{ price: .6, size: 30 }];
  const e = f.buy();
  assert.equal(e.requestedShares, 200); assert.equal(e.shares, 30);
  assert.equal(e.cancelledShares, 170); assert.equal(e.fees, .36);
  f.buy(); assert.equal(f.bot.shadowEntries.length, 2);
  assert.throws(() => planTakerBuy(f.r, 'UP', f.now(), 3000, 1600), /Invalid requested/);
  const poor = fixture(70); poor.buy(); poor.end(); poor.open(2); poor.buy();
  assert.equal(poor.bot.shadowEntries.length, 1);
});

test('signals, minimum delay and hold-to-resolution exits remain unchanged', () => {
  const f = fixture(); f.time(START + 44999); f.quote(); f.buy();
  assert.equal(f.bot.shadowEntries.length, 0);
  f.time(START + 45000); f.quote(); f.score(.58); f.buy();
  assert.equal(f.bot.shadowEntries.length, 0);
  f.score(.7); const e = f.buy();
  f.score(.01); f.buy(); f.bot.checkTakeProfits(); f.bot.checkStopLosses();
  assert.equal(f.bot.shadowEntries.length, 1); assert.equal(e.status, 'OPEN');
});

test('strategy change resets old history once; a new strategy ledger restores normally', async () => {
  const f = fixture(); let archives = 0;
  f.bot.ledgerStore = { archive: async () => { archives++; } };
  f.bot.flushLedger = async () => {};
  assert.equal(await restoreOrResetLedger(f.bot, { strategyId: 'prior-flat-taker' }, Bot.STRATEGY.id), 'reset');
  assert.equal(archives, 1); assert.equal(f.bot.availablePaperCash(), 3000);
  assert.equal(f.bot.recovery.step, 0);
  assert.equal(await restoreOrResetLedger(f.bot, f.bot.exportLedger(), Bot.STRATEGY.id), 'restored');
  assert.equal(archives, 1);
});

test('dashboard shows actual recovery size, role, outcome source and recovery state', async () => {
  const f = fixture(); f.buy(); f.end(); f.open(2); f.buy();
  const html = fs.readFileSync(path.join(__dirname, '../public/freqai-dashboard.html'), 'utf8');
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];
  const elements = new Map();
  const element = () => ({ textContent: '', innerHTML: '', className: '', style: {}, dataset: {},
    addEventListener() {}, setAttribute() {}, classList: { add() {}, remove() {} },
    querySelectorAll() { return []; }, querySelector() { return {}; } });
  vm.runInNewContext(script, {
    document: { getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); },
      addEventListener() {}, visibilityState: 'visible' },
    fetch: async () => ({ ok: true, json: async () => f.bot.snapshot() }),
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    AbortController, Date, Intl, console, navigator: { onLine: true }, window: { addEventListener() {} },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.notEqual(elements.get('status')?.textContent, 'OFFLINE');
  assert.equal(elements.get('currentShares').textContent, '200 shares');
  assert.match(elements.get('restingOrders').innerHTML, /200 \/ 200 filled/);
  assert.match(elements.get('restingOrders').innerHTML, /RECOVERY/);
  assert.match(elements.get('recoveryState').textContent, /step 1\/3/);
  assert.match(elements.get('shadowEntries').innerHTML, /sizing result LOSS/);
  assert.match(html, /strictly above \$0\.98/);
  assert.match(html, /strictly below \$0\.02/);
});

test('production WebSocket entry path uses the 200-share recovery plan immediately', () => {
  const f = fixture(); f.buy(); f.end(); f.open(2);
  f.bot.tokenRefs.set('up2', { recordKey: 'BTC:5m', side: 'UP' });
  f.bot.handleMarketMessage({ event_type: 'book', asset_id: 'up2', timestamp: String(f.now()),
    bids: [{ price: '.59', size: '1000' }], asks: [{ price: '.6', size: '1000' }] });
  assert.equal(f.bot.shadowEntries[0].requestedShares, 200);
  assert.equal(f.bot.shadowEntries[0].shares, 200);
  assert.equal(f.bot.shadowEntries[0].recoveryRole, 'RECOVERY');
  assert.equal(f.bot.shadowEntries[0].fees, 2.4);
});

test('real market-rollover lifecycle captures the ended mark before clearing its book', async () => {
  const f = fixture(); const e = f.buy();
  f.r.targetStart = START; f.time(START + W); f.quote(.005, .015);
  f.bot.marketData = { getAssetMarket: async () => ({
    id: 'next-market', start: START + W, end: START + 2 * W,
    tokens: { UP: 'next-up', DOWN: 'next-down' },
  }) };
  await f.bot.refreshMarket(f.r, f.now());
  assert.equal(e.sizingOutcome, 'LOSS');
  assert.equal(e.status, 'PENDING_RESOLUTION');
  assert.equal(f.r.market.id, 'next-market');
  assert.equal(f.r.quotes.UP.mid, null);
  assert.equal(f.bot.entrySizing(f.r).requestedShares, 100);
  assert.equal(f.bot.recovery.step, 1);
});

test('HTTP dashboard state exposes recovery sizing without inventing realized profit', async t => {
  const f = fixture(); f.buy(); f.end(); f.open(2); f.buy();
  const server = require('../server')(f.bot, 0);
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const root = `http://127.0.0.1:${server.address().port}`;
  const state = await (await fetch(root + '/api/state')).json();
  assert.equal(state.strategy.id, Bot.STRATEGY.id);
  assert.equal(state.recovery.step, 1);
  assert.equal(state.shadowSizing.currentShares, 200);
  assert.equal(state.shadowAccount.realizedPnl, 0);
  assert.equal(state.shadowTakerOrders[0].requestedShares, 200);
  const html = await (await fetch(root + '/')).text();
  assert.match(html, /id="recoveryState"/);
});
