'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const Engine = require('../shadow-ladder/engine');
const Runtime = require('../shadow-ladder/runtime');
const START = 1800000000000, W = 300000;
function fixture(engine) {
  let now = START + 1000;
  const e = engine || new Engine({ now: () => now });
  if (engine) e.now = () => now;
  const record = { marketStatus: 'OPEN', market: { id: 'm', title: 'BTC 5m',
    start: START, end: START + W, tokens: { UP: 'u', DOWN: 'd' },
    feeSchedule: { rate: .05, exponent: 1 } }, quotes: {} };
  function quote(side = 'UP', bid = .49, ask = .5, size = 500, overrides = {}) {
    record.quotes[side] = { tokenId: side === 'UP' ? 'u' : 'd', marketId: record.market.id,
      windowStart: record.market.start, updatedAt: now, bestBid: bid, bestAsk: ask,
      asks: [{ price: ask, size }], bids: [{ price: bid, size }], ...overrides };
    e.observe(record, side); return e.positions[0];
  }
  return { e, record, quote, now: () => now, time(n) { now = n; },
    advance(n = 400) { now += n; },
    buy(side = 'UP', size = 200) { quote(side); now += 400; return quote(side, .32, .33, size); } };
}
const near = (a, b) => assert.ok(Math.abs(a - b) < .00001, `${a} != ${b}`);
test('posts 200 shares BOTH sides, reserves $132, and requires a later quote after latency', () => {
  const f = fixture(); f.quote('UP', .30, .31);
  assert.equal(f.e.orders.length, 2); assert.equal(f.e.positions.length, 0);
  near(f.e.reservedCash(), 132); near(f.e.account().availableCash, 2868);
  assert.ok(f.e.orders.every(o => o.limitPrice === .33 && o.requestedShares === 200));
  f.advance(200); f.quote('UP', .30, .31); assert.equal(f.e.positions.length, 0);
  f.advance(100); f.quote('UP', .30, .31); assert.equal(f.e.positions[0].entryPrice, .33);
  near(f.e.cash, 2934); near(f.e.positions[0].entryFees, 0);
});
test('first PARTIAL fill cancels opposite order immediately; only depth replenishment fills more', () => {
  const f = fixture(), p = f.buy('DOWN', 20);
  assert.equal(p.side, 'DOWN'); assert.equal(p.baseShares, 20);
  const opposite = f.e.orders.find(o => o.side === 'UP');
  assert.equal(opposite.status, 'CANCELLED'); assert.equal(opposite.canceledShares, 200);
  f.advance(); f.quote('UP', .29, .30, 500); assert.equal(f.e.positions.length, 1);
  f.advance(); f.quote('DOWN', .32, .33, 20); assert.equal(p.baseShares, 20);
  f.advance(); f.quote('DOWN', .32, .33, 50); assert.equal(p.baseShares, 50);
  f.advance(); f.quote('DOWN', .32, .33, 200); assert.equal(p.baseShares, 200);
  assert.equal(f.e.orders.find(o => o.side === 'DOWN').status, 'FILLED');
  near(f.e.reservedCash(), 0);
});
test('a bid touch alone cannot fill a resting buy; wrong/stale/future/crossed quotes cannot execute', () => {
  const f = fixture(); f.quote(); f.advance();
  f.quote('UP', .33, .34, 500); assert.equal(f.e.positions.length, 0);
  for (const overrides of [() => ({ tokenId: 'other' }), () => ({ marketId: 'other' }),
    () => ({ windowStart: START - W }), () => ({ updatedAt: f.now() - 2001 }),
    () => ({ updatedAt: f.now() + 1 }), () => ({ bestBid: .4 })]) {
    f.advance(); f.quote('UP', .32, .33, 500, overrides()); assert.equal(f.e.positions.length, 0);
  }
  f.advance(); f.quote('UP', .32, .33); assert.equal(f.e.positions.length, 1);
});
test('add-on is a single 300-share market sweep, not a guaranteed 70c fill', () => {
  const f = fixture(), p = f.buy();
  f.advance(); f.quote('UP', .699, .71); assert.equal(p.addOn.state, 'WAITING');
  f.advance(); f.quote('UP', .70, .71); assert.equal(p.addOn.state, 'PENDING');
  assert.equal(p.addOn.requestedShares, 300); near(f.e.reservedCash(), 315);
  f.advance(299); f.quote('UP', .70, .71); assert.equal(p.addOn.filledShares, 0);
  f.advance(1); f.quote('UP', .70, .71);
  assert.equal(p.addOn.state, 'FILLED'); assert.ok(p.addOn.fees > 0);
  near(p.addOn.filledShares, 300);
  near(p.addOn.spent, 213);
  near(p.addOn.fees, 3.0885);
  assert.equal(p.fills.at(-1).price, .71);
  near(p.baseShares, 200); near(p.shares, 200 + p.addOn.filledShares);
  near(f.e.cash, 3000 - p.totalCost - p.entryFees);
  const shares = p.shares; f.advance(); f.quote('UP', .8, .81);
  assert.equal(p.shares, shares); near(f.e.reservedCash(), 0);
});
test('multi-level taker add-on obeys actual depth and cancels unspent remainder without retry', () => {
  const f = fixture(), p = f.buy();
  f.advance(); f.quote('UP', .7, .71);
  f.advance(); f.quote('UP', .7, .71, 10, { asks: [{ price: .71, size: 10 }, { price: .72, size: 5 }] });
  assert.equal(p.addOn.state, 'PARTIAL'); near(p.addOn.filledShares, 15);
  near(p.addOn.spent, 10.7);
  const cost = p.totalCost; f.advance(); f.quote('UP', .7, .71, 500);
  near(p.totalCost, cost);
});
test('multi-level execution stops at 300 shares even when much more depth is visible', () => {
  const f = fixture(), p = f.buy();
  f.advance(); f.quote('UP', .7, .71);
  f.advance(); f.quote('UP', .7, .71, 100, {
    asks: [{ price: .71, size: 100 }, { price: .72, size: 1000 }] });
  near(p.addOn.filledShares, 300); near(p.addOn.spent, 215);
  assert.equal(p.addOn.state, 'FILLED'); near(f.e.reservedCash(), 0);
});
test('add-on never borrows: cash and fees constrain a partial 300-share request', () => {
  const f = fixture(), p = f.buy();
  f.e.cash = 50;
  f.advance(); f.quote('UP', .7, .71);
  near(p.addOn.budget, 50);
  f.advance(); f.quote('UP', .7, .71);
  assert.equal(p.addOn.state, 'PARTIAL');
  assert.ok(p.addOn.filledShares > 0 && p.addOn.filledShares < 300);
  assert.ok(f.e.cash >= 0); assert.ok(p.addOn.spent + p.addOn.fees <= 50);
  near(f.e.reservedCash(), 0);
});
test('legacy completed fills, cash and history restore unchanged; old pending budgets are honored', () => {
  const f = fixture(), p = f.buy();
  f.advance(); f.quote('UP', .7, .71);
  // Emulate a ledger written before fixed-share sizing was introduced.
  delete p.addOn.requestedShares; p.addOn.budget = 74; p.addOn.targetBudget = 74;
  const e = new Engine({ now: f.now }); e.restore(f.e.export());
  const g = fixture(e); g.time(f.now() + 400); g.quote('UP', .7, .71);
  assert.equal(e.positions[0].addOn.state, 'FILLED');
  assert.ok(e.positions[0].addOn.filledShares < 105);
  g.advance(); g.quote('UP', .99, .999);
  const saved = e.export(), restored = new Engine({ now: g.now });
  restored.restore(saved);
  assert.deepEqual(restored.positions, saved.positions);
  near(restored.cash, saved.cash);
  near(restored.account().realizedPnl, e.account().realizedPnl);
  assert.equal(restored.account().closedTrades, 1);
});
test('partial BASE fill still requests a fixed 300-share add-on', () => {
  const f = fixture(), p = f.buy('UP', 50);
  f.advance(); f.quote('UP', .7, .71); assert.equal(p.addOn.requestedShares, 300);
  f.advance(); f.quote('UP', .7, .71); near(p.addOn.filledShares, 300);
  f.advance(); f.quote('UP', .32, .33, 150);
  near(p.baseShares, 200); near(p.addOn.filledShares, 300);
});
test('TP credits modeled $1 for ALL filled shares, never double credits on settlement or reenters', () => {
  const f = fixture(), p = f.buy();
  f.advance(); f.quote('UP', .7, .71); f.advance(); f.quote('UP', .7, .71);
  f.advance(); f.quote('UP', .99, .999);
  assert.equal(p.status, 'CLOSED_TP'); near(p.exitPrice, 1); near(p.exitProceeds, p.shares);
  near(f.e.cash, 3000 + p.realizedPnl); near(f.e.account().realizedPnl, p.realizedPnl);
  const cash = f.e.cash, shares = p.shares;
  f.advance(); f.quote('UP', .32, .33); assert.equal(p.shares, shares);
  f.time(START + W); f.e.settle('m', 'UP'); near(f.e.cash, cash);
});
test('TP takes priority over add-on when the first high quote is already at 99c', () => {
  const f = fixture(), p = f.buy('UP', 20);
  f.advance(); f.quote('UP', .99, .999);
  assert.equal(p.status, 'CLOSED_TP'); assert.equal(p.addOn.filledShares, 0);
  assert.equal(f.e.orders.find(o => o.side === 'UP').remainingShares, 0);
  near(f.e.cash, 3013.4);
});
test('no stop-loss or signal flip; no TP after expiry; pending winner pays only official outcome', () => {
  const f = fixture(), p = f.buy();
  f.advance(); f.quote('UP', .01, .02); assert.equal(p.status, 'OPEN');
  f.time(START + W); f.e.tick(); assert.equal(p.status, 'PENDING_RESOLUTION');
  assert.equal(f.e.account().equity, null);
  f.quote('UP', .99, .999); assert.equal(p.status, 'PENDING_RESOLUTION');
  f.e.settle('wrong', 'UP'); assert.equal(p.status, 'PENDING_RESOLUTION');
  f.e.settle('m', 'UP'); assert.equal(p.status, 'RESOLVED_WIN'); near(p.realizedPnl, 134);
  near(f.e.cash, 3134);
});
test('official loss includes actual add-on cost and taker fees', () => {
  const f = fixture(), p = f.buy();
  f.advance(); f.quote('UP', .7, .71); f.advance(); f.quote('UP', .7, .71);
  f.time(START + W); f.e.tick(); f.e.settle('m', 'DOWN');
  assert.equal(p.status, 'RESOLVED_LOSS');
  near(p.realizedPnl, -p.totalCost - p.entryFees);
  near(p.realizedPnl, -282.0885);
});
test('orders expire and a new window has its own orders, with no old position or quote rollover', () => {
  const f = fixture(); f.quote(); f.time(START + W); f.e.tick();
  assert.ok(f.e.orders.every(o => o.status === 'EXPIRED'));
  f.record.market = { ...f.record.market, id: 'm2', start: START + W, end: START + 2 * W };
  f.quote('UP', .32, .33); assert.equal(f.e.orders.length, 4);
  assert.equal(f.e.positions.length, 0);
  f.advance(); f.quote('UP', .32, .33);
  assert.equal(f.e.positions[0].marketId, 'm2');
});
test('pending add-on expires instead of executing in the next window', () => {
  const f = fixture(), p = f.buy();
  f.time(START + W - 100); f.quote('UP', .7, .71);
  assert.equal(p.addOn.state, 'PENDING'); f.time(START + W); f.e.tick();
  assert.equal(p.addOn.state, 'EXPIRED'); assert.equal(p.addOn.filledShares, 0);
  near(f.e.reservedCash(), 0);
});
test('unknown fee schedule skips add-on, not a fee-free invented taker fill', () => {
  const f = fixture(), p = f.buy(); delete f.record.market.feeSchedule;
  f.advance(); f.quote('UP', .7, .71); f.advance(); f.quote('UP', .7, .71);
  assert.equal(p.addOn.state, 'SKIPPED'); assert.equal(p.addOn.filledShares, 0);
});
test('cash-limited orders skip both sides instead of overspending or borrowing', () => {
  const f = fixture(); f.e.cash = 100; f.quote();
  assert.ok(f.e.orders.every(o => o.status === 'SKIPPED')); near(f.e.reservedCash(), 0);
  f.advance(); f.quote('UP', .32, .33); assert.equal(f.e.positions.length, 0);
});
test('restart preserves order selection, consumed depth and a PENDING add-on, without duplicate execution', () => {
  const f = fixture(), p = f.buy('UP', 20);
  const e = new Engine({ now: f.now }); e.restore(f.e.export());
  const g = fixture(e); g.time(f.now() + 400);
  g.quote('UP', .32, .33, 20); assert.equal(e.positions[0].baseShares, 20);
  g.advance(); g.quote('DOWN', .32, .33); assert.equal(e.positions.length, 1);
  g.advance(); g.quote('UP', .7, .71);
  const e2 = new Engine({ now: g.now }); e2.restore(e.export());
  const h = fixture(e2); h.time(g.now() + 400); h.quote('UP', .7, .71);
  assert.equal(e2.positions[0].addOn.state, 'FILLED');
  const saved = e2.export(), e3 = new Engine({ now: h.now }); e3.restore(saved);
  const j = fixture(e3); j.time(h.now() + 400); j.quote('UP', .7, .71);
  near(e3.positions[0].shares, e2.positions[0].shares);
  assert.equal(p.baseShares, 20);
});
test('restored cash corruption is rejected and stale equity is unknown with a real curve gap', () => {
  const f = fixture(); f.buy();
  const bad = f.e.export(); bad.cash += 1;
  assert.throws(() => new Engine().restore(bad), /reconciliation/);
  const order = f.e.export(); order.orders[0].filledShares += 1;
  assert.throws(() => new Engine().restore(order), /quantities/);
  f.e.tick(); assert.ok(f.e.account().equity !== null);
  f.advance(11000); f.e.tick(); assert.equal(f.e.account().equity, null);
  assert.equal(f.e.equityCurve.at(-1).equity, null);
});
test('independent runtime preserves main ledger and restores only its new shadow account', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow33-test-'));
  t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
  let now = START + 1000;
  const main = { strategy: { id: 'main-unchanged' }, history: [{ id: 'keep' }], cash: 1111,
    applyBook() {}, marketData: { getMarket: async () => ({}), resolvedWinner: () => null } };
  const before = JSON.stringify(main), original = main.applyBook;
  const r = new Runtime(main, { directory: dir, now: () => now });
  await r.start(); assert.equal(r.worker, undefined); assert.equal(JSON.stringify(main), before);
  const f = fixture(); f.quote();
  main.applyBook(f.record, 'UP'); now += 400;
  f.record.quotes.UP = { ...f.record.quotes.UP, updatedAt: now, bestBid: .32, bestAsk: .33, asks: [{ price: .33, size: 200 }] };
  main.applyBook(f.record, 'UP');
  assert.equal(r.engine.positions.length, 1); await r.stop();
  assert.equal(main.applyBook, original); assert.equal(JSON.stringify(main), before);
  const r2 = new Runtime(main, { directory: dir, now: () => now });
  await r2.start(); assert.equal(r2.engine.positions.length, 1); near(r2.engine.cash, 2934);
  await r2.stop();
});
test('runtime reports corrupt shadow state without silently resetting or hooking main', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow33-corrupt-'));
  t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
  const file = path.join(dir, 'ledger.json'); fs.writeFileSync(file, '{broken');
  const main = { applyBook() {} }, original = main.applyBook;
  const r = new Runtime(main, { directory: dir }); await r.start();
  assert.equal(r.snapshot().status, 'ERROR'); assert.equal(main.applyBook, original);
  await r.stop(); assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
});
test('official resolution polling settles shadow holdings and persists without touching main', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow33-settle-'));
  t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
  const f = fixture(); f.buy(); f.time(START + W + 1);
  const calls = [], main = { applyBook() {}, cash: 123,
    marketData: { getMarket: async id => { calls.push(id); return { winner: 'UP' }; }, resolvedWinner: m => m.winner } };
  const r = new Runtime(main, { directory: dir, now: f.now }); r.engine = f.e;
  await r.start(); await r.tick();
  assert.deepEqual(calls, ['m']); assert.equal(r.engine.positions[0].status, 'RESOLVED_WIN');
  assert.equal(main.cash, 123); await r.stop();
});
test('HTTP and dashboard render real shadow state, first-fill cancellation and 300-share add-on', async t => {
  const f = fixture(), p = f.buy();
  f.advance(); f.quote('UP', .7, .71); f.e.tick();
  const main = new (require('../price-resting-btc-bot'))({ marketData: {} });
  const server = require('../server')(main, 0, { snapshot: () => f.e.snapshot() });
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = 'http://127.0.0.1:' + server.address().port;
  const state = await (await fetch(url + '/api/shadow/state')).json();
  assert.equal(state.positions[0].addOn.requestedShares, 300);
  const html = await (await fetch(url + '/shadow')).text();
  assert.match(html, /viewport/); assert.doesNotMatch(html, /id="signals"|id="mwarn"/);
  const elements = new Map();
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  vm.runInNewContext(script, { document: { getElementById(id) {
    if (!elements.has(id)) elements.set(id, { innerHTML: '', className: '', style: {} });
    return elements.get(id);
  } }, fetch: async () => ({ ok: true, json: async () => state }), setTimeout() {}, Date, console });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(elements.get('status').innerHTML, /RUNNING/);
  assert.match(elements.get('orders').innerHTML, /CANCELLED/);
  assert.match(elements.get('positions').innerHTML, /300 shares requested/);
  assert.match(elements.get('cash').innerHTML, /2,934\.00/);
  assert.equal(main.shadowEntries.length, 0); assert.equal(p.shares, 200);
});
