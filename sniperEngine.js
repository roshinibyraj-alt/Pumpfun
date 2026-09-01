'use strict';

// ── SniperBot Config ──────────────────────────────────────────
const WINDOW_SECONDS  = 300;
const SNIPER_WAIT     = 150;   // seconds after window starts to begin monitoring
const ENTRY_PRICE     = 0.89;  // trigger when ask reaches this
const STOP_LOSS_PRICE = 0.80;  // stop-loss sell when bid drops to this
const CEILING_PRICE   = 0.99;  // aggressive slippage ceiling for buy & sell
const BASE_PCT        = 0.067; // 6.7% of capital per trade
const MART_MULT       = 2.5;   // martingale multiplier after loss
const START_CAPITAL   = 150;

function round2(v) { return Math.round(v * 100) / 100; }
function round5(v) { return Math.round(v * 100000) / 100000; }

class SniperEngine {
  constructor(opts = {}) {
    // Shared market data (read from main engine's CLOB polling)
    this.markets = opts.markets;
    this.tokens  = opts.tokens;

    this.capital      = START_CAPITAL;
    this.startCapital = START_CAPITAL;

    this.trades     = [];
    this.wins       = 0;
    this.losses      = 0;
    this.realizedPnl = 0;
    this.peakEquity  = START_CAPITAL;
    this.maxDrawdown = 0;
    this.logs        = [];
    this.equityCurve = [{ t: Date.now(), equity: START_CAPITAL }];
    this.nextOrderId = 1;

    // Martingale state
    this.currentBet       = round2(BASE_PCT * START_CAPITAL);
    this.consecutiveLosses = 0;

    // Per-window state
    this.windowPosition = null;   // { side, shares, fillPrice, cost, windowStart }
    this.windowTraded   = new Set();
    this.prevAsks       = new Map();  // previous ask per side for cross detection
    this.lastWindow     = null;

    // Connected flag
    this.connected = false;
  }

  log(msg) {
    const line = `[${new Date().toISOString().slice(11, 23)}] 🎯SNIPER ${msg}`;
    this.logs.push(line);
    if (this.logs.length > 500) this.logs.shift();
    try { console.log(line); } catch (_) {}
  }

  // ── Main Loop (called every ~100ms) ────────────────────────
  evaluate() {
    const now  = Date.now();
    const nowS = now / 1000;
    const cs   = Math.floor(nowS / WINDOW_SECONDS) * WINDOW_SECONDS;
    const elapsed = nowS - cs;

    // Mark connected on first tick with market data
    if (!this.connected && this.markets.size > 0) this.connected = true;

    // ── Window transition ──────────────────────────────────────
    if (cs !== this.lastWindow) {
      // Return capital for any unresolved position from previous window
      if (this.windowPosition) {
        this.log(`⚠️ UNRESOLVED pos from window ${this.windowPosition.windowStart} — returning cost $${this.windowPosition.cost.toFixed(2)}`);
        this.capital = round2(this.capital + this.windowPosition.cost);
        this.windowPosition = null;
      }
      this.lastWindow   = cs;
      this.prevAsks.clear();
      // Don't clear windowTraded — it's per-window and won't collide
    }

    const slug    = `btc-updown-5m-${cs}`;
    const market  = this.markets.get(slug);
    if (!market || market.resolved) return;

    // ── Resolution at window end ───────────────────────────────
    if (nowS >= market.windowEnd && this.windowPosition && this.windowPosition.windowStart === cs) {
      this.resolveWindow(market);
      return;
    }

    // ── Wait period ────────────────────────────────────────────
    if (elapsed < SNIPER_WAIT) return;

    // ── Already traded this window → check stop-loss only ──────
    if (this.windowTraded.has(cs)) {
      if (this.windowPosition && this.windowPosition.windowStart === cs) {
        this.checkStopLoss(market);
      }
      return;
    }

    // ── Check entry trigger ────────────────────────────────────
    this.checkEntry(market, cs);

    // ── Check stop-loss right after entry ──────────────────────
    if (this.windowPosition && this.windowPosition.windowStart === cs) {
      this.checkStopLoss(market);
    }
  }

  // ── Entry Detection ─────────────────────────────────────────
  // Fires when ask crosses from below ENTRY_PRICE to ≥ ENTRY_PRICE.
  // If no previous ask recorded yet (first tick after 150s), treat as cross.
  checkEntry(market, cs) {
    const upAsk   = market.up.ask   ?? market.up.mid;
    const downAsk = market.down.ask ?? market.down.mid;

    const prevUp   = this.prevAsks.get('UP');
    const prevDown = this.prevAsks.get('DOWN');

    // Store for next tick
    if (upAsk   != null) this.prevAsks.set('UP', upAsk);
    if (downAsk != null) this.prevAsks.set('DOWN', downAsk);

    let triggerSide  = null;
    let triggerPrice = null;

    // Cross detection: previous < ENTRY_PRICE and current ≥ ENTRY_PRICE
    // Also fires on first tick (prev is undefined) if current ≥ ENTRY_PRICE
    if (upAsk != null && upAsk >= ENTRY_PRICE && (prevUp == null || prevUp < ENTRY_PRICE)) {
      triggerSide  = 'UP';
      triggerPrice = upAsk;
    } else if (downAsk != null && downAsk >= ENTRY_PRICE && (prevDown == null || prevDown < ENTRY_PRICE)) {
      triggerSide  = 'DOWN';
      triggerPrice = downAsk;
    }

    if (!triggerSide) return;

    // Calculate bet size
    const betAmount = Math.min(this.currentBet, this.capital);
    if (betAmount <= 0) return;

    // Shares at trigger price (ceiling 0.99 for slippage — actual fill could be higher)
    const shares = Math.floor(betAmount / ENTRY_PRICE);  // base shares on ideal price
    if (shares <= 0) return;

    // Simulate fill: max(triggerPrice, ENTRY_PRICE) — worst-case is ceiling
    const fillPrice = Math.min(Math.max(triggerPrice, ENTRY_PRICE), CEILING_PRICE);
    const cost = round2(shares * fillPrice);
    if (cost > this.capital) return;

    this.capital = round2(this.capital - cost);

    this.windowPosition = {
      side: triggerSide, shares, fillPrice, cost, windowStart: cs,
    };
    this.windowTraded.add(cs);

    this.log(`ENTRY ${triggerSide} ${shares}sh @ $${fillPrice.toFixed(2)} (trigger $${triggerPrice.toFixed(2)}) · cost $${cost.toFixed(2)} · bet $${betAmount.toFixed(2)}`);

    this.trades.push({
      timestamp: Date.now(), type: 'BUY', bot: 'sniper',
      outcome: triggerSide, shares, price: fillPrice, cost, orderId: this.nextOrderId++,
    });
    this.recordEquity();
  }

  // ── Stop-Loss Check ─────────────────────────────────────────
  // Sells when bid ≤ STOP_LOSS_PRICE with ceiling slippage.
  checkStopLoss(market) {
    if (!this.windowPosition) return;

    const token = this.windowPosition.side === 'UP' ? market.up : market.down;
    const bid   = token.bid ?? token.mid;

    if (bid == null || bid > STOP_LOSS_PRICE) return;

    // Simulate sell fill: min(bid, STOP_LOSS_PRICE) — worst case with slippage
    const sellPrice = Math.max(Math.min(bid, STOP_LOSS_PRICE), 0);
    const payout    = round2(this.windowPosition.shares * sellPrice);
    const pnl       = round2(payout - this.windowPosition.cost);

    this.capital      = round2(this.capital + payout);
    this.realizedPnl  = round2(this.realizedPnl + pnl);

    const isProfit = pnl >= 0;
    if (isProfit) {
      this.wins++;
      this.consecutiveLosses = 0;
      this.currentBet = round2(BASE_PCT * this.startCapital);
    } else {
      this.losses++;
      this.consecutiveLosses++;
      this.currentBet = round2(this.currentBet * MART_MULT);
    }

    this.log(`SL ${this.windowPosition.side} @ $${sellPrice.toFixed(2)} · ${this.windowPosition.shares}sh · P&L ${isProfit ? '+' : '-'}$${Math.abs(pnl).toFixed(2)} · next bet $${this.currentBet.toFixed(2)}`);

    this.trades.push({
      timestamp: Date.now(), type: 'STOP_LOSS', bot: 'sniper',
      outcome: this.windowPosition.side, shares: this.windowPosition.shares,
      price: sellPrice, cost: this.windowPosition.cost, pnl, orderId: this.nextOrderId++,
    });

    this.windowPosition = null;
    this.recordEquity();
  }

  // ── Resolution (same method as LimitBot) ────────────────────
  resolveWindow(market) {
    const fUp   = market.finalUpMax   ?? 0;
    const fDown = market.finalDownMax ?? 0;

    let winner = null;
    if (fUp >= 0.95)      winner = 'UP';
    else if (fDown >= 0.95) winner = 'DOWN';
    if (!winner) return false;

    const pos = this.windowPosition;
    if (!pos || pos.windowStart !== market.windowStart) return false;

    const won   = pos.side === winner;
    const payout = won ? pos.shares : 0;
    const pnl    = round2(payout - pos.cost);

    this.capital     = round2(this.capital + payout);
    this.realizedPnl = round2(this.realizedPnl + pnl);

    if (pnl >= 0) {
      this.wins++;
      this.consecutiveLosses = 0;
      this.currentBet = round2(BASE_PCT * this.startCapital);
    } else {
      this.losses++;
      this.consecutiveLosses++;
      this.currentBet = round2(this.currentBet * MART_MULT);
    }

    this.log(`RES ${pos.side} ${won ? 'WIN' : 'LOSS'} · ${pos.shares}sh @ $${pos.fillPrice.toFixed(2)} · P&L ${pnl >= 0 ? '+' : '-'}$${Math.abs(pnl).toFixed(2)} · next bet $${this.currentBet.toFixed(2)}`);

    this.trades.push({
      timestamp: Date.now(), type: 'RESOLVED', bot: 'sniper',
      outcome: pos.side, shares: pos.shares, price: won ? 1 : 0,
      cost: pos.cost, pnl, orderId: this.nextOrderId++, winner,
    });

    this.windowPosition = null;
    this.recordEquity();
    return true;
  }

  // ── Equity Tracking ─────────────────────────────────────────
  recordEquity() {
    const equity = round2(this.capital);
    const now = Date.now();
    if (equity > this.peakEquity) this.peakEquity = equity;
    const dd = round2(this.peakEquity - equity);
    if (dd > this.maxDrawdown) this.maxDrawdown = dd;
    const last = this.equityCurve[this.equityCurve.length - 1];
    if (!last || now - last.t > 2000) this.equityCurve.push({ t: now, equity });
  }

  // ── Dashboard State ─────────────────────────────────────────
  buildState() {
    return {
      name: 'SniperBot',
      capital: this.capital,
      startCapital: this.startCapital,
      realizedPnl: this.realizedPnl,
      totalPnl: round2(this.capital - this.startCapital),
      wins: this.wins, losses: this.losses,
      winRate: this.wins + this.losses ? round2(this.wins / (this.wins + this.losses) * 100) : null,
      maxDrawdown: this.maxDrawdown,
      currentBet: this.currentBet,
      consecutiveLosses: this.consecutiveLosses,
      position: this.windowPosition,
      trades: this.trades.slice(-50).reverse(),
      equityCurve: this.equityCurve,
      logs: this.logs.slice(-200),
      connected: this.connected,
      config: { entryPrice: ENTRY_PRICE, stopLoss: STOP_LOSS_PRICE, ceiling: CEILING_PRICE, basePct: BASE_PCT, martMult: MART_MULT, startCapital: START_CAPITAL },
    };
  }
}

module.exports = { SniperEngine };
