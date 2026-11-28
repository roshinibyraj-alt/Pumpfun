'use strict';

const STRATEGY = Object.freeze({
  id: 'independent-shadow-33-profit-add70-v1',
  name: 'BTC 33¢ resting buys · profit-funded add-on',
  initialCapital: 3000, baseShares: 200, entryPrice: .33,
  addOnTrigger: .70, takeProfitBid: .99, takeProfitPayout: 1,
  description: 'Paper only. Rest 200 shares on both sides at $0.33. First partial fill cancels the other side. At held-side bid $0.70, spend the base position’s (.70−.33) profit budget once on a market buy, including fees. $0.99 bid credits modeled $1/share TP; otherwise official resolution. No model, recovery, stop-loss, flip or rearm.',
  fillAssumption: 'Simulated maker fill exactly $0.33 against subsequent fresh asks at or below $0.33; displayed depth limits quantity, but queue execution is unverified.',
  executionDelayMs: 300,
});
const SIDES = ['UP', 'DOWN'];
const isOpen = p => ['OPEN', 'PENDING_RESOLUTION'].includes(p.status);
const liveOrder = o => ['RESTING', 'PARTIALLY_FILLED'].includes(o.status);
const finite = n => typeof n === 'number' && Number.isFinite(n);
const EPS = 1e-7;
const fee = (n, p, rate, exponent) => Number((n * rate * (p * (1 - p)) ** exponent).toFixed(5));
const levels = rows => (rows || []).map(l => ({ price: Number(l.price), size: Number(l.size) }))
  .filter(l => finite(l.price) && l.price > 0 && l.price < 1 && finite(l.size) && l.size > 0)
  .sort((a, b) => a.price - b.price);

class ShadowLadderEngine {
  constructor({ now = Date.now, changed = () => {} } = {}) {
    this.now = now; this.changed = changed; this.cash = STRATEGY.initialCapital;
    this.positions = []; this.orders = []; this.windows = {}; this.events = [];
    this.current = null; this.equityCurve = []; this.lastEquityAt = 0; this.lastError = null;
  }
  log(type, message) {
    this.events.unshift({ at: this.now(), type, message });
    this.events = this.events.slice(0, 100); this.changed();
  }
  reservedCash() {
    return this.orders.filter(liveOrder).reduce((n, o) => n + o.remainingShares * .33, 0)
      + this.positions.filter(p => p.addOn.state === 'PENDING').reduce((n, p) => n + p.addOn.budget, 0);
  }
  fresh(q, now = this.now()) {
    return q && finite(q.updatedAt) && q.updatedAt <= now && now - q.updatedAt <= 2000;
  }
  observe(record, side) {
    const m = record?.market, q = record?.quotes?.[side], now = this.now();
    if (!SIDES.includes(side) || !m || !m.tokens?.UP || !m.tokens?.DOWN
      || m.end - m.start !== 300000 || record.marketStatus !== 'OPEN'
      || now < m.start || now >= m.end || !q || q.tokenId !== String(m.tokens?.[side])
      || q.marketId !== String(m.id || m.slug) || q.windowStart !== m.start
      || !this.fresh(q, now) || q.updatedAt < m.start || !finite(q.bestBid) || !finite(q.bestAsk)
      || q.bestBid < 0 || q.bestAsk > 1 || q.bestBid > q.bestAsk) return;
    const id = String(m.start);
    let w = this.windows[id];
    if (!w) {
      this.expire(now);
      w = this.windows[id] = { id, marketId: String(m.id || m.slug), title: m.title || m.slug,
        start: m.start, end: m.end, tokens: { UP: String(m.tokens.UP), DOWN: String(m.tokens.DOWN) },
        selectedSide: null, quotes: {}, depths: {}, createdAt: now };
      this.place(w);
    }
    if (w.marketId !== String(m.id || m.slug) || w.tokens[side] !== String(q.tokenId)) return;
    const previous = w.quotes[side];
    if (previous && q.updatedAt <= previous.updatedAt) return;
    const asks = levels(q.asks), depth = {}, old = w.depths[side] || {};
    for (const l of asks) {
      const p = old[l.price];
      depth[l.price] = { observed: l.size,
        remaining: p ? Math.min(l.size, p.remaining + Math.max(0, l.size - p.observed)) : l.size };
    }
    w.depths[side] = depth;
    w.quotes[side] = { bestBid: q.bestBid, bestAsk: q.bestAsk, updatedAt: q.updatedAt, asks };
    const rate = m.feesEnabled === false ? 0 : Number(m.feeSchedule?.rate);
    const exponent = Number(m.feeSchedule?.exponent ?? 1);
    w.feeRate = finite(rate) && rate >= 0 && rate < 1 ? rate : null;
    w.feeExponent = finite(exponent) && exponent >= 0 ? exponent : null;
    if (!this.current || w.start >= this.current.windowStart)
      this.current = { id: w.marketId, title: w.title, windowStart: w.start, windowEnd: w.end };
    this.executeBase(w, side);
    this.processPosition(w, side);
    this.changed();
  }
  place(w) {
    const funded = this.cash - this.reservedCash() >= 2 * 200 * .33 - EPS;
    for (const side of SIDES) this.orders.unshift({
      id: `shadow33-${w.id}-${side}`, marketId: w.marketId, tokenId: w.tokens[side],
      side, windowStart: w.start, windowEnd: w.end, limitPrice: .33,
      requestedShares: 200, filledShares: 0, remainingShares: funded ? 200 : 0,
      canceledShares: funded ? 0 : 200, status: funded ? 'RESTING' : 'SKIPPED',
      placedAt: this.now(), eligibleAt: this.now() + 300, lastFillAt: null,
      cancelReason: funded ? null : 'Insufficient unreserved shadow cash for both orders.',
    });
    this.log(funded ? 'ORDERS_PLACED' : 'ORDERS_SKIPPED',
      funded ? 'UP and DOWN: 200-share simulated resting buys at $0.33; $132 reserved.'
        : 'Skipped both resting orders: insufficient unreserved cash.');
  }
  cancel(o, status, reason) {
    if (!liveOrder(o)) return;
    o.canceledShares += o.remainingShares; o.remainingShares = 0;
    o.status = status; o.cancelReason = reason; o.canceledAt = this.now();
    this.log(status, `${o.side}: ${reason}`);
  }
  executeBase(w, side) {
    const now = this.now(), q = w.quotes[side];
    const o = this.orders.find(o => o.id === `shadow33-${w.id}-${side}`);
    if (!o || !liveOrder(o) || now < o.eligibleAt || q.updatedAt <= o.placedAt
      || now >= w.end || (w.selectedSide && w.selectedSide !== side)) return;
    for (const l of q.asks) {
      if (l.price > .33 || o.remainingShares < EPS) break;
      const n = Math.min(o.remainingShares, w.depths[side][l.price]?.remaining || 0);
      if (n < EPS) continue;
      if (!w.selectedSide) {
        w.selectedSide = side;
        const other = this.orders.find(x => x.id === `shadow33-${w.id}-${side === 'UP' ? 'DOWN' : 'UP'}`);
        this.cancel(other, 'CANCELLED', 'Opposite side received its first partial fill.');
      }
      let p = this.positions.find(p => p.id === `shadow33-${w.id}`);
      if (!p) {
        p = { id: `shadow33-${w.id}`, contextId: w.id, marketId: w.marketId,
          tokenId: w.tokens[side], side, windowStart: w.start, windowEnd: w.end,
          shares: 0, remainingShares: 0, baseShares: 0, baseCost: 0,
          totalCost: 0, entryFees: 0, exitFees: 0, exitProceeds: 0,
          entryPrice: .33, entryAt: now, status: 'OPEN', exitPrice: null,
          exitAt: null, realizedPnl: null, markBid: null, unrealizedPnl: null,
          fills: [], sales: [], addOn: { state: 'WAITING', budget: 0, spent: 0,
            fees: 0, filledShares: 0, triggerAt: null, reason: 'Waiting for held-side best bid >= $0.70.' } };
        this.positions.unshift(p);
      }
      const cost = n * .33;
      this.cash -= cost; p.baseShares += n; p.baseCost += cost;
      p.shares += n; p.remainingShares += n; p.totalCost += cost;
      p.entryPrice = p.totalCost / p.shares;
      p.fills.push({ kind: 'MAKER_BASE', at: now, price: .33, shares: n, fee: 0 });
      o.filledShares += n; o.remainingShares = Math.max(0, 200 - o.filledShares);
      o.status = o.remainingShares < EPS ? 'FILLED' : 'PARTIALLY_FILLED'; o.lastFillAt = now;
      w.depths[side][l.price].remaining -= n;
      this.log('BASE_FILL', `${side}: ${n.toFixed(4)} shares at exactly $0.33; maker fee $0. Queue fill is simulated.`);
    }
  }
  processPosition(w, side) {
    const now = this.now(), q = w.quotes[side];
    const p = this.positions.find(p => p.contextId === w.id && p.side === side && p.status === 'OPEN');
    if (!p || !this.fresh(q, now) || now >= w.end) return;
    if (q.bestBid >= .99) {
      const payout = p.remainingShares;
      this.cash += payout; p.exitProceeds += payout;
      p.sales.push({ at: now, kind: 'MODELED_ONE_DOLLAR_TP', price: 1, shares: p.remainingShares, fee: 0 });
      p.remainingShares = 0;
      this.close(p, 'CLOSED_TP', 'MODELED_ONE_DOLLAR_TP');
      return;
    }
    if (p.addOn.state === 'WAITING' && q.bestBid >= .70) {
      const available = Math.max(0, this.cash - this.reservedCash());
      const targetBudget = Number((p.baseShares * (.70 - .33)).toFixed(8));
      const budget = Math.min(targetBudget, available);
      p.addOn = { ...p.addOn, state: budget > .00001 ? 'PENDING' : 'SKIPPED',
        budget, targetBudget, baseSharesAtTrigger: p.baseShares, triggerAt: now,
        eligibleAt: now + 300, reason: budget < targetBudget
          ? 'Add-on limited to actual unreserved cash; unrealized profit is not cash.'
          : 'Profit budget frozen; awaiting market execution after >=300ms.' };
      this.log('ADD_ON_TRIGGER', `${side}: ${p.baseShares.toFixed(4)} base shares; $${targetBudget.toFixed(4)} profit budget ($${budget.toFixed(4)} funded).`);
    }
    const a = p.addOn;
    if (a.state !== 'PENDING' || now < a.eligibleAt || q.updatedAt <= a.triggerAt) return;
    if (!finite(w.feeRate) || !finite(w.feeExponent)) {
      a.state = 'SKIPPED'; a.reason = 'No valid taker fee schedule; market buy not invented.';
      this.log('ADD_ON_SKIPPED', a.reason); return;
    }
    let depthLimited = true;
    for (const l of q.asks) {
      const room = Math.max(0, a.budget - a.spent - a.fees);
      if (room <= .00002) { depthLimited = false; break; }
      const unitFee = w.feeRate * (l.price * (1 - l.price)) ** w.feeExponent;
      const available = w.depths[side][l.price]?.remaining || 0;
      const n = Math.min(available, Math.max(0, (room - .00001) / (l.price + unitFee)));
      if (n <= EPS) continue;
      const cost = n * l.price, f = fee(n, l.price, w.feeRate, w.feeExponent);
      if (cost + f > room + EPS) throw new Error('Add-on exceeded its all-in budget');
      a.spent += cost; a.fees += f; a.filledShares += n;
      this.cash -= cost + f; p.totalCost += cost; p.entryFees += f;
      p.shares += n; p.remainingShares += n;
      p.fills.push({ kind: 'TAKER_ADD_ON', at: now, price: l.price, shares: n, fee: f });
      w.depths[side][l.price].remaining -= n;
    }
    p.entryPrice = p.totalCost / p.shares;
    const spent = a.spent + a.fees;
    a.state = !a.filledShares ? 'SKIPPED' : a.budget - spent < .001 ? 'FILLED' : 'PARTIAL';
    a.reason = !a.filledShares ? 'No executable asks; add-on canceled without a fill.'
      : depthLimited && a.budget - spent >= .001
        ? 'Available ask depth used; unspent remainder canceled. No second add-on.'
        : 'All-in market-buy budget used, including taker fees. No second add-on.';
    this.log('ADD_ON_RESULT', `${side}: ${a.filledShares.toFixed(4)} added; spent $${spent.toFixed(4)} including $${a.fees.toFixed(5)} fees. ${a.reason}`);
  }
  close(p, status, reason) {
    p.status = status; p.exitReason = reason; p.exitAt = this.now();
    p.exitPrice = p.exitProceeds / p.shares;
    p.realizedPnl = p.exitProceeds - p.totalCost - p.entryFees - p.exitFees;
    p.unrealizedPnl = null;
    if (['WAITING', 'PENDING'].includes(p.addOn.state)) {
      p.addOn.state = 'EXPIRED'; p.addOn.reason = 'Position closed before add-on execution.';
    }
    for (const o of this.orders.filter(o => o.windowStart === p.windowStart))
      this.cancel(o, 'CANCELLED', 'Position closed; unfilled base quantity canceled.');
    this.log(status, `${p.side}: net ${p.realizedPnl >= 0 ? '+' : ''}$${p.realizedPnl.toFixed(4)}; ${reason}.`);
  }
  settle(marketId, winner) {
    if (!SIDES.includes(winner)) return;
    for (const p of this.positions.filter(p => p.marketId === String(marketId) && isOpen(p) && this.now() >= p.windowEnd)) {
      const payout = p.side === winner ? p.remainingShares : 0;
      this.cash += payout; p.exitProceeds += payout; p.resolutionWinner = winner;
      p.sales.push({ at: this.now(), kind: 'OFFICIAL_RESOLUTION', price: p.side === winner ? 1 : 0, shares: p.remainingShares, fee: 0 });
      p.remainingShares = 0;
      this.close(p, p.side === winner ? 'RESOLVED_WIN' : 'RESOLVED_LOSS', 'OFFICIAL_RESOLUTION');
    }
  }
  expire(now = this.now()) {
    for (const o of this.orders.filter(o => liveOrder(o) && now >= o.windowEnd))
      this.cancel(o, 'EXPIRED', 'Window ended; no rollover of resting orders.');
    for (const p of this.positions.filter(isOpen)) {
      if (now >= p.windowEnd) {
        p.status = 'PENDING_RESOLUTION';
        if (['WAITING', 'PENDING'].includes(p.addOn.state)) {
          p.addOn.state = 'EXPIRED'; p.addOn.reason = 'Window ended before add-on execution.';
        }
      }
    }
  }
  tick() {
    const now = this.now();
    this.expire(now);
    for (const [id, w] of Object.entries(this.windows))
      if (now - w.end > 600000 && !this.positions.some(p => p.contextId === id && p.status === 'OPEN'))
        delete this.windows[id];
    if (now - this.lastEquityAt >= 10000) {
      const a = this.account();
      this.equityCurve.push({ at: now, equity: a.equity, balance: 3000 + a.realizedPnl });
      this.equityCurve = this.equityCurve.slice(-3000); this.lastEquityAt = now;
    }
    this.changed();
  }
  account() {
    const pending = this.positions.filter(isOpen), closed = this.positions.filter(p => !isOpen(p));
    let marked = 0, unknown = false, unrealized = 0;
    for (const p of pending) {
      const q = this.windows[p.contextId]?.quotes[p.side];
      const known = p.status === 'OPEN' && this.now() < p.windowEnd && this.fresh(q);
      p.markBid = known ? q.bestBid : null;
      p.unrealizedPnl = known ? p.remainingShares * q.bestBid - p.totalCost - p.entryFees : null;
      if (known) { marked += p.remainingShares * q.bestBid; unrealized += p.unrealizedPnl; }
      else unknown = true;
    }
    const reservedCash = this.reservedCash();
    return { initialCapital: 3000, cash: this.cash, equity: unknown ? null : this.cash + marked,
      reservedCash, availableCash: Math.max(0, this.cash - reservedCash),
      realizedPnl: closed.reduce((s, p) => s + p.realizedPnl, 0),
      unrealizedPnl: unknown ? null : unrealized,
      totalFees: this.positions.reduce((s, p) => s + p.entryFees + p.exitFees, 0),
      wins: closed.filter(p => p.realizedPnl > 0).length, losses: closed.filter(p => p.realizedPnl < 0).length,
      closedTrades: closed.length, openPositions: pending.filter(p => p.status === 'OPEN').length,
      pendingResolution: pending.filter(p => p.status === 'PENDING_RESOLUTION').length };
  }
  snapshot() {
    const account = this.account(), w = this.current && this.windows[String(this.current.windowStart)];
    const quotes = Object.fromEntries(SIDES.map(side => {
      const q = w?.quotes[side];
      return [side, this.fresh(q) ? { bestBid: q.bestBid, bestAsk: q.bestAsk, updatedAt: q.updatedAt } : null];
    }));
    return { now: this.now(), status: this.lastError ? 'ERROR' : 'RUNNING', lastError: this.lastError,
      strategy: STRATEGY, account,
      market: this.current ? { ...this.current, quotes, secondsRemaining: Math.max(0, (this.current.windowEnd - this.now()) / 1000) } : null,
      orders: this.orders.slice(0, 200), positions: this.positions.slice(0, 500),
      events: this.events, equityCurve: this.equityCurve };
  }
  export() {
    return structuredClone({ version: 1, strategyId: STRATEGY.id, cash: this.cash,
      positions: this.positions, orders: this.orders, windows: this.windows, events: this.events,
      current: this.current, equityCurve: this.equityCurve, lastEquityAt: this.lastEquityAt });
  }
  restore(saved) {
    if (saved?.version !== 1 || saved.strategyId !== STRATEGY.id || !finite(saved.cash) || saved.cash < -EPS
      || !Array.isArray(saved.positions) || !Array.isArray(saved.orders) || !saved.windows)
      throw new Error('Invalid shadow ladder ledger; refusing a silent reset.');
    const cash = saved.positions.reduce((n, p) => n - p.totalCost - p.entryFees + p.exitProceeds - p.exitFees, 3000);
    if (!finite(cash) || Math.abs(cash - saved.cash) > .00001)
      throw new Error('Shadow cash failed full-ledger reconciliation.');
    const selected = new Map();
    for (const p of saved.positions) {
      if (!SIDES.includes(p.side) || !(p.shares > 0) || p.baseShares > 200 + EPS
        || !finite(p.totalCost) || !p.addOn || !Array.isArray(p.fills)
        || selected.has(p.windowStart)) throw new Error('Invalid or duplicate shadow window position.');
      selected.set(p.windowStart, p.side);
    }
    for (const o of saved.orders) {
      if (o.limitPrice !== .33 || o.requestedShares !== 200 || !finite(o.filledShares)
        || o.filledShares < 0 || o.remainingShares < 0 || o.canceledShares < 0
        || Math.abs(o.filledShares + o.remainingShares + o.canceledShares - 200) > .00001)
        throw new Error('Invalid shadow resting-order quantities.');
    }
    for (const key of ['cash', 'positions', 'orders', 'windows', 'events', 'current', 'equityCurve', 'lastEquityAt'])
      this[key] = structuredClone(saved[key]);
    if (this.reservedCash() > this.cash + .00001) throw new Error('Shadow reservations exceed cash.');
    this.tick();
  }
}
ShadowLadderEngine.STRATEGY = STRATEGY;
module.exports = ShadowLadderEngine;
