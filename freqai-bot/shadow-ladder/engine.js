'use strict';

const STRATEGY = Object.freeze({
  id: 'independent-shadow-virtual33-entry70-stop40-cutoff120-v1',
  name: 'BTC virtual 33¢ → 300-share entry at 70¢',
  initialCapital: 3000, baseShares: 0, entryPrice: .33,
  addOnTrigger: .70, addOnShares: 300, stopLossBid: .40,
  entryCutoffSeconds: 120, lateExitSeconds: 30, lateExitBid: .90,
  takeProfitBid: .99, takeProfitPayout: 1,
  description: 'Paper only. Track both sides virtually at $0.33 without buying or spending cash. First ask touch selects the side. At its best bid >= $0.70, request one 300-share market entry before the final two minutes. SL bid <= $0.40; in the final 30 seconds also sell when current bid <= $0.90, regardless of earlier highs. Sales use actual bid depth and fees. $0.99 bid credits modeled $1/share TP; otherwise official resolution.',
  fillAssumption: 'The $0.33 observation creates no order, shares or P&L. The only entry sweeps subsequent fresh asks after latency, limited by actual depth and cash including taker fees.',
  executionDelayMs: 300,
});
const SIDES = ['UP', 'DOWN'];
const isOpen = p => ['OPEN', 'PENDING_RESOLUTION'].includes(p.status);
const liveOrder = o => o.status === 'PENDING';
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
    return Object.values(this.windows).filter(w => w.entry?.state === 'PENDING')
      .reduce((n, w) => n + w.entry.budget, 0);
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
        selectedSide: null, quotes: {}, depths: {}, bidDepths: {}, createdAt: now };
      this.place(w);
    }
    if (w.marketId !== String(m.id || m.slug) || w.tokens[side] !== String(q.tokenId)) return;
    const previous = w.quotes[side];
    if (previous && q.updatedAt <= previous.updatedAt) return;
    const asks = levels(q.asks).filter(l => l.price >= q.bestAsk), depth = {}, old = w.depths[side] || {};
    for (const l of asks) {
      const p = old[l.price];
      depth[l.price] = { observed: l.size,
        remaining: p ? Math.min(l.size, p.remaining + Math.max(0, l.size - p.observed)) : l.size };
    }
    w.depths[side] = depth;
    const bids = levels(q.bids).filter(l => l.price <= q.bestBid).sort((a, b) => b.price - a.price), bidDepth = {}, oldBid = w.bidDepths[side] || {};
    for (const l of bids) {
      const p = oldBid[l.price];
      bidDepth[l.price] = { observed: l.size,
        remaining: p ? Math.min(l.size, p.remaining + Math.max(0, l.size - p.observed)) : l.size };
    }
    w.bidDepths[side] = bidDepth;
    w.quotes[side] = { bestBid: q.bestBid, bestAsk: q.bestAsk, updatedAt: q.updatedAt, asks, bids };
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
    w.entry = { state: 'WAITING', budget: 0, spent: 0, fees: 0, filledShares: 0,
      requestedShares: 300, reason: 'Watching for the first virtual $0.33 ask touch.' };
    w.trackingEligibleAt = this.now() + STRATEGY.executionDelayMs;
    w.cutoffAt = w.end - STRATEGY.entryCutoffSeconds * 1000;
    this.log('VIRTUAL_TRACKING', 'Watching UP and DOWN at $0.33 only: no orders, no shares and no cash reserved.');
  }
  cancel(o, status, reason) {
    if (!liveOrder(o)) return;
    o.canceledShares += o.remainingShares; o.remainingShares = 0;
    o.status = status; o.cancelReason = reason; o.canceledAt = this.now();
    this.log(status, `${o.side}: ${reason}`);
  }
  executeBase(w, side) {
    const now = this.now(), q = w.quotes[side];
    if (now >= w.cutoffAt || w.selectedSide || now < w.trackingEligibleAt
      || q.updatedAt <= w.createdAt || q.bestAsk > STRATEGY.entryPrice) return;
    w.selectedSide = side; w.virtualTouchAt = now;
    w.entry.reason = `${side} selected virtually at $0.33; waiting for its bid >= $0.70.`;
    this.log('VIRTUAL_TOUCH', `${side} selected by a virtual $0.33 ask touch. No purchase or P&L.`);
  }
  processPosition(w, side) {
    const now = this.now(), q = w.quotes[side];
    if (!this.fresh(q, now) || now >= w.end) return;
    let p = this.positions.find(p => p.contextId === w.id && p.side === side && p.status === 'OPEN');
    if (p) {
      if (p.exitPending) { this.executeExit(w, p, q); return; }
      if (q.bestBid >= STRATEGY.takeProfitBid) {
        const payout = p.remainingShares;
        this.cash += payout; p.exitProceeds += payout;
        p.sales.push({ at: now, kind: 'MODELED_ONE_DOLLAR_TP', price: 1, shares: p.remainingShares, fee: 0 });
        p.remainingShares = 0;
        this.close(p, 'CLOSED_TP', 'MODELED_ONE_DOLLAR_TP'); return;
      }
      const reason = q.bestBid <= STRATEGY.stopLossBid ? 'STOP_LOSS'
        : now >= w.end - STRATEGY.lateExitSeconds * 1000 && q.bestBid <= STRATEGY.lateExitBid ? 'LATE_EXIT' : null;
      if (reason) {
        p.exitPending = { reason, at: now, bookAt: q.updatedAt,
          eligibleAt: now + STRATEGY.executionDelayMs };
        this.log(reason + '_TRIGGER', `${side}: bid $${q.bestBid.toFixed(3)}; market sale pending after latency.`);
      }
      return;
    }
    if (w.selectedSide !== side) return;
    const a = w.entry;
    if (now >= w.cutoffAt) { this.cutoff(w); return; }
    if (a.state === 'WAITING' && q.bestBid >= STRATEGY.addOnTrigger) {
      if (!finite(w.feeRate) || !finite(w.feeExponent)) {
        a.reason = 'Waiting for a valid taker fee schedule before placing an entry.'; return;
      }
      const available = Math.max(0, this.cash - this.reservedCash());
      a.budget = Math.min(STRATEGY.addOnShares * (1 + w.feeRate), available);
      a.state = 'PENDING'; a.triggerAt = now; a.eligibleAt = now + STRATEGY.executionDelayMs;
      a.reason = '300-share market entry requested; waiting for a later book after latency.';
      this.orders.unshift({ id: `entry70-${w.id}`, marketId: w.marketId, tokenId: w.tokens[side],
        side, type: 'TAKER_ENTRY', windowStart: w.start, windowEnd: w.end,
        limitPrice: null, requestedShares: 300, filledShares: 0, remainingShares: 300,
        canceledShares: 0, status: 'PENDING', placedAt: now, lastFillAt: null });
      this.log('ENTRY_TRIGGER', `${side}: 300-share market entry requested at bid >= $0.70; no $0.33 shares held.`);
    }
    if (a.state !== 'PENDING' || now < a.eligibleAt || q.updatedAt <= a.triggerAt) return;
    if (!finite(w.feeRate) || !finite(w.feeExponent)) {
      a.state = 'SKIPPED'; a.reason = 'No valid taker fee schedule; no fill invented.';
      this.cancel(this.orders.find(o => o.id === `entry70-${w.id}`), 'SKIPPED', a.reason); return;
    }
    const fills = [];
    for (const l of q.asks) {
      const room = Math.max(0, a.budget - a.spent - a.fees);
      const remaining = Math.max(0, a.requestedShares - a.filledShares);
      if (room <= .00002 || remaining <= EPS) break;
      const unitFee = w.feeRate * (l.price * (1 - l.price)) ** w.feeExponent;
      const available = w.depths[side][l.price]?.remaining || 0;
      const n = Math.min(remaining, available, Math.max(0, (room - .00001) / (l.price + unitFee)));
      if (n <= EPS) continue;
      const cost = n * l.price, f = fee(n, l.price, w.feeRate, w.feeExponent);
      if (cost + f > room + EPS) throw new Error('Entry exceeded its all-in budget');
      a.spent += cost; a.fees += f; a.filledShares += n;
      this.cash -= cost + f;
      fills.push({ kind: 'TAKER_ENTRY', at: now, price: l.price, shares: n, fee: f });
      w.depths[side][l.price].remaining -= n;
    }
    a.state = !a.filledShares ? 'SKIPPED' : a.requestedShares - a.filledShares < EPS ? 'FILLED' : 'PARTIAL';
    a.reason = 'Actual ask depth and taker fees used; unfilled remainder canceled. No re-entry.';
    const o = this.orders.find(o => o.id === `entry70-${w.id}`);
    Object.assign(o, { status: a.state, filledShares: a.filledShares, remainingShares: 0,
      canceledShares: 300 - a.filledShares, lastFillAt: fills.length ? now : null,
      averagePrice: a.filledShares ? a.spent / a.filledShares : null, fees: a.fees, cancelReason: a.reason });
    if (a.filledShares > EPS) this.positions.unshift({
      id: `shadow70-${w.id}`, contextId: w.id, marketId: w.marketId,
      tokenId: w.tokens[side], side, windowStart: w.start, windowEnd: w.end,
      shares: a.filledShares, remainingShares: a.filledShares, baseShares: 0, baseCost: 0,
      totalCost: a.spent, entryFees: a.fees, exitFees: 0, exitProceeds: 0,
      entryPrice: a.spent / a.filledShares, entryAt: now, status: 'OPEN',
      exitPrice: null, exitAt: null, realizedPnl: null, markBid: null, unrealizedPnl: null,
      feeRate: w.feeRate, feeExponent: w.feeExponent, fills, sales: [],
      virtualTouchAt: w.virtualTouchAt, addOn: { ...a }, exitPending: null,
    });
    this.log('ENTRY_RESULT', `${side}: ${a.filledShares.toFixed(4)}/300 shares bought; cost $${a.spent.toFixed(4)} plus $${a.fees.toFixed(5)} fees.`);
  }
  cutoff(w) {
    if (!['WAITING', 'PENDING'].includes(w.entry.state)) return;
    w.entry.state = 'CUTOFF'; w.entry.reason = 'Final two minutes: no new entry, including delayed requests.';
    const o = this.orders.find(o => o.id === `entry70-${w.id}`);
    if (o) this.cancel(o, 'CANCELLED', w.entry.reason);
    this.log('ENTRY_CUTOFF', w.entry.reason);
  }
  executeExit(w, p, q) {
    const now = this.now(), intent = p.exitPending;
    if (now < intent.eligibleAt || q.updatedAt <= intent.bookAt || now >= p.windowEnd) return;
    if (!finite(p.feeRate) || !finite(p.feeExponent)) return;
    for (const l of q.bids) {
      const n = Math.min(p.remainingShares, w.bidDepths[p.side][l.price]?.remaining || 0);
      if (n <= EPS) continue;
      const gross = n * l.price, f = fee(n, l.price, p.feeRate, p.feeExponent);
      p.remainingShares = Math.max(0, p.remainingShares - n);
      p.exitProceeds += gross; p.exitFees += f; this.cash += gross - f;
      w.bidDepths[p.side][l.price].remaining -= n;
      p.sales.push({ at: now, kind: intent.reason, price: l.price, shares: n, fee: f });
      if (p.remainingShares <= EPS) break;
    }
    if (p.remainingShares <= EPS) this.close(p, intent.reason === 'STOP_LOSS' ? 'CLOSED_SL' : 'CLOSED_LATE', intent.reason);
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
    for (const w of Object.values(this.windows)) if (now >= w.cutoffAt) this.cutoff(w);
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
      p.unrealizedPnl = known ? p.remainingShares * q.bestBid + p.exitProceeds - p.exitFees - p.totalCost - p.entryFees : null;
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
      market: this.current ? { ...this.current, quotes, secondsRemaining: Math.max(0, (this.current.windowEnd - this.now()) / 1000),
        tracking: w ? { selectedSide: w.selectedSide, virtualTouchAt: w.virtualTouchAt || null,
          cutoffAt: w.cutoffAt, entry: { ...w.entry } } : null } : null,
      orders: this.orders.slice(0, 200), positions: this.positions.slice(0, 500),
      events: this.events, equityCurve: this.equityCurve };
  }
  export() {
    return structuredClone({ version: 2, strategyId: STRATEGY.id, cash: this.cash,
      positions: this.positions, orders: this.orders, windows: this.windows, events: this.events,
      current: this.current, equityCurve: this.equityCurve, lastEquityAt: this.lastEquityAt });
  }
  restore(saved) {
    if (saved?.version !== 2 || saved.strategyId !== STRATEGY.id || !finite(saved.cash) || saved.cash < -EPS
      || !Array.isArray(saved.positions) || !Array.isArray(saved.orders) || !saved.windows)
      throw new Error('Invalid shadow ladder ledger; refusing a silent reset.');
    const cash = saved.positions.reduce((n, p) => n - p.totalCost - p.entryFees + p.exitProceeds - p.exitFees, 3000);
    if (!finite(cash) || Math.abs(cash - saved.cash) > .00001)
      throw new Error('Shadow cash failed full-ledger reconciliation.');
    const selected = new Map();
    for (const p of saved.positions) {
      if (!SIDES.includes(p.side) || !(p.shares > 0) || p.shares > 300 + EPS || p.baseShares !== 0
        || !finite(p.totalCost) || !p.addOn || !Array.isArray(p.fills)
        || !finite(p.remainingShares) || p.remainingShares < 0 || p.remainingShares > p.shares + EPS
        || !finite(p.feeRate) || !finite(p.feeExponent)
        || selected.has(p.windowStart)) throw new Error('Invalid or duplicate shadow window position.');
      selected.set(p.windowStart, p.side);
    }
    for (const o of saved.orders) {
      if (o.type !== 'TAKER_ENTRY' || o.limitPrice !== null || o.requestedShares !== 300 || !finite(o.filledShares)
        || o.filledShares < 0 || o.remainingShares < 0 || o.canceledShares < 0
        || Math.abs(o.filledShares + o.remainingShares + o.canceledShares - 300) > .00001)
        throw new Error('Invalid shadow market-order quantities.');
    }
    for (const w of Object.values(saved.windows)) {
      if (!w.entry || !w.bidDepths || !finite(w.cutoffAt) || !finite(w.entry.budget)
        || w.entry.budget < 0 || w.entry.requestedShares !== 300)
        throw new Error('Invalid shadow tracking or entry reservation.');
    }
    for (const key of ['cash', 'positions', 'orders', 'windows', 'events', 'current', 'equityCurve', 'lastEquityAt'])
      this[key] = structuredClone(saved[key]);
    if (this.reservedCash() > this.cash + .00001) throw new Error('Shadow reservations exceed cash.');
    this.tick();
  }
}
ShadowLadderEngine.STRATEGY = STRATEGY;
module.exports = ShadowLadderEngine;
