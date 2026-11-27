'use strict';
const STRATEGY = Object.freeze({ id: 'independent-rebound-shadow-v1',
  name: 'BTC rebound shadow · independent experiment', entryMid: .35, targetBid: .75,
  threshold: .63, baseShares: 50, initialCapital: 3000,
  description: 'First observed dip per side, calibrated rebound model, real ask/bid depth and fees. No recovery, rearm or stop-loss. Unsold shares await official resolution. Research only.' });
const open = p => p.status === 'OPEN' || p.status === 'PENDING_RESOLUTION';
const finite = n => n != null && Number.isFinite(n);
const fee = (shares, price, rate) => Number((shares * rate * price * (1 - price)).toFixed(5));
const levels = (rows, descending) => (rows || []).map(l => ({ price: Number(l.price), size: Number(l.size) }))
  .filter(l => l.price > 0 && l.price < 1 && Number.isFinite(l.size) && l.size > 0)
  .sort((a, b) => descending ? b.price - a.price : a.price - b.price);

class ReboundEngine {
  constructor({ now = Date.now, requestScore = () => false, changed = () => {} } = {}) {
    this.now = now; this.requestScore = requestScore; this.changed = changed;
    this.cash = 3000; this.positions = []; this.signals = []; this.contexts = {};
    this.examples = []; this.events = []; this.current = null; this.sequence = 0;
    this.equityCurve = []; this.lastEquityAt = 0;
    this.model = { status: 'TRAINING', lastError: null }; this.lastError = null;
  }
  log(type, message) {
    this.events.unshift({ at: this.now(), type, message }); this.events.length = Math.min(this.events.length, 60);
    this.changed();
  }
  fresh(c, now = this.now()) {
    const q = c?.quote;
    return !!q && now >= q.updatedAt && now - q.updatedAt <= 2000
      && finite(q.bestBid) && finite(q.bestAsk) && q.bestBid <= q.bestAsk;
  }
  observe(record, side, spot) {
    const m = record?.market, q = record?.quotes?.[side], now = this.now();
    if (!m || record.marketStatus !== 'OPEN' || !q || q.tokenId !== String(m.tokens?.[side]) || q.marketId !== String(m.id || m.slug)
      || q.windowStart !== m.start || now < m.start || now >= m.end
      || !finite(q.updatedAt) || q.updatedAt > now || now - q.updatedAt > 2000
      || !finite(q.bestBid) || !finite(q.bestAsk) || q.bestBid > q.bestAsk
      || !(q.mid > 0 && q.mid < 1)) return;
    const id = `${m.start}:${side}`;
    let c = this.contexts[id];
    if (!c) c = this.contexts[id] = { id, side, tokenId: String(m.tokens[side]), marketId: String(m.id || m.slug),
      start: m.start, end: m.end, eligible: now - m.start <= 5000,
      openMid: q.mid, low: q.mid, btcOpen: spot?.open || null,
      points: [], maxGap: 0, lastAt: now, depth: { asks: {}, bids: {} } };
    if (!finite(c.btcOpen) && finite(spot?.open) && spot.open > 0) c.btcOpen = spot.open;
    c.maxGap = Math.max(c.maxGap, now - c.lastAt); c.lastAt = now; c.low = Math.min(c.low, q.mid);
    c.quote = { bestBid: q.bestBid, bestAsk: q.bestAsk, mid: q.mid, updatedAt: q.updatedAt,
      asks: levels(q.asks, false), bids: levels(q.bids, true) };
    c.feeRate = m.feesEnabled === false ? 0 : Number(m.feeSchedule?.rate ?? .05);
    if (!Number.isFinite(c.feeRate) || c.feeRate < 0 || c.feeRate >= 1) {
      c.eligible = false; return;
    }
    this.current = { id: c.marketId, windowStart: c.start, windowEnd: c.end };
    if (c.candidate) c.candidate.maxMid = Math.max(c.candidate.maxMid, q.mid);
    this.refreshDepth(c);
    if (!c.points.length || now - c.points.at(-1).at >= 1000 || (!c.candidate && q.mid <= .35)) {
      c.points.push({ at: now, mid: q.mid, spread: q.bestAsk - q.bestBid,
        btcPrice: spot && now - spot.at <= 5000 ? spot.price : null });
      c.points = c.points.slice(-310);
    }
    if (!c.candidate && c.eligible && q.mid <= .35) {
      const signal = { id: `rebound-${++this.sequence}`, side, at: now, windowStart: c.start,
        entryMid: q.mid, probability: null, status: 'SCORING', reason: 'Assessing the first cheap-zone observation.' };
      c.candidate = { signalId: signal.id, at: now, maxMid: q.mid, features: null, finalized: false };
      this.signals.unshift(signal);
      this.signals = this.signals.slice(0, 500);
      const context = { at: now, end: c.end, openMid: c.openMid, low: c.low,
        btcOpen: c.btcOpen, points: structuredClone(c.points) };
      if (!finite(c.btcOpen) || !finite(context.points.at(-1).btcPrice)) {
        signal.status = 'SKIPPED'; signal.reason = 'Fresh BTC context unavailable at the first dip.';
      } else if (!this.requestScore(signal.id, context)) {
        signal.status = 'SKIPPED'; signal.reason = 'Model worker unavailable; no invented score or fallback entry.';
      }
      this.changed();
    }
    this.execute(c, now); this.takeProfit(c, now); this.changed();
  }
  refreshDepth(c) {
    for (const side of ['asks', 'bids']) {
      const previous = c.depth[side], next = {};
      for (const l of c.quote[side]) {
        const p = previous[l.price];
        next[l.price] = { observed: l.size,
          remaining: p ? Math.min(l.size, p.remaining + Math.max(0, l.size - p.observed)) : l.size };
      }
      c.depth[side] = next;
    }
  }
  score(row) {
    const s = this.signals.find(s => s.id === row.id);
    const c = Object.values(this.contexts).find(c => c.candidate?.signalId === row.id);
    if (!s || !c) return;
    c.candidate.features = row.features || c.candidate.features;
    if (s.status !== 'SCORING') return;
    s.probability = row.probability; s.modelVersion = row.version;
    s.rawProbability = row.rawProbability ?? null;
    s.calibrationMethod = row.calibrationMethod ?? null;
    s.btcHistoryAsOf = row.btcHistoryAsOf ?? null;
    s.lookbackHours = row.lookbackHours ?? null;
    if (!finite(row.probability)) {
      s.status = 'SKIPPED'; s.reason = row.lastError || 'Model not ready; no fallback entry.';
    } else if (row.probability < .63) {
      s.status = 'REJECTED'; s.reason = 'Rebound score below 63%.';
    } else if (this.now() - s.at > 2000 || this.now() >= c.end) {
      s.status = 'SKIPPED'; s.reason = 'Score arrived too late for a fresh entry.';
    } else {
      s.status = 'APPROVED'; s.reason = 'Score qualified; awaiting 300ms minimum execution delay and fresh asks.';
    }
    this.execute(c, this.now()); this.changed();
  }
  execute(c, now) {
    const s = this.signals.find(s => s.id === c.candidate?.signalId);
    if (!s || s.status !== 'APPROVED') return;
    if (now >= c.end || now - s.at > 2000) {
      s.status = 'SKIPPED'; s.reason = 'Entry expired; no later-window or stale-score fill.'; return;
    }
    if (now - s.at < 300 || !this.fresh(c, now)) return;
    if (c.quote.mid > .35) {
      s.status = 'SKIPPED'; s.reason = 'Price left the cheap zone before execution.'; return;
    }
    let remaining = 50, cost = 0, fees = 0; const fills = [];
    const rate = c.feeRate ?? .05;
    for (const l of c.quote.asks) {
      // Never buy a level whose net $0.75 target payout cannot cover its fees.
      if (.75 - l.price - rate * (l.price * (1 - l.price) + .75 * .25) <= 0) break;
      const available = c.depth.asks[l.price]?.remaining || 0;
      let n = Math.min(remaining, available);
      const unit = l.price + rate * l.price * (1 - l.price);
      n = Math.min(n, Math.max(0, (this.cash - cost - fees - .00001) / unit));
      if (!(n > 1e-6)) continue;
      const f = fee(n, l.price, rate);
      fills.push({ price: l.price, shares: n, fee: f, at: now });
      cost += n * l.price; fees += f; remaining -= n; c.depth.asks[l.price].remaining -= n;
      if (remaining < 1e-6) break;
    }
    if (!fills.length) {
      s.status = 'SKIPPED'; s.reason = 'No affordable executable ask depth below the net target payout.'; return;
    }
    const shares = 50 - remaining;
    this.cash -= cost + fees;
    this.positions.unshift({ id: s.id, contextId: c.id, marketId: c.marketId, tokenId: c.tokenId,
      side: c.side, windowStart: c.start, windowEnd: c.end, entryAt: now,
      shares, remainingShares: shares, totalCost: cost, entryFees: fees, entryPrice: cost / shares,
      exitShares: 0, exitProceeds: 0, exitFees: 0, fills, sales: [], realizedPnl: null,
      status: 'OPEN', feeRate: rate, modelVersion: s.modelVersion, probability: s.probability });
    s.status = 'ENTERED'; s.reason = `Bought ${shares.toFixed(2)}/50 shares against visible asks; remainder canceled.`;
    this.log('BUY', `${c.side}: ${shares.toFixed(2)} shares at $${(cost / shares).toFixed(4)}; entry fees $${fees.toFixed(4)}.`);
  }
  takeProfit(c, now) {
    if (!this.fresh(c, now) || now >= c.end) return;
    for (const p of this.positions.filter(p => p.contextId === c.id && p.status === 'OPEN')) {
      for (const l of c.quote.bids) {
        if (l.price < .75 || p.remainingShares <= 1e-7) break;
        const n = Math.min(p.remainingShares, c.depth.bids[l.price]?.remaining || 0);
        if (!(n > 1e-7)) continue;
        const f = fee(n, l.price, p.feeRate), proceeds = n * l.price;
        this.cash += proceeds - f; p.exitProceeds += proceeds; p.exitFees += f;
        p.exitShares += n; p.remainingShares = Math.max(0, p.remainingShares - n);
        c.depth.bids[l.price].remaining -= n;
        p.sales.push({ at: now, price: l.price, shares: n, fee: f, kind: 'TAKER_TP' });
        p.exitAt = now;
        this.log('TP_SALE', `${p.side}: sold ${n.toFixed(2)} shares at $${l.price.toFixed(4)} against visible bids.`);
      }
      if (p.remainingShares <= 1e-7) this.close(p, 'CLOSED_TP', 'DEPTH_BACKED_TP', now);
    }
  }
  close(p, status, reason, now) {
    if (!open(p)) return;
    Object.assign(p, { status, exitReason: reason, exitAt: now,
      exitPrice: p.exitProceeds / p.shares,
      realizedPnl: p.exitProceeds - p.exitFees - p.totalCost - p.entryFees,
      unrealizedPnl: null });
    this.log(status, `${p.side}: closed net $${p.realizedPnl.toFixed(4)} including entry and exit fees.`);
  }
  settle(marketId, winner, now = this.now()) {
    if (!['UP', 'DOWN'].includes(winner)) return;
    for (const p of this.positions.filter(p => p.marketId === marketId && open(p) && now >= p.windowEnd)) {
      const won = p.side === winner, payout = won ? p.remainingShares : 0;
      this.cash += payout; p.exitProceeds += payout;
      p.sales.push({ at: now, price: won ? 1 : 0, shares: p.remainingShares, fee: 0, kind: 'OFFICIAL_RESOLUTION' });
      p.exitShares += p.remainingShares; p.remainingShares = 0; p.resolutionWinner = winner;
      this.close(p, won ? 'RESOLVED_WIN' : 'RESOLVED_LOSS', 'OFFICIAL_RESOLUTION', now);
    }
  }
  tick() {
    const now = this.now();
    for (const s of this.signals.filter(s => s.status === 'SCORING' && now - s.at > 2000)) {
      s.status = 'SKIPPED'; s.reason = 'Model did not return a fresh score within two seconds.';
    }
    for (const c of Object.values(this.contexts)) {
      this.execute(c, now); this.takeProfit(c, now);
      const e = c.candidate;
      if (e && !e.finalized && now >= c.end) {
        const complete = c.maxGap <= 5000 && c.end - c.lastAt <= 5000;
        if (e.features && (e.maxMid >= .75 || complete)) {
          this.examples.push({ features: e.features, y: Number(e.maxMid >= .75),
            windowStart: c.start, at: e.at, source: 'LIVE_CLOB' });
          this.examples = this.examples.slice(-4000);
        }
        e.finalized = true;
      }
      if (now >= c.end) {
        for (const p of this.positions.filter(p => p.contextId === c.id && p.status === 'OPEN'))
          p.status = 'PENDING_RESOLUTION';
        if (now - c.end > 600000) delete this.contexts[c.id];
      }
    }
    if (now - this.lastEquityAt >= 10000) {
      const a = this.account();
      this.equityCurve.push({ at: now, equity: a.equity, balance: 3000 + a.realizedPnl });
      this.equityCurve = this.equityCurve.slice(-3000); this.lastEquityAt = now;
    }
    this.changed();
  }
  account() {
    let marked = 0, unknown = false; const pending = this.positions.filter(open);
    for (const p of pending) {
      const c = this.contexts[p.contextId], known = p.status === 'OPEN' && this.fresh(c);
      const entryTotal = p.totalCost + p.entryFees;
      p.partialRealizedPnl = p.exitProceeds - p.exitFees - entryTotal * p.exitShares / p.shares;
      p.markBid = known ? c.quote.bestBid : null;
      p.unrealizedPnl = known ? p.remainingShares * p.markBid - entryTotal * p.remainingShares / p.shares : null;
      if (known) marked += p.remainingShares * p.markBid; else unknown = true;
    }
    const closed = this.positions.filter(p => !open(p));
    return { initialCapital: 3000, cash: this.cash, equity: unknown ? null : this.cash + marked,
      realizedPnl: closed.reduce((n, p) => n + p.realizedPnl, 0) + pending.reduce((n, p) => n + p.partialRealizedPnl, 0),
      unrealizedPnl: unknown ? null : pending.reduce((n, p) => n + p.unrealizedPnl, 0),
      totalFees: this.positions.reduce((n, p) => n + p.entryFees + p.exitFees, 0),
      wins: closed.filter(p => p.realizedPnl > 0).length, losses: closed.filter(p => p.realizedPnl < 0).length,
      closedTrades: closed.length, openPositions: pending.filter(p => p.status === 'OPEN').length,
      pendingResolution: pending.filter(p => p.status === 'PENDING_RESOLUTION').length };
  }
  snapshot() {
    const quotes = {}, current = this.current, now = this.now();
    let eligible = false;
    for (const side of ['UP', 'DOWN']) {
      const c = current && this.contexts[`${current.windowStart}:${side}`];
      quotes[side] = c?.quote ? { ...c.quote, asks: undefined, bids: undefined } : null;
      eligible ||= !!c?.eligible && now < c.end;
    }
    return { now, status: this.lastError ? 'ERROR' : this.model.status,
      strategy: STRATEGY, model: this.model, account: this.account(),
      market: current ? { ...current, quotes, eligible, secondsRemaining: Math.max(0, (current.windowEnd - now) / 1000) } : null,
      signals: this.signals.slice(0, 100), positions: this.positions.slice(0, 500),
      events: this.events, training: { closedExamples: this.examples.length,
        activeExamples: Object.values(this.contexts).filter(c => c.candidate && !c.candidate.finalized).length } };
  }
  export() {
    return structuredClone({ version: 1, strategyId: STRATEGY.id, cash: this.cash, positions: this.positions,
      signals: this.signals, contexts: this.contexts, examples: this.examples, events: this.events,
      current: this.current, sequence: this.sequence, equityCurve: this.equityCurve, lastEquityAt: this.lastEquityAt });
  }
  restore(saved) {
    if (saved.version !== 1 || saved.strategyId !== STRATEGY.id || !Number.isFinite(saved.cash) || saved.cash < -1e-5
      || !Array.isArray(saved.positions) || !Array.isArray(saved.examples)) throw new Error('Invalid independent shadow ledger; refusing reset.');
    const expected = saved.positions.reduce((n, p) => n - p.totalCost - p.entryFees + p.exitProceeds - p.exitFees, 3000);
    if (!Number.isFinite(expected) || Math.abs(expected - saved.cash) > .00001)
      throw new Error('Independent shadow cash does not reconcile with its full ledger.');
    for (const key of ['cash', 'positions', 'signals', 'contexts', 'examples', 'events', 'current',
      'sequence', 'equityCurve', 'lastEquityAt']) this[key] = structuredClone(saved[key]);
    for (const s of this.signals.filter(s => ['SCORING', 'APPROVED'].includes(s.status))) {
      s.status = 'SKIPPED'; s.reason = 'Process restarted before execution; no stale-score fill.';
    }
  }
}
ReboundEngine.STRATEGY = STRATEGY;
module.exports = ReboundEngine;
