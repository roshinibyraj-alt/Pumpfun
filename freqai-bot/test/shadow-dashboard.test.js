'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../public/shadow-ladder-dashboard.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const START = 1800000000000;
function state() {
  return {
    now: START + 1000, status: 'RUNNING',
    strategy: { baseShares: 200, entryPrice: .33, addOnTrigger: .7, addOnShares: 300,
      takeProfitBid: .99, takeProfitPayout: 1, initialCapital: 3000 },
    account: { initialCapital: 3000, realizedPnl: 50, equity: null, cash: 2900,
      availableCash: 2900, reservedCash: 0, totalFees: 2, wins: 2, losses: 1, closedTrades: 3 },
    market: { windowStart: START, windowEnd: START + 300000, secondsRemaining: 299, quotes: {} },
    positions: [], orders: [], events: [],
    equityCurve: [{ at: START, equity: null, balance: 3000 },
      { at: START + 500, equity: null, balance: 3050 }],
  };
}
async function render(s) {
  const nodes = new Map(), moves = [], timers = [];
  const context = {
    document: { getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, { innerHTML: '', className: '', style: {},
        before(other) { moves.push([id, other]); } });
      return nodes.get(id);
    } },
    fetch: async () => ({ ok: true, json: async () => s }),
    setTimeout(fn) { timers.push(fn); }, Date, console,
  };
  vm.runInNewContext(script, context);
  await new Promise(resolve => setImmediate(resolve));
  return { nodes, moves, timers };
}
test('equity section moves above market; settled balance remains visible during unknown live equity', async () => {
  const { nodes, moves } = await render(state());
  assert.equal(moves[0][0], 'marketCard');
  assert.equal(moves[0][1], nodes.get('equityCard'));
  assert.match(nodes.get('settled').innerHTML, /3,050\.00/);
  assert.match(nodes.get('equity').innerHTML, /Awaiting marks/);
  assert.match(nodes.get('curve').innerHTML, /data-series="b"/);
  assert.doesNotMatch(nodes.get('curve').innerHTML, /data-series="v"|NaN|Infinity/);
  assert.match(nodes.get('curveNote').innerHTML, /2 unavailable samples/);
  assert.match(html, /<details>[\s\S]*?Cash, fees and account details/);
});
test('chart preserves live-equity gaps instead of drawing a line across missing values', async () => {
  const s = state();
  s.equityCurve = [{ at: START, equity: 3020, balance: 3000 },
    { at: START + 300, equity: null, balance: 3000 },
    { at: START + 600, equity: 3050, balance: 3050 }];
  const { nodes } = await render(s);
  const curve = nodes.get('curve').innerHTML;
  assert.equal((curve.match(/data-series="v"/g) || []).length, 2);
  assert.equal((curve.match(/data-series="b"/g) || []).length, 1);
  assert.match(curve, /H[\d.]+V/);
  assert.doesNotMatch(curve, /NaN|Infinity/);
});
test('current active position and orders exclude expired history; older results are collapsed and bounded', async () => {
  const s = state();
  const position = i => ({ side: 'UP', shares: 200, totalCost: 66, entryPrice: .33,
    windowStart: START - i * 300000, windowEnd: START + (1 - i) * 300000,
    entryAt: START, exitAt: START - i, entryFees: 0, exitProceeds: 200,
    realizedPnl: 134, addOn: { state: 'WAITING', filledShares: 0 }, fills: [] });
  s.positions = [{ ...position(0), status: 'OPEN' },
    ...Array.from({ length: 10 }, (_, i) => ({ ...position(i + 1), status: 'PENDING_RESOLUTION' })),
    ...Array.from({ length: 12 }, (_, i) => ({ ...position(i + 20), status: 'CLOSED_TP' }))];
  s.orders = [{ side: 'DOWN', status: 'RESTING', windowStart: START, requestedShares: 200 },
    { side: 'UP', status: 'EXPIRED', windowStart: START - 300000, requestedShares: 200 }];
  const { nodes, timers } = await render(s);
  assert.equal(nodes.get('posN').innerHTML, '1');
  assert.equal(nodes.get('pendingN').innerHTML, '10');
  assert.equal((nodes.get('positions').innerHTML.match(/class="row p"/g) || []).length, 1);
  assert.match(nodes.get('positions').innerHTML, /300 shares at trigger/);
  assert.equal((nodes.get('pending').innerHTML.match(/class="row p"/g) || []).length, 5);
  assert.match(nodes.get('pending').innerHTML, /5 more pending/);
  nodes.get('morePending').onclick();
  assert.equal((nodes.get('pending').innerHTML.match(/class="row p"/g) || []).length, 10);
  assert.equal(nodes.get('morePending').style.display, 'none');
  assert.equal(nodes.get('ordN').innerHTML, '1');
  assert.doesNotMatch(nodes.get('orders').innerHTML, /EXPIRED/);
  assert.equal(nodes.get('cloN').innerHTML, '5 of 12');
  assert.equal((nodes.get('closed').innerHTML.match(/class="row /g) || []).length, 5);
  nodes.get('moreClosed').onclick();
  assert.equal(nodes.get('cloN').innerHTML, '12 of 12');
  assert.equal(nodes.get('moreClosed').style.display, 'none');
  // Polling does not reset the user's expanded history limit.
  await timers[0]();
  assert.equal(nodes.get('cloN').innerHTML, '12 of 12');
  assert.match(html, /<details class="card" id="pendingDetails">/);
});
test('empty history gives an honest initial balance point, and hides empty pending/results controls', async () => {
  const s = state(); s.equityCurve = [];
  const { nodes } = await render(s);
  assert.match(nodes.get('curve').innerHTML, /data-series="b"/);
  assert.equal(nodes.get('pendingDetails').style.display, 'none');
  assert.equal(nodes.get('moreClosed').style.display, 'none');
  assert.match(nodes.get('positions').innerHTML, /Flat/);
  assert.equal(nodes.get('status').innerHTML, 'RUNNING');
});
