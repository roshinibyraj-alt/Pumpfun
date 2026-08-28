'use strict';

// ── Config ──────────────────────────────────────────────────
const GAMMA_API     = process.env.GAMMA_API || 'https://gamma-api.polymarket.com';
const CLOB_REST     = process.env.CLOB_REST || 'https://clob.polymarket.com';
const BINANCE_API   = process.env.BINANCE_API || 'https://api.binance.com';
const CLOB_POLL_MS  = Number(process.env.CLOB_POLL_MS || 1000);
const CLOB_FRESH_MS = Number(process.env.CLOB_FRESH_MS || 4000);
const TICK_POLL_MS  = Number(process.env.TICK_POLL_MS || 1000);
const WINDOW_SECONDS = 300;
const START_BANKROLL = Number(process.env.START_BANKROLL || 20000);
const EQUITY_FILE   = process.env.EQUITY_FILE || './equity.json';

// ── jmazzini Strategy Params ───────────────────────────────
const ASSETS            = ['btc', 'eth'];
const ENTRY_SECONDS_MIN = Number(process.env.ENTRY_SECONDS_MIN || 10);
const ENTRY_SECONDS_MAX = Number(process.env.ENTRY_SECONDS_MAX || 50);
const PRICE_MIN         = {
  BTC: Number(process.env.PRICE_MIN_BTC || 0.94),
  ETH: Number(process.env.PRICE_MIN_ETH || 0.92),
};
const PRICE_MAX         = Number(process.env.PRICE_MAX || 0.99);
const DELTA_SKIP        = Number(process.env.DELTA_SKIP || 0.0005);
const DELTA_WEAK        = Number(process.env.DELTA_WEAK || 0.001);
const DELTA_STRONG      = Number(process.env.DELTA_STRONG || 0.002);
const MIN_CONFIDENCE    = Number(process.env.MIN_CONFIDENCE || 0.3);
const ATR_PERIODS       = Number(process.env.ATR_PERIODS || 5);
const ATR_MULTIPLIER    = Number(process.env.ATR_MULTIPLIER || 1.5);
const FLAT_SHARES       = Number(process.env.FLAT_SHARES || 1000);
const MIN_BET           = Number(process.env.MIN_BET || 1);

// Polymarket fee
const TAKER_FEE_RATE    = Number(process.env.TAKER_FEE_RATE || 0.07);

// Binance symbols per asset
const BINANCE_SYMBOLS = { btc: 'BTCUSDT', eth: 'ETHUSDT' };

const fs = require('fs');

// ── Helpers ─────────────────────────────────────────────────
function round2(v) { return Math.round(v * 100) / 100; }
function round5(v) { return Math.round(v * 100000) / 100000; }
function windowStartFor(ms) { return Math.floor(ms / 1000 / WINDOW_SECONDS) * WINDOW_SECONDS; }
function slugFor(a, s) { return `${a}-updown-5m-${s}`; }
function takerFee(shares, price) { return round5(shares * TAKER_FEE_RATE * price * (1 - price)); }
function ema(data, period) {
  const k = 2 / (period + 1);
  let e = data[0];
  for (let i = 1; i < data.length; i++) e = data[i] * k + e * (1 - k);
  return e;
}
function sampleCurve(c, max = 1500) {
  if (!Array.isArray(c) || c.length <= max) return c || [];
  const step = (c.length - 1) / (max - 1);
  const out = [];
  for (let i = 0; i < max; i++) out.push(c[Math.round(i * step)]);
  out[max - 1] = c[c.length - 1];
  return out;
}
function loadEquityFile(f) {
  try { const d = JSON.parse(fs.readFileSync(f, 'utf8')); return Array.isArray(d) ? d : []; } catch (_) { return []; }
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
    this.activeWindowStart = null;
    this.discoveryRunning = false;
    this.pollRunning = false;
    this.loopRunning = false;
    this.lastSuccessfulPollAt = null;
    this.lastPollErrorAt = null;

    // Binance data (per-asset)
    this.binanceCandles = {};    // { btc: [...], eth: [...] }
    this.binanceCandles5m = {};  // { btc: [...], eth: [...] } for ATR
    this.tickHistory = {};       // { btc: [...], eth: [...] }
    this.tickFetching = false;
    this.tickFetchedAt = 0;
    this.candleFetching = false;
    this.candleFetchedAt = 0;

    // Per-asset signals
    this.signals = {};           // { btc: { score, confidence, direction, ... }, eth: { ... } }
    this.lastSignalEvalAt = 0;

    // Position (one at a time, max)
    this.positions = [];
    this.resolvedPositions = [];

    // Tracking
    this.trades = [];
    this.wins = 0;
    this.losses = 0;
    this.realizedPnl = 0;
    this.peakEquity = START_BANKROLL;
    this.maxDrawdown = 0;
    this.logs = [];
    this.pollCount = 0;

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
        up: { tokenId: tokenIds[ui], slug, asset, outcome: 'UP', bid: null, ask: null, mid: null, spread: null, updatedAt: null, bookAsks: [] },
        down: { tokenId: tokenIds[di], slug, asset, outcome: 'DOWN', bid: null, ask: null, mid: null, spread: null, updatedAt: null, bookAsks: [] },
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
  applyBook(token, bids, asks) {
    const validAsks = asks.filter(l => Number(l.size) > 0).map(l => ({ price: Number(l.price), size: Number(l.size) }));
    validAsks.sort((a, b) => a.price - b.price);
    token.bookAsks = validAsks;
    const bestBid = (bids.filter(l => Number(l.size) > 0).map(l => ({ price: Number(l.price) })).sort((a,b) => b.price - a.price)[0]?.price) ?? null;
    const bestAsk = validAsks[0]?.price ?? null;
    const cleanBid = Number.isFinite(bestBid) && bestBid > 0 && bestBid <= 1 ? bestBid : null;
    const cleanAsk = Number.isFinite(bestAsk) && bestAsk > 0 && bestAsk <= 1 ? bestAsk : null;
    if (cleanBid === token.bid && cleanAsk === token.ask) return;
    token.bid = cleanBid; token.ask = cleanAsk;
    token.spread = cleanBid != null && cleanAsk != null ? round5(cleanAsk - cleanBid) : null;
    token.mid = cleanBid != null && cleanAsk != null ? round5((cleanBid + cleanAsk) / 2) : (cleanAsk ?? cleanBid);
    token.updatedAt = Date.now();
    this.pushHistory(token.tokenId, token.mid);
  }

  pushHistory(tokenId, price) {
    if (!Number.isFinite(price)) return;
    const now = Date.now(), s = this.history.get(tokenId) || [];
    s.push({ t: now, p: price });
    while (s.length > 2 && now - s[0].t > 5000) s.shift();
    this.history.set(tokenId, s.slice(-240));
  }

  simulateGtcBookFill(token, shares, ceiling) {
    const asks = token.bookAsks || [];
    let rem = shares, total = 0;
    for (const lv of asks) { if (lv.price > ceiling) break; if (rem <= 0) break; const f = Math.min(lv.size, rem); total += round2(f * lv.price); rem -= f; }
    const filled = shares - rem;
    return filled > 0 ? { avgPrice: round5(total / filled), filled, totalCost: round2(total) } : null;
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

  // ── jmazzini Strategy: Window-Delta + Momentum + ATR ──────
  _getBinanceCurrentPrice(asset) {
    const symbol = BINANCE_SYMBOLS[asset];
    if (!symbol) return 0;
    const candles = this.binanceCandles[asset];
    if (candles && candles.length > 0) return candles[candles.length - 1].close;
    const ticks = this.tickHistory[asset];
    if (ticks && ticks.length > 0) return ticks[ticks.length - 1].p;
    return 0;
  }

  _getWindowOpenPrice(asset, windowStart) {
    const candles5m = this.binanceCandles5m[asset];
    if (candles5m) {
      for (const c of candles5m) {
        if (c.openTime <= windowStart && c.openTime + 300 > windowStart) return c.open;
      }
    }
    const candles = this.binanceCandles[asset];
    if (candles) {
      for (const c of candles) {
        if (c.openTime <= windowStart && c.openTime + 60 > windowStart) return c.open;
      }
      if (candles.length > 0) return candles[0].open;
    }
    return 0;
  }

  _getAtr(asset, windowStart, periods = ATR_PERIODS) {
    const candles5m = this.binanceCandles5m[asset];
    if (!candles5m || candles5m.length < 2) return 0;
    const relevant = candles5m.filter(c => c.openTime + 300 <= windowStart).slice(-periods);
    if (relevant.length === 0) return 0;
    const ranges = relevant.map(c => c.high - c.low);
    return ranges.reduce((s, r) => s + r, 0) / ranges.length;
  }

  _getCurrentRange(asset) {
    const candles5m = this.binanceCandles5m[asset];
    if (!candles5m || candles5m.length === 0) return 0;
    const current = candles5m[candles5m.length - 1];
    return current.high - current.low;
  }

  analyzeAsset(asset, windowStart) {
    const currentPrice = this._getBinanceCurrentPrice(asset);
    if (currentPrice <= 0) return { confidence: 0, direction: null, reason: 'no Binance price' };

    const windowOpen = this._getWindowOpenPrice(asset, windowStart);
    if (windowOpen <= 0) return { confidence: 0, direction: null, reason: 'no window open price' };

    // 1. Window Delta
    const delta = (currentPrice - windowOpen) / windowOpen;
    const deltaPct = Math.abs(delta) * 100;

    // ATR volatility filter
    const atr = this._getAtr(asset, windowStart);
    if (atr > 0) {
      const currentRange = this._getCurrentRange(asset);
      if (currentRange > atr * ATR_MULTIPLIER) {
        return {
          confidence: 0, direction: null,
          windowOpen, currentPrice, deltaPct, atr, currentRange,
          reason: `ATR skip: range $${currentRange.toFixed(2)} > ${ATR_MULTIPLIER}x ATR $${atr.toFixed(2)}`,
        };
      }
    }

    if (Math.abs(delta) < DELTA_SKIP) {
      return {
        confidence: 0, direction: null,
        windowOpen, currentPrice, deltaPct, atr,
        reason: `delta ${deltaPct.toFixed(4)}% < ${(DELTA_SKIP * 100).toFixed(3)}% — too close to the line`,
      };
    }

    // Delta weight (jmazzini scoring)
    let deltaWeight;
    if (Math.abs(delta) >= DELTA_STRONG * 5) deltaWeight = 7;   // > 1%
    else if (Math.abs(delta) >= DELTA_STRONG) deltaWeight = 5;    // > 0.2%
    else if (Math.abs(delta) >= DELTA_WEAK) deltaWeight = 3;      // > 0.1%
    else deltaWeight = 1;                                         // > 0.05%

    let score = delta > 0 ? deltaWeight : -deltaWeight;

    // 2. Micro momentum (last 2 × 1m candles)
    const candles = this.binanceCandles[asset];
    let momentumStr = 'no data';
    if (candles && candles.length >= 2) {
      const prevClose = candles[candles.length - 2].close;
      const lastClose = candles[candles.length - 1].close;
      const momentumUp = lastClose > prevClose;
      if ((delta > 0 && momentumUp) || (delta < 0 && !momentumUp)) {
        score += 2;
        momentumStr = momentumUp ? '↑ confirms' : '↓ confirms';
      } else {
        momentumStr = `${momentumUp ? '↑' : '↓'} contradicts, ignored`;
      }
    }

    const confidence = Math.min(Math.abs(score) / 9.0, 1.0);
    const direction = score > 0 ? 'UP' : 'DOWN';

    return {
      score: round5(score), confidence: round5(confidence), direction,
      windowOpen, currentPrice, deltaPct, deltaWeight,
      atr: atr || 0, currentRange: this._getCurrentRange(asset),
      momentum: momentumStr,
      reason: `delta=${deltaPct.toFixed(4)}% (w=${deltaWeight}) momentum=${momentumStr}`,
    };
  }

  async fetchBinanceCandles(limit = 25) {
    if (this.candleFetching) return;
    const now = Date.now();
    if (now - this.candleFetchedAt < 8000) return;
    this.candleFetching = true;
    try {
      const fetches = ASSETS.map(async (asset) => {
        const symbol = BINANCE_SYMBOLS[asset];
        if (!symbol) return;
        const data = await this.getJSON(`${BINANCE_API}/api/v3/klines?symbol=${symbol}&interval=1m&limit=${limit}`);
        if (Array.isArray(data) && data.length > 0) {
          this.binanceCandles[asset] = data.map(c => ({
            openTime: Number(c[0]) / 1000,
            open: Number(c[1]), high: Number(c[2]), low: Number(c[3]), close: Number(c[4]),
            volume: Number(c[5]),
          }));
        }
        const data5m = await this.getJSON(`${BINANCE_API}/api/v3/klines?symbol=${symbol}&interval=5m&limit=${ATR_PERIODS + 3}`);
        if (Array.isArray(data5m) && data5m.length > 0) {
          this.binanceCandles5m[asset] = data5m.map(c => ({
            openTime: Number(c[0]) / 1000,
            open: Number(c[1]), high: Number(c[2]), low: Number(c[3]), close: Number(c[4]),
            volume: Number(c[5]),
          }));
        }
      });
      await Promise.all(fetches);
      this.candleFetchedAt = now;
    } catch (_) {} finally { this.candleFetching = false; }
  }

  async fetchBinanceTick() {
    if (this.tickFetching) return;
    const now = Date.now();
    if (now - this.tickFetchedAt < TICK_POLL_MS - 200) return;
    this.tickFetching = true;
    try {
      const fetches = ASSETS.map(async (asset) => {
        const symbol = BINANCE_SYMBOLS[asset];
        if (!symbol) return;
        try {
          const data = await this.getJSON(`${BINANCE_API}/api/v3/ticker/price?symbol=${symbol}`, 4000);
          const price = Number(data?.price);
          if (Number.isFinite(price)) {
            this.tickHistory[asset].push({ t: now, p: price });
            if (this.tickHistory[asset].length > 120) this.tickHistory[asset].shift();
          }
        } catch (_) {}
      });
      await Promise.all(fetches);
      this.tickFetchedAt = now;
      const cs = windowStartFor(now);
      const elapsed = Math.floor(now / 1000) - cs;
      if (elapsed >= WINDOW_SECONDS - ENTRY_SECONDS_MAX && now - (this.lastSignalEvalAt || 0) >= 300) {
        this.computeSignals();
        this.evaluateEntry();
      }
    } catch (_) {} finally { this.tickFetching = false; }
  }

  computeSignals() {
    const now = Date.now();
    const cs = windowStartFor(now);
    for (const asset of ASSETS) {
      this.signals[asset] = this.analyzeAsset(asset, cs);
    }
  }

  // ── Strategy: Late Entry (10–50s before close) ────────────
  evaluateEntry() {
    const now = Date.now();
    const cs = windowStartFor(now);
    const secondsLeft = (cs + WINDOW_SECONDS) - Math.floor(now / 1000);
    if (secondsLeft <= 0 || secondsLeft > ENTRY_SECONDS_MAX) return;
    if (secondsLeft < ENTRY_SECONDS_MIN) return;

    for (const asset of ASSETS) {
      const signal = this.signals[asset];
      if (!signal || signal.confidence < MIN_CONFIDENCE || !signal.direction) continue;

      const market = [...this.markets.values()].find(m => m.windowStart === cs && m.asset === asset && !m.resolved && !m.tradingClosed);
      if (!market) continue;

      const alreadyOpen = this.positions.some(p => p.windowStart === cs && p.slug === market.slug && p.status === 'open');
      if (alreadyOpen) continue;

      const upPrice = market.up.mid ?? market.up.ask ?? market.up.bid;
      const dnPrice = market.down.mid ?? market.down.ask ?? market.down.bid;
      if (!Number.isFinite(upPrice) || !Number.isFinite(dnPrice)) continue;

      const leadingSide = upPrice >= dnPrice ? 'UP' : 'DOWN';
      const leadingPrice = Math.max(upPrice, dnPrice);

      const assetUpper = asset.toUpperCase();
      const priceFloor = PRICE_MIN[assetUpper] || 0.92;
      if (leadingPrice < priceFloor) continue;
      if (leadingPrice > PRICE_MAX) continue;

      if (signal.direction !== leadingSide) continue;

      const token = leadingSide === 'UP' ? market.up : market.down;
      const price = token.ask ?? token.mid ?? token.bid;
      if (!Number.isFinite(price) || price <= 0 || price >= 1) continue;
      if (price > PRICE_MAX) continue;

      this.executeBuy(market, leadingSide, price, FLAT_SHARES, cs, market.windowEnd);
    }
  }

  executeBuy(market, outcome, price, shares, windowStart, windowEnd) {
    // Hard guard: only one trade per window.
    const windowTraded = this.positions.some(p => p.windowStart === windowStart && (p.status === 'open' || p.exitReason === 'RESOLUTION'));
    if (windowTraded) return;
    const cost = round2(shares * price);
    const fee = takerFee(shares, price);
    const totalCost = round2(cost + fee);
    if (totalCost > this.bankroll) { this.log(`⚠️ SKIP ${outcome} ${shares}sh — need $${totalCost.toFixed(2)}, have $${this.bankroll.toFixed(2)}`); return; }
    this.bankroll = round2(this.bankroll - totalCost);
    const token = outcome === 'UP' ? market.up : market.down;
    const asset = market.asset;
    const signal = this.signals[asset] || {};
    const pos = {
      slug: market.slug, asset, conditionId: market.conditionId,
      outcome, tokenId: token.tokenId,
      shares, entryPrice: price, cost, fee, totalCost,
      status: 'open', openedAt: Date.now(), markPrice: token.mid,
      windowStart, windowEnd,
      signalConf: signal.confidence || 0, signalScore: signal.score || 0,
      betLabel: outcome,
      exitReason: null, exitPrice: null, closedAt: null, pnl: null,
    };
    this.positions.push(pos);
    this.trades.push({ timestamp: Date.now(), type: 'BUY', outcome, shares, price, cost, fee, confidence: signal.confidence || 0, score: signal.score || 0, markPrice: token.mid, betLabel: outcome, asset });
    this.log(`⚡ ${asset.toUpperCase()} BUY ${outcome} ${shares}sh @${price.toFixed(3)} · conf ${((signal.confidence||0)*100).toFixed(0)}% · delta ${signal.deltaPct!=null?signal.deltaPct.toFixed(4)+'%':'—'} · cost $${cost.toFixed(2)}`);
    this.recordEquity();
  }

  evaluateExit() {
    // Refresh mark prices for open positions.
    // This only refreshes mark prices for open positions.
    for (const p of this.positions) {
      if (p.status !== 'open') continue;
      const market = this.markets.get(p.slug);
      if (market) { const token = p.outcome === 'UP' ? market.up : market.down; if (Number.isFinite(token?.mid)) p.markPrice = token.mid; }
    }
  }


  sellPosition(p, reason) {
    if (!p || p.status !== 'open') return;
    const exitPrice = p.markPrice ?? p.entryPrice;
    const proceeds = round2(p.shares * exitPrice);
    const exitFee = takerFee(p.shares, exitPrice);
    const netProceeds = round2(proceeds - exitFee);
    const pnl = round2(netProceeds - p.cost - p.fee);
    p.status = 'closed'; p.exitReason = reason; p.exitPrice = exitPrice; p.exitFee = exitFee;
    p.closedAt = Date.now(); p.pnl = pnl; p.won = pnl >= 0;
    this.bankroll = round2(this.bankroll + netProceeds);
    this.realizedPnl = round2(this.realizedPnl + pnl);
    if (pnl >= 0) this.wins++; else this.losses++;
    this.log(`💰 EXIT ${reason} ${p.betLabel||''} ${p.outcome} ${p.shares}sh @${exitPrice.toFixed(3)} · P&L ${pnl >= 0 ? '+' : '-'}$${Math.abs(pnl).toFixed(2)}`);
    this.resolvedPositions.unshift({ ...p });
    this.resolvedPositions = this.resolvedPositions.slice(0, 50);
    this.trades.push({ timestamp: p.closedAt, type: 'SELL', outcome: p.outcome, shares: p.shares, price: exitPrice, cost: p.cost, fee: exitFee, pnl });
    this.positions = this.positions.filter(x => x !== p);
    this.recordEquity();
  }

  // ── Resolution (Binance-based) ────────────────────────────
  async resolveByBinance() {
    const openPositions = this.positions.filter(p => p.status === 'open');
    if (!openPositions.length) return;
    const now = Date.now() / 1000;
    if (now < openPositions[0].windowEnd) return;

    for (const p of openPositions) {
      const candles = this.binanceCandles[p.asset];
      if (!candles || candles.length < 2) continue;

      // Find the close price at window end
      let closePrice = null;
      for (const c of candles) {
        if (c.openTime >= p.windowEnd - 60 && c.openTime < p.windowEnd) {
          closePrice = c.close; break;
        }
      }
      if (closePrice == null) closePrice = candles[candles.length - 1]?.close;

      // Find the open price at window start
      let openPrice = null;
      for (const c of candles) {
        if (c.openTime <= p.windowStart && c.openTime + 60 > p.windowStart) {
          openPrice = c.open; break;
        }
      }
      if (openPrice == null) openPrice = candles[0]?.open;
      if (!Number.isFinite(closePrice) || !Number.isFinite(openPrice)) continue;

      const winner = closePrice >= openPrice ? 'UP' : 'DOWN';
      const won = p.outcome === winner;
      const payout = won ? p.shares : 0;
      const pnl = round2(payout - p.cost - p.fee);

      p.status = 'closed';
      p.won = won;
      p.exitReason = 'RESOLUTION';
      p.exitPrice = won ? 1 : 0;
      p.exitFee = 0;
      p.closedAt = Date.now();
      p.pnl = pnl;
      p.resolvedWinner = winner;
      p.resolvedOpen = openPrice;
      p.resolvedClose = closePrice;

      this.bankroll = round2(this.bankroll + payout);
      this.realizedPnl = round2(this.realizedPnl + pnl);
      if (won) this.wins++; else this.losses++;

      this.log(`🏁 ${p.asset.toUpperCase()} RESOLUTION ${winner} (${openPrice.toFixed(0)}→${closePrice.toFixed(0)}) · ${p.outcome} ${won ? 'WIN' : 'LOSS'} · P&L ${pnl >= 0 ? '+' : '-'}$${Math.abs(pnl).toFixed(2)}`);
      this.resolvedPositions.unshift({ ...p });
      this.resolvedPositions = this.resolvedPositions.slice(0, 50);
      this.trades.push({ timestamp: p.closedAt, type: 'RESOLVED', outcome: p.outcome, shares: p.shares, price: won ? 1 : 0, cost: p.cost, fee: p.fee, pnl, asset: p.asset });
      this.positions = this.positions.filter(x => x !== p);
    }
    this.recordEquity();
  }

  // ── Equity Curve ──────────────────────────────────────────
  recordEquity() {
    const openMark = this.positions.filter(p => p.status === 'open').reduce((s, p) => s + p.shares * (p.markPrice ?? p.entryPrice), 0);
    const markValue = round2(this.bankroll + openMark);
    const last = this.equityCurve[this.equityCurve.length - 1];
    if (!last || Date.now() - last.t > 1000 || Math.abs(last.equity - markValue) > 0.001) {
      this.equityCurve.push({ t: Date.now(), equity: markValue });
      if (this.equityCurve.length > 4000) this.equityCurve = sampleCurve(this.equityCurve, 2000);
      if (Date.now() - this.lastEquitySaveAt > 5000) {
        this.lastEquitySaveAt = Date.now();
        try { fs.writeFileSync(EQUITY_FILE, JSON.stringify(sampleCurve(this.equityCurve, 2000))); } catch (_) {}
      }
    }
    if (markValue > this.peakEquity) this.peakEquity = markValue;
    const dd = this.peakEquity - markValue;
    if (dd > this.maxDrawdown) this.maxDrawdown = dd;
  }

  isClobFresh() { return Boolean(this.lastSuccessfulPollAt && Date.now() - this.lastSuccessfulPollAt <= CLOB_FRESH_MS); }

  publicMarkets() {
    const cs = windowStartFor(Date.now());
    return [...this.markets.values()].filter(m => m.windowStart === cs)
      .map(m => ({
        slug: m.slug, asset: m.asset, title: m.title,
        windowStart: m.windowStart, windowEnd: m.windowEnd,
        resolved: m.resolved, winner: m.winner,
        elapsed: Math.max(0, Math.floor(Date.now() / 1000 - m.windowStart)),
        remaining: Math.max(0, m.windowEnd - Math.floor(Date.now() / 1000)),
        up: { bid: m.up.bid, ask: m.up.ask, mid: m.up.mid, spread: m.up.spread, updatedAt: m.up.updatedAt },
        down: { bid: m.down.bid, ask: m.down.ask, mid: m.down.mid, spread: m.down.spread, updatedAt: m.down.updatedAt },
      }));
  }

  _combinedSignal() {
    const sigs = Object.entries(this.signals || {});
    if (!sigs.length) return { score: 0, confidence: 0, lean: 'NEUTRAL', indicators: {} };
    // Pick the asset with highest confidence as the combined view
    const best = sigs.reduce((a, b) => (b[1]?.confidence || 0) > (a[1]?.confidence || 0) ? b : a);
    const [asset, sig] = best;
    return {
      score: sig.score || 0, confidence: sig.confidence || 0,
      lean: sig.direction || 'NEUTRAL', asset,
      indicators: this.signals,
      reason: sig.reason || '',
    };
  }

  buildState() {
    const openPos = this.positions.filter(p => p.status === 'open');
    const openMarkValue = openPos.reduce((s, p) => s + p.shares * (p.markPrice ?? p.entryPrice), 0);
    const unrealizedPnl = openPos.reduce((s, p) => s + round2(p.shares * (p.markPrice ?? p.entryPrice) - p.cost - p.fee), 0);
    const markValue = round2(this.bankroll + openMarkValue);
    const now = Date.now();
    const cs = windowStartFor(now);
    return {
      bankroll: this.bankroll, markValue, realizedPnl: this.realizedPnl,
      unrealizedPnl, totalPnl: round2(markValue - START_BANKROLL),
      wins: this.wins, losses: this.losses,
      winRate: this.wins + this.losses ? round2(this.wins / (this.wins + this.losses) * 100) : null,
      maxDrawdown: this.maxDrawdown,
      signals: this.signals,
      signal: this._combinedSignal(),
      positions: openPos.map(p => ({ outcome: p.outcome, shares: p.shares, entryPrice: p.entryPrice, cost: p.cost,
        betLabel: p.betLabel, markPrice: p.markPrice, asset: p.asset,
        unrealized: round2(p.shares * (p.markPrice ?? p.entryPrice) - p.cost - p.fee),
        confidence: p.signalConf, openedAt: p.openedAt, side: p.outcome })),

      markets: this.publicMarkets(),
      resolvedPositions: this.resolvedPositions.slice(0, 30),
      trades: this.trades.slice(-80).reverse(),
      equityCurve: sampleCurve(this.equityCurve, 1500),
      logs: this.logs.slice(-220),
      config: {
        entrySecondsMin: ENTRY_SECONDS_MIN, entrySecondsMax: ENTRY_SECONDS_MAX,
        priceMinBTC: PRICE_MIN.BTC, priceMinETH: PRICE_MIN.ETH, priceMax: PRICE_MAX,
        deltaSkip: DELTA_SKIP, deltaWeak: DELTA_WEAK, deltaStrong: DELTA_STRONG,
        minConfidence: MIN_CONFIDENCE, atrPeriods: ATR_PERIODS, atrMultiplier: ATR_MULTIPLIER,
        flatShares: FLAT_SHARES, takerFeeRate: TAKER_FEE_RATE,
      },
      connected: this.isClobFresh(),
      uptime: Math.floor((now - this.startedAt) / 1000),
      tickCount: Object.values(this.tickHistory).reduce((s, a) => s + a.length, 0),
    };
  }

  // ── Main Loop ─────────────────────────────────────────────
  async init() {
    const start = windowStartFor(Date.now());
    const discs = [];
    for (const asset of ASSETS) {
      discs.push(this.discoverMarket(asset, start));
      discs.push(this.discoverMarket(asset, start + WINDOW_SECONDS));
    }
    await Promise.all(discs);
    await this.fetchBinanceCandles();
    this.computeSignals();

    // CLOB polling
    setInterval(() => this.pollClobBooks(), CLOB_POLL_MS);
    // Binance tick polling (1s)
    setInterval(() => this.fetchBinanceTick().catch(() => {}), TICK_POLL_MS);
    // Binance candle refresh (10s)
    setInterval(() => this.fetchBinanceCandles().catch(() => {}), 10000);
    // Signal recomputation (every 1s)
    setInterval(() => { this.lastSignalEvalAt = Date.now(); this.computeSignals(); this.evaluateEntry(); }, 1000);
    // Exit check (every 1s)
    setInterval(() => { this.evaluateExit(); }, 1000);
    // Resolution check (every 3s)
    setInterval(() => { this.resolveByBinance().catch(() => {}); }, 3000);
    // Discovery retry
    setInterval(() => this.retryDiscovery().catch(() => {}), 1500);
    // Equity snapshot
    setInterval(() => this.recordEquity(), 2000);

    this.log(`🚀 jmazzini bot started | ETH+BTC 5m | entry ${ENTRY_SECONDS_MIN}-${ENTRY_SECONDS_MAX}s before close | min-conf ${(MIN_CONFIDENCE*100).toFixed(0)}% | ${FLAT_SHARES}sh`);
  }
}

module.exports = { BotEngine, loadEquityFile, config: { ASSETS, START_BANKROLL, FLAT_SHARES, ENTRY_SECONDS_MIN, ENTRY_SECONDS_MAX, PRICE_MIN, PRICE_MAX, DELTA_SKIP, DELTA_WEAK, DELTA_STRONG, MIN_CONFIDENCE, ATR_PERIODS, ATR_MULTIPLIER, TAKER_FEE_RATE, WINDOW_SECONDS } };
