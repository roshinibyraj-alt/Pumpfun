'use strict';

// ── Config ──────────────────────────────────────────────────
const GAMMA_API      = process.env.GAMMA_API || 'https://gamma-api.polymarket.com';
const CLOB_REST      = process.env.CLOB_REST || 'https://clob.polymarket.com';
const CLOB_POLL_MS   = Number(process.env.CLOB_POLL_MS || 200);
const CLOB_FRESH_MS  = Number(process.env.CLOB_FRESH_MS || 4000);
const WINDOW_SECONDS = 300;
const ASSETS         = ['btc'];
const START_BANKROLL = Number(process.env.START_BANKROLL || 500);
const EQUITY_FILE    = process.env.EQUITY_FILE || './equity.json';

// Strategy params
const BUY_PRICES = (process.env.BUY_PRICES || '0.10,0.05').split(',').map(Number); // limit buy price levels
const SHARES      = Number(process.env.SHARES || 100);       // shares per order per level
const ORDER_WINDOW_SECONDS = Number(process.env.ORDER_WINDOW_SECONDS || 150); // cancel unfilled after this
const MAKER_FEE   = Number(process.env.MAKER_FEE || 0);      // 0 for limit orders
const MAKER_REBATE = Number(process.env.MAKER_REBATE || 0.001); // 0.1% rebate

const fs = require('fs');

function round2(v) { return Math.round(v * 100) / 100; }
function round5(v) { return Math.round(v * 100000) / 100000; }
function windowStartFor(ms) { return Math.floor(ms / 1000 / WINDOW_SECONDS) * WINDOW_SECONDS; }
function slugFor(a, s) { return `${a}-updown-5m-${s}`; }
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

class BotEngine {
  constructor(opts = {}) {
    this.fetchImpl = opts.fetchImpl || fetch;
    this.startedAt = Date.now();
    this.capital = { value: START_BANKROLL };
    Object.defineProperty(this, 'bankroll', { get: () => this.capital.value, set: v => { this.capital.value = v; } });

    this.markets = new Map();
    this.tokens = new Map();
    this.history = new Map();
    this.discoveredWindows = new Set();
    this.discoveryRunning = false;
    this.pollRunning = false;
    this.lastSuccessfulPollAt = null;
    this.lastPollErrorAt = null;
    this.lastErrorMsg = null;

    // Orders: one BUY per side per window, hold to resolution
    this.orders = [];
    this.nextOrderId = 1;
    this.entryWindow = null;   // don't trade mid-window on deploy
    this.lastCancelWindow = null;

    this.trades = [];
    this.wins = 0;
    this.losses = 0;
    this.realizedPnl = 0;
    this.peakEquity = START_BANKROLL;
    this.maxDrawdown = 0;
    this.logs = [];
    this.pollCount = 0;

    const seeded = (opts.initialEquity && Array.isArray(opts.initialEquity) && opts.initialEquity.length) ? opts.initialEquity.slice() : null;
    this.equityCurve = seeded || [{ t: Date.now(), equity: START_BANKROLL }];
  }

  log(msg) {
    const line = `[${new Date().toISOString().slice(11, 23)}] ${msg}`;
    this.logs.push(line);
    if (this.logs.length > 500) this.logs.shift();
    try { console.log(line); } catch (_) {}
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
        resolved: false, winner: null, resolvedOutcome: null, tradingClosed: false, finalUpMax: null, finalDownMax: null,
        up: { tokenId: tokenIds[ui], slug, asset, outcome: 'UP', bid: null, ask: null, mid: null, updatedAt: null, bookAsks: [] },
        down: { tokenId: tokenIds[di], slug, asset, outcome: 'DOWN', bid: null, ask: null, mid: null, updatedAt: null, bookAsks: [] },
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
  async pollClobBooks() {
    if (this.pollRunning) return;
    const now = Date.now(), cs = windowStartFor(now);
    const starts = new Set([cs, cs + WINDOW_SECONDS]);
    const tokens = [...this.tokens.values()].filter(t => { const m = this.markets.get(t.slug); return m && starts.has(m.windowStart) && !m.tradingClosed && !m.resolved; });
    if (!tokens.length) return;
    this.pollRunning = true;
    try {
      const books = await this.postJSON(`${CLOB_REST}/books`, tokens.map(t => ({ token_id: t.tokenId })), 6000);
      const byToken = new Map((Array.isArray(books) ? books : []).map(b => [String(b?.asset_id || ''), b]).filter(([id]) => this.tokens.has(id)));
      for (const t of tokens) { const b = byToken.get(t.tokenId); if (b) this.applyBook(t, b.bids || [], b.asks || []); }
      this.pollCount++;
      this.lastSuccessfulPollAt = Date.now();
      this.lastPollErrorAt = null;
      this.lastErrorMsg = null;
    } catch (e) {
      this.lastErrorMsg = e.message;
      if (!this.lastPollErrorAt || Date.now() - this.lastPollErrorAt >= 5000) { this.log(`⚠️ CLOB poll: ${e.message}`); this.lastPollErrorAt = Date.now(); }
    } finally { this.pollRunning = false; }
  }

  applyBook(token, bids, asks) {
    const validAsks = asks.filter(l => Number(l.size) > 0).map(l => ({ price: Number(l.price), size: Number(l.size) }));
    validAsks.sort((a, b) => a.price - b.price);
    token.bookAsks = validAsks;
    const bestBid = (bids.filter(l => Number(l.size) > 0).map(l => ({ price: Number(l.price) })).sort((a,b) => b.price - a.price)[0]?.price) ?? null;
    const bestAsk = validAsks[0]?.price ?? null;
    const cleanBid = Number.isFinite(bestBid) && bestBid > 0 && bestBid <= 1 ? bestBid : null;
    const cleanAsk = Number.isFinite(bestAsk) && bestAsk > 0 && bestAsk <= 1 ? bestAsk : null;

    // Capture final-2s max prices on EVERY poll (before early-return check)
    const market = this.markets.get(token.slug);
    if (market && !market.resolved) {
      const nowS = Date.now() / 1000;
      if (nowS >= market.windowEnd - 2) {
        const probe = cleanAsk ?? cleanBid ?? token.mid ?? 0;
        if (token.outcome === 'UP' && (market.finalUpMax == null || probe > market.finalUpMax)) market.finalUpMax = probe;
        if (token.outcome === 'DOWN' && (market.finalDownMax == null || probe > market.finalDownMax)) market.finalDownMax = probe;
      }
    }

    if (cleanBid === token.bid && cleanAsk === token.ask) return;
    token.bid = cleanBid; token.ask = cleanAsk;
    token.mid = cleanBid != null && cleanAsk != null ? round5((cleanBid + cleanAsk) / 2) : (cleanAsk ?? cleanBid);
    token.updatedAt = Date.now();
  }

  // ── Order Management ──────────────────────────────────────
  // Place exactly ONE buy on each side when window opens (guard against duplicates)
  placeBuyOrders(market) {
    for (const side of ['up', 'down']) {
      const outcome = side === 'up' ? 'UP' : 'DOWN';
      for (const price of BUY_PRICES) {
        // Only place if no order exists for this side+price/window in ANY status
        const existing = this.orders.find(o => o.slug === market.slug && o.outcome === outcome && o.type === 'BUY' && o.price === price);
        if (existing) continue;

        const order = {
          id: this.nextOrderId++,
          slug: market.slug,
          outcome, type: 'BUY',
          price, shares: SHARES,
          status: 'PENDING',
          createdAt: Date.now(), filledAt: null, fillPrice: null,
          cost: null, fee: 0, rebate: 0, totalCost: null,
        };
        this.orders.push(order);
        this.log(`📋 LIMIT BUY ${outcome} ${SHARES}sh @ $${price.toFixed(2)} · ord #${order.id}`);
      }
    }
  }

  checkBuyFill(market) {
    const cs = market.windowStart;
    const buys = this.orders.filter(o => o.slug === market.slug && o.type === 'BUY' && o.status === 'PENDING');
    for (const order of buys) {
      const token = order.outcome === 'UP' ? market.up : market.down;
      if (!token) return;
      const ask = token.ask ?? token.mid;
      if (ask != null && ask <= order.price + 0.001) {
        this.fillBuy(order, order.price);
      }
    }
  }

  fillBuy(order, price) {
    const cost = round2(order.shares * price);
    const rebate = makerRebate(order.shares, price);
    const totalCost = round2(cost - rebate);
    if (totalCost > this.bankroll) { this.log(`⚠️ SKIP BUY #${order.id} ${order.outcome} — need $${totalCost.toFixed(2)}, have $${this.bankroll.toFixed(2)}`); return; }
    this.bankroll = round2(this.bankroll - totalCost);
    order.status = 'FILLED';
    order.filledAt = Date.now();
    order.fillPrice = price;
    order.cost = cost;
    order.rebate = rebate;
    order.totalCost = totalCost;
    this.trades.push({ timestamp: Date.now(), type: 'BUY', outcome: order.outcome, shares: order.shares, price, cost: totalCost, rebate, orderId: order.id });
    this.log(`✅ BUY FILLED ${order.outcome} ${order.shares}sh @ $${price.toFixed(2)} · cost $${cost.toFixed(2)} · rebate $${rebate.toFixed(2)}`);
    this.recordEquity();
  }

  cancelUnfilled(market) {
    const pending = this.orders.filter(o => o.slug === market.slug && o.status === 'PENDING');
    for (const order of pending) {
      order.status = 'CANCELLED';
      order.closedAt = Date.now();
      this.log(`❌ CANCELLED #${order.id} ${order.type} ${order.outcome} @ $${order.price.toFixed(2)}`);
    }
  }

  // ── Resolution (CLOB final 2s prices, no API) ─────────────────
  // Resolve based on final 2-second max prices only. No API fallback.
  resolveWindow(market, nowS) {
    if (nowS < market.windowEnd) return false;
    const fUp = market.finalUpMax ?? 0;
    const fDown = market.finalDownMax ?? 0;
    let winner = null;
    if (fUp >= 0.95) winner = 'UP';
    else if (fDown >= 0.95) winner = 'DOWN';
    if (!winner) {
      this.log('⏳ RESOLUTION PENDING — neither side >= 0.95 (UP max=' + round5(fUp) + ', DOWN max=' + round5(fDown) + ')');
      return false;
    }
    market.resolved = true;
    market.winner = winner;
    this.log('🏁 RESOLUTION ' + winner + ' · UP max=' + round5(fUp) + ' · DOWN max=' + round5(fDown) + ' (final 2s CLOB)');

    // Cancel any unfilled orders
    this.cancelUnfilled(market);

    // Resolve all filled buys
    const filledBuys = this.orders.filter(o => o.slug === market.slug && o.type === 'BUY' && o.status === 'FILLED');
    for (const order of filledBuys) {
      const won = order.outcome === winner;
      const payout = won ? order.shares : 0;
      const pnl = round2(payout - order.totalCost);
      this.bankroll = round2(this.bankroll + payout);
      this.realizedPnl = round2(this.realizedPnl + pnl);
      if (pnl >= 0) this.wins++; else this.losses++;
      order.status = 'RESOLVED';
      order.resolvedAt = Date.now();
      order.pnl = pnl;
      this.log('🏁 ' + order.outcome + ' ' + (won ? 'WIN' : 'LOSS') + ' #' + order.id + ' @ $' + order.fillPrice.toFixed(2) + ' → P&L ' + (pnl >= 0 ? '+' : '-') + '$' + Math.abs(pnl).toFixed(2));
      this.trades.push({ timestamp: Date.now(), type: 'RESOLVED', outcome: order.outcome, shares: order.shares, price: won ? 1 : 0, cost: order.totalCost, pnl, orderId: order.id, winner });
    }
    this.recordEquity();
    return true;
  }

  // ── Main Loop ─────────────────────────────────────────────
  evaluate() {
    const now = Date.now();
    const cs = windowStartFor(now);
    const market = this.markets.get(slugFor('btc', cs));
    if (this.entryWindow != null && cs < this.entryWindow) return;
    if (!market || market.resolved || market.tradingClosed) return;
    const elapsed = Math.floor(now / 1000) - cs;
    if (elapsed < 0 || elapsed >= WINDOW_SECONDS) return;

    // Place buy orders once (immediately at window open)
    if (this.lastOrderWindow !== cs) {
      this.lastOrderWindow = cs;
      this.placeBuyOrders(market);
    }

    // Cancel unfilled orders after ORDER_WINDOW_SECONDS
    if (elapsed >= ORDER_WINDOW_SECONDS && this.lastCancelWindow !== cs) {
      this.lastCancelWindow = cs;
      this.cancelUnfilled(market);
    }

    // Check fills each tick (only while orders can still fill)
    if (elapsed < ORDER_WINDOW_SECONDS) this.checkBuyFill(market);
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
        up: { bid: m.up.bid, ask: m.up.ask, mid: m.up.mid, spread: m.up.bid != null && m.up.ask != null ? round5(m.up.ask - m.up.bid) : null },
        down: { bid: m.down.bid, ask: m.down.ask, mid: m.down.mid, spread: m.down.bid != null && m.down.ask != null ? round5(m.down.ask - m.down.bid) : null },
      }));
  }

  buildState() {
    const now = Date.now();
    const cs = windowStartFor(now);
    return {
      bankroll: this.bankroll,
      realizedPnl: this.realizedPnl,
      totalPnl: round2(this.bankroll - START_BANKROLL),
      wins: this.wins, losses: this.losses,
      winRate: this.wins + this.losses ? round2(this.wins / (this.wins + this.losses) * 100) : null,
      maxDrawdown: this.maxDrawdown,
      orders: this.orders.slice(-30).reverse(),
      activeOrders: this.orders.filter(o => o.status === 'PENDING').map(o => ({ id: o.id, outcome: o.outcome, type: o.type, price: o.price, shares: o.shares, createdAt: o.createdAt, slug: o.slug })),
      pendingCount: this.orders.filter(o => o.status === 'PENDING').length,
      filledCount: this.orders.filter(o => o.status === 'FILLED').length,
      resolvedCount: this.orders.filter(o => o.status === 'RESOLVED').length,
      markets: this.publicMarkets(),
      trades: this.trades.slice(-50).reverse(),
      equityCurve: sampleCurve(this.equityCurve, 1500),
      logs: this.logs.slice(-200),
      config: { buyPrices: BUY_PRICES, shares: SHARES, orderWindow: ORDER_WINDOW_SECONDS, makerRebate: MAKER_REBATE, startBankroll: START_BANKROLL },
      connected: this.lastSuccessfulPollAt != null && (now - this.lastSuccessfulPollAt) < 20000,
      uptime: Math.floor((now - this.startedAt) / 1000),
      pollCount: this.pollCount,
      lastPollAt: this.lastSuccessfulPollAt,
      lastError: this.lastErrorMsg,
      entryWindow: this.entryWindow,
      waitingForWindow: this.entryWindow != null && windowStartFor(now) < this.entryWindow,
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

  async init() {
    const start = windowStartFor(Date.now());
    // Begin trading at next fresh window to avoid mid-window deploy
    this.entryWindow = start + WINDOW_SECONDS;
    this.lastOrderWindow = null;
    this.log(`⏳ Started mid-window ${start} — will place orders at next window ${this.entryWindow}`);

    // Warm up the CLOB connection (DNS/TLS) in parallel with discovery so the first
    // books POST is fast instead of paying the cold handshake.
    this.fetchImpl(CLOB_REST + '/').catch(() => {});

    // Current window first (needed now), next window in background
    await this.discoverMarket('btc', start);
    this.discoverMarket('btc', start + WINDOW_SECONDS).catch(() => {});

    setInterval(() => this.pollClobBooks(), CLOB_POLL_MS);
    setInterval(() => this.evaluate(), 100);
    setInterval(() => {
      const now = Date.now(), nowS = now / 1000;
      // Resolve ALL past markets with filled orders, not just the current window
      for (const [slug, m] of this.markets) {
        if (m.resolved || m.tradingClosed) continue;
        const hasFilled = this.orders.some(o => o.slug === slug && o.type === 'BUY' && o.status === 'FILLED');
        if (!hasFilled) continue;
        if (nowS >= m.windowEnd) {
          this.resolveWindow(m, nowS);
        }
      }
    }, 250);
    setInterval(() => this.retryDiscovery().catch(() => {}), 2000);
    setInterval(() => this.recordEquity(), 2000);

    this.log(`🚀 LimitBot started · BUY both @ ${BUY_PRICES.map(p => '$' + p.toFixed(2)).join(' + ')} · ${SHARES}sh each · cancel @ ${ORDER_WINDOW_SECONDS}s · hold to resolution`);
  }
}

module.exports = { BotEngine, loadEquityFile, config: { ASSETS, START_BANKROLL, BUY_PRICES, SHARES, ORDER_WINDOW_SECONDS, MAKER_FEE, MAKER_REBATE, WINDOW_SECONDS } };
