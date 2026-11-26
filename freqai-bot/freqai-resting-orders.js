'use strict';

const { isFresh } = require('./freqai-open-entry-utils');
const SHARES = 100;
const OFFSET = 0.10;
const THRESHOLD_PCT = 58;
const active = order => ['RESTING', 'PARTIAL'].includes(order.status);
const round = value => Number(value.toFixed(8));

class FreqAIRestingOrders {
  constructor(bot) { this.bot = bot; }

  expire(now) {
    for (const order of this.bot.shadowRestingOrders) {
      if (active(order) && now >= order.windowEnd) this.cancel(order, 'EXPIRED', now);
    }
  }

  cancel(order, reason, now) {
    order.status = reason;
    order.cancelledAt = now;
    order.cancelledShares = order.remainingShares;
    order.remainingShares = 0;
    this.sync(order);
    this.bot.log(`${order.side} limit @ $${order.limitPrice.toFixed(3)} ${reason.toLowerCase()}; filled shares remain held.`, {
      type: `LIMIT_${reason}`, asset: 'BTC', timeframe: '5m', side: order.side, now,
    });
    this.bot.scheduleLedgerSave();
  }

  reserved() {
    return this.bot.shadowRestingOrders.filter(active)
      .reduce((sum, order) => sum + order.remainingShares * order.limitPrice, 0);
  }

  sync(order) {
    const record = this.bot.records.get('BTC:5m');
    if (!record?.market || String(record.market.id || record.market.slug) !== order.marketId
      || Number(record.market.start) !== order.windowStart) return;
    Object.assign(record.sideStates[order.side], {
      orderId: order.id, orderStatus: order.status, limitPrice: order.limitPrice,
      requestedShares: SHARES, filledShares: order.filledShares,
      reason: `${order.status}: ${order.filledShares}/100 filled at fixed $${order.limitPrice.toFixed(3)}. Filled shares are held to resolution.`,
    });
  }

  available() {
    const b = this.bot;
    const realized = b.shadowTotals[THRESHOLD_PCT].realizedPnl;
    const committed = b.shadowEntries.filter(e => ['OPEN', 'PENDING_RESOLUTION'].includes(e.status))
      .reduce((sum, e) => sum + e.totalCost + e.fees, 0);
    return b.initialCapital + realized - committed - this.reserved();
  }

  validQuote(record, side, quote, now) {
    return isFresh(quote, now) && Array.isArray(quote.asks)
      && (!quote.tokenId || quote.tokenId === String(record.market.tokens[side]))
      && (!quote.marketId || quote.marketId === String(record.market.id || record.market.slug))
      && (quote.windowStart == null || Number(quote.windowStart) === Number(record.market.start));
  }

  process(record, scores, prediction, now) {
    const b = this.bot;
    this.expire(now);
    const market = record.market;
    if (!market || record.marketStatus !== 'OPEN' || now < Number(market.start) + 45_000 || now >= Number(market.end)) return;
    const key = String(market.id || market.slug);
    const belongs = o => o.marketId === key && o.windowStart === Number(market.start);
    let order = b.shadowRestingOrders.find(o => belongs(o) && active(o));
    const qualifying = scores && scores.probability > THRESHOLD_PCT / 100;
    if (order && qualifying && scores.side !== order.side) {
      this.cancel(order, 'CANCELLED_OPPOSITE_SIGNAL', now);
      order = null;
    }
    // A filled order consumes this window. Partial inventory is never sold;
    // only its still-resting remainder can be replaced on an opposite signal.
    const completed = b.shadowRestingOrders.some(o => belongs(o) && o.status === 'FILLED');
    if (!order && qualifying && !completed) {
      const quote = record.quotes[scores.side];
      if (!this.validQuote(record, scores.side, quote, now)) return;
      const ask = Number(quote.bestAsk);
      const tick = Number(market.raw?.orderPriceMinTickSize ?? market.tickSize ?? 0.001);
      if (!(tick > 0) || !Number.isFinite(tick)) return;
      const limit = round(Math.floor((ask - OFFSET + 1e-10) / tick) * tick);
      if (!(ask > 0 && ask < 1) || !(limit > 0 && limit < ask)) {
        record.sideStates[scores.side].reason = 'Ask minus $0.10 is not a valid positive limit; waiting.';
        return;
      }
      if (this.available() + 1e-8 < SHARES * limit) {
        record.sideStates[scores.side].reason = 'Insufficient unreserved paper capital for 100 shares.';
        return;
      }
      order = {
        id: `limit-${THRESHOLD_PCT}-${++b.shadowOrderSequence}`, marketId: key,
        marketSlug: market.slug, marketTitle: market.title,
        tokenId: String(market.tokens[scores.side]), side: scores.side,
        windowStart: Number(market.start), windowEnd: Number(market.end),
        requestedShares: SHARES, filledShares: 0, remainingShares: SHARES,
        signalAsk: ask, limitPrice: limit, placedAt: now,
        signalProbability: scores.probability, scores: { ...scores },
        modelCandleStart: Number(prediction.candleStart), model: prediction.model || 'LightGBMClassifier',
        status: 'RESTING', depthBudget: {}, lastQuoteAt: null,
        execution: 'MAKER_LIMIT', fees: 0,
      };
      b.shadowRestingOrders.unshift(order);
      this.sync(order);
      record.sideStates[order.side].orderStatus = 'RESTING';
      record.sideStates[order.side].reason = `100-share limit resting at $${limit.toFixed(3)}; only an opposite >${THRESHOLD_PCT}% signal can replace it.`;
      b.lastDecision = { side: order.side, at: now, pUp: scores.pUp, pDown: scores.pDown, limitPrice: limit };
      b.log(`${order.side} ${(scores.probability * 100).toFixed(1)}%: resting 100-share buy @ $${limit.toFixed(3)} (signal ask $${ask.toFixed(3)}).`, {
        type: 'LIMIT_PLACED', asset: 'BTC', timeframe: '5m', side: order.side, now,
      });
      b.scheduleLedgerSave();
      return; // Never fill against the quote that placed the order.
    }
    if (!order) return;
    const quote = record.quotes[order.side];
    if (!this.validQuote(record, order.side, quote, now)
      || Number(quote.updatedAt) <= order.placedAt
      || Number(quote.updatedAt) <= Number(order.lastQuoteAt || 0)) return;
    order.lastQuoteAt = Number(quote.updatedAt);
    const levels = new Map();
    for (const level of quote.asks) {
      const price = Number(level.price), size = Number(level.size);
      if (!(price > 0 && price < 1) || !(size > 0) || !Number.isFinite(size)) continue;
      levels.set(String(price), { price, size });
    }
    // A bid-only update must not reuse unchanged ask liquidity. Track consumed
    // level capacity until its displayed size grows or it disappears/reappears.
    for (const price of Object.keys(order.depthBudget)) {
      if (!levels.has(price)) order.depthBudget[price] = { visible: 0, remaining: 0 };
    }
    let quantity = 0;
    for (const [key, level] of [...levels].sort((a, c) => a[1].price - c[1].price)) {
      const old = order.depthBudget[key];
      const remaining = old ? Math.max(0, Math.min(level.size,
        old.remaining + Math.max(0, level.size - old.visible))) : level.size;
      const budget = order.depthBudget[key] = { visible: level.size, remaining };
      // Strictly-through depth, not a midpoint/bid touch, is conservative
      // evidence for a resting maker fill. Queue priority is not known.
      if (level.price >= order.limitPrice || order.remainingShares <= quantity) continue;
      const take = Math.min(budget.remaining, order.remainingShares - quantity);
      budget.remaining = round(budget.remaining - take);
      quantity = round(quantity + take);
    }
    if (quantity > 0) this.fill(order, quantity, quote, now);
    b.scheduleLedgerSave();
  }

  fill(order, quantity, quote, now) {
    const b = this.bot;
    let entry = b.shadowEntries.find(e => e.orderId === order.id);
    if (!entry) {
      entry = {
        id: `shadow-${THRESHOLD_PCT}-${++b.shadowSequence}`, orderId: order.id, thresholdPct: THRESHOLD_PCT,
        marketId: order.marketId, marketSlug: order.marketSlug, marketTitle: order.marketTitle,
        tokenId: order.tokenId, asset: 'BTC', timeframe: '5m', side: order.side,
        windowStart: order.windowStart, windowEnd: order.windowEnd, entryAt: now,
        orderPlacedAt: order.placedAt, signalAsk: order.signalAsk, limitPrice: order.limitPrice,
        entryPrice: order.limitPrice, requestedShares: SHARES, shares: 0, originalShares: 0,
        totalCost: 0, fees: 0, fills: [], status: 'OPEN', realizedPnl: null,
        modelProbabilityUp: order.scores.pUp, modelProbabilityDown: order.scores.pDown,
        selectedProbability: order.signalProbability, modelCandleStart: order.modelCandleStart,
        model: order.model, exitPrice: null, exitPayout: null, exitReason: null,
        fillRule: 'Paper maker fill at fixed limit only after fresh strictly-through ask depth; queue priority not observable.',
      };
      b.shadowEntries.unshift(entry);
      b.shadowTotals[THRESHOLD_PCT].entries += 1;
    }
    entry.shares = round(entry.shares + quantity);
    entry.originalShares = entry.shares;
    entry.totalCost = round(entry.totalCost + quantity * order.limitPrice);
    entry.fills.push({ price: order.limitPrice, shares: quantity, fee: 0, liquidity: 'MAKER', at: now });
    entry.markBid = quote.bestBid == null ? null : Number(quote.bestBid);
    entry.markUpdatedAt = quote.updatedAt;
    entry.markStatus = entry.markBid == null ? 'WAITING_FOR_MARK' : 'LIVE';
    entry.unrealizedPnl = entry.markBid == null ? null : entry.markBid * entry.shares - entry.totalCost;
    order.filledShares = round(order.filledShares + quantity);
    order.remainingShares = round(SHARES - order.filledShares);
    order.status = order.remainingShares <= 1e-8 ? 'FILLED' : 'PARTIAL';
    order.lastFillAt = now;
    this.sync(order);
    b.log(`${order.side} maker limit filled ${quantity} @ $${order.limitPrice.toFixed(3)}; ${order.filledShares}/100 filled.`, {
      type: 'LIMIT_FILL', asset: 'BTC', timeframe: '5m', side: order.side, now,
    });
    b.scheduleLedgerSave();
  }
}

module.exports = { FreqAIRestingOrders, SHARES, THRESHOLD_PCT, active };
