'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { start } = require('./server.cjs');
const { CricketEngine } = require('./engine.cjs');
function memoryStore(initial) {
  return { status: 'TEST_MEMORY', error: null, writes: [], chain: Promise.resolve(),
    async open() { return initial; }, async save(data) { this.writes.push(JSON.parse(JSON.stringify(data))); }, async close() {} };
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
    const reset = await (await post('/api/reset', {})).json();
    assert.equal(reset.mode, 'PAPER_ONLY'); assert.equal(reset.cash, 3000);
    assert.equal(reset.equity, 3000); assert.equal(reset.matches.length, 0);
    assert.equal(reset.orders.length, 0); assert.equal(storage.writes.at(-1).orders.length, 0);
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
test('expired crypto window automatically loads the next five-minute event without deleting history', async () => {
  const previous = new CricketEngine().data;
  previous.matches.push({ id: 'old-btc', kind: 'crypto', slug: 'btc-updown-5m-1795521300',
    cryptoWindow: { symbol: 'BTC', startTimestamp: 1795521300, intervalSeconds: 300 }, closed: true,
    markets: [{ id: 'old-market', closed: true, settled: true, outcomes: [] }] });
  const loaded = [];
  const storage = memoryStore(previous);
  const runtime = await start({ port: 0, seed: false, storage, now: () => 1795521600 * 1000,
    connectFeeds: false, refreshBooksOnAdd: false,
    loadMatchFn: async url => {
      loaded.push(url);
      return { id: 'next-btc', kind: 'crypto', slug: 'btc-updown-5m-1795521600', title: 'Bitcoin Up or Down',
        cryptoWindow: { symbol: 'BTC', startTimestamp: 1795521600, intervalSeconds: 300 }, closed: false,
        markets: [{ id: 'next-market', question: 'Bitcoin Up or Down', closed: false, settled: false,
          acceptingOrders: true, secondsDelay: 1, feeRate: 0, feeExponent: 1, feeKnown: true,
          minOrderSize: 5, tickSize: .01,
          outcomes: [{ id: 'next-up', name: 'Up', shares: 0, costBasis: 0, liquidationValue: 0 },
            { id: 'next-down', name: 'Down', shares: 0, costBasis: 0, liquidationValue: 0 }] }] };
    } });
  try {
    await runtime.ensureNextCryptoWindows();
    assert.deepEqual(loaded, ['https://polymarket.com/event/btc-updown-5m-1795521600']);
    assert.equal(runtime.engine.data.matches.length, 2);
    assert.equal(runtime.engine.data.matches[0].slug, 'btc-updown-5m-1795521600');
    assert.equal(runtime.engine.data.matches[1].slug, 'btc-updown-5m-1795521300');
    assert.equal(storage.writes.at(-1).matches.length, 2);
  } finally { await runtime.close(); }
});
