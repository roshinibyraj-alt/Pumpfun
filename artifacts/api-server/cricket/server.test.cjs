'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { start } = require('./server.cjs');
function memoryStore() {
  return { status: 'TEST_MEMORY', error: null, writes: [],
    async open() {}, async save(data) { this.writes.push(JSON.parse(JSON.stringify(data))); }, async close() {} };
}
test('HTTP serves new dashboard, rejects unsafe loads, queues buys and persists history', async () => {
  const storage = memoryStore();
  const runtime = await start({ port: 0, seed: false, storage });
  const base = `http://127.0.0.1:${runtime.server.address().port}`;
  const post = (url, data, headers = {}) => fetch(base + url, { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(data) });
  try {
    const html = await (await fetch(base)).text();
    assert.match(html, /BUY 100/); assert.match(html, /SELL ALL/);
    assert.match(html, /PAPER ONLY/); assert.match(html, /\/api\/matches/);
    assert.equal((await (await fetch(base + '/api/healthz')).json()).mode, 'PAPER_ONLY');
    assert.equal((await post('/api/matches', { url: 'https://example.com/event/aaa' })).status, 400);
    assert.equal((await post('/api/orders', {}, { Origin: 'https://evil.example' })).status, 403);
    runtime.engine.data.matches.push({ id: 'm', title: 'Test cricket match', closed: false, markets: [
      { id: 'mk', question: 'Test cricket match', closed: false, acceptingOrders: true, secondsDelay: 10,
        feeKnown: true, feeRate: .05, feeExponent: 1, minOrderSize: 5, tickSize: .01,
        outcomes: [{ id: 'team', name: 'Test team', shares: 0, costBasis: 0, liquidationValue: 0 }] }] });
    runtime.engine.book('team', [{ price: .49, size: 100 }], [{ price: .5, size: 100 }]);
    const request = { outcomeId: 'team', side: 'BUY', requestId: 'test-order-1234' };
    const response = await post('/api/orders', request); assert.equal(response.status, 202);
    const accepted = await response.json();
    assert.equal(accepted.order.status, 'PENDING'); assert.equal(accepted.state.cash, 3000);
    const duplicate = await (await post('/api/orders', request)).json();
    assert.equal(duplicate.order.id, accepted.order.id); assert.equal(duplicate.state.orders.length, 1);
    assert.equal(storage.writes.at(-1).orders.length, 1);
    assert.equal((await (await fetch(base + '/api/state')).json()).mode, 'PAPER_ONLY');
  } finally { await runtime.close(); }
});
test('persistence failures prevent accepting further paper orders', async () => {
  const storage = memoryStore(), runtime = await start({ port: 0, seed: false, storage });
  const base = `http://127.0.0.1:${runtime.server.address().port}`;
  try {
    storage.error = 'Paper ledger could not be saved. New orders are paused.';
    const res = await fetch(base + '/api/orders', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 503); assert.equal((await fetch(base + '/api/healthz')).status, 503);
  } finally { storage.error = null; await runtime.close(); }
});
