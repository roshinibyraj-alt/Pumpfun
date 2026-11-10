'use strict';

const config = require('./btc-price-band-config.cjs');
const marketDataDefault = require('./wick-market-data.js');
const { feeParameters, takerFeeAt } = require('./paper-trading.js');
const { resolvedPayout } = require('./position-exits.js');

const EPSILON = 1e-8;

function numeric(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value, digits = 6) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function normalizeLevels(levels, side) {
  return (Array.isArray(levels) ? levels : [])
    .map(level => ({ price: numeric(level.price), size: numeric(level.size) }))
    .filter(level => level.price > 0 && level.price < 1 && level.size > 0)
    .sort((a, b) => side === 'asks' ? a.price - b.price : b.price - a.price);
}

function reconcileLevels(previous, next) {
  const oldLevels = new Map((previous || []).map(level => [level.price, level]));
  return next.map(level => {
    const old = oldLevels.get(level.price);
    const availableSize = old
      ? Math.max(0, old.availableSize + level.size - old.size)
      : level.size;
    return { ...level, availableSize };
  });
}

function emptyInventoryBox() {
  return {
    shares: 0,
    averageEntryPrice: null,
    grossCost: 0,
    fees: 0,
    totalCost: 0,
    markValue: null,
    unrealizedPnl: null,
    positions: 0,
    unmarkedPositions: 0,
  };
}

function groupInventory(trades, selector) {
  const result = { UP: emptyInventoryBox(), DOWN: emptyInventoryBox() };
  for (const trade of trades) {
    if (!selector(trade)) continue;
    const box = result[trade.side];
    if (!box) continue;
    box.shares += trade.shares;
    box.grossCost += trade.grossCost;
    box.fees += trade.fees;
    box.totalCost += trade.totalCost;
    box.positions += 1;
    if (trade.markValue != null) {
      box.markValue = (box.markValue || 0) + trade.markValue;
      box.unrealizedPnl = (box.unrealizedPnl || 0) + trade.unrealizedPnl;
    } else {
      box.unmarkedPositions += 1;
    }
  }
  for (const side of ['UP', 'DOWN']) {
    const box = result[side];
    box.shares = round(box.shares) || 0;
    box.grossCost = round(box.grossCost) || 0;
    box.fees = round(box.fees) || 0;
    box.totalCost = round(box.totalCost) || 0;
    box.averageEntryPrice = box.shares > 0 ? round(box.grossCost / box.shares) : null;
    box.markValue = box.markValue == null ? null : round(box.markValue);
    box.unrealizedPnl = box.unrealizedPnl == null ? null : round(box.unrealizedPnl);
  }
  return result;
}

function sourceTimestamp(value) {
  const number = Number(value);
  if (Number.isFinite(number) && number > 0) return number;
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function bestAskPriceChanged(previous, next) {
  if (next == null) return false;
  if (previous == null) return true;
  return Math.abs(previous - next) >= EPSILON;
}

class BtcPriceBandBot {
  constructor(options = {}) {
    this.marketData = options.marketData || marketDataDefault;
    this.now = options.now || Date.now;
    this.config = options.config || config;
    this.startingCapital = Number(options.startingCapital ?? this.config.STARTING_CAPITAL);
    this.cash = this.startingCapital;
    this.realizedPnl = 0;
    this.trades = [];
    this.events = [];
    this.running = false;
    this.error = null;
    this.statusReason = 'Starting the BTC 5-minute price-band paper bot.';
    this.windowStart = null;
    this.windowEnd = null;
    this.market = null;
    this.quotes = { UP: null, DOWN: null };
    this.books = new Map();
    this.sideState = {
      UP: this.emptySideState(),
      DOWN: this.emptySideState(),
    };
    this.lastAskTrigger = { UP: null, DOWN: null };
    this.websocket = {
      status: 'DISCONNECTED',
      connectedAt: null,
      lastMessageAt: null,
      reconnectCount: 0,
      error: null,
    };
    this.marketStream = null;
    this.streamGeneration = 0;
    this.seenMarketEvents = new Set();
    this.lastMarketRefreshAt = 0;
    this.lastResolutionCheckAt = 0;
    this.resolutionLastAttemptAt = new Map();
    this.resolutionInFlight = new Set();
    this.interval = null;
    this.tickInProgress = false;
    this.tradeSequence = 0;
    this.eventSequence = 0;
  }

  emptySideState() {
    return {
      status: 'WAITING_FOR_MARKET',
      reason: 'Waiting for the BTC market and its live ask book.',
      lastUpdateAt: null,
      lastBestAsk: null,
      qualifyingUpdates: 0,
      buys: 0,
      sharesBought: 0,
    };
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.log('BOT_STARTED', 'BTC 5-minute ask-band paper bot started.');
    void this.tick();
    this.interval = setInterval(() => void this.tick(), this.config.POLL_INTERVAL_MS);
    this.interval.unref?.();
  }

  stop() {
    this.running = false;
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    this.closeMarketStream();
  }

  log(type, message, details = {}) {
    this.events.unshift({
      id: `event-${++this.eventSequence}`,
      at: this.now(),
      type,
      message,
      ...details,
    });
    this.events = this.events.slice(0, 150);
  }

  closeMarketStream() {
    this.streamGeneration += 1;
    if (this.marketStream) {
      try {
        this.marketStream.close();
      } catch {
        // Closing a stale socket must not interrupt the next window.
      }
    }
    this.marketStream = null;
  }

  resetWindow(start) {
    if (this.windowStart === start) return;
    const previousStart = this.windowStart;
    this.markOpenPositions(this.now());
    for (const trade of this.trades) {
      if (trade.status === 'OPEN' && trade.windowStart < start) {
        trade.status = 'AWAITING_RESOLUTION';
        trade.settlementStatus = 'AWAITING_SETTLEMENT';
        trade.awaitingResolutionAt = this.now();
      }
    }
    if (previousStart != null) {
      const moved = this.trades.filter(trade =>
        trade.windowStart === previousStart && trade.status === 'AWAITING_RESOLUTION').length;
      if (moved) {
        this.log('WINDOW_EXPIRED',
          `${moved} BTC position(s) moved to resolution after the 5-minute window ended.`,
          { windowStart: previousStart, positions: moved });
      }
    }
    this.closeMarketStream();
    this.windowStart = start;
    this.windowEnd = start + this.config.WINDOW_MS;
    this.market = null;
    this.quotes = { UP: null, DOWN: null };
    this.books.clear();
    this.sideState = { UP: this.emptySideState(), DOWN: this.emptySideState() };
    this.lastAskTrigger = { UP: null, DOWN: null };
    this.seenMarketEvents.clear();
    this.websocket = {
      status: 'DISCONNECTED',
      connectedAt: null,
      lastMessageAt: null,
      reconnectCount: 0,
      error: null,
    };
    this.lastMarketRefreshAt = 0;
    this.statusReason = 'Looking up the current BTC 5-minute Polymarket market.';
  }

  async refreshMarket(now) {
    if (this.market?.start === this.windowStart
      && now - this.lastMarketRefreshAt < this.config.MARKET_REFRESH_MS) return;
    this.lastMarketRefreshAt = now;
    const market = await this.marketData.getBtcMarket(this.windowStart, this.config.WINDOW_MS);
    if (!market) {
      this.statusReason = 'Waiting for the current BTC 5-minute Polymarket market.';
      return;
    }
    if (market.start !== this.windowStart || market.end !== this.windowEnd
      || !market.tokens?.UP || !market.tokens?.DOWN) {
      throw new Error('BTC UP/DOWN outcomes do not match the current 5-minute window.');
    }

    const changed = !this.market
      || String(this.market.id) !== String(market.id)
      || this.market.tokens.UP !== market.tokens.UP
      || this.market.tokens.DOWN !== market.tokens.DOWN;
    this.market = market;
    if (changed) {
      this.quotes = { UP: null, DOWN: null };
      this.books.clear();
      this.sideState = { UP: this.emptySideState(), DOWN: this.emptySideState() };
      this.lastAskTrigger = { UP: null, DOWN: null };
      this.startMarketStream(market);
    }
    this.statusReason = 'BTC market loaded; waiting for live UP/DOWN ask updates.';
    this.error = null;
  }

  startMarketStream(market) {
    this.closeMarketStream();
    const generation = this.streamGeneration;
    if (typeof this.marketData.connectMarketStream !== 'function') {
      throw new Error('Polymarket market WebSocket is unavailable.');
    }
    this.websocket = {
      status: 'CONNECTING',
      connectedAt: null,
      lastMessageAt: null,
      reconnectCount: 0,
      error: null,
    };
    this.marketStream = this.marketData.connectMarketStream(
      [market.tokens.UP, market.tokens.DOWN],
      {
        heartbeatMs: this.config.WS_HEARTBEAT_MS,
        reconnectMinMs: this.config.WS_RECONNECT_MIN_MS,
        reconnectMaxMs: this.config.WS_RECONNECT_MAX_MS,
        onStatus: update => {
          if (generation !== this.streamGeneration) return;
          this.websocket = { ...this.websocket, ...update };
          if (update.status === 'CONNECTED') {
            this.websocket.connectedAt = this.now();
            this.websocket.error = null;
            this.statusReason = 'Connected to Polymarket; waiting for BTC UP/DOWN order books.';
          } else if (update.status === 'DISCONNECTED' || update.status === 'ERROR') {
            this.websocket.error = update.error || null;
            this.statusReason = 'Polymarket WebSocket reconnecting; stale prices cannot trigger buys.';
          }
        },
        onMessage: event => {
          if (generation !== this.streamGeneration) return;
          try {
            this.handleMarketMessage(event);
          } catch (error) {
            this.websocket.error = error?.message || 'Could not process a Polymarket update.';
            this.log('WEBSOCKET_MESSAGE_ERROR', this.websocket.error);
          }
        },
      },
    );
  }

  sideForToken(tokenId) {
    if (!this.market) return null;
    const token = String(tokenId || '');
    if (token === String(this.market.tokens.UP)) return 'UP';
    if (token === String(this.market.tokens.DOWN)) return 'DOWN';
    return null;
  }

  rememberEvent(event) {
    const key = JSON.stringify(event);
    if (this.seenMarketEvents.has(key)) return false;
    this.seenMarketEvents.add(key);
    if (this.seenMarketEvents.size > 500) {
      this.seenMarketEvents.delete(this.seenMarketEvents.values().next().value);
    }
    return true;
  }

  handleMarketMessage(event) {
    if (Array.isArray(event)) {
      for (const item of event) this.handleMarketMessage(item);
      return;
    }
    if (!event || typeof event !== 'object') return;
    const type = event.event_type || event.eventType;
    if (!type || type === 'PONG') return;
    const now = this.now();
    this.websocket.lastMessageAt = now;
    this.websocket.error = null;
    if (type === 'book') {
      if (!this.rememberEvent(event)) return;
      this.handleBookSnapshot(event, now);
    } else if (type === 'price_change') {
      if (!this.rememberEvent(event)) return;
      this.handlePriceChanges(event, now);
    } else if (type === 'best_bid_ask') {
      this.handleBestBidAsk(event, now);
    }
    this.markOpenPositions(now);
  }

  handleBookSnapshot(event, now) {
    const tokenId = String(event.asset_id || event.assetId || '');
    const side = this.sideForToken(tokenId);
    if (!side) return;
    const previous = this.books.get(tokenId);
    const previousBestAsk = previous?.asks?.[0]?.price ?? null;
    const asks = reconcileLevels(previous?.asks, normalizeLevels(event.asks, 'asks'));
    const bids = reconcileLevels(previous?.bids, normalizeLevels(event.bids, 'bids'));
    const book = {
      asks,
      bids,
      updatedAt: now,
      sourceTimestamp: sourceTimestamp(event.timestamp),
    };
    this.books.set(tokenId, book);
    this.updateQuoteFromBook(side, tokenId, book, now, event.timestamp);
    const nextBestAsk = asks[0]?.price ?? null;
    if (bestAskPriceChanged(previousBestAsk, nextBestAsk)
      && this.tryBuy(side, now, 'BEST_ASK_PRICE_CHANGE')) {
      this.recordAskTrigger(side, 'BOOK_UPDATE', event.timestamp);
    }
  }

  handlePriceChanges(event, now) {
    const changes = Array.isArray(event.price_changes)
      ? event.price_changes
      : Array.isArray(event.priceChanges) ? event.priceChanges : [];
    const byToken = new Map();
    for (const change of changes) {
      const tokenId = String(change.asset_id || change.assetId || '');
      const side = this.sideForToken(tokenId);
      if (!side) continue;
      if (!byToken.has(tokenId)) byToken.set(tokenId, { side, changes: [], askChanged: false });
      const group = byToken.get(tokenId);
      group.changes.push(change);
      const bookSide = String(change.side || '').toUpperCase();
      if (bookSide === 'SELL' || bookSide === 'ASK' || bookSide === 'ASKS') {
        group.askChanged = true;
      }
    }
    for (const [tokenId, group] of byToken) {
      const book = this.books.get(tokenId);
      if (!book) continue;
      const previousBestAsk = book.asks[0]?.price ?? null;
      for (const change of group.changes) this.applyLevelChange(book, change);
      const nextBestAsk = book.asks[0]?.price ?? null;
      book.updatedAt = now;
      book.sourceTimestamp = sourceTimestamp(event.timestamp);
      this.updateQuoteFromBook(group.side, tokenId, book, now, event.timestamp);
      if (group.askChanged && bestAskPriceChanged(previousBestAsk, nextBestAsk)) {
        if (this.isDuplicateAskTrigger(group.side, 'ASK_PRICE_UPDATE', event.timestamp)) {
          this.lastAskTrigger[group.side] = null;
          continue;
        }
        if (this.tryBuy(group.side, now, 'ASK_PRICE_UPDATE')) {
          this.recordAskTrigger(group.side, 'ASK_PRICE_UPDATE', event.timestamp);
        }
      }
    }
  }

  askTriggerSignature(side, timestamp) {
    return {
      timestamp: sourceTimestamp(timestamp),
      bestAsk: this.quotes[side]?.bestAsk ?? null,
    };
  }

  recordAskTrigger(side, source, timestamp) {
    this.lastAskTrigger[side] = {
      source,
      ...this.askTriggerSignature(side, timestamp),
    };
  }

  isDuplicateAskTrigger(side, source, timestamp) {
    const previous = this.lastAskTrigger[side];
    if (!previous || previous.source === source) return false;
    const current = this.askTriggerSignature(side, timestamp);
    return current.timestamp != null
      && previous.timestamp === current.timestamp
      && current.bestAsk != null
      && previous.bestAsk != null
      && Math.abs(previous.bestAsk - current.bestAsk) < EPSILON;
  }

  applyLevelChange(book, change) {
    const price = numeric(change.price);
    const size = numeric(change.size);
    if (!(price > 0 && price < 1) || size == null) return;
    const side = String(change.side || '').toUpperCase();
    const levels = side === 'SELL' || side === 'ASK' || side === 'ASKS'
      ? book.asks
      : side === 'BUY' || side === 'BID' || side === 'BIDS' ? book.bids : null;
    if (!levels) return;
    const index = levels.findIndex(level => Math.abs(level.price - price) < EPSILON);
    if (size <= 0) {
      if (index >= 0) levels.splice(index, 1);
      return;
    }
    if (index >= 0) {
      const level = levels[index];
      level.availableSize = Math.max(0, level.availableSize + size - level.size);
      level.size = size;
    } else {
      levels.push({ price, size, availableSize: size });
    }
    levels.sort((a, b) => side === 'SELL' || side === 'ASK' || side === 'ASKS'
      ? a.price - b.price : b.price - a.price);
  }

  handleBestBidAsk(event, now) {
    const tokenId = String(event.asset_id || event.assetId || '');
    const side = this.sideForToken(tokenId);
    if (!side) return;
    const previous = this.quotes[side] || {};
    const previousBestAsk = previous.bestAsk ?? null;
    const bestAsk = numeric(event.best_ask ?? event.bestAsk);
    const bestBid = numeric(event.best_bid ?? event.bestBid);
    this.quotes[side] = {
      ...previous,
      asset: 'BTC',
      side,
      tokenId,
      bestAsk: bestAsk ?? previous.bestAsk ?? null,
      askSize: previous.askSize ?? 0,
      bestBid: bestBid ?? previous.bestBid ?? null,
      bidSize: previous.bidSize ?? 0,
      midpoint: bestAsk != null && bestBid != null ? (bestAsk + bestBid) / 2 : previous.midpoint ?? null,
      updatedAt: now,
      sourceTimestamp: sourceTimestamp(event.timestamp),
      status: 'LIVE',
      error: null,
      eventType: 'BEST_BID_ASK',
    };
    const bestAskChanged = bestAsk != null
      && (previousBestAsk == null || Math.abs(bestAsk - previousBestAsk) >= EPSILON);
    if (bestAskChanged) {
      if (this.isDuplicateAskTrigger(side, 'BEST_BID_ASK', event.timestamp)) {
        this.lastAskTrigger[side] = null;
      } else if (this.tryBuy(side, now, 'BEST_BID_ASK')) {
        this.recordAskTrigger(side, 'BEST_BID_ASK', event.timestamp);
      }
    }
  }

  updateQuoteFromBook(side, tokenId, book, now, timestamp) {
    const ask = book.asks[0] || null;
    const bid = book.bids[0] || null;
    this.quotes[side] = {
      asset: 'BTC',
      side,
      tokenId,
      bestAsk: ask?.price ?? null,
      askSize: ask?.size ?? 0,
      availableAskSize: ask?.availableSize ?? 0,
      bestBid: bid?.price ?? null,
      bidSize: bid?.size ?? 0,
      midpoint: ask && bid ? (ask.price + bid.price) / 2 : null,
      updatedAt: now,
      sourceTimestamp: sourceTimestamp(timestamp),
      status: 'LIVE',
      error: null,
      eventType: 'ORDER_BOOK',
    };
  }

  quoteIsFresh(quote, now) {
    return quote?.status === 'LIVE'
      && Number.isFinite(quote.updatedAt)
      && now >= quote.updatedAt
      && now - quote.updatedAt <= this.config.MAX_QUOTE_AGE_MS;
  }

  sweepAsks(side, requestedShares) {
    const market = this.market;
    const quote = this.quotes[side];
    const tokenId = String(market?.tokens?.[side] || '');
    const book = this.books.get(tokenId);
    if (!book || !this.quoteIsFresh(quote, this.now())) return null;
    if (Math.abs((book.asks[0]?.price ?? NaN) - quote.bestAsk) >= EPSILON) return null;
    const parameters = feeParameters(market);
    let remaining = requestedShares;
    let grossCost = 0;
    let fees = 0;
    const fills = [];
    for (const level of book.asks) {
      if (remaining <= EPSILON || level.price > this.config.MAX_ENTRY_ASK) break;
      if (level.price < this.config.MIN_ENTRY_ASK) continue;
      const shares = Math.min(remaining, Math.max(0, level.availableSize));
      if (shares <= EPSILON) continue;
      const cost = shares * level.price;
      const fee = takerFeeAt(level.price, shares, parameters);
      fills.push({ level, price: level.price, shares, cost, fee });
      grossCost += cost;
      fees += fee;
      remaining -= shares;
    }
    const complete = remaining <= EPSILON;
    if (complete) {
      for (const fill of fills) fill.level.availableSize -= fill.shares;
    }
    return {
      tokenId,
      shares: requestedShares - remaining,
      remainingShares: Math.max(0, remaining),
      grossCost,
      fees,
      totalCost: grossCost + fees,
      averagePrice: grossCost / Math.max(EPSILON, requestedShares - remaining),
      fills: fills.map(({ level, ...fill }) => fill),
      complete,
    };
  }

  tryBuy(side, now, triggerType) {
    const quote = this.quotes[side];
    const state = this.sideState[side];
    state.lastUpdateAt = now;
    state.lastBestAsk = quote?.bestAsk ?? null;
    if (!this.quoteIsFresh(quote, now) || !Number.isFinite(quote.bestAsk)) {
      state.status = 'WAITING_FOR_FRESH_ASK';
      state.reason = 'Waiting for a fresh Polymarket best ask.';
      return false;
    }
    if (quote.bestAsk < this.config.MIN_ENTRY_ASK) {
      state.status = 'BELOW_PRICE_BAND';
      state.reason = `Best ask ${quote.bestAsk.toFixed(3)} is below $${this.config.MIN_ENTRY_ASK.toFixed(2)}.`;
      return false;
    }
    if (quote.bestAsk > this.config.MAX_ENTRY_ASK) {
      state.status = 'ABOVE_PRICE_BAND';
      state.reason = `Best ask ${quote.bestAsk.toFixed(3)} is above $${this.config.MAX_ENTRY_ASK.toFixed(2)}.`;
      return false;
    }

    state.qualifyingUpdates += 1;
    const execution = this.sweepAsks(side, this.config.SHARES_PER_BUY);
    if (!execution || !execution.complete) {
      state.status = 'WAITING_FOR_FULL_DEPTH';
      state.reason = `Ask is in range, but ${this.config.SHARES_PER_BUY} shares are not available within the price band.`;
      this.log('ENTRY_WAITING_FOR_DEPTH',
        `${side} ask is in range; waiting for full ${this.config.SHARES_PER_BUY}-share visible depth.`,
        { side, bestAsk: quote.bestAsk, triggerType });
      return false;
    }
    if (execution.totalCost > this.cash + EPSILON) {
      state.status = 'INSUFFICIENT_CAPITAL';
      state.reason = `Needs $${execution.totalCost.toFixed(2)} including fees; $${this.cash.toFixed(2)} is available.`;
      this.log('ENTRY_BLOCKED_CAPITAL', `${side} buy skipped because paper cash is insufficient.`, {
        side, requiredCash: round(execution.totalCost), availableCash: round(this.cash), triggerType,
      });
      return false;
    }

    this.cash = round(this.cash - execution.totalCost, 8);
    const trade = {
      id: `trade-${++this.tradeSequence}`,
      asset: 'BTC',
      side,
      marketId: String(this.market.id),
      marketSlug: this.market.slug,
      marketTitle: this.market.title,
      tokenId: execution.tokenId,
      windowStart: this.windowStart,
      windowEnd: this.windowEnd,
      shares: this.config.SHARES_PER_BUY,
      entryPrice: execution.averagePrice,
      triggerAsk: quote.bestAsk,
      triggerType,
      grossCost: execution.grossCost,
      fees: execution.fees,
      totalCost: execution.totalCost,
      fills: execution.fills,
      openedAt: now,
      status: 'OPEN',
      settlementStatus: 'OPEN',
      markPrice: null,
      markValue: null,
      unrealizedPnl: null,
      realizedPnl: null,
      outcome: null,
    };
    this.trades.push(trade);
    state.status = 'BUY_FILLED';
    state.reason = `Bought ${trade.shares} ${side} shares at ${trade.entryPrice.toFixed(3)} average.`;
    state.buys += 1;
    state.sharesBought += trade.shares;
    this.log('BUY_FILLED',
      `${side} buy filled: ${trade.shares} shares at ${trade.entryPrice.toFixed(3)} average.`,
      {
        tradeId: trade.id,
        side,
        shares: trade.shares,
        bestAsk: quote.bestAsk,
        averagePrice: round(trade.entryPrice),
        totalCost: round(trade.totalCost),
        fees: round(trade.fees),
        triggerType,
      });
    this.markOpenPositions(now);
    return true;
  }

  markOpenPositions(now) {
    for (const trade of this.trades) {
      if (trade.status !== 'OPEN') continue;
      const quote = trade.windowStart === this.windowStart ? this.quotes[trade.side] : null;
      if (!this.quoteIsFresh(quote, now) || !Number.isFinite(quote.bestBid)) {
        trade.markPrice = null;
        trade.markValue = null;
        trade.unrealizedPnl = null;
        continue;
      }
      trade.markPrice = quote.bestBid;
      trade.markValue = trade.shares * quote.bestBid;
      trade.unrealizedPnl = trade.markValue - trade.totalCost;
      trade.markAt = now;
    }
  }

  async resolveDue(now = this.now(), { force = false } = {}) {
    const pending = this.trades.filter(trade => trade.status === 'AWAITING_RESOLUTION');
    const marketIds = [...new Set(pending.map(trade => trade.marketId))];
    const due = marketIds.filter(marketId => !this.resolutionInFlight.has(marketId)
      && (force || now - (this.resolutionLastAttemptAt.get(marketId) || 0) >= this.config.RESOLUTION_POLL_MS));
    await Promise.all(due.map(async marketId => {
      this.resolutionInFlight.add(marketId);
      this.resolutionLastAttemptAt.set(marketId, now);
      try {
        const market = await this.marketData.getMarket(marketId);
        for (const trade of this.trades) {
          if (trade.status !== 'AWAITING_RESOLUTION' || trade.marketId !== marketId) continue;
          const payout = resolvedPayout(market, trade);
          trade.settlementLastCheckedAt = now;
          if (payout == null) {
            trade.settlementStatus = 'AWAITING_SETTLEMENT';
            trade.settlementError = 'The original Polymarket market is not confirmed resolved yet.';
            continue;
          }
          const proceeds = trade.shares * payout;
          trade.status = 'SETTLED';
          trade.settlementStatus = 'SETTLED';
          trade.settlementError = null;
          trade.finalOutcome = 'MARKET_RESOLUTION';
          trade.resolutionPayout = payout;
          trade.proceeds = proceeds;
          trade.realizedPnl = proceeds - trade.totalCost;
          trade.settledAt = now;
          trade.outcome = payout === 1 ? 'WIN' : 'LOSS';
          this.cash = round(this.cash + proceeds, 8);
          this.realizedPnl += trade.realizedPnl;
          this.log('POSITION_RESOLVED',
            `BTC ${trade.side} settled from its exact original market: ${trade.outcome.toLowerCase()}.`,
            { tradeId: trade.id, marketId, payout, realizedPnl: round(trade.realizedPnl) });
        }
      } catch (error) {
        for (const trade of this.trades) {
          if (trade.status === 'AWAITING_RESOLUTION' && trade.marketId === marketId) {
            trade.settlementStatus = 'AWAITING_SETTLEMENT';
            trade.settlementError = error?.message || 'Resolution check failed.';
            trade.settlementLastCheckedAt = now;
          }
        }
      } finally {
        this.resolutionInFlight.delete(marketId);
      }
    }));
  }

  maybeResolve(now) {
    if (now - this.lastResolutionCheckAt < this.config.RESOLUTION_POLL_MS) return;
    this.lastResolutionCheckAt = now;
    void this.resolveDue(now);
  }

  async tick() {
    if (this.tickInProgress) return this.snapshot();
    this.tickInProgress = true;
    const now = this.now();
    try {
      const currentStart = Math.floor(now / this.config.WINDOW_MS) * this.config.WINDOW_MS;
      this.resetWindow(currentStart);
      await this.refreshMarket(now);
      this.markOpenPositions(now);
      this.maybeResolve(now);
      if (!this.error) {
        this.statusReason = this.market
          ? `BTC 5-minute market active; WebSocket ${this.websocket.status.toLowerCase()}.`
          : this.statusReason;
      }
      return this.snapshot();
    } catch (error) {
      this.error = error?.message || 'BTC price-band scan failed.';
      this.statusReason = 'Market scan paused; retrying automatically.';
      this.log('SCAN_ERROR', this.error);
      return this.snapshot();
    } finally {
      this.tickInProgress = false;
    }
  }

  inventoryBoxSnapshot(trades, selector) {
    return groupInventory(trades, selector);
  }

  quoteSnapshot(side, now) {
    const quote = this.quotes[side];
    if (!quote) {
      return { side, status: 'WAITING', bestAsk: null, bestBid: null, updatedAt: null, ageMs: null };
    }
    const ageMs = Math.max(0, now - quote.updatedAt);
    return {
      ...quote,
      status: ageMs <= this.config.MAX_QUOTE_AGE_MS ? 'LIVE' : 'STALE',
      ageMs,
    };
  }

  snapshot() {
    const now = this.now();
    this.markOpenPositions(now);
    const open = this.trades.filter(trade => trade.status === 'OPEN');
    const pending = this.trades.filter(trade => trade.status === 'AWAITING_RESOLUTION');
    const settled = this.trades.filter(trade => trade.status === 'SETTLED');
    const marked = this.trades.filter(trade =>
      ['OPEN', 'AWAITING_RESOLUTION'].includes(trade.status) && trade.markValue != null);
    const markedValue = marked.reduce((sum, trade) => sum + trade.markValue, 0);
    const unrealizedPnl = marked.reduce((sum, trade) => sum + trade.unrealizedPnl, 0);
    const account = {
      startingCapital: this.startingCapital,
      cash: round(this.cash, 2),
      openCost: round(open.reduce((sum, trade) => sum + trade.totalCost, 0), 2),
      realizedPnl: round(this.realizedPnl, 2),
      unrealizedPnl: round(unrealizedPnl, 2),
      markedValue: round(markedValue, 2),
      equity: round(this.cash + markedValue, 2),
      openPositions: open.length,
      pendingResolutionPositions: pending.length,
      settledPositions: settled.length,
      wins: settled.filter(trade => trade.outcome === 'WIN').length,
      losses: settled.filter(trade => trade.outcome === 'LOSS').length,
      takerFees: round(this.trades.reduce((sum, trade) => sum + trade.fees, 0), 2),
      unmarkedPositions: open.length + pending.length - marked.length,
    };
    const currentWindowTrades = this.trades.filter(trade =>
      trade.status === 'OPEN' && trade.windowStart === this.windowStart);
    const pendingTrades = this.trades.filter(trade => trade.status === 'AWAITING_RESOLUTION');
    const windowSeconds = this.windowEnd == null ? null : Math.max(0, (this.windowEnd - now) / 1000);
    return {
      mode: 'PAPER ONLY',
      running: this.running,
      now,
      lastUpdateAt: now,
      status: this.error ? 'WARNING' : this.running ? 'RUNNING' : 'STOPPED',
      statusReason: this.statusReason,
      error: this.error,
      strategy: {
        version: this.config.STRATEGY_VERSION,
        timeframe: '5m',
        assets: ['BTC'],
        startingCapital: this.startingCapital,
        sharesPerBuy: this.config.SHARES_PER_BUY,
        minEntryAsk: this.config.MIN_ENTRY_ASK,
        maxEntryAsk: this.config.MAX_ENTRY_ASK,
        trigger: 'Each UP or DOWN best-ask price change into or within the inclusive price band.',
        orderType: 'PAPER TAKER SWEEP',
        intraWindowSales: false,
        settlement: 'Exact original BTC market resolution only',
        resolutionPollMs: this.config.RESOLUTION_POLL_MS,
        priceSource: 'Polymarket CLOB market WebSocket',
      },
      window: {
        start: this.windowStart,
        end: this.windowEnd,
        secondsRemaining: windowSeconds,
        slug: this.market?.slug || (this.windowStart == null ? null : `btc-updown-5m-${Math.floor(this.windowStart / 1000)}`),
      },
      market: this.market ? {
        id: this.market.id,
        slug: this.market.slug,
        title: this.market.title,
        start: this.market.start,
        end: this.market.end,
      } : null,
      quotes: {
        UP: this.quoteSnapshot('UP', now),
        DOWN: this.quoteSnapshot('DOWN', now),
      },
      websocket: {
        ...this.websocket,
        lastMessageAgeMs: this.websocket.lastMessageAt == null
          ? null : Math.max(0, now - this.websocket.lastMessageAt),
      },
      sideState: this.sideState,
      account,
      inventory: {
        currentWindow: this.inventoryBoxSnapshot(this.trades,
          trade => trade.status === 'OPEN' && trade.windowStart === this.windowStart),
        awaitingResolution: this.inventoryBoxSnapshot(this.trades,
          trade => trade.status === 'AWAITING_RESOLUTION'),
      },
      trades: this.trades.slice().sort((a, b) => b.openedAt - a.openedAt).slice(0, 200),
      events: this.events.slice(0, 80),
    };
  }
}

module.exports = {
  BtcPriceBandBot,
  normalizeLevels,
  groupInventory,
};
