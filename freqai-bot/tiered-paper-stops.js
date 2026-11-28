'use strict';
const TIERS = Object.freeze([
  Object.freeze({ entryAbove: .90, stopBid: .50 }),
  Object.freeze({ entryAbove: .75, stopBid: .40 }),
  Object.freeze({ entryAbove: .65, stopBid: .30 }),
  Object.freeze({ entryAbove: .50, stopBid: .20 }),
  Object.freeze({ entryAtOrBelow: .50, stopBid: .09 }),
]);
const active = e => ['OPEN', 'PENDING_RESOLUTION'].includes(e.status);
const held = e => active(e) ? Math.max(0, e.shares - (e.exitShares || 0)) : 0;
const netSales = e => (e.exitProceeds || 0) - (e.exitFees || 0);
const partialPnl = e => netSales(e) - (e.totalCost + e.fees) * (e.exitShares || 0) / e.shares;
function stopFor(price) {
  if (!(price > 0 && price < 1)) throw new Error('Invalid actual average entry price.');
  const normalized = Math.round(price * 1e10) / 1e10;
  return TIERS.find(t => t.entryAbove != null && normalized > t.entryAbove)?.stopBid ?? .09;
}
function prepare(e) {
  if (!active(e)) return;
  if (!e.exitAccountingVersion) {
    Object.assign(e, { exitAccountingVersion: 1, exitShares: 0, exitProceeds: 0,
      exitFees: 0, slSales: [], slDepthBudget: {}, terminalPayout: 0 });
  }
  e.stopLossBid = e.fixedStopLossBid ?? stopFor(e.totalCost / e.shares);
  e.remainingHeldShares = held(e);
  e.partialRealizedPnl = partialPnl(e);
}
function validQuote(e, q, now, entry = false) {
  if (!q || q.updatedAt == null || !Number.isFinite(Number(q.updatedAt))
    || Number(q.updatedAt) > now || now - Number(q.updatedAt) > 2000
    || Number(q.updatedAt) < e.entryAt
    || (q.tokenId && q.tokenId !== e.tokenId)
    || (q.marketId && q.marketId !== e.marketId)
    || (q.windowStart != null && Number(q.windowStart) !== e.windowStart)) return false;
  const bid = q.bestBid == null ? null : Number(q.bestBid);
  const ask = q.bestAsk == null ? null : Number(q.bestAsk);
  if ((bid != null && (!Number.isFinite(bid) || bid < 0 || bid > 1))
    || (ask != null && (!Number.isFinite(ask) || ask <= 0 || ask > 1))
    || (bid != null && ask != null && bid > ask)) return false;
  const rows = entry ? q.asks : q.bids;
  if (!Array.isArray(rows)) return false;
  const prices = rows.filter(l => Number(l.size) > 0).map(l => Number(l.price));
  if (new Set(prices).size !== prices.length) return false;
  if (entry) return ask != null && prices.length > 0
    && Math.abs(Math.min(...prices) - ask) < 1e-8;
  return bid != null && (prices.length === 0 || Math.abs(Math.max(...prices) - bid) < 1e-8);
}
function sweep(e, q, now, delayMs) {
  prepare(e);
  if (e.status !== 'OPEN' || now >= e.windowEnd || !validQuote(e, q, now)) return [];
  const bid = Number(q.bestBid), quoteAt = Number(q.updatedAt);
  if (!e.slTriggeredAt && bid > e.stopLossBid) return [];
  if (!e.slTriggeredAt) Object.assign(e, { slTriggeredAt: now, slEligibleAt: now + delayMs,
    triggerBid: bid, triggerQuoteAt: quoteAt });
  const rate = Number(e.feeRate);
  if (!Number.isFinite(rate) || rate < 0 || rate >= 1) {
    e.slError = 'Cannot sell without a valid market taker fee rate.'; return [];
  }
  e.slError = null;
  const next = {}, rows = [...q.bids].filter(l => Number(l.price) > 0 && Number(l.price) < 1
    && Number.isFinite(Number(l.size)) && Number(l.size) > 0)
    .sort((a, b) => Number(b.price) - Number(a.price));
  const signature = JSON.stringify(rows.map(l => [Number(l.price), Number(l.size)]));
  if (e.slDepthAt != null && (quoteAt < e.slDepthAt
    || (quoteAt === e.slDepthAt && signature !== e.slDepthSignature
      && !(Number.isFinite(q.sequence) && q.sequence > (e.slDepthSequence ?? -1))))) return [];
  e.slDepthAt = quoteAt; e.slDepthSignature = signature; e.slDepthSequence = q.sequence ?? null;
  for (const l of rows) {
    const price = Number(l.price), size = Number(l.size), old = e.slDepthBudget[price];
    next[price] = { observed: size, remaining: old
      ? Math.min(size, old.remaining + Math.max(0, size - old.observed)) : size };
  }
  e.slDepthBudget = next;
  if (now < e.slEligibleAt) return [];
  const fills = [];
  for (const l of rows) {
    const price = Number(l.price), level = next[price], shares = Math.min(held(e), level.remaining);
    if (!(shares > 1e-8)) continue;
    const fee = Number((shares * rate * price * (1 - price)).toFixed(5));
    const fill = { at: now, bookAt: quoteAt, price, shares, fee, liquidity: 'TAKER',
      remainingHeldSharesAfter: Math.max(0, held(e) - shares),
      realizedPnl: shares * price - fee - (e.totalCost + e.fees) * shares / e.shares };
    level.remaining -= shares; e.exitShares += shares;
    e.exitProceeds += shares * price; e.exitFees += fee;
    e.slSales.push(fill); fills.push(fill);
  }
  e.remainingHeldShares = held(e); e.partialRealizedPnl = partialPnl(e);
  e.slOrderStatus = held(e) <= 1e-8 ? 'FILLED' : e.exitShares > 0 ? 'PARTIALLY_FILLED'
    : now < e.slEligibleAt ? 'SUBMITTING' : 'WAITING_FOR_BIDS';
  return fills;
}
function validate(e) {
  if (!e.exitAccountingVersion) return;
  if (e.exitAccountingVersion !== 1 || !Array.isArray(e.slSales)
    || ![e.exitShares, e.exitProceeds, e.exitFees, e.terminalPayout].every(Number.isFinite)
    || e.exitShares < 0 || e.exitShares > e.shares + 1e-8 || e.exitFees < 0
    || e.exitProceeds < 0 || e.terminalPayout < 0
    || e.terminalPayout > e.shares - e.exitShares + 1e-8)
    throw new Error('Invalid saved stop-loss accounting.');
  const sum = key => e.slSales.reduce((n, s) => n + s[key], 0);
  if (e.slSales.length && (!Number.isFinite(e.feeRate) || e.feeRate < 0 || e.feeRate >= 1))
    throw new Error('Invalid saved stop-loss fee rate.');
  if (e.slSales.some(s => !(s.shares > 0 && s.price > 0 && s.price < 1)
      || !Number.isFinite(s.fee) || s.fee < 0 || s.at < e.entryAt || s.at >= e.windowEnd
      || s.bookAt > s.at || s.at - s.bookAt > 2000)
    || e.slSales.some(s => ![s.at, s.bookAt, s.realizedPnl].every(Number.isFinite)
      || Math.abs(s.fee - Number((s.shares * e.feeRate * s.price * (1 - s.price)).toFixed(5))) > 1e-8
      || Math.abs(s.realizedPnl - (s.shares * s.price - s.fee
        - (e.totalCost + e.fees) * s.shares / e.shares)) > 1e-7)
    || Math.abs(sum('shares') - e.exitShares) > 1e-7
    || Math.abs(e.slSales.reduce((n, s) => n + s.shares * s.price, 0) - e.exitProceeds) > 1e-7
    || Math.abs(sum('fee') - e.exitFees) > 1e-7) throw new Error('Saved stop-loss fills do not reconcile.');
  if (e.exitShares > 0 && (!Number.isFinite(e.slTriggeredAt)
    || !Number.isFinite(e.slEligibleAt) || e.slTriggeredAt < e.entryAt
    || e.slTriggeredAt >= e.windowEnd || e.slEligibleAt < e.slTriggeredAt))
    throw new Error('Invalid saved stop-loss trigger.');
  for (const l of Object.values(e.slDepthBudget || {})) {
    if (!Number.isFinite(l.observed) || !Number.isFinite(l.remaining)
      || l.remaining < -1e-8 || l.remaining > l.observed + 1e-8)
      throw new Error('Invalid saved stop-loss liquidity budget.');
  }
  if (!active(e) && Math.abs(e.realizedPnl
    - (netSales(e) + e.terminalPayout - e.totalCost - e.fees)) > 1e-7)
    throw new Error('Saved net P&L does not match stop-loss proceeds and fees.');
}
module.exports = { TIERS, active, held, netSales, partialPnl, stopFor, prepare, validQuote, sweep, validate };
