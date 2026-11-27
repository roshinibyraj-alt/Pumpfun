'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const Engine = require('../rebound/engine');
const W = 300000, START = 1800000000000;
function fixture() {
  let now = START + 1000; const requests = [];
  const e = new Engine({ now: () => now, requestScore: (id, context) => { requests.push({ id, context }); return true; } });
  const record = { marketStatus: 'OPEN', market: { id: 'm0', start: START, end: START + W,
    tokens: { UP: 'u0', DOWN: 'd0' }, feeSchedule: { rate: .05 } }, quotes: {} };
  function quote(side = 'UP', bid = .49, ask = .51, size = 100) {
    record.quotes[side] = { bestBid: bid, bestAsk: ask, mid: (bid + ask) / 2,
      updatedAt: now, tokenId: record.market.tokens[side], marketId: record.market.id,
      windowStart: record.market.start, bids: [{ price: bid, size }], asks: [{ price: ask, size }] };
    e.observe(record, side, { price: 60001, open: 60000, at: now });
  }
  function buy(side = 'UP') {
    quote(side); now += 1000; quote(side, .29, .31);
    const s = e.signals[0];
    e.score({ id: s.id, features: Array(15).fill(0), probability: .8, version: 'test' });
    now += 350; e.tick(); return e.positions[0];
  }
  return { e, record, quote, buy, requests, now: () => now, time: t => { now = t; } };
}
test('independent first-dip entry has delay, actual ask fill, fees and no recovery', () => {
  const f = fixture(), p = f.buy();
  assert.equal(p.shares, 50); assert.equal(p.entryPrice, .31);
  assert.equal(p.totalCost, 15.5); assert.equal(p.entryFees, .53475);
  assert.equal(f.e.cash, 2983.96525);
  assert.equal(f.requests.length, 1);
  assert.ok(p.entryAt - f.e.signals[0].at >= 300);
  f.quote('UP', .19, .21); assert.equal(f.requests.length, 1);
  assert.equal(f.e.positions.length, 1);
});
test('raw and final rebound scores stay distinct and model changes preserve the paper ledger', () => {
  const f = fixture(); f.quote(); f.time(f.now() + 1000); f.quote('UP', .29, .31);
  const signal = f.e.signals[0];
  f.e.score({ id: signal.id, features: Array(26).fill(0), rawProbability: .9,
    probability: .27, calibrationMethod: 'sigmoid', lookbackHours: 8,
    btcHistoryAsOf: START - 1, version: 'context8h-test' });
  assert.equal(signal.status, 'REJECTED'); assert.equal(f.e.positions.length, 0);
  assert.equal(signal.rawProbability, .9); assert.equal(signal.probability, .27);
  const restored = new Engine(); restored.restore(f.e.export());
  assert.equal(restored.cash, 3000);
  assert.equal(restored.signals[0].rawProbability, .9);
  assert.equal(restored.signals[0].lookbackHours, 8);
});
test('a qualified score cannot use stale, expensive or future quotes', () => {
  for (const reason of ['stale', 'leftZone', 'delayed']) {
    const f = fixture(); f.quote(); f.time(f.now() + 1000); f.quote('UP', .29, .31);
    if (reason === 'delayed') f.time(f.now() + 2001);
    f.e.score({ id: f.e.signals[0].id, probability: .8, features: Array(15).fill(0) });
    if (reason === 'stale') f.time(f.now() + 2001);
    else if (reason === 'leftZone') { f.time(f.now() + 350); f.quote('UP', .49, .51); }
    f.e.tick(); assert.equal(f.e.positions.length, 0, reason);
  }
});
test('TP sells available bids only; unchanged depth cannot be sold twice, replenishment can', () => {
  const f = fixture(), p = f.buy();
  f.time(f.now() + 1000); f.quote('UP', .75, .76, 20);
  assert.equal(p.exitShares, 20); assert.equal(p.remainingShares, 30);
  const partial = f.e.account();
  assert.ok(partial.realizedPnl > 0, 'The sold portion is realized immediately');
  assert.ok(Math.abs(partial.equity - 3000 - partial.realizedPnl - partial.unrealizedPnl) < 1e-8);
  const cash = f.e.cash;
  f.time(f.now() + 1000); f.quote('UP', .75, .76, 20);
  assert.equal(f.e.cash, cash); assert.equal(p.remainingShares, 30);
  f.time(f.now() + 1000); f.quote('UP', .75, .76, 30);
  assert.equal(p.exitShares, 30, 'Only ten newly displayed shares were replenished');
  f.time(f.now() + 1000); f.quote('UP', .75, .76, 50);
  assert.equal(p.status, 'CLOSED_TP'); assert.equal(p.exitPrice, .75);
  assert.equal(p.exitProceeds, 37.5);
  assert.ok(Math.abs(p.realizedPnl - 20.9965) < 1e-8);
  assert.ok(Math.abs(f.e.cash - 3020.9965) < 1e-8);
  f.e.settle('m0', 'UP', START + W); assert.ok(Math.abs(f.e.cash - 3020.9965) < 1e-8);
});
test('partial TP remainder settles at official outcome and reconciles fees/cash', () => {
  const f = fixture(), p = f.buy();
  f.time(f.now() + 1000); f.quote('UP', .75, .76, 20);
  f.time(START + W); f.e.tick();
  assert.equal(p.status, 'PENDING_RESOLUTION'); assert.equal(f.e.account().equity, null);
  f.e.settle('wrong-market', 'UP'); assert.equal(p.status, 'PENDING_RESOLUTION');
  f.e.settle('m0', 'DOWN');
  assert.equal(p.exitProceeds, 15); assert.equal(p.remainingShares, 0);
  assert.ok(p.realizedPnl < 0);
  assert.ok(Math.abs(f.e.cash - (3000 + p.realizedPnl)) < 1e-8);
  const cash = f.e.cash; f.e.settle('m0', 'UP'); assert.equal(f.e.cash, cash);
});
test('both sides can trade independently and stale marks remain unknown', () => {
  const f = fixture(); f.buy(); f.buy('DOWN');
  assert.equal(f.e.positions.length, 2);
  assert.ok(f.e.account().equity != null);
  f.time(f.now() + 2001); assert.equal(f.e.account().equity, null);
  assert.equal(f.e.account().unrealizedPnl, null);
});
test('late-started windows and mismatched quotes cannot create a signal', () => {
  const f = fixture(); f.time(START + 10000); f.quote('UP', .2, .21);
  assert.equal(f.e.signals.length, 0);
  const g = fixture(); g.record.market.tokens.UP = 'u2';
  g.record.quotes.UP = { bestBid: .2, bestAsk: .21, mid: .205, updatedAt: g.now(),
    tokenId: 'wrong', marketId: 'm0', windowStart: START };
  g.e.observe(g.record, 'UP', { price: 60000, open: 60000, at: g.now() });
  assert.equal(g.e.signals.length, 0);
});
test('an opening BTC feed race does not block the whole window after spot data becomes ready', () => {
  const f = fixture();
  f.record.quotes.UP = { bestBid: .49, bestAsk: .51, mid: .5, updatedAt: f.now(),
    tokenId: 'u0', marketId: 'm0', windowStart: START };
  f.e.observe(f.record, 'UP', null);
  assert.equal(f.e.contexts[`${START}:UP`].btcOpen, null);
  f.time(f.now() + 1000); f.quote('UP', .29, .31);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].context.btcOpen, 60000);
  assert.equal(f.e.signals[0].status, 'SCORING');
});
test('full ledger survives restart without re-entry, duplicated sales or cash reset', () => {
  const f = fixture(), p = f.buy(); f.quote('UP', .75, .76, 20);
  const saved = f.e.export(), g = fixture(); g.time(f.now()); g.e.restore(saved);
  assert.equal(g.e.cash, f.e.cash);
  g.quote('UP', .75, .76, 20); g.e.tick();
  assert.equal(g.e.cash, f.e.cash); assert.equal(g.e.positions.length, 1);
  assert.equal(g.e.positions[0].remainingShares, p.remainingShares);
  saved.cash += 1; assert.throws(() => new Engine().restore(saved), /reconcile/);
});
test('training positives need an observed rebound; gaps do not become false negatives', () => {
  const f = fixture(); f.buy();
  f.time(START + W); f.e.tick(); assert.equal(f.e.examples.length, 0);
  const g = fixture(); g.buy(); g.quote('UP', .75, .76);
  g.time(START + W); g.e.tick();
  assert.equal(g.e.examples.length, 1); assert.equal(g.e.examples[0].y, 1);
});
test('a fully observed window can supply a negative example independently of its trade result', () => {
  const f = fixture(); f.buy();
  for (let at = f.now() + 1000; at < START + W; at += 1000) {
    f.time(at); f.quote('UP', .49, .51);
  }
  f.time(START + W); f.e.tick();
  assert.equal(f.e.examples.length, 1); assert.equal(f.e.examples[0].y, 0);
  assert.equal(f.e.positions[0].status, 'PENDING_RESOLUTION');
});
test('market fee-free flags are respected on entry and TP sales', () => {
  const f = fixture(); f.record.market.feesEnabled = false; const p = f.buy();
  f.quote('UP', .75, .76, 100);
  assert.equal(p.entryFees, 0); assert.equal(p.exitFees, 0);
  assert.equal(p.realizedPnl, 22);
});
test('shadow runtime does not change main ledger/strategy, and its account persists separately', async t => {
  const Runtime = require('../rebound/runtime');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebound-isolation-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const main = { cash: 1234, strategyId: 'existing', trades: [{ id: 'main' }],
    applyBook() {}, marketData: {}, binanceFeed: null };
  const before = JSON.stringify(main), original = main.applyBook;
  const r = new Runtime(main, { directory: dir, fetchImpl: async () => ({ ok: true, json: async () => [] }) });
  r.worker = { start() {}, stop() {}, snapshot: () => ({ status: 'READY_EXPERIMENTAL' }), score: () => false };
  await r.start(); assert.notEqual(main.applyBook, original);
  assert.equal(JSON.stringify(main), before);
  r.engine.cash = 3000; await r.stop();
  assert.equal(main.applyBook, original);
  assert.equal(JSON.stringify(main), before);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'ledger.json'))).cash, 3000);
});
test('HTTP shadow routes and mobile dashboard render actual independent state', async t => {
  const f = fixture(); f.buy();
  const main = new (require('../freqai-martingale-btc-bot'))({ marketData: {} });
  const server = require('../server')(main, 0, { snapshot: () => f.e.snapshot() });
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = 'http://127.0.0.1:' + server.address().port;
  const state = await (await fetch(url + '/api/shadow/state')).json();
  assert.equal(state.account.initialCapital, 3000); assert.equal(state.positions.length, 1);
  const html = await (await fetch(url + '/shadow')).text();
  assert.match(html, /\/api\/shadow\/state/);
  assert.match(html, /id="entryReady"/);
  const elements = new Map(), element = () => ({ innerHTML: '', className: '' });
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];
  vm.runInNewContext(script, { document: { getElementById(id) {
    if (!elements.has(id)) elements.set(id, element()); return elements.get(id);
  } }, fetch: async () => ({ ok: true, json: async () => state }), setTimeout() {}, Date, console });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(elements.get('cash').innerHTML, /2,983\.97/);
  assert.match(elements.get('signals').innerHTML, /ENTERED/);
  assert.match(elements.get('mwarn').innerHTML, /Experimental/);
  assert.equal(main.shadowEntries.length, 0);
});
test('a corrupt shadow ledger is reported and never silently replaced on shutdown', async t => {
  const Runtime = require('../rebound/runtime');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebound-corrupt-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'ledger.json'), original = '{"version":999,"cash":123}';
  fs.writeFileSync(file, original);
  const main = { applyBook() {}, marketData: {} }, runtime = new Runtime(main, { directory: dir });
  await runtime.start(); assert.equal(runtime.snapshot().status, 'ERROR');
  await runtime.stop(); assert.equal(fs.readFileSync(file, 'utf8'), original);
});
test('independent public BTC fallback supplies real forming-candle context when WebSocket is unavailable', async t => {
  const Runtime = require('../rebound/runtime'), f = fixture();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebound-spot-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const main = { applyBook() {}, marketData: {}, binanceFeed: null }, scores = [];
  const r = new Runtime(main, { directory: dir, now: f.now, fetchImpl: async () => ({
    ok: true, json: async () => [[START, '60000', '60002', '59999', '60001', '2', START + W - 1]] }) });
  r.worker = { start() {}, stop() {}, snapshot: () => ({}), score(id, context) { scores.push(context); return true; } };
  await r.start(); await new Promise(resolve => setImmediate(resolve));
  f.quote(); main.applyBook(f.record, 'UP');
  f.time(f.now() + 1000); f.quote('UP', .29, .31); main.applyBook(f.record, 'UP');
  assert.equal(scores.length, 1);
  assert.equal(scores[0].btcOpen, 60000); assert.equal(scores[0].points.at(-1).btcPrice, 60001);
  assert.equal(r.snapshot().dataFeed.source, 'BINANCE_PUBLIC_REST_FORMING_CANDLE');
  await r.stop();
});
