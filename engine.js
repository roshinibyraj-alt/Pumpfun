'use strict';

// ── Config ──────────────────────────────────────────────────
const GAMMA_API      = process.env.GAMMA_API || 'https://gamma-api.polymarket.com';
const CLOB_REST      = process.env.CLOB_REST || 'https://clob.polymarket.com';
const CLOB_POLL_MS   = Number(process.env.CLOB_POLL_MS || 200);
const CLOB_FRESH_MS  = Number(process.env.CLOB_FRESH_MS || 4000);
const WINDOW_SECONDS = 300;
const ASSETS         = ['btc'];
const START_BANKROLL = Number(process.env.START_BANKROLL || 100);
const EQUITY_FILE    = process.env.EQUITY_FILE || './equity.json';

// Strategy params
const BUY_PRICE  = Number(process.env.BUY_PRICE || 0.01);   // limit buy at this price
const SELL_PRICE = Number(process.env.SELL_PRICE || 0.02);  // limit sell at this price
const SHARES     = Number(process.env.SHARES || 100);       // shares per order
const MAKER_FEE_RATE = Number(process.env.MAKER_FEE_RATE || 0);  // 0 for limit orders
const MAKER_REBATE   = Number(process.env.MAKER_REBATE || 0.001); // 0.1% rebate per filled order
const FINAL_WIN_PRICE = Number(process.env.FINAL_WIN_PRICE || 0.90);
const FINAL_WINDOW_MS = Number(process.env.FINAL_WINDOW_MS || 2000);

const fs = require('fs');

// ── Helpers ─────────────────────────────────────────────────
function round2(v) { return Math.round(v * 100) / 100; }
function round5(v) { return Math.round(v * 100000) / 100000; }
function windowStartFor(ms) { return Math.floor(ms / 1000 / WINDOW_SECONDS) * WINDOW_SECONDS; }
function slugFor(a, s) { return `${a}-updown-5m-${s}`; }
function makerFee(shares, price) { return round5(shares * MAKER_FEE_RATE * price * (1 - price)); }
function makerRebate(shares, price) { return round5(shares * MAKER_REBATE * price); }
function loadEquityFile(f) {
  try { const d = JSON.parse(fs.readFileSync(f, 'utf8')); return Array.isArray(d) ? d : []; } catch (_) { return []; }
}
function sampleCurve(c, max = 1500) {
  if (!Array.isArray(c) || c.length <= max) return c || [];
  const step = (c.length - 1) / (max - 1);
  const out = [];
  for (let i = 0; i < max; i++) out.push(c[Math.round(i * step)]);
  out[max - 1] = c[c.length - 1];
  return out;
}

// ── Engine ──────────────────────────────────────────────────
class BotEngine {
  constructor(opts = {}) {
    this.fetchImpl = opts.fetchImpl || fetch;
    this.startedAt = Date.now();
    this.capital = { value: START_BANKROLL };
    Object.defineProperty(this, 'bankroll', { get: () => this.capital.value, set: v => { this.capital.value = v; } });

    // Market data
    this.markets = new Map();
    this.tokens = new Map();
    this.history = new Map();
    this.discoveredWindows = new Set();
    this.discoveryRunning = false;
    this.pollRunning = false;
    this.lastSuccessfulPollAt = null;
    this.lastPollErrorAt = null;

    // Orders: { id, slug, outcome, type: 'BUY'|'SELL', price, shares, status: 'PENDING'|'FILLED'|'CANCELLED'|'SOLD', createdAt, filledAt, closedAt, fillPrice, sellOrderId }
    this.orders = [];
    this.nextOrderId = 1;

    // Tracking
    this.trades = [];
    this.wins = 0;
    this.losses = 0;
    this.realizedPnl = 0;
    this.peakEquity = START_BANKROLL;
    this.maxDrawdown = 0;
    this.logs = [];
    this.pollCount = 0;
    this.windowsTraded = 0;

    // Equity
    const seeded = (opts.initialEquity && Array.isArray(opts.initialEquity) && opts.initialEquity.length) ? opts.initialEquity.slice() : null;
    this.equityCurve = seeded || [{ t: Date.now(), equity: START_BANKROLL }];
    this.lastEquitySaveAt = 0;
  }

  log(msg) {
    const line = `[${new Date().toISOString().slice(11, 23)}] ${msg}`;
    this.logs.push(line);
    if (this.logs.length > 500) this.logs.shift();
  }

  async getJSON(url, timeout = 8000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const r = await this.fetchImpl(url, { signal: ctrl.signal, headers: { 'User-Agent': 'bot/1.0' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } finally { clearTimeout(timer); }
  }

  async postJSON(url, body, timeout = 12000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const r = await this.fetchImpl(url, {
        method: 'POST', signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'bot/1.0' },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } finally { clearTimeout(timer); }
  }

  // ── Market Discovery ──────────────────────────────────────
  async discoverMarket(asset, start) {
    const slug = slugFor(asset, start);
    if (this.discoveredWindows.has(slug)) return this.markets.get(slug) || null;
    try {
      const rows = await this.getJSON(`${GAMMA_API}/markets?slug=${encodeURIComponent(slug)}`);
      const market = Array.isArray(rows) ? rows[0] : null;
      if (!market || !market.conditionId || !market.clobTokenIds || market.closed) return null;
      this.discoveredWindows.add(slug);
      const outcomes = typeof market.outcomes === 'string' ? JSON.parse(market.outcomes) : market.outcomes || [];
      const tokenIds = typeof market.clobTokenIds === 'string' ? JSON.parse(market.clobTokenIds) : market.clobTokenIds || [];
      const ui = outcomes.findIndex(o => String(o).toLowerCase() === 'up');
      const di = outcomes.findIndex(o => String(o).toLowerCase() === 'down');
      if (ui < 0 || di < 0 || !tokenIds[ui] || !tokenIds[di]) return null;
      const rec = {
        slug, asset, conditionId: market.conditionId, title: market.question || slug,
        windowStart: start, windowEnd: start + WINDOW_SECONDS,
        resolved: false, winner: null, tradingClosed: false,
        finalUpMax: 0, finalDownMax: 0, finalCaptureAt: 0,
        up: { tokenId: tokenIds[ui], slug, asset, outcome: 'UP', bid: null, ask: null, mid: null, spread: null, updatedAt: null, bookAsks: [], bookBids: [] },
        down: { tokenId: tokenIds[di], slug, asset, outcome: 'DOWN', bid: null, ask: null, mid: null, spread: null, updatedAt: null, bookAsks: [], bookBids: [] },
      };
      this.markets.set(slug, rec);
      this.tokens.set(rec.up.tokenId, rec.up);
      this.tokens.set(rec.down.tokenId, rec.down);
      this.log(`🎯 ${asset.toUpperCase()} 5m discovered ${slug}`);
      return rec;
    } catch (e) { this.log(`⚠️ Discovery: ${e.message}`); return null; }
  }

  async retryDiscovery() {
    if (this.discoveryRunning) return;
    this.discoveryRunning = true;
    try {
      const starts = [windowStartFor(Date.now()), windowStartFor(Date.now()) + WINDOW_SECONDS];
      for (const s of starts) for (const a of ASSETS)
        if (!this.markets.has(slugFor(a, s))) await this.discoverMarket(a, s);
    } finally { this.discoveryRunning = false; }
  }

  // ── CLOB Book Polling ─────────────────────────────────────
  captureFinalPrice(token) {
    if (token?.mid == null || token.mid <= 0) return;
    const m = this.markets.get(token.slug);
    if (!m) return;
    const nowMs = Date.now();
    const endMs = m.windowEnd * 1000;
    if (nowMs < endMs - FINAL_WINDOW_MS) return;
    if (token.outcome === 'UP') m.finalUpMax = Math.max(m.finalUpMax ?? 0, token.mid);
    else if (token.outcome === 'DOWN') m.finalDownMax = Math.max(m.finalDownMax ?? 0, token.mid);
    m.finalCaptureAt = nowMs;
  }

  applyBook(token, bids, asks) {
    this.captureFinalPrice(token);
    const validAsks = asks.filter(l => Number(l.size) > 0).map(l => ({ price: Number(l.price), size: Number(l.size) }));
    validAsks.sort((a, b) => a.price - b.price);
    token.bookAsks = validAsks;
    const validBids = bids.filter(l => Number(l.size) > 0).map(l => ({ price: Number(l.price), size: Number(l.size) }));
    validBids.sort((a, b) => b.price - a.price);
    token.bookBids = validBids;
    const bestBid = validBids[0]?.price ?? null;
    const bestAsk = validAsks[0]?.price ?? null;
    const cleanBid = Number.isFinite(bestBid) && bestBid > 0 && bestBid <= 1 ? bestBid : null;
    const cleanAsk = Number.isFinite(bestAsk) && bestAsk > 0 && bestAsk <= 1 ? bestAsk : null;
    if (cleanBid === token.bid && cleanAsk === token.ask) return;
    token.bid = cleanBid; token.ask = cleanAsk;
    token.spread = cleanBid != null && cleanAsk != null ? round5(cleanAsk - cleanBid) : null;
    token.mid = cleanBid != null && cleanAsk != null ? round5((cleanBid + cleanAsk) / 2) : (cleanAsk ?? cleanBid);
    token.updatedAt = Date.now();
    this.captureFinalPrice(token);
  }

  async pollClobBooks() {
    if (this.pollRunning) return;
    const now = Date.now(), cs = windowStartFor(now);
    const tokens = [...this.tokens.values()].filter(t => { const m = this.markets.get(t.slug); return m?.windowStart === cs && !m.tradingClosed && !m.resolved; });
    if (!tokens.length) return;
    this.pollRunning = true;
    try {
      const books = await this.postJSON(`${CLOB_REST}/books`, tokens.map(t => ({ token_id: t.tokenId })));
      const byToken = new Map((Array.isArray(books) ? books : []).map(b => [String(b?.asset_id || ''), b]).filter(([id]) => this.tokens.has(id)));
      for (const t of tokens) { const b = byToken.get(t.tokenId); if (b) this.applyBook(t, b.bids || [], b.asks || []); }
      this.pollCount++;
      this.lastSuccessfulPollAt = Date.now();
    } catch (e) {
      if (!this.lastPollErrorAt || Date.now() - this.lastPollErrorAt >= 5000) { this.log(`⚠️ CLOB poll: ${e.message}`); this.lastPollErrorAt = Date.now(); }
    } finally { this.pollRunning = false; }
  }

  // ── Order Management ──────────────────────────────────────
  placeBuyOrders(market) {
    for (const side of ['up', 'down']) {
      const outcome = side === 'up' ? 'UP' : 'DOWN';
      // Don't duplicate if we already have a pending buy this window
      const existing = this.orders.find(o => o.slug === market.slug && o.outcome === outcome && o.type === 'BUY' && o.status === 'PENDING');
      if (existing) continue;

      const order = {
        id: this.nextOrderId++,
        slug: market.slug,
        outcome,
        type: 'BUY',
        price: BUY_PRICE,
        shares: SHARES,
        status: 'PENDING',
        createdAt: Date.now(),
        filledAt: null,
        fillPrice: null,
        sellOrderId: null,
      };
      this.orders.push(order);
      this.log(`📋 LIMIT BUY ${outcome} ${SHARES}sh @ $${BUY_PRICE.toFixed(2)} — order #${order.id}`);
    }
  }

  checkOrderFills(market) {
    const pendingBuys = this.orders.filter(o => o.slug === market.slug && o.type === 'BUY' && o.status === 'PENDING');
    const pendingSells = this.orders.filter(o => o.slug === market.slug && o.type === 'SELL' && o.status === 'PENDING');

    // Check buy fills: a buy at 0.01 fills when ask drops to 0.01 (someone sells to us)
    for (const order of pendingBuys) {
      const token = order.outcome === 'UP' ? market.up : market.down;
      const ask = token.ask ?? token.mid;
      if (ask != null && ask <= order.price + 0.001) {
        this.fillBuyOrder(order, order.price, market);
      }
    }

    // Check sell fills: a sell at 0.02 fills when bid rises to 0.02 (someone buys from us)
    for (const order of pendingSells) {
      const token = order.outcome === 'UP' ? market.up : market.down;
      const bid = token.bid ?? token.mid;
      if (bid != null && bid >= order.price - 0.001) {
        this.fillSellOrder(order, order.price, market);
      }
    }
  }

  fillBuyOrder(order, price, market) {
    const cost = round2(order.shares * price);
    const fee = makerFee(order.shares, price);
    const rebate = makerRebate(order.shares, price);
    const totalCost = round2(cost + fee - rebate);
    if (totalCost > this.bankroll) { this.log(`⚠️ SKIP BUY #${order.id} — need $${totalCost.toFixed(2)}, have $${this.bankroll.toFixed(2)}`); return; }

    this.bankroll = round2(this.bankroll - totalCost);
    order.status = 'FILLED';
    order.filledAt = Date.now();
    order.fillPrice = price;
    order.cost = cost;
    order.fee = fee;
    order.rebate = rebate;
    order.totalCost = totalCost;

    this.log(`✅ BUY FILLED #${order.id} ${order.outcome} ${order.shares}sh @ $${price.toFixed(2)} · cost $${cost.toFixed(2)} · rebate $${rebate.toFixed(2)}`);

    // Immediately place limit sell at SELL_PRICE
    const sellOrder = {
      id: this.nextOrderId++,
      slug: order.slug,
      outcome: order.outcome,
      type: 'SELL',
      price: SELL_PRICE,
      shares: order.shares,
      status: 'PENDING',
      createdAt: Date.now(),
      filledAt: null,
      fillPrice: null,
      buyOrderId: order.id,
    };
    order.sellOrderId = sellOrder.id;
    this.orders.push(sellOrder);
    this.log(`📋 LIMIT SELL ${order.outcome} ${order.shares}sh @ $${SELL_PRICE.toFixed(2)} — order #${sellOrder.id} (after buy #${order.id} filled)`);
    this.recordEquity();
  }

  fillSellOrder(order, price, market) {
    const proceeds = round2(order.shares * price);
    const fee = makerFee(order.shares, price);
    const rebate = makerRebate(order.shares, price);
    const netProceeds = round2(proceeds - fee + rebate);

    order.status = 'FILLED';
    order.filledAt = Date.now();
    order.fillPrice = price;
    order.proceeds = proceeds;
    order.fee = fee;
    order.rebate = rebate;
    order.netProceeds = netProceeds;

    // Find the matching buy order
    const buyOrder = this.orders.find(o => o.id === order.buyOrderId);
    const buyCost = buyOrder ? buyOrder.totalCost : round2(order.shares * BUY_PRICE);
    const pnl = round2(netProceeds - buyCost);

    this.bankroll = round2(this.bankroll + netProceeds);
    this.realizedPnl = round2(this.realizedPnl + pnl);
    if (pnl >= 0) this.wins++; else this.losses++;

    const tag = '💰 SELL FILLED';
    this.log(`${tag} #${order.id} ${order.outcome} ${order.shares}sh @ $${price.toFixed(2)} · revenue $${proceeds.toFixed(2)} · P&L ${pnl >= 0 ? '+' : '-'}$${Math.abs(pnl).toFixed(2)}`);
    this.trades.push({ timestamp: Date.now(), type: 'SELL', outcome: order.outcome, shares: order.shares, price, cost: buyCost, fee, rebate, pnl, buyOrderId: order.buyOrderId });
    this.recordEquity();
  }

  cancelUnfilledOrders(market) {
    const pending = this.orders.filter(o => o.slug === market.slug && o.status === 'PENDING');
    for (const order of pending) {
      order.status = 'CANCELLED';
      order.closedAt = Date.now();
      this.log(`❌ CANCELLED #${order.id} ${order.type} ${order.outcome} ${order.shares}sh @ $${order.price.toFixed(2)}`);
    }
  }

  // ── Resolution ────────────────────────────────────────────
  resolveWindow(market) {
    const finalUp  = market.finalUpMax  ?? 0;
    const finalDown = market.finalDownMax ?? 0;
    let winner;
    if (finalUp > 0 && finalUp > finalDown) winner = 'UP';
    else if (finalDown > 0 && finalDown > finalUp) winner = 'DOWN';
    else if (finalUp >= FINAL_WIN_PRICE) winner = 'UP';
    else if (finalDown >= FINAL_WIN_PRICE) winner = 'DOWN';
    else winner = 'UP';

    market.resolved = true;
    market.winner = winner;
    this.log(`🏁 RESOLUTION ${winner} (up=${finalUp.toFixed(3)} down=${finalDown.toFixed(3)})`);

    // Resolve unfilled buy orders that became positions via resolution
    const filledBuys = this.orders.filter(o => o.slug === market.slug && o.type === 'BUY' && o.status === 'FILLED' && o.sellOrderId);
    for (const buyOrder of filledBuys) {
      const sellOrder = this.orders.find(o => o.id === buyOrder.sellOrderId);
      if (sellOrder && sellOrder.status === 'FILLED') continue; // already resolved via sell
      // Buy was filled but sell wasn't — resolve by resolution
      if (sellOrder) { sellOrder.status = 'CANCELLED'; sellOrder.closedAt = Date.now(); }
      const won = buyOrder.outcome === winner;
      const payout = won ? buyOrder.shares : 0;
      const netPayout = round2(payout);
      const pnl = round2(netPayout - buyOrder.totalCost);

      this.bankroll = round2(this.bankroll + netPayout);
      this.realizedPnl = round2(this.realizedPnl + pnl);
      if (pnl >= 0) this.wins++; else this.losses++;

      this.log(`🏁 RESOLVED #${buyOrder.id} ${buyOrder.outcome} ${won ? 'WIN' : 'LOSS'} · P&L ${pnl >= 0 ? '+' : '-'}$${Math.abs(pnl).toFixed(2)}`);
      this.trades.push({ timestamp: Date.now(), type: 'RESOLVED', outcome: buyOrder.outcome, shares: buyOrder.shares, price: won ? 1 : 0, cost: buyOrder.totalCost, pnl, buyOrderId: buyOrder.id });
    }
  }

  // ── Main Loop ─────────────────────────────────────────────
  evaluate() {
    const now = Date.now();
    const cs = windowStartFor(now);
    const market = [...this.markets.values()].find(m => m.windowStart === cs && !m.resolved && !m.tradingClosed);
    if (!market) return;

    const elapsed = Math.floor(now / 1000) - cs;

    // Place buy orders once window starts (immediately)
    if (elapsed >= 0 && elapsed < 5) {
      this.placeBuyOrders(market);
    }

    // Check fills on every tick
    this.checkOrderFills(market);
  }

  // ── State ─────────────────────────────────────────────────
  publicMarkets() {
    const cs = windowStartFor(Date.now());
    return [...this.markets.values()].filter(m => m.windowStart === cs)
      .map(m => ({
        slug: m.slug, asset: m.asset, title: m.title,
        windowStart: m.windowStart, windowEnd: m.windowEnd,
        resolved: m.resolved, winner: m.winner,
        elapsed: Math.max(0, Math.floor(Date.now() / 1000) - m.windowStart),
        remaining: Math.max(0, m.windowEnd - Math.floor(Date.now() / 1000)),
        up: { bid: m.up.bid, ask: m.up.ask, mid: m.up.mid, spread: m.up.spread },
        down: { bid: m.down.bid, ask: m.down.ask, mid: m.down.mid, spread: m.down.spread },
      }));
  }

  buildState() {
    const now = Date.now();
    const cs = windowStartFor(now);
    const activeOrders = this.orders.filter(o => o.status === 'PENDING');
    const filledOrders = this.orders.filter(o => o.status === 'FILLED');
    return {
      bankroll: this.bankroll,
      realizedPnl: this.realizedPnl,
      totalPnl: round2(this.bankroll - START_BANKROLL),
      wins: this.wins,
      losses: this.losses,
      winRate: this.wins + this.losses ? round2(this.wins / (this.wins + this.losses) * 100) : null,
      maxDrawdown: this.maxDrawdown,
      orders: { pending: activeOrders.length, filled: filledOrders.length },
      activeOrders: activeOrders.map(o => ({
        id: o.id, outcome: o.outcome, type: o.type, price: o.price, shares: o.shares,
        createdAt: o.createdAt, slug: o.slug,
      })),
      filledOrders: filledOrders.slice(-20).reverse().map(o => ({
        id: o.id, outcome: o.outcome, type: o.type, price: o.price, shares: o.shares,
        fillPrice: o.fillPrice, createdAt: o.createdAt, filledAt: o.filledAt,
        cost: o.cost, proceeds: o.proceeds, pnl: o.pnl,
      })),
      markets: this.publicMarkets(),
      trades: this.trades.slice(-50).reverse(),
      equityCurve: sampleCurve(this.equityCurve, 1500),
      logs: this.logs.slice(-200),
      config: { buyPrice: BUY_PRICE, sellPrice: SELL_PRICE, shares: SHARES, makerFeeRate: MAKER_FEE_RATE, makerRebate: MAKER_REBATE, startBankroll: START_BANKROLL },
      connected: this.pollCount > 0,
      uptime: Math.floor((now - this.startedAt) / 1000),
      pollCount: this.pollCount,
    };
  }

  recordEquity() {
    const equity = round2(this.bankroll);
    const now = Date.now();
    if (equity > this.peakEquity) this.peakEquity = equity;
    const dd = round2(this.peakEquity - equity);
    if (dd > this.maxDrawdown) this.maxDrawdown = dd;
    const last = this.equityCurve[this.equityCurve.length - 1];
    if (!last || now - last.t > 2000) this.equityCurve.push({ t: now, equity });
  }

  // ── Init ──────────────────────────────────────────────────
  async init() {
    const start = windowStartFor(Date.now());
    await Promise.all([this.discoverMarket('btc', start), this.discoverMarket('btc', start + WINDOW_SECONDS)]);

    // CLOB polling
    setInterval(() => this.pollClobBooks(), CLOB_POLL_MS);
    // Order evaluation (fast — check fills on every tick)
    setInterval(() => this.evaluate(), 100);
    // Resolution check
    setInterval(() => {
      const now = Date.now(), cs = windowStartFor(now);
      const market = this.markets.get(slugFor('btc', cs));
      if (market && !market.resolved && now / 1000 >= market.windowEnd) {
        this.cancelUnfilledOrders(market);
        this.resolveWindow(market);
      }
    }, 250);
    // Discovery retry
    setInterval(() => this.retryDiscovery().catch(() => {}), 1500);
    // Equity snapshot
    setInterval(() => this.recordEquity(), 2000);

    this.log(`🚀 LimitBot started · BUY @ $${BUY_PRICE.toFixed(2)} · SELL @ $${SELL_PRICE.toFixed(2)} · ${SHARES}sh · maker fee ${(MAKER_FEE_RATE*100).toFixed(1)}% · rebate ${(MAKER_REBATE*100).toFixed(2)}%`);
  }
}

module.exports = { BotEngine, loadEquityFile, config: { ASSETS, START_BANKROLL, BUY_PRICE, SELL_PRICE, SHARES, MAKER_FEE_RATE, MAKER_REBATE, WINDOW_SECONDS } };
