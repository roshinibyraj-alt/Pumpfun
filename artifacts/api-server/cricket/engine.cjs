'use strict';
const { randomUUID } = require('node:crypto');
const VERSION = 'cricket-manual-paper-v1';
const round = n => Math.round(n * 1e8) / 1e8;
const fee = (p, q, market) => q * market.feeRate * (p * (1 - p)) ** market.feeExponent;
function levels(input, descending = false) {
  return (Array.isArray(input) ? input : []).map(x => ({ price: Number(x.price), size: Number(x.size) }))
    .filter(x => Number.isFinite(x.price) && x.price > 0 && x.price < 1 && Number.isFinite(x.size) && x.size > 0)
    .sort((a, b) => descending ? b.price - a.price : a.price - b.price);
}
function parseMarketUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error('Paste a complete Polymarket cricket match URL.'); }
  if (url.protocol !== 'https:' || !['polymarket.com', 'www.polymarket.com'].includes(url.hostname)
    || url.username || url.password || url.port) throw new Error('Only official https://polymarket.com URLs are accepted.');
  const parts = url.pathname.split('/').filter(Boolean);
  const slug = parts.at(-1);
  if (!slug || !/^[a-z0-9-]{3,180}$/.test(slug)) throw new Error('The market URL has no valid match identifier.');
  return slug;
}
class CricketEngine {
  constructor(saved, now = () => Date.now()) {
    this.now = now;
    this.data = saved || { version: VERSION, initialCapital: 3000, cash: 3000, totalFees: 0, realizedPnl: 0, matches: [], orders: [] };
    if (this.data.version !== VERSION) throw new Error('Unsupported cricket ledger version; refusing to erase it.');
    this.books = new Map();
    for (const o of this.data.orders) if (o.status === 'PENDING') {
      o.status = 'INTERRUPTED'; o.reason = 'Paper order interrupted by restart; no fill assumed.'; o.completedAt = this.now();
    }
  }
  reset() {
    this.data = { version: VERSION, initialCapital: 3000, cash: 3000, totalFees: 0,
      realizedPnl: 0, matches: [], orders: [] };
    this.books.clear();
  }
  locate(id) {
    for (const match of this.data.matches) for (const market of match.markets) {
      const outcome = market.outcomes.find(x => x.id === id);
      if (outcome) return { match, market, outcome };
    }
    throw new Error('Outcome not loaded. Paste the match URL first.');
  }
  book(id, bids, asks, at = this.now()) {
    this.books.set(id, { bids: levels(bids, true), asks: levels(asks), at });
    this.mark(id);
  }
  fresh(id) { const b = this.books.get(id); return b && this.now() - b.at <= 5000 && this.now() >= b.at; }
  pending(id) { return this.data.orders.find(o => o.outcomeId === id && o.status === 'PENDING'); }
  reservedCash() {
    return this.data.orders.filter(o => o.status === 'PENDING' && o.side === 'BUY').reduce((s, o) => s + o.reserve, 0);
  }
  submit({ outcomeId, side, requestId, slippageCents = 3 }) {
    if (!/^[\w-]{8,100}$/.test(requestId || '')) throw new Error('A unique request ID is required.');
    const previous = this.data.orders.find(o => o.requestId === requestId);
    if (previous) return previous;
    if (!['BUY', 'SELL'].includes(side)) throw new Error('Choose BUY or SELL.');
    const { match, market, outcome } = this.locate(outcomeId);
    if (match.closed || market.closed || !market.acceptingOrders) throw new Error('This market is not accepting orders.');
    if (!market.feeKnown) throw new Error('Fee schedule unavailable; trading paused rather than assuming zero fees.');
    if (!Number.isFinite(market.secondsDelay) || market.secondsDelay < 0) throw new Error('Matching delay unavailable.');
    if (!this.fresh(outcomeId)) throw new Error('Live book is stale or disconnected. Wait for a fresh quote.');
    if (this.pending(outcomeId)) throw new Error('This outcome already has an order pending.');
    const slip = Number(slippageCents);
    if (!Number.isFinite(slip) || slip < 0 || slip > 20) throw new Error('Slippage must be between 0 and 20 cents.');
    const book = this.books.get(outcomeId);
    const reference = (side === 'BUY' ? book.asks : book.bids)[0]?.price;
    if (!reference) throw new Error(`No executable ${side === 'BUY' ? 'asks' : 'bids'} available.`);
    const quantity = side === 'BUY' ? 100 : outcome.shares;
    if (!(quantity > 0)) throw new Error('No shares available to sell.');
    if (quantity + 1e-8 < market.minOrderSize) throw new Error(`Market minimum is ${market.minOrderSize} shares; holding is below the minimum.`);
    const tick = market.tickSize;
    const limitPrice = round(side === 'BUY'
      ? Math.min(1 - tick, Math.floor((reference + slip / 100 + 1e-9) / tick) * tick)
      : Math.max(tick, Math.ceil((reference - slip / 100 - 1e-9) / tick) * tick));
    // Conservative maximum fee per share on [0,1]; reserve across simultaneous team buys.
    const reserve = side === 'BUY' ? quantity * (limitPrice + market.feeRate * 0.25 ** market.feeExponent) : 0;
    if (reserve > this.data.cash - this.reservedCash() + 1e-8) throw new Error('Insufficient available paper cash for this order and its fee reserve.');
    const submittedAt = this.now();
    const order = { id: randomUUID(), requestId, outcomeId, marketId: market.id, team: outcome.name, market: market.question,
      side, requestedShares: quantity, filledShares: 0, status: 'PENDING', submittedAt,
      eligibleAt: submittedAt + market.secondsDelay * 1000, limitPrice, reserve, gross: 0, fees: 0,
      realizedPnl: null, averagePrice: null, reason: `Waiting for ${market.secondsDelay}s exchange matching delay.` };
    this.data.orders.unshift(order);
    return order;
  }
  execute(order) {
    if (order.status !== 'PENDING' || this.now() < order.eligibleAt) return false;
    const { match, market, outcome } = this.locate(order.outcomeId);
    const book = this.books.get(order.outcomeId);
    if (!this.fresh(order.outcomeId) || book.at < order.eligibleAt) {
      if (this.now() - order.eligibleAt > 10000) this.reject(order, 'No fresh execution snapshot after matching delay.');
      return false;
    }
    if (match.closed || market.closed || !market.acceptingOrders) {
      this.reject(order, 'Market stopped accepting orders during matching delay.'); return true;
    }
    const source = order.side === 'BUY' ? book.asks : book.bids;
    let remaining = Math.min(order.requestedShares, order.side === 'SELL' ? outcome.shares : Infinity);
    let qty = 0, gross = 0, fees = 0;
    for (const level of source) {
      if ((order.side === 'BUY' && level.price > order.limitPrice + 1e-8)
        || (order.side === 'SELL' && level.price < order.limitPrice - 1e-8)) break;
      const take = Math.min(remaining, level.size);
      if (take <= 1e-8) continue;
      const cost = take * level.price, charge = fee(level.price, take, market);
      if (order.side === 'BUY' && gross + cost + fees + charge > this.data.cash + 1e-8) break;
      qty += take; remaining -= take; gross += cost; fees += charge;
      level.size = round(level.size - take);
      if (remaining <= 1e-8) break;
    }
    order.filledShares = round(qty); order.gross = round(gross); order.fees = round(fees);
    order.averagePrice = qty ? gross / qty : null; order.completedAt = this.now();
    order.status = qty < 1e-8 ? 'UNFILLED' : qty + 1e-8 < order.requestedShares ? 'PARTIAL' : 'FILLED';
    order.reason = qty ? 'Matched against visible depth after delay; unfilled remainder cancelled.'
      : 'No liquidity within the price limit after delay; remainder cancelled.';
    if (qty) {
      if (order.side === 'BUY') {
        outcome.shares = round(outcome.shares + qty); outcome.costBasis = round(outcome.costBasis + gross + fees);
        this.data.cash = round(this.data.cash - gross - fees);
      } else {
        const basis = outcome.costBasis * qty / outcome.shares;
        outcome.costBasis = round(outcome.costBasis - basis); outcome.shares = round(outcome.shares - qty);
        order.realizedPnl = round(gross - fees - basis);
        this.data.cash = round(this.data.cash + gross - fees);
        this.data.realizedPnl = round(this.data.realizedPnl + order.realizedPnl);
      }
      this.data.totalFees = round(this.data.totalFees + fees);
    }
    this.mark(order.outcomeId);
    return true;
  }
  reject(order, reason) {
    order.status = 'REJECTED'; order.reason = reason; order.completedAt = this.now();
  }
  mark(id) {
    const { market, outcome } = this.locate(id);
    const book = this.books.get(id);
    if (!book) return;
    let remaining = outcome.shares, value = 0;
    for (const l of book.bids) {
      const take = Math.min(remaining, l.size);
      value += take * l.price - fee(l.price, take, market); remaining -= take;
      if (remaining <= 1e-8) break;
    }
    // Unmarketable shares are conservatively valued at zero, not at the ask/mid.
    outcome.liquidationValue = round(Math.max(0, value));
  }
  settle(market, payouts) {
    if (market.settled || payouts.length !== market.outcomes.length
      || !payouts.every(x => Number.isFinite(x) && x >= 0 && x <= 1)
      || Math.abs(payouts.reduce((s, x) => s + x, 0) - 1) > 1e-6) return false;
    for (const o of this.data.orders) if (o.marketId === market.id && o.status === 'PENDING') this.reject(o, 'Market resolved before the order matched.');
    market.outcomes.forEach((outcome, i) => {
      if (outcome.shares > 0) {
        const gross = round(outcome.shares * payouts[i]), pnl = round(gross - outcome.costBasis);
        this.data.cash = round(this.data.cash + gross); this.data.realizedPnl = round(this.data.realizedPnl + pnl);
        this.data.orders.unshift({ id: randomUUID(), marketId: market.id, outcomeId: outcome.id, team: outcome.name,
          market: market.question, side: 'SETTLEMENT', requestedShares: outcome.shares, filledShares: outcome.shares,
          averagePrice: payouts[i], gross, fees: 0, realizedPnl: pnl, submittedAt: this.now(),
          completedAt: this.now(), status: 'SETTLED', reason: 'Official resolved-market payout; not an early simulated sale.' });
        outcome.shares = 0; outcome.costBasis = 0; outcome.liquidationValue = 0;
      }
    });
    market.settled = true; market.closed = true; market.acceptingOrders = false;
    return true;
  }
  snapshot() {
    const matches = this.data.matches.map(match => ({ ...match, markets: match.markets.map(market => ({
      ...market, outcomes: market.outcomes.map(outcome => {
        const b = this.books.get(outcome.id), bid = b?.bids.find(l => l.size > 0)?.price ?? null;
        const ask = b?.asks.find(l => l.size > 0)?.price ?? null;
        return { ...outcome, bid, ask, mid: bid !== null && ask !== null ? (bid + ask) / 2 : null,
          updatedAt: b?.at ?? null, quoteFresh: !!this.fresh(outcome.id), pendingOrderId: this.pending(outcome.id)?.id ?? null,
          averageEntry: outcome.shares ? outcome.costBasis / outcome.shares : null,
          unrealizedPnl: round((outcome.liquidationValue || 0) - outcome.costBasis) };
      }),
    })) }));
    const positionValue = matches.flatMap(x => x.markets).flatMap(x => x.outcomes).reduce((s, x) => s + (x.liquidationValue || 0), 0);
    return { ...this.data, matches, mode: 'PAPER_ONLY', availableCash: round(this.data.cash - this.reservedCash()),
      equity: round(this.data.cash + positionValue), positionValue: round(positionValue), updatedAt: this.now() };
  }
}
module.exports = { CricketEngine, parseMarketUrl, levels, fee, VERSION };
