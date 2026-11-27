'use strict';

// https://docs.polymarket.com/trading/fees — fee amounts rounded to 5 decimals.
function planTakerBuy(record, side, now, cash, requestedShares = 100) {
  if (!Number.isSafeInteger(requestedShares) || requestedShares <= 0) throw new Error('Invalid requested taker size.');
  const m = record.market, q = record.quotes?.[side];
  if (!m || record.marketStatus !== 'OPEN' || now < Number(m.start) + 45000
    || now >= Number(m.end) || !q || q.updatedAt == null
    || !Number.isFinite(Number(q.updatedAt)) || now < Number(q.updatedAt)
    || now - Number(q.updatedAt) > 2000 || !Array.isArray(q.asks)
    || (q.tokenId && q.tokenId !== String(m.tokens[side]))
    || (q.marketId && q.marketId !== String(m.id || m.slug))
    || (q.windowStart != null && Number(q.windowStart) !== Number(m.start))) return null;
  const feeRate = m.feesEnabled === false ? 0 : Number(m.feeSchedule?.rate ?? 0.05);
  if (!Number.isFinite(feeRate) || feeRate < 0 || feeRate >= 1) return null;
  let remaining = requestedShares, cost = 0, fees = 0;
  const fills = [];
  for (const level of [...q.asks].sort((a, b) => Number(a.price) - Number(b.price))) {
    const price = Number(level.price), size = Number(level.size);
    if (!(price > 0 && price < 1) || !Number.isFinite(size) || size <= 0) continue;
    const shares = Math.min(remaining, size);
    const fee = Number((shares * feeRate * price * (1 - price)).toFixed(5));
    fills.push({ price, shares, fee, liquidity: 'TAKER', at: now });
    cost += shares * price; fees += fee; remaining -= shares;
    if (remaining <= 1e-8) break;
  }
  if (!fills.length || !Number.isFinite(cash) || cost + fees > cash + 1e-8) return null;
  return { shares: requestedShares - remaining, totalCost: cost, fees, fills,
    entryPrice: cost / (requestedShares - remaining), unfilledShares: remaining,
    status: remaining > 1e-8 ? 'PARTIALLY_FILLED' : 'FILLED',
    markBid: q.bestBid == null ? null : Number(q.bestBid), markUpdatedAt: q.updatedAt,
    signalAsk: q.bestAsk, feeRate };
}
// Find the smallest whole-share sweep whose $1 winning payout covers all
// purchase costs and market-specific fees plus the requested recovery profit.
function planRecoveryBuy(record, side, now, cash, target) {
  if (!Number.isFinite(target) || target <= 0 || !Number.isFinite(cash) || cash <= 0) return null;
  const depth = (record.quotes?.[side]?.asks || []).filter(l =>
    Number(l.price) > 0 && Number(l.price) < 1 && Number(l.size) > 0 && Number.isFinite(Number(l.size)))
    .reduce((sum, l) => sum + Number(l.size), 0);
  let lo = 50, hi = Math.floor(depth);
  if (!Number.isSafeInteger(hi) || hi < lo) return null;
  const sweep = n => planTakerBuy(record, side, now, Number.MAX_VALUE, n);
  const maximum = sweep(hi);
  if (!maximum || maximum.shares - maximum.totalCost - maximum.fees < target) return null;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2), fill = sweep(mid);
    if (fill && fill.shares - fill.totalCost - fill.fees >= target) hi = mid;
    else lo = mid + 1;
  }
  const fill = planTakerBuy(record, side, now, cash, lo);
  return fill && fill.unfilledShares < 1e-8
    && fill.shares - fill.totalCost - fill.fees >= target ? { ...fill, requestedShares: lo } : null;
}
module.exports = { planTakerBuy, planRecoveryBuy };
