'use strict';

const { BinanceTickFeed, CANDLE_MS } = require('./binance-tick-feed.cjs');
const marketDataDefault = require('./wick-market-data.js');
const { feeParameters, takerFeeAt } = require('./paper-trading.js');
const { resolvedPayout } = require('./position-exits.js');
const { normalizeLevels } = require('./btc-price-band-bot.cjs');

const EPSILON = 1e-8;
const DEFAULT_CONFIG = Object.freeze({
  STRATEGY_VERSION: 'btc-5m-binance-taker-sizing-profit-close-v2',
  WINDOW_MS: CANDLE_MS,
  STARTING_CAPITAL: 3_000,
  BASE_SHARES: 100,
  LOSS_SIZE_STEP_SHARES: 20,
  WIN_SIZE_REDUCTION_SHARES: 30,
  VOLATILITY_CANDLES: 3,
  MIN_NET_EDGE_PER_SHARE: 0.05,
  MIN_FLIP_NET_EDGE_PER_SHARE: 0.10,
  ENTRY_CONFIRMATION_UPDATES: 2,
  ENTRY_CONFIRMATION_MIN_INTERVAL_MS: 500,
  ENTRY_CONFIRMATION_MAX_INTERVAL_MS: 2_000,
  FLIP_CONFIRMATION_UPDATES: 2,
  FLIP_CONFIRMATION_MIN_INTERVAL_MS: 500,
  FLIP_CONFIRMATION_MAX_INTERVAL_MS: 2_000,
  MAX_FLIPS_PER_WINDOW: 1,
  MAX_DATA_AGE_MS: 2_000,
  POLL_INTERVAL_MS: 500,
  RESOLUTION_POLL_MS: 5_000,
  CRYPTO_MAKER_REBATE_SHARE: 0.20,
});

function round(value, digits = 6) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function timestamp(value, fallback = null) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalCdf(value) {
  if (!Number.isFinite(value)) return value > 0 ? 1 : 0;
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t)
    + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return Math.max(0, Math.min(1, 0.5 * (1 + sign * erf)));
}

function calculateVolatility(candles, candleCount = DEFAULT_CONFIG.VOLATILITY_CANDLES) {
  const sample = (Array.isArray(candles) ? candles : [])
    .filter(candle => candle?.closed !== false
      && Number.isFinite(Number(candle?.open))
      && Number.isFinite(Number(candle?.close))
      && Number(candle.open) > 0
      && Number(candle.close) > 0)
    .slice(-candleCount);
  if (sample.length !== candleCount) return null;
  const returns = sample.map(candle => Math.log(Number(candle.close) / Number(candle.open)));
  const variance = returns.reduce((sum, value) => sum + value ** 2, 0) / returns.length;
  const volatility = Math.sqrt(variance);
  return Number.isFinite(volatility) && volatility > 1e-10 ? volatility : null;
}

function estimateUpProbability({ currentPrice, windowOpenPrice, volatility5m, secondsRemaining }) {
  if (![currentPrice, windowOpenPrice, volatility5m, secondsRemaining]
    .every(value => Number.isFinite(Number(value)))
    || currentPrice <= 0 || windowOpenPrice <= 0 || volatility5m <= 0
    || secondsRemaining <= 0) return null;
  const remainingVolatility = volatility5m * Math.sqrt(
    Math.max(0, secondsRemaining) / (5 * 60),
  );
  if (!(remainingVolatility > 1e-10)) return null;
  const zScore = Math.log(currentPrice / windowOpenPrice) / remainingVolatility;
  return Math.max(0, Math.min(1, normalCdf(zScore)));
}

function emptyQuote(side) {
  return {
    side,
    bestAsk: null,
    askSize: 0,
    bestBid: null,
    bidSize: 0,
    updatedAt: null,
    sourceTimestamp: null,
    status: 'WAITING',
  };
}

function sideForToken(market, tokenId) {
  if (String(tokenId) === String(market?.tokens?.UP || '')) return 'UP';
  if (String(tokenId) === String(market?.tokens?.DOWN || '')) return 'DOWN';
  return null;
}

function normalizeBookLevels(levels, side) {
  return normalizeLevels(levels, side).map(level => ({
    ...level,
    availableSize: level.size,
  }));
}

class BtcMispricingBot {
  constructor(options = {}) {
    this.config = { ...DEFAULT_CONFIG, ...(options.config || {}) };
    this.now = options.now || Date.now;
    this.marketData = options.marketData || marketDataDefault;
    this.stateStore = options.stateStore || null;
    this.storageHealthy = !this.stateStore;
    this.persistenceStatus = this.stateStore ? 'NOT_STARTED' : 'DISABLED';
    this.priceFeed = options.priceFeed || new BinanceTickFeed({
      WebSocketImpl: options.WebSocketImpl,
      fetchImpl: options.fetchImpl,
      now: this.now,
      onUpdate: () => {
        void this.evaluate();
      },
    });
    if (options.priceFeed && typeof this.priceFeed === 'object') {
      this.priceFeed.onUpdate = () => {
        void this.evaluate();
      };
    }

    this.running = false;
    this.error = null;
    this.status = 'STARTING';
    this.statusReason = 'Starting Binance and Polymarket feeds.';
    this.startingCapital = this.config.STARTING_CAPITAL;
    this.cash = this.startingCapital;
    this.realizedPnl = 0;
    this.trades = [];
    this.events = [];
    this.tradeSequence = 0;
    this.orderSequence = 0;
    this.eventSequence = 0;
    this.nextEntryShares = this.config.BASE_SHARES;
    this.windowStart = null;
    this.windowEnd = null;
    this.market = null;
    this.books = new Map();
    this.quotes = { UP: emptyQuote('UP'), DOWN: emptyQuote('DOWN') };
    this.entryTriggeredThisWindow = false;
    this.pendingEntryOrder = null;
    this.entryConfirmation = { side: null, count: 0, lastTickAt: null };
    this.seenTradeEvents = [];
    this.flipsThisWindow = 0;
    this.flipConfirmation = { side: null, count: 0, lastTickAt: null };
    this.websocket = {
      status: 'WAITING',
      connectedAt: null,
      lastMessageAt: null,
      reconnectCount: 0,
      error: null,
    };
    this.marketStream = null;
    this.streamGeneration = 0;
    this.marketLoadInProgress = false;
    this.nextMarketLoadAt = 0;
    this.timer = null;
    this.persistenceTimer = null;
    this.persistInFlight = Promise.resolve();
    this.tickInProgress = false;
    this.resolutionLastAttemptAt = new Map();
    this.resolutionInFlight = new Set();
    this.lastResolvePollAt = 0;
    this.lastEvaluationSignature = null;
    this.currentSignal = {
      side: null,
      reason: 'Waiting for three closed Binance 5-minute candles and live prices.',
      edgePerShare: null,
    };
  }

  async start() {
    if (this.running) return this.snapshot();
    this.running = true;
    try {
      if (this.stateStore) {
        this.persistenceStatus = 'CONNECTING';
        await this.stateStore.initialize();
        const saved = await this.stateStore.loadState();
        if (saved) this.restoreState(saved);
        this.storageHealthy = true;
        this.persistenceStatus = 'CONNECTED';
      }
      await this.priceFeed.start?.();
      await this.tick();
      this.timer = setInterval(() => {
        void this.tick();
      }, this.config.POLL_INTERVAL_MS);
      this.timer.unref?.();
      this.status = 'RUNNING';
      this.schedulePersist(true);
    } catch (error) {
      this.error = error?.message || 'Mispricing bot failed to start.';
      this.status = 'ERROR';
      this.statusReason = 'Trading is paused until its feeds and paper ledger are ready.';
      if (this.stateStore) {
        this.storageHealthy = false;
        this.persistenceStatus = 'ERROR';
      }
    }
    return this.snapshot();
  }

  stop() {
    this.running = false;
    clearInterval(this.timer);
    clearTimeout(this.persistenceTimer);
    this.timer = null;
    this.persistenceTimer = null;
    this.closeMarketStream();
    this.priceFeed.stop?.();
    this.status = 'STOPPED';
  }

  restoreState(state) {
    this.startingCapital = Number(state.startingCapital) || this.config.STARTING_CAPITAL;
    this.cash = Number.isFinite(Number(state.cash)) ? Number(state.cash) : this.startingCapital;
    this.realizedPnl = Number(state.realizedPnl) || 0;
    this.trades = Array.isArray(state.trades) ? state.trades : [];
    this.events = Array.isArray(state.events) ? state.events.slice(0, 300) : [];
    this.tradeSequence = Math.max(
      Number(state.tradeSequence) || 0,
      ...this.trades.map(trade => {
        const match = String(trade.id || '').match(/^misprice-trade-(\d+)$/);
        return match ? Number(match[1]) : 0;
      }),
    );
    this.orderSequence = Math.max(0, Number(state.orderSequence) || 0);
    this.eventSequence = Math.max(
      Number(state.eventSequence) || 0,
      ...this.events.map(event => {
        const match = String(event.id || '').match(/^misprice-event-(\d+)$/);
        return match ? Number(match[1]) : 0;
      }),
    );
    const savedNextShares = Number(state.nextEntryShares);
    this.nextEntryShares = Number.isFinite(savedNextShares)
      ? Math.max(this.config.BASE_SHARES, Math.floor(savedNextShares))
      : this.config.BASE_SHARES;
    this.windowStart = Number.isFinite(Number(state.windowStart))
      ? Number(state.windowStart) : null;
    this.windowEnd = this.windowStart == null ? null : this.windowStart + this.config.WINDOW_MS;
    this.entryTriggeredThisWindow = state.entryTriggeredThisWindow === true;
    // Passive paper orders from the previous strategy are canceled on restore.
    this.pendingEntryOrder = null;
    this.entryConfirmation = { side: null, count: 0, lastTickAt: null };
    this.seenTradeEvents = Array.isArray(state.seenTradeEvents)
      ? state.seenTradeEvents.slice(-2_000) : [];
    this.flipsThisWindow = Math.max(0, Number(state.flipsThisWindow) || 0);
    this.market = null;
    this.books.clear();
    this.quotes = { UP: emptyQuote('UP'), DOWN: emptyQuote('DOWN') };
    this.statusReason = 'Restored the separate mispricing paper ledger.';
  }

  persistentStateSnapshot() {
    return {
      schemaVersion: 2,
      strategyVersion: this.config.STRATEGY_VERSION,
      startingCapital: this.startingCapital,
      cash: this.cash,
      realizedPnl: this.realizedPnl,
      trades: this.trades,
      events: this.events,
      tradeSequence: this.tradeSequence,
      orderSequence: this.orderSequence,
      eventSequence: this.eventSequence,
      nextEntryShares: this.nextEntryShares,
      windowStart: this.windowStart,
      entryTriggeredThisWindow: this.entryTriggeredThisWindow,
      pendingEntryOrder: this.pendingEntryOrder,
      seenTradeEvents: this.seenTradeEvents.slice(-2_000),
      flipsThisWindow: this.flipsThisWindow,
    };
  }

  schedulePersist(force = false) {
    if (!this.stateStore || !this.storageHealthy) return;
    clearTimeout(this.persistenceTimer);
    if (force) {
      void this.persist();
      return;
    }
    this.persistenceTimer = setTimeout(() => {
      this.persistenceTimer = null;
      void this.persist();
    }, 250);
    this.persistenceTimer.unref?.();
  }

  async persist() {
    if (!this.stateStore || !this.storageHealthy) return false;
    const snapshot = this.persistentStateSnapshot();
    this.persistInFlight = this.persistInFlight
      .catch(() => {})
      .then(() => this.stateStore.saveState(snapshot));
    try {
      await this.persistInFlight;
      this.persistenceStatus = 'CONNECTED';
      return true;
    } catch (error) {
      this.storageHealthy = false;
      this.persistenceStatus = 'ERROR';
      this.error = error?.message || 'Could not save the mispricing paper ledger.';
      this.statusReason = 'Trading paused because the mispricing paper ledger is unavailable.';
      this.status = 'ERROR';
      return false;
    }
  }

  log(type, message, details = {}) {
    const event = {
      id: `misprice-event-${++this.eventSequence}`,
      at: this.now(),
      type,
      message,
      ...details,
    };
    this.events.unshift(event);
    if (this.events.length > 300) this.events.length = 300;
    return event;
  }

  closeMarketStream() {
    this.streamGeneration += 1;
    try {
      this.marketStream?.close?.();
    } catch {
      // Closing an old market stream must not prevent the next market from loading.
    }
    this.marketStream = null;
  }

  async resetWindow(start) {
    if (this.windowStart === start) return;
    const previousStart = this.windowStart;
    if (this.pendingEntryOrder && this.pendingEntryOrder.windowStart < start) {
      this.cancelPendingEntryOrder(
        'The 5-minute window ended before the passive order filled.',
        this.now(),
      );
    }
    if (previousStart != null) {
      let moved = 0;
      for (const trade of this.trades) {
        if (trade.status === 'OPEN' && trade.windowStart < start) {
          trade.status = 'AWAITING_RESOLUTION';
          trade.settlementStatus = 'AWAITING_SETTLEMENT';
          trade.awaitingResolutionAt = this.now();
          moved += 1;
        }
      }
      if (moved) {
        this.log('WINDOW_EXPIRED',
          `${moved} position(s) are waiting for the exact original Polymarket market to resolve.`,
          { previousWindowStart: previousStart, positions: moved });
      }
    }
    this.closeMarketStream();
    this.windowStart = start;
    this.windowEnd = start + this.config.WINDOW_MS;
    this.market = null;
    this.books.clear();
    this.quotes = { UP: emptyQuote('UP'), DOWN: emptyQuote('DOWN') };
    this.entryTriggeredThisWindow = false;
    this.resetEntryConfirmation();
    this.flipsThisWindow = 0;
    this.resetFlipConfirmation();
    this.lastEvaluationSignature = null;
    this.schedulePersist(true);
    await this.loadMarket(start);
  }

  async loadMarket(start) {
    if (this.marketLoadInProgress || this.now() < this.nextMarketLoadAt) return false;
    this.marketLoadInProgress = true;
    try {
      const market = await this.marketData.getBtcMarket(start, this.config.WINDOW_MS);
      if (!market || Number(market.start) !== start
        || !market.tokens?.UP || !market.tokens?.DOWN) {
        throw new Error('The current Polymarket BTC 5-minute market is unavailable.');
      }
      this.market = market;
      await Promise.all(['UP', 'DOWN'].map(async side => {
        const book = await this.marketData.getBook(market.tokens[side]);
        this.applyBookSnapshot({
          asset_id: market.tokens[side],
          bids: book?.bids,
          asks: book?.asks,
          timestamp: this.now(),
        }, this.now());
      }));
      this.startMarketStream(market);
      this.error = null;
      this.statusReason = 'Polymarket market loaded; waiting for fresh Binance and CLOB data.';
      this.nextMarketLoadAt = 0;
      return true;
    } catch (error) {
      this.error = error?.message || 'Could not load the current BTC market.';
      this.statusReason = 'Waiting for the current BTC market and order books.';
      this.status = this.storageHealthy ? 'WAITING' : 'ERROR';
      this.market = null;
      this.nextMarketLoadAt = this.now() + 5_000;
      return false;
    } finally {
      this.marketLoadInProgress = false;
    }
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
        onStatus: update => {
          if (generation !== this.streamGeneration) return;
          this.websocket = { ...this.websocket, ...update };
          if (update.status === 'CONNECTED') this.websocket.connectedAt = this.now();
        },
        onMessage: event => {
          if (generation !== this.streamGeneration) return;
          this.handleMarketMessage(event);
        },
      },
    );
  }

  handleMarketMessage(event) {
    if (Array.isArray(event)) {
      for (const item of event) this.handleMarketMessage(item);
      return;
    }
    if (!event || typeof event !== 'object') return;
    const payload = event.payload && typeof event.payload === 'object'
      ? { ...event, ...event.payload }
      : event;
    const type = event.event_type || event.eventType || event.type;
    if (!type || type === 'PONG') return;
    this.websocket.lastMessageAt = this.now();
    this.websocket.error = null;
    if (type === 'book') this.applyBookSnapshot(payload, this.now());
    else if (type === 'price_change') this.applyPriceChanges(payload, this.now());
    else if (type === 'best_bid_ask') this.applyBestBidAsk(payload, this.now());
    void this.evaluate();
  }

  applyBookSnapshot(event, now) {
    const tokenId = String(event.asset_id || event.assetId || '');
    const side = sideForToken(this.market, tokenId);
    if (!side) return false;
    const bids = normalizeBookLevels(event.bids, 'bids');
    const asks = normalizeBookLevels(event.asks, 'asks');
    const book = {
      bids,
      asks,
      updatedAt: now,
      sourceTimestamp: timestamp(event.timestamp, now),
    };
    this.books.set(tokenId, book);
    this.updateQuoteFromBook(side, tokenId, book, now);
    return true;
  }

  applyPriceChanges(event, now) {
    const changes = Array.isArray(event.price_changes)
      ? event.price_changes
      : Array.isArray(event.priceChanges) ? event.priceChanges : [];
    for (const change of changes) {
      const tokenId = String(change.asset_id || change.assetId || '');
      const side = sideForToken(this.market, tokenId);
      const book = this.books.get(tokenId);
      if (!side || !book) continue;
      this.applyLevelChange(book, change);
      book.updatedAt = now;
      book.sourceTimestamp = timestamp(event.timestamp, now);
      this.updateQuoteFromBook(side, tokenId, book, now);
    }
  }

  applyLevelChange(book, change) {
    const price = Number(change.price);
    const size = Number(change.size);
    if (!(price > 0 && price < 1) || !Number.isFinite(size)) return;
    const side = String(change.side || '').toUpperCase();
    const asks = side === 'SELL' || side === 'ASK' || side === 'ASKS';
    const bids = side === 'BUY' || side === 'BID' || side === 'BIDS';
    const levels = asks ? book.asks : bids ? book.bids : null;
    if (!levels) return;
    const index = levels.findIndex(level => Math.abs(level.price - price) < EPSILON);
    if (size <= 0) {
      if (index >= 0) levels.splice(index, 1);
      return;
    }
    if (index >= 0) {
      levels[index].size = size;
      levels[index].availableSize = size;
    } else {
      levels.push({ price, size, availableSize: size });
    }
    levels.sort((left, right) => asks
      ? left.price - right.price : right.price - left.price);
  }

  applyBestBidAsk(event, now) {
    const tokenId = String(event.asset_id || event.assetId || '');
    const side = sideForToken(this.market, tokenId);
    if (!side) return;
    const previous = this.quotes[side];
    const bestAsk = Number(event.best_ask ?? event.bestAsk);
    const bestBid = Number(event.best_bid ?? event.bestBid);
    this.quotes[side] = {
      ...previous,
      bestAsk: Number.isFinite(bestAsk) ? bestAsk : previous.bestAsk,
      bestBid: Number.isFinite(bestBid) ? bestBid : previous.bestBid,
      updatedAt: now,
      sourceTimestamp: timestamp(event.timestamp, now),
      status: 'LIVE',
    };
  }

  updateQuoteFromBook(side, tokenId, book, now) {
    const ask = book.asks[0] || null;
    const bid = book.bids[0] || null;
    this.quotes[side] = {
      side,
      tokenId,
      bestAsk: ask?.price ?? null,
      askSize: ask?.availableSize ?? 0,
      bestBid: bid?.price ?? null,
      bidSize: bid?.availableSize ?? 0,
      updatedAt: now,
      sourceTimestamp: book.sourceTimestamp,
      status: 'LIVE',
    };
  }

  sideQuoteIsFresh(side, now) {
    const quote = this.quotes[side];
    const book = this.books.get(String(this.market?.tokens?.[side] || ''));
    return quote?.status === 'LIVE'
      && Number.isFinite(quote.updatedAt)
      && now >= quote.updatedAt
      && now - quote.updatedAt <= this.config.MAX_DATA_AGE_MS
      && Number.isFinite(book?.updatedAt)
      && now >= book.updatedAt
      && now - book.updatedAt <= this.config.MAX_DATA_AGE_MS;
  }

  resetEntryConfirmation() {
    this.entryConfirmation = { side: null, count: 0, lastTickAt: null };
  }

  recordEntryConfirmation(side, model, now) {
    const tickAt = timestamp(model?.tickAt, null);
    if (tickAt == null || tickAt > now || now - tickAt > this.config.MAX_DATA_AGE_MS) {
      this.resetEntryConfirmation();
      return { confirmed: false, count: 0 };
    }
    const current = this.entryConfirmation;
    const elapsed = current.lastTickAt == null ? null : tickAt - current.lastTickAt;
    if (current.side !== side || elapsed == null || elapsed < 0
      || elapsed > this.config.ENTRY_CONFIRMATION_MAX_INTERVAL_MS) {
      this.entryConfirmation = { side, count: 1, lastTickAt: tickAt };
    } else if (elapsed >= this.config.ENTRY_CONFIRMATION_MIN_INTERVAL_MS) {
      this.entryConfirmation = {
        side,
        count: Math.min(this.config.ENTRY_CONFIRMATION_UPDATES, current.count + 1),
        lastTickAt: tickAt,
      };
    }
    return {
      confirmed: this.entryConfirmation.count >= this.config.ENTRY_CONFIRMATION_UPDATES,
      count: this.entryConfirmation.count,
    };
  }

  passiveBidQuote(side, now = this.now()) {
    if (!this.sideQuoteIsFresh(side, now)) return null;
    const quote = this.quotes[side];
    const book = this.books.get(String(this.market?.tokens?.[side] || ''));
    const bid = book?.bids?.[0];
    const ask = book?.asks?.[0];
    if (!bid || !ask
      || !Number.isFinite(bid.price) || bid.price <= 0 || bid.price >= 1
      || !Number.isFinite(ask.price) || ask.price <= bid.price + EPSILON
      || Math.abs(bid.price - quote.bestBid) >= EPSILON
      || Math.abs(ask.price - quote.bestAsk) >= EPSILON) return null;
    return {
      limitPrice: bid.price,
      queueAheadShares: Math.max(0, Number(bid.availableSize) || 0),
      bestAsk: ask.price,
    };
  }

  cancelPendingEntryOrder(reason, now = this.now()) {
    const order = this.pendingEntryOrder;
    if (!order) return false;
    order.status = order.filledShares > 0 ? 'PARTIALLY_FILLED_CANCELLED' : 'CANCELLED';
    order.cancelledAt = now;
    order.cancelReason = reason;
    this.log('MAKER_ORDER_CANCELLED', reason, {
      orderId: order.id,
      side: order.side,
      limitPrice: order.limitPrice,
      filledShares: order.filledShares,
      remainingShares: order.remainingShares,
    });
    this.pendingEntryOrder = null;
    this.schedulePersist(true);
    return true;
  }

  placeMakerEntryOrder(side, model, now, entryReason, edgePerShare) {
    const passive = this.passiveBidQuote(side, now);
    if (!passive) {
      this.currentSignal = {
        side,
        reason: 'No safe post-only bid is available; the bot will not cross the spread.',
        edgePerShare,
      };
      return false;
    }
    const shares = this.nextEntryShares;
    const estimatedCost = shares * passive.limitPrice;
    if (estimatedCost > this.cash + EPSILON) {
      this.currentSignal = {
        side,
        reason: `The ${side} signal qualifies, but available paper cash cannot fund ${shares} shares at the passive bid.`,
        edgePerShare,
      };
      return false;
    }
    const order = {
      id: `misprice-order-${++this.orderSequence}`,
      side,
      marketId: String(this.market.id),
      tokenId: String(this.market.tokens[side]),
      marketSlug: this.market.slug,
      windowStart: this.windowStart,
      windowEnd: this.windowEnd,
      limitPrice: passive.limitPrice,
      targetShares: shares,
      filledShares: 0,
      remainingShares: shares,
      queueAheadShares: passive.queueAheadShares,
      estimatedCost,
      estimatedEdgePerShare: edgePerShare,
      modelProbability: side === 'UP' ? model.probabilityUp : model.probabilityDown,
      modelPriceAtEntry: model.currentPrice,
      entryReason,
      postOnly: true,
      status: 'RESTING',
      postedAt: now,
    };
    this.pendingEntryOrder = order;
    this.entryTriggeredThisWindow = true;
    this.resetEntryConfirmation();
    this.currentSignal = {
      side,
      reason: `Post-only ${side} bid resting at $${passive.limitPrice.toFixed(2)}; waiting for a sell trade to fill it.`,
      edgePerShare,
    };
    this.log('MAKER_ORDER_PLACED',
      `Posted a post-only ${shares}-share ${side} buy at $${passive.limitPrice.toFixed(2)}; no taker entry fee applies if it fills as maker.`,
      {
        orderId: order.id,
        side,
        limitPrice: order.limitPrice,
        targetShares: order.targetShares,
        queueAheadShares: round(order.queueAheadShares, 4),
        estimatedCost: round(order.estimatedCost, 4),
        estimatedEdgePerShare: round(edgePerShare, 4),
        postOnly: true,
      });
    this.schedulePersist(true);
    return true;
  }

  recordMakerFill(order, shares, now, transactionHash = null) {
    const filledShares = Math.min(
      Math.max(0, Number(shares) || 0),
      Math.max(0, Number(order.remainingShares) || 0),
    );
    if (filledShares <= EPSILON) return false;
    const grossCost = filledShares * order.limitPrice;
    const makerFee = 0;
    const estimatedRebate = takerFeeAt(
      order.limitPrice,
      filledShares,
      feeParameters(this.market),
    ) * this.config.CRYPTO_MAKER_REBATE_SHARE;
    let trade = order.tradeId
      ? this.trades.find(item => item.id === order.tradeId)
      : null;
    if (!trade) {
      trade = {
        id: `misprice-trade-${++this.tradeSequence}`,
        asset: 'BTC',
        side: order.side,
        marketId: order.marketId,
        marketSlug: order.marketSlug,
        marketTitle: this.market?.title || order.marketSlug,
        tokenId: order.tokenId,
        windowStart: order.windowStart,
        windowEnd: order.windowEnd,
        shares: 0,
        entryPrice: order.limitPrice,
        totalCost: 0,
        grossCost: 0,
        fees: 0,
        fills: [],
        openedAt: now,
        modelProbability: order.modelProbability,
        modelPriceAtEntry: order.modelPriceAtEntry,
        expectedEdgePerShare: order.estimatedEdgePerShare,
        entryReason: order.entryReason,
        entryOrderId: order.id,
        executionRole: 'MAKER',
        estimatedMakerRebate: 0,
        status: 'OPEN',
        settlementStatus: 'OPEN',
        markPrice: null,
        markValue: null,
        unrealizedPnl: null,
        realizedPnl: null,
        outcome: null,
      };
      this.trades.push(trade);
      order.tradeId = trade.id;
    }
    trade.shares += filledShares;
    trade.grossCost += grossCost;
    trade.totalCost += grossCost + makerFee;
    trade.entryPrice = trade.grossCost / trade.shares;
    trade.fees += makerFee;
    trade.estimatedMakerRebate += estimatedRebate;
    trade.fills.push({
      price: order.limitPrice,
      shares: filledShares,
      gross: grossCost,
      fee: makerFee,
      role: 'MAKER',
      transactionHash,
      at: now,
    });
    this.cash = round(this.cash - grossCost - makerFee, 8);
    order.filledShares += filledShares;
    order.remainingShares = Math.max(0, order.targetShares - order.filledShares);
    order.lastFillAt = now;
    order.status = order.remainingShares <= EPSILON ? 'FILLED' : 'PARTIALLY_FILLED';
    this.log('MAKER_BUY_FILLED',
      `Filled ${round(filledShares, 4)} ${order.side} shares at the resting $${order.limitPrice.toFixed(2)} bid; entry fee $0, estimated rebate $${round(estimatedRebate, 4)}.`,
      {
        orderId: order.id,
        tradeId: trade.id,
        side: order.side,
        shares: round(filledShares, 4),
        averagePrice: round(trade.entryPrice),
        totalCost: round(grossCost, 4),
        entryFee: 0,
        estimatedMakerRebate: round(estimatedRebate, 4),
        remainingShares: round(order.remainingShares, 4),
      });
    if (order.remainingShares <= EPSILON) {
      order.status = 'FILLED';
      order.filledAt = now;
      this.pendingEntryOrder = null;
    }
    this.schedulePersist(true);
    return true;
  }

  applyLastTradePrice(event, now) {
    const order = this.pendingEntryOrder;
    if (!order || order.windowStart !== this.windowStart
      || String(event.asset_id || event.assetId || '') !== order.tokenId
      || String(event.side || '').toUpperCase() !== 'SELL') return false;
    const price = Number(event.price);
    const size = Number(event.size);
    const tradeAt = timestamp(event.timestamp, now);
    if (!Number.isFinite(price) || price <= 0 || price >= 1
      || !Number.isFinite(size) || size <= 0
      || tradeAt < order.postedAt || tradeAt > now + 1_000) return false;
    const txHash = event.transaction_hash || event.transactionHash || event.hash || null;
    const eventKey = txHash
      ? `${order.tokenId}:${txHash}:${tradeAt}:${price}:${size}`
      : `${order.tokenId}:${tradeAt}:${price}:${size}:${String(event.side).toUpperCase()}`;
    if (this.seenTradeEvents.includes(eventKey)) return false;
    this.seenTradeEvents.push(eventKey);
    if (this.seenTradeEvents.length > 2_000) {
      this.seenTradeEvents.splice(0, this.seenTradeEvents.length - 2_000);
    }
    if (price > order.limitPrice + EPSILON) return false;

    let executableShares = size;
    if (price + EPSILON >= order.limitPrice) {
      const queueConsumed = Math.min(order.queueAheadShares, executableShares);
      order.queueAheadShares = Math.max(0, order.queueAheadShares - queueConsumed);
      executableShares -= queueConsumed;
    } else {
      // A print below the resting limit means the order was traded through.
      order.queueAheadShares = 0;
    }
    if (executableShares <= EPSILON) return false;
    return this.recordMakerFill(order, executableShares, now, txHash);
  }

  modelSnapshot(now = this.now()) {
    const feed = this.priceFeed.snapshot?.() || {};
    const candles = (feed.candles || []).slice(-this.config.VOLATILITY_CANDLES);
    const volatility5m = calculateVolatility(candles, this.config.VOLATILITY_CANDLES);
    const currentCandle = feed.currentCandle;
    const windowOpenPrice = currentCandle
      && Number(currentCandle.start) === this.windowStart
      ? Number(currentCandle.open) : null;
    const secondsRemaining = this.windowEnd == null
      ? null : Math.max(0, (this.windowEnd - now) / 1000);
    const tickFresh = feed.status === 'CONNECTED'
      && Number.isFinite(feed.tickAt)
      && now >= feed.tickAt
      && now - feed.tickAt <= this.config.MAX_DATA_AGE_MS;
    const historyReady = feed.historyStatus === 'READY'
      && candles.length === this.config.VOLATILITY_CANDLES
      && volatility5m != null;
    const dataReady = tickFresh && historyReady && windowOpenPrice > 0
      && secondsRemaining > 0;
    const probabilityUp = dataReady ? estimateUpProbability({
      currentPrice: Number(feed.price),
      windowOpenPrice,
      volatility5m,
      secondsRemaining,
    }) : null;
    let reason = 'Waiting for Binance tick and three closed 5-minute candles.';
    if (feed.status !== 'CONNECTED' || !tickFresh) reason = 'Waiting for a fresh Binance trade tick.';
    else if (!historyReady) reason = 'Waiting for three completed Binance 5-minute candles.';
    else if (!(windowOpenPrice > 0)) reason = 'Waiting for the Binance price at this window open.';
    else if (secondsRemaining <= 0) reason = 'This 5-minute window has ended.';
    else if (probabilityUp != null) reason = 'Fair probabilities are estimated from Binance price, time remaining, and the last three closed candles.';
    return {
      ready: dataReady && probabilityUp != null,
      reason,
      currentPrice: Number.isFinite(Number(feed.price)) ? Number(feed.price) : null,
      tickAt: feed.tickAt ?? null,
      tickAgeMs: feed.tickAgeMs ?? null,
      windowOpenPrice: Number.isFinite(windowOpenPrice) ? windowOpenPrice : null,
      secondsRemaining,
      volatility5m,
      volatilityCandles: candles.map(candle => ({
        start: candle.start,
        open: candle.open,
        close: candle.close,
        logReturn: Number.isFinite(Number(candle.logReturn))
          ? Number(candle.logReturn)
          : Math.log(Number(candle.close) / Number(candle.open)),
      })),
      probabilityUp,
      probabilityDown: probabilityUp == null ? null : 1 - probabilityUp,
    };
  }

  sweep(side, bookSide, requestedShares, { consume = false } = {}) {
    if (!this.market || !this.sideQuoteIsFresh(side, this.now())) return null;
    const tokenId = String(this.market.tokens[side]);
    const book = this.books.get(tokenId);
    const quote = this.quotes[side];
    const levels = book?.[bookSide];
    if (!Array.isArray(levels)) return null;
    const bestPrice = levels[0]?.price ?? null;
    const quotedPrice = bookSide === 'asks' ? quote.bestAsk : quote.bestBid;
    if (bestPrice == null || quotedPrice == null
      || Math.abs(bestPrice - quotedPrice) >= EPSILON) return null;
    const fees = feeParameters(this.market);
    let remaining = requestedShares;
    let gross = 0;
    let feeTotal = 0;
    const fills = [];
    for (const level of levels) {
      if (remaining <= EPSILON) break;
      const shares = Math.min(remaining, Math.max(0, Number(level.availableSize) || 0));
      if (shares <= EPSILON) continue;
      const cost = shares * level.price;
      const fee = takerFeeAt(level.price, shares, fees);
      fills.push({ level, price: level.price, shares, gross: cost, fee });
      gross += cost;
      feeTotal += fee;
      remaining -= shares;
    }
    const complete = remaining <= EPSILON;
    if (complete && consume) {
      for (const fill of fills) fill.level.availableSize -= fill.shares;
    }
    const shares = requestedShares - remaining;
    return {
      side,
      bookSide,
      requestedShares,
      shares,
      remainingShares: Math.max(0, remaining),
      gross,
      fees: feeTotal,
      totalCost: bookSide === 'asks' ? gross + feeTotal : null,
      netProceeds: bookSide === 'bids' ? gross - feeTotal : null,
      averagePrice: gross / Math.max(EPSILON, shares),
      complete,
      fills: fills.map(({ level, ...fill }) => fill),
    };
  }

  currentOpenTrade() {
    return this.trades.find(trade => trade.status === 'OPEN'
      && trade.windowStart === this.windowStart
      && trade.marketId === String(this.market?.id)) || null;
  }

  pendingOrderEdge(model, order = this.pendingEntryOrder) {
    if (!order || !model?.ready) return null;
    const probability = order.side === 'UP' ? model.probabilityUp : model.probabilityDown;
    return Number.isFinite(Number(probability))
      ? Number(probability) - Number(order.limitPrice)
      : null;
  }

  pendingOrderInvalidReason(model, now) {
    const order = this.pendingEntryOrder;
    if (!order) return null;
    if (now >= this.windowEnd || order.windowStart !== this.windowStart) {
      return 'The market window ended before the passive order filled.';
    }
    const passive = this.passiveBidQuote(order.side, now);
    const edgePerShare = this.pendingOrderEdge(model, order);
    if (!model.ready || !passive || edgePerShare == null
      || edgePerShare < this.config.MIN_NET_EDGE_PER_SHARE) {
      return 'The Binance signal, Polymarket book, or minimum edge filter no longer qualifies.';
    }
    if (passive.bestAsk <= order.limitPrice + EPSILON) {
      return 'The ask reached the limit without a matching sell trade print; canceled rather than inventing a fill.';
    }
    return null;
  }

  evaluatePendingEntryOrder(model, now) {
    const order = this.pendingEntryOrder;
    if (!order) return false;
    const edgePerShare = this.pendingOrderEdge(model, order);
    const invalidReason = this.pendingOrderInvalidReason(model, now);
    if (invalidReason) {
      this.cancelPendingEntryOrder(invalidReason, now);
      this.currentSignal = {
        side: order.side,
        reason: 'The resting maker order was canceled because its entry filters no longer pass.',
        edgePerShare,
      };
      return false;
    }
    this.currentSignal = {
      side: order.side,
      reason: `Post-only order resting at $${order.limitPrice.toFixed(2)}; ${round(order.queueAheadShares, 2)} shares estimated ahead in queue.`,
      edgePerShare,
    };
    return false;
  }

  evaluate(now = this.now()) {
    if (!this.market || this.windowStart == null || !this.storageHealthy) return false;
    const model = this.modelSnapshot(now);
    this.model = model;
    if (!model.ready) {
      this.resetFlipConfirmation();
      this.currentSignal = {
        side: null,
        reason: model.reason,
        edgePerShare: null,
      };
      return false;
    }
    const openTrade = this.currentOpenTrade();
    if (openTrade) return this.evaluateFlip(openTrade, model, now);
    if (this.entryTriggeredThisWindow || now >= this.windowEnd) return false;
    const shares = this.nextEntryShares;
    const candidates = ['UP', 'DOWN'].map(side => {
      if (!this.sideQuoteIsFresh(side, now)) return null;
      const preview = this.sweep(side, 'asks', shares);
      if (!preview?.complete) return null;
      const probability = side === 'UP' ? model.probabilityUp : model.probabilityDown;
      const expectedProfit = probability * shares - preview.totalCost;
      return {
        side,
        preview,
        expectedProfit,
        edgePerShare: expectedProfit / shares,
      };
    }).filter(candidate => candidate
      && candidate.edgePerShare >= this.config.MIN_NET_EDGE_PER_SHARE);
    if (!candidates.length) {
      this.currentSignal = {
        side: null,
        reason: 'No side clears the minimum net edge after visible ask-sweep costs and fees.',
        edgePerShare: null,
      };
      return false;
    }
    candidates.sort((left, right) => right.edgePerShare - left.edgePerShare);
    const selected = candidates[0];
    if (selected.preview.totalCost > this.cash + EPSILON) {
      this.currentSignal = {
        side: selected.side,
        reason: `The ${selected.side} edge qualifies, but paper cash is insufficient for ${shares} shares.`,
        edgePerShare: selected.edgePerShare,
      };
      return false;
    }
    const execution = this.sweep(selected.side, 'asks', shares, { consume: true });
    if (!execution?.complete) return false;
    this.buyPosition(
      selected.side,
      execution,
      model,
      now,
      'MODEL_EDGE',
      selected.edgePerShare,
    );
    this.entryTriggeredThisWindow = true;
    this.currentSignal = {
      side: selected.side,
      reason: `${selected.side} bought because its estimated net edge cleared the configured threshold.`,
      edgePerShare: selected.edgePerShare,
    };
    this.schedulePersist(true);
    return true;
  }

  resetFlipConfirmation() {
    this.flipConfirmation = { side: null, count: 0, lastTickAt: null };
  }

  recordFlipConfirmation(side, model, now) {
    const tickAt = timestamp(model?.tickAt, null);
    if (tickAt == null || tickAt > now
      || now - tickAt > this.config.MAX_DATA_AGE_MS) {
      this.resetFlipConfirmation();
      return { confirmed: false, count: 0 };
    }

    const current = this.flipConfirmation;
    const elapsedSinceConfirmation = current.lastTickAt == null
      ? null : tickAt - current.lastTickAt;
    if (current.side !== side
      || elapsedSinceConfirmation == null
      || elapsedSinceConfirmation < 0
      || elapsedSinceConfirmation > this.config.FLIP_CONFIRMATION_MAX_INTERVAL_MS) {
      this.flipConfirmation = { side, count: 1, lastTickAt: tickAt };
    } else if (elapsedSinceConfirmation
      >= this.config.FLIP_CONFIRMATION_MIN_INTERVAL_MS) {
      this.flipConfirmation = {
        side,
        count: Math.min(
          this.config.FLIP_CONFIRMATION_UPDATES,
          current.count + 1,
        ),
        lastTickAt: tickAt,
      };
    }

    return {
      confirmed: this.flipConfirmation.count
        >= this.config.FLIP_CONFIRMATION_UPDATES,
      count: this.flipConfirmation.count,
    };
  }

  evaluateFlip(openTrade, model, now) {
    const opposite = openTrade.side === 'UP' ? 'DOWN' : 'UP';
    if (this.flipsThisWindow >= this.config.MAX_FLIPS_PER_WINDOW
      || now >= this.windowEnd
      || !this.sideQuoteIsFresh(openTrade.side, now)
      || !this.sideQuoteIsFresh(opposite, now)) {
      this.resetFlipConfirmation();
      this.currentSignal = {
        side: opposite,
        reason: 'Holding the current position; no eligible flip is available this window.',
        edgePerShare: null,
      };
      return false;
    }
    const salePreview = this.sweep(openTrade.side, 'bids', openTrade.shares);
    if (!salePreview?.complete) {
      this.resetFlipConfirmation();
      this.currentSignal = {
        side: opposite,
        reason: 'The opposite model signal appeared, but visible bids cannot close the full position.',
        edgePerShare: null,
      };
      return false;
    }
    const liquidationPnl = salePreview.netProceeds - openTrade.totalCost;
    if (liquidationPnl <= EPSILON) {
      this.resetFlipConfirmation();
      this.currentSignal = {
        side: opposite,
        reason: 'Holding: the current position is not net-profitable to liquidate at visible bids.',
        edgePerShare: null,
      };
      return false;
    }
    const targetShares = this.sizeAfterOutcome(this.nextEntryShares, 'WIN');
    const buyPreview = this.sweep(opposite, 'asks', targetShares);
    const oppositeProbability = opposite === 'UP' ? model.probabilityUp : model.probabilityDown;
    const expectedProfit = buyPreview?.complete
      ? oppositeProbability * targetShares - buyPreview.totalCost
      : null;
    const edgePerShare = expectedProfit == null
      ? null : expectedProfit / targetShares;
    if (!buyPreview?.complete || edgePerShare == null
      || edgePerShare < this.config.MIN_FLIP_NET_EDGE_PER_SHARE) {
      this.resetFlipConfirmation();
      this.currentSignal = {
        side: opposite,
        reason: !buyPreview?.complete
          ? `Holding: the opposite side does not have enough visible ask depth for all ${targetShares} shares.`
          : `Holding: the opposite edge is below the $${this.config.MIN_FLIP_NET_EDGE_PER_SHARE.toFixed(2)} flip threshold after fees.`,
        edgePerShare,
      };
      return false;
    }
    if (this.cash + salePreview.netProceeds + EPSILON < buyPreview.totalCost) {
      this.resetFlipConfirmation();
      this.currentSignal = {
        side: opposite,
        reason: 'Holding: paper cash cannot fund the full opposite-side buy.',
        edgePerShare,
      };
      return false;
    }
    const confirmation = this.recordFlipConfirmation(opposite, model, now);
    if (!confirmation.confirmed) {
      this.currentSignal = {
        side: opposite,
        reason: `Waiting for ${opposite} confirmation (${confirmation.count}/${this.config.FLIP_CONFIRMATION_UPDATES} fresh Binance updates, at least ${this.config.FLIP_CONFIRMATION_MIN_INTERVAL_MS} ms apart).`,
        edgePerShare,
      };
      return false;
    }
    const sale = this.sweep(openTrade.side, 'bids', openTrade.shares, { consume: true });
    const buy = this.sweep(opposite, 'asks', targetShares, { consume: true });
    if (!sale?.complete || !buy?.complete) return false;
    this.resetFlipConfirmation();
    this.closePosition(openTrade, sale, now, 'PROFITABLE_MODEL_FLIP', opposite);
    this.buyPosition(
      opposite,
      buy,
      model,
      now,
      'PROFITABLE_MODEL_FLIP',
      edgePerShare,
    );
    this.flipsThisWindow += 1;
    this.log('PROFITABLE_MODEL_FLIP',
      `Closed profitable ${openTrade.side} shares and bought ${targetShares} ${opposite} shares on the opposite model edge.`,
      {
        fromSide: openTrade.side,
        toSide: opposite,
        sharesSold: sale.shares,
        sharesBought: buy.shares,
        liquidationPnl: round(liquidationPnl, 2),
        oppositeEdgePerShare: round(edgePerShare, 4),
        confirmationUpdates: confirmation.count,
        minimumFlipEdgePerShare: this.config.MIN_FLIP_NET_EDGE_PER_SHARE,
        flipsThisWindow: this.flipsThisWindow,
      });
    this.currentSignal = {
      side: opposite,
      reason: `Flipped after a profitable exit and ${confirmation.count} fresh opposite-signal confirmations.`,
      edgePerShare,
    };
    this.schedulePersist(true);
    return true;
  }

  buyPosition(side, execution, model, now, entryReason, edgePerShare) {
    const trade = {
      id: `misprice-trade-${++this.tradeSequence}`,
      asset: 'BTC',
      side,
      marketId: String(this.market.id),
      marketSlug: this.market.slug,
      marketTitle: this.market.title,
      tokenId: String(this.market.tokens[side]),
      windowStart: this.windowStart,
      windowEnd: this.windowEnd,
      shares: execution.shares,
      entryPrice: execution.averagePrice,
      totalCost: execution.totalCost,
      grossCost: execution.gross,
      fees: execution.fees,
      fills: execution.fills,
      openedAt: now,
      modelProbability: side === 'UP' ? model.probabilityUp : model.probabilityDown,
      modelPriceAtEntry: model.currentPrice,
      expectedEdgePerShare: edgePerShare,
      entryReason,
      executionRole: 'TAKER',
      status: 'OPEN',
      settlementStatus: 'OPEN',
      markPrice: null,
      markValue: null,
      unrealizedPnl: null,
      realizedPnl: null,
      outcome: null,
    };
    this.cash = round(this.cash - trade.totalCost, 8);
    this.trades.push(trade);
    this.log('BUY_FILLED',
      `Bought ${trade.shares} ${side} shares at a $${trade.entryPrice.toFixed(3)} average; model edge was $${Number(edgePerShare).toFixed(3)} per share after fees.`,
      {
        tradeId: trade.id,
        side,
        shares: trade.shares,
        averagePrice: round(trade.entryPrice),
        totalCost: round(trade.totalCost, 2),
        fees: round(trade.fees, 2),
        modelProbability: round(trade.modelProbability, 4),
        expectedEdgePerShare: round(edgePerShare, 4),
        modelPrice: round(trade.modelPriceAtEntry, 2),
        executionRole: trade.executionRole,
      });
    return trade;
  }

  closePosition(trade, execution, now, reason, nextSide = null) {
    this.cash = round(this.cash + execution.netProceeds, 8);
    trade.status = 'CLOSED';
    trade.settlementStatus = 'CLOSED';
    trade.closedAt = now;
    trade.exitReason = reason;
    trade.exitSide = nextSide;
    trade.exitPrice = execution.averagePrice;
    trade.exitGrossProceeds = execution.gross;
    trade.exitFees = execution.fees;
    trade.proceeds = execution.netProceeds;
    trade.realizedPnl = round(execution.netProceeds - trade.totalCost, 8);
    trade.outcome = 'EXIT';
    trade.exitFills = execution.fills;
    this.realizedPnl = round(this.realizedPnl + trade.realizedPnl, 8);
    if (trade.realizedPnl > EPSILON) {
      this.applySizingAdjustment(
        trade,
        'WIN',
        now,
        'Profitable intra-window close',
        'PROFITABLE_INTRAWINDOW_CLOSE',
      );
    }
    return trade;
  }

  sizeAfterOutcome(shares, outcome) {
    return outcome === 'LOSS'
      ? Number(shares) + this.config.LOSS_SIZE_STEP_SHARES
      : Math.max(
        this.config.BASE_SHARES,
        Number(shares) - this.config.WIN_SIZE_REDUCTION_SHARES,
      );
  }

  recalculateNextEntryShares() {
    const sizingTrades = this.trades
      .filter(trade => trade.sizingAdjustmentApplied
        && ['WIN', 'LOSS'].includes(trade.sizingOutcome || trade.outcome))
      .sort((left, right) => (
        Number(left.sizingAdjustedAt ?? left.settledAt ?? left.closedAt ?? left.windowStart) || 0
      ) - (
        Number(right.sizingAdjustedAt ?? right.settledAt ?? right.closedAt ?? right.windowStart) || 0
      )
        || (Number(left.windowStart) || 0) - (Number(right.windowStart) || 0)
        || String(left.id).localeCompare(String(right.id)));
    let shares = this.config.BASE_SHARES;
    for (const trade of sizingTrades) {
      const outcome = trade.sizingOutcome || trade.outcome;
      trade.sizeBeforeAdjustment = shares;
      shares = this.sizeAfterOutcome(shares, outcome);
      trade.sizeAfterAdjustment = shares;
      if (trade.outcome === outcome && ['WIN', 'LOSS'].includes(trade.outcome)) {
        trade.sizeBeforeResolution = trade.sizeBeforeAdjustment;
        trade.sizeAfterResolution = shares;
      }
    }
    this.nextEntryShares = shares;
    return shares;
  }

  applySizingAdjustment(trade, outcome, now, reason, adjustmentType) {
    if (trade.sizingAdjustmentApplied || !['WIN', 'LOSS'].includes(outcome)) return false;
    trade.sizingAdjustmentApplied = true;
    trade.sizingOutcome = outcome;
    trade.sizingAdjustedAt = now;
    const previous = this.nextEntryShares;
    const next = this.recalculateNextEntryShares();
    this.log('NEXT_ENTRY_SIZE_UPDATED',
      `${reason}; next order size is ${next} shares.`,
      {
        tradeId: trade.id,
        outcome,
        adjustmentType,
        previousShares: previous,
        nextShares: next,
        lossIncrementShares: this.config.LOSS_SIZE_STEP_SHARES,
        winReductionShares: this.config.WIN_SIZE_REDUCTION_SHARES,
        minimumShares: this.config.BASE_SHARES,
        at: now,
      });
    return true;
  }

  applyResolutionSizing(trade, now) {
    if (trade.outcome !== 'WIN' && trade.outcome !== 'LOSS') return false;
    return this.applySizingAdjustment(
      trade,
      trade.outcome,
      now,
      `${trade.outcome === 'LOSS' ? 'Loss' : 'Win'} resolved`,
      'ORIGINAL_MARKET_RESOLUTION',
    );
  }

  updateOpenMarks(now) {
    for (const trade of this.trades) {
      if (trade.status !== 'OPEN' || trade.windowStart !== this.windowStart
        || trade.marketId !== String(this.market?.id)) continue;
      const quote = this.quotes[trade.side];
      if (!this.sideQuoteIsFresh(trade.side, now) || !Number.isFinite(quote.bestBid)) {
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

  async resolveDue(now = this.now()) {
    if (now - this.lastResolvePollAt < this.config.RESOLUTION_POLL_MS) return;
    this.lastResolvePollAt = now;
    const marketIds = [...new Set(this.trades
      .filter(trade => trade.status === 'AWAITING_RESOLUTION')
      .map(trade => String(trade.marketId)))];
    const due = marketIds.filter(id => !this.resolutionInFlight.has(id)
      && now - (this.resolutionLastAttemptAt.get(id) || 0) >= this.config.RESOLUTION_POLL_MS);
    await Promise.all(due.map(async marketId => {
      this.resolutionInFlight.add(marketId);
      this.resolutionLastAttemptAt.set(marketId, now);
      try {
        const market = await this.marketData.getMarket(marketId);
        let changed = false;
        for (const trade of this.trades) {
          if (trade.status !== 'AWAITING_RESOLUTION'
            || String(trade.marketId) !== marketId) continue;
          const payout = resolvedPayout(market, trade);
          trade.settlementLastCheckedAt = now;
          if (payout == null) continue;
          const proceeds = trade.shares * payout;
          trade.status = 'SETTLED';
          trade.settlementStatus = 'SETTLED';
          trade.settlementSource = 'ORIGINAL_MARKET_RESOLUTION';
          trade.resolutionPayout = payout;
          trade.proceeds = proceeds;
          trade.realizedPnl = round(proceeds - trade.totalCost, 8);
          trade.settledAt = now;
          trade.outcome = payout === 1 ? 'WIN' : 'LOSS';
          this.cash = round(this.cash + proceeds, 8);
          this.realizedPnl = round(this.realizedPnl + trade.realizedPnl, 8);
          this.applyResolutionSizing(trade, now);
          this.log('POSITION_RESOLVED',
            `${trade.side} settled from its exact original Polymarket market as a ${trade.outcome.toLowerCase()}.`,
            {
              tradeId: trade.id,
              marketId,
              payout,
              realizedPnl: round(trade.realizedPnl, 2),
            });
          changed = true;
        }
        if (changed) this.schedulePersist(true);
      } catch (error) {
        this.error = error?.message || 'Could not check the original market resolution.';
      } finally {
        this.resolutionInFlight.delete(marketId);
      }
    }));
  }

  async tick() {
    if (this.tickInProgress) return this.snapshot();
    this.tickInProgress = true;
    const now = this.now();
    try {
      const currentStart = Math.floor(now / this.config.WINDOW_MS) * this.config.WINDOW_MS;
      if (this.windowStart !== currentStart) await this.resetWindow(currentStart);
      if (!this.market) await this.loadMarket(currentStart);
      if (this.market) this.evaluate(now);
      this.updateOpenMarks(now);
      await this.resolveDue(now);
      if (this.market) {
        this.status = this.storageHealthy ? 'RUNNING' : 'ERROR';
        this.statusReason = `BTC 5-minute market active; Polymarket WebSocket ${this.websocket.status.toLowerCase()}.`;
      } else if (this.storageHealthy && this.status !== 'STOPPED') {
        this.status = 'WAITING';
      }
      return this.snapshot();
    } catch (error) {
      this.error = error?.message || 'Mispricing evaluation failed.';
      this.status = 'ERROR';
      this.statusReason = 'The paper bot paused after an evaluation error.';
      return this.snapshot();
    } finally {
      this.tickInProgress = false;
    }
  }

  accountSnapshot() {
    const openTrades = this.trades.filter(trade => trade.status === 'OPEN');
    const awaiting = this.trades.filter(trade => trade.status === 'AWAITING_RESOLUTION');
    const settled = this.trades.filter(trade => trade.status === 'SETTLED');
    const markedValue = openTrades.reduce((sum, trade) => sum + (Number(trade.markValue) || 0), 0);
    const unrealizedPnl = openTrades.reduce((sum, trade) => sum + (Number(trade.unrealizedPnl) || 0), 0);
    return {
      startingCapital: round(this.startingCapital, 2),
      cash: round(this.cash, 2),
      openCost: round(openTrades.reduce((sum, trade) => sum + trade.totalCost, 0), 2),
      realizedPnl: round(this.realizedPnl, 2),
      unrealizedPnl: round(unrealizedPnl, 2),
      markedValue: round(markedValue, 2),
      equity: round(this.cash + markedValue, 2),
      openPositions: openTrades.length,
      pendingResolutionPositions: awaiting.length,
      settledPositions: settled.length,
      closedPositions: this.trades.filter(trade => trade.status === 'CLOSED').length,
      wins: settled.filter(trade => trade.outcome === 'WIN').length,
      losses: settled.filter(trade => trade.outcome === 'LOSS').length,
      takerFees: round(this.trades.reduce((sum, trade) =>
        sum + (Number(trade.fees) || 0) + (Number(trade.exitFees) || 0), 0), 2),
      tradeCount: this.trades.length,
    };
  }

  snapshot() {
    const now = this.now();
    const model = this.modelSnapshot(now);
    const openTrade = this.currentOpenTrade();
    return {
      mode: 'PAPER ONLY',
      running: this.running,
      status: this.status,
      statusReason: this.statusReason,
      error: this.error,
      now,
      persistence: {
        status: this.persistenceStatus,
        storageHealthy: this.storageHealthy,
      },
      strategy: {
        version: this.config.STRATEGY_VERSION,
        timeframe: '5m',
        symbol: 'BTCUSDT',
        baseShares: this.config.BASE_SHARES,
        nextEntryShares: this.nextEntryShares,
        lossSizeStepShares: this.config.LOSS_SIZE_STEP_SHARES,
        winSizeReductionShares: this.config.WIN_SIZE_REDUCTION_SHARES,
        profitableIntrawindowCloseReducesSize: true,
        sizeFloorShares: this.config.BASE_SHARES,
        volatilityLookbackCandles: this.config.VOLATILITY_CANDLES,
        minimumNetEdgePerShare: this.config.MIN_NET_EDGE_PER_SHARE,
        minimumFlipNetEdgePerShare: this.config.MIN_FLIP_NET_EDGE_PER_SHARE,
        entryOrderType: 'TAKER SWEEP OF VISIBLE ASKS',
        flipConfirmationUpdates: this.config.FLIP_CONFIRMATION_UPDATES,
        flipConfirmationIntervalMs: this.config.FLIP_CONFIRMATION_MIN_INTERVAL_MS,
        flipConfirmation: {
          side: this.flipConfirmation.side,
          updates: this.flipConfirmation.count,
        },
        maximumFlipsPerWindow: this.config.MAX_FLIPS_PER_WINDOW,
        flipsThisWindow: this.flipsThisWindow,
        entryTriggeredThisWindow: this.entryTriggeredThisWindow,
        exitPolicy: 'Hold to exact original-market resolution unless a profitable opposite edge of at least $0.10/share persists across two fresh Binance updates, at least 500 ms apart.',
        priceSource: 'Binance BTCUSDT aggregate trades',
      },
      window: {
        start: this.windowStart,
        end: this.windowEnd,
        secondsRemaining: this.windowEnd == null
          ? null : Math.max(0, (this.windowEnd - now) / 1000),
        slug: this.market?.slug || null,
      },
      market: this.market ? {
        id: this.market.id,
        slug: this.market.slug,
        title: this.market.title,
        start: this.market.start,
        end: this.market.end,
      } : null,
      binance: this.priceFeed.snapshot?.() || null,
      model,
      signal: this.currentSignal,
      quotes: {
        UP: { ...this.quotes.UP },
        DOWN: { ...this.quotes.DOWN },
      },
      websocket: { ...this.websocket },
      position: openTrade ? {
        tradeId: openTrade.id,
        side: openTrade.side,
        shares: openTrade.shares,
        entryPrice: openTrade.entryPrice,
        totalCost: openTrade.totalCost,
        markPrice: openTrade.markPrice,
        markValue: openTrade.markValue,
        unrealizedPnl: openTrade.unrealizedPnl,
        openedAt: openTrade.openedAt,
      } : null,
      account: this.accountSnapshot(),
      trades: this.trades.slice().sort((left, right) => right.openedAt - left.openedAt).slice(0, 100),
      events: this.events.slice(0, 50),
    };
  }
}

module.exports = {
  BtcMispricingBot,
  DEFAULT_CONFIG,
  calculateVolatility,
  estimateUpProbability,
  normalCdf,
};
