'use strict';
// Deliberately public-market-data only: no wallet SDK, signer, private key or live order endpoint.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { CricketEngine } = require('./engine.cjs');
const { json, array, metadata, loadMatch } = require('./markets.cjs');
const { Store } = require('./store.cjs');
const WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const EXAMPLE = 'https://polymarket.com/sports/crint/crint-aus-gbr-2026-11-24';
async function start({ port = Number(process.env.PORT || 8080), seed = true, storage = new Store() } = {}) {
  const store = storage;
  const engine = new CricketEngine(await store.open());
  const clients = new Set(), refreshing = new Map();
  const feed = { status: 'CONNECTING', lastMessageAt: null };
  let socket, reconnect, stopping = false, dirty = false, metadataBusy = false, adding = false;
  let persistenceQueued = false;
  function state() { return { ...engine.snapshot(), feed, persistence: { status: store.status, error: store.error } }; }
  function persist() { dirty = false; return store.save(engine.data); }
  function publish() {
    const message = `data: ${JSON.stringify(state())}\n\n`;
    for (const client of clients) { if (client.writableLength > 1e6) { client.end(); clients.delete(client); } else client.write(message); }
  }
  function execute(id) {
    const pending = engine.pending(id);
    if (pending && engine.execute(pending)) { dirty = true; }
  }
  function ingest(message) {
    const type = message.event_type;
    if (type === 'book') {
      try { engine.locate(message.asset_id); } catch { return; }
      engine.book(message.asset_id, message.bids, message.asks); execute(message.asset_id);
    } else if (type === 'price_change') {
      for (const change of message.price_changes || []) {
        const book = engine.books.get(change.asset_id);
        if (!book || !['BUY', 'SELL'].includes(change.side)) continue;
        const key = change.side === 'BUY' ? 'bids' : 'asks';
        const p = Number(change.price), size = Number(change.size);
        if (!Number.isFinite(p) || !Number.isFinite(size)) continue;
        const next = book[key].filter(l => Math.abs(l.price - p) > 1e-10);
        if (size > 0) next.push({ price: p, size });
        engine.book(change.asset_id, key === 'bids' ? next : book.bids, key === 'asks' ? next : book.asks);
        execute(change.asset_id);
      }
    } else if (type === 'tick_size_change') {
      try { const m = engine.locate(message.asset_id).market; const tick = Number(message.new_tick_size); if (tick > 0) m.tickSize = tick; } catch {}
    }
  }
  const outcomeIds = () => engine.data.matches.flatMap(m => m.markets.filter(k => !k.closed).flatMap(k => k.outcomes.map(o => o.id)));
  function connect() {
    if (stopping) return;
    clearTimeout(reconnect);
    if (socket) { socket.onclose = null; socket.close(); }
    const ids = outcomeIds();
    if (!ids.length) { feed.status = 'NO_ACTIVE_MARKETS'; return; }
    feed.status = 'CONNECTING';
    socket = new WebSocket(WS_URL);
    socket.onopen = () => { feed.status = 'CONNECTED'; socket.send(JSON.stringify({ assets_ids: ids, type: 'market', custom_feature_enabled: true })); };
    socket.onmessage = event => {
      feed.lastMessageAt = Date.now();
      if (event.data === 'PONG') return;
      try { const parsed = JSON.parse(event.data); for (const message of Array.isArray(parsed) ? parsed : [parsed]) ingest(message); } catch {}
    };
    socket.onerror = () => { feed.status = 'RECONNECTING'; };
    socket.onclose = () => {
      feed.status = 'RECONNECTING';
      if (!stopping) reconnect = setTimeout(connect, 2000);
    };
  }
  async function refreshBook(id) {
    if (refreshing.has(id)) return refreshing.get(id);
    const began = Date.now();
    const job = (async () => {
      const raw = await json(`https://clob.polymarket.com/book?token_id=${encodeURIComponent(id)}`);
      if (String(raw.asset_id) !== id) throw new Error('Order-book asset mismatch.');
      if ((engine.books.get(id)?.at || 0) > began) return;
      engine.book(id, raw.bids, raw.asks); execute(id);
    })().finally(() => refreshing.delete(id));
    refreshing.set(id, job);
    return job;
  }
  async function add(url) {
    if (engine.data.matches.length >= 20) throw new Error('Twenty matches are already loaded.');
    const match = await loadMatch(url);
    const old = engine.data.matches.find(m => m.id === match.id);
    if (old) return old;
    engine.data.matches.unshift(match);
    await persist(); connect();
    await Promise.allSettled(match.markets.flatMap(m => m.outcomes.map(o => refreshBook(o.id))));
    publish(); return match;
  }
  async function refreshMetadata() {
    if (metadataBusy) return;
    metadataBusy = true;
    try {
      for (const match of engine.data.matches) {
        for (const market of match.markets.filter(m => !m.settled)) {
          try {
            const raw = await json(`https://gamma-api.polymarket.com/markets/${encodeURIComponent(market.id)}`);
            // Reject changed IDs/outcome ordering instead of paying the wrong team.
            const ids = array(raw.clobTokenIds);
            if (ids.length !== market.outcomes.length || ids.some((id, i) => String(id) !== market.outcomes[i].id)) continue;
            Object.assign(market, metadata(raw));
            const payouts = array(raw.outcomePrices).map(Number);
            if (raw.closed === true && raw.umaResolutionStatus === 'resolved') {
              if (engine.settle(market, payouts)) dirty = true;
            }
          } catch { /* A failed result read never invents a winner or closes a position. */ }
        }
        match.closed = match.markets.every(m => m.closed);
      }
    } finally { metadataBusy = false; }
  }
  function reply(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body));
  }
  async function body(req) {
    if (!req.headers['content-type']?.startsWith('application/json')) throw new Error('JSON request required.');
    let text = '';
    for await (const chunk of req) { text += chunk; if (Buffer.byteLength(text) > 4096) throw new Error('Request too large.'); }
    return JSON.parse(text);
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    const pathname = new URL(req.url, 'http://localhost').pathname;
    try {
      if (req.method === 'GET' && pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        fs.createReadStream(path.resolve(__dirname, '../public/cricket-dashboard.html')).pipe(res); return;
      }
      if (req.method === 'GET' && pathname === '/api/healthz') return reply(res, store.error ? 503 : 200,
        { status: store.error ? 'PERSISTENCE_ERROR' : 'RUNNING', strategy: 'cricket-manual-paper-v1', mode: 'PAPER_ONLY' });
      if (req.method === 'GET' && pathname === '/api/state') return reply(res, 200, state());
      if (req.method === 'GET' && pathname === '/api/events') {
        if (clients.size >= 100) return reply(res, 429, { error: 'Too many dashboard streams.' });
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        clients.add(res); res.write(`data: ${JSON.stringify(state())}\n\n`); req.on('close', () => clients.delete(res)); return;
      }
      if (req.method === 'POST') {
        const origin = req.headers.origin;
        if (origin && new URL(origin).host !== req.headers.host) return reply(res, 403, { error: 'Cross-site actions are not allowed.' });
        if (store.error) return reply(res, 503, { error: store.error });
        const input = await body(req);
        if (pathname === '/api/matches') {
          if (adding) return reply(res, 409, { error: 'A match is already loading. Please wait.' });
          adding = true;
          try { await add(input.url); return reply(res, 200, state()); } finally { adding = false; }
        }
        if (pathname === '/api/orders') {
          const order = engine.submit(input);
          await persist(); publish();
          return reply(res, 202, { order, state: state() });
        }
      }
      reply(res, 404, { error: 'Not found.' });
    } catch (err) {
      reply(res, 400, { error: err.message?.slice(0, 250) || 'Request failed.' });
    }
  });
  // Restored pending paper requests are explicitly interrupted, never replayed.
  await persist();
  await new Promise(resolve => server.listen(port, '0.0.0.0', resolve));
  if (seed && !engine.data.matches.length) add(EXAMPLE).catch(() => { feed.status = 'PASTE_MATCH_URL'; publish(); });
  else { connect(); refreshMetadata().catch(() => {}); }
  const ticks = setInterval(() => {
    for (const order of engine.data.orders.filter(o => o.status === 'PENDING')) {
      if (Date.now() >= order.eligibleAt) {
        execute(order.outcomeId);
        if (order.status === 'PENDING') refreshBook(order.outcomeId).catch(() => {});
      }
    }
    if (dirty && !persistenceQueued) {
      persistenceQueued = true;
      persist().catch(() => {}).finally(() => { persistenceQueued = false; });
    }
    publish();
  }, 200);
  const bookPoll = setInterval(() => { for (const id of outcomeIds()) refreshBook(id).catch(() => {}); }, 3000);
  const metadataPoll = setInterval(() => refreshMetadata().catch(() => {}), 10000);
  const heartbeat = setInterval(() => {
    if (socket?.readyState === WebSocket.OPEN) {
      if (feed.lastMessageAt && Date.now() - feed.lastMessageAt > 30000) { connect(); return; }
      socket.send('PING');
    }
    for (const client of clients) client.write(': heartbeat\n\n');
  }, 10000);
  async function close() {
    stopping = true; clearTimeout(reconnect);
    [ticks, bookPoll, metadataPoll, heartbeat].forEach(clearInterval);
    socket?.close(); clients.forEach(c => c.end());
    await persist(); await store.close();
    server.close();
  }
  return { server, engine, close, state, add, refreshBook };
}
if (require.main === module) start().then(runtime => {
  console.log('Cricket manual paper dashboard listening; live order execution is absent.');
  process.once('SIGTERM', () => runtime.close().then(() => process.exit(0)));
  process.once('SIGINT', () => runtime.close().then(() => process.exit(0)));
}).catch(() => { console.error('Cricket paper startup failed. Check database availability and ledger compatibility.'); process.exit(1); });
module.exports = { start };
