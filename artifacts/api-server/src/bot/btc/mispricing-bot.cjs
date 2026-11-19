'use strict';

const { CANDLE_MS } = require('./binance-tick-feed.cjs');
const marketDataDefault = require('./wick-market-data.js');
const { feeParameters, takerFeeAt } = require('./paper-trading.js');
const { resolvedPayout } = require('./position-exits.js');
const { normalizeLevels } = require('./btc-price-band-bot.cjs');

const EPSILON = 1e-8;
const DEFAULT_CONFIG = Object.freeze({
  STRATEGY_VERSION: 'btc-5m-clob-092-rung-ladder-hold-resolution-v1',
  WINDOW_MS: CANDLE_MS,
  STARTING_CAPITAL: 3_000,
  LADDER_TRIGGER_PRICE: 0.92,
  LADDER_ORDER_SHARES: 100,
  LADDER_PRICES: Object.freeze([0.90, 0.80, 0.70, 0.60, 0.50, 0.40, 0.30, 0.20]),
  LADDER_FILL_OFFSET: 0.01,
  BASE_SHARES: 100,
  LOSS_SIZE_STEP_SHARES: 20,
  WIN_SIZE_REDUCTION_SHARES: 30,
  VOLATILITY_CANDLES: 3,
  MIN_NET_EDGE_PER_SHARE: 0.05,
  MIN_FLIP_NET_EDGE_PER_SHARE: 0.10,
  TAKE_PROFIT_BID: 0.99,
  TAKE_PROFIT_PAYOUT_PER_SHARE: 1,
  STOP_LOSS_BID: 0.01,
  STOP_LOSS_PAYOUT_PER_SHARE: 0,
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

function selectInitialSideFromCandles(candles) {
  const sample = (Array.isArray(candles) ? candles : []).slice(-3);
  const returns = sample.map(candle => {
    const open = Number(candle?.open);
    const close = Number(candle?.close);
    return open > 0 && Number.isFinite(open) && Number.isFinite(close)
      ? (close / open) - 1
      : null;
  });
  if (returns.length !== 3 || returns.some(value => !Number.isFinite(value))) {
    return {
      side: null,
      averageFirstTwoReturnPct: null,
      latestReturnPct: null,
      reason: 'Waiting for three complete candle returns to select an initial side.',
    };
  }

  const averageFirstTwo = (returns[0] + returns[1]) / 2;
  const latest = returns[2];
  if (averageFirstTwo > latest) {
    return {
      side: 'UP',
      averageFirstTwoReturnPct: averageFirstTwo * 100,
      latestReturnPct: latest * 100,
      reason: 'UP: the average return of candles 1 and 2 is greater than candle 3.',
    };
  }
  if (averageFirstTwo < latest) {
    return {
      side: 'DOWN',
      averageFirstTwoReturnPct: averageFirstTwo * 100,
      latestReturnPct: latest * 100,
      reason: 'DOWN: the average return of candles 1 and 2 is less than candle 3.',
    };
  }
  return {
    side: null,
    averageFirstTwoReturnPct: averageFirstTwo * 100,
    latestReturnPct: latest * 100,
    reason: 'No initial side: the average return of candles 1 and 2 exactly matches candle 3.',
  };
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
    this.priceFeed = options.priceFeed || null;

    this.running = false;
    this.error = null;
    this.status = 'STARTING';
    this.statusReason = 'Starting the Polymarket CLOB WebSocket and paper ledger.';
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
    this.activeLadder = null;
    this.latestTradePrices = { UP: null, DOWN: null };
    this.entryConfirmation = { side: null, count: 0, lastTickAt: null };
    this.seenTradeEvents = [];
    this.flipsThisWindow = 0;
    this.sizingGeneration = 0;
    this.sizingResetRequestId = null;
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
      reason: 'Waiting for a Polymarket UP or DOWN price to reach $0.92.',
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
        const historyResetRequestId = this.liveAccount
          ? ''
          : String(process.env.BTC_PAPER_MISPRICING_HISTORY_RESET_REQUEST_ID || '').trim();
        if (historyResetRequestId) {
          if (typeof this.stateStore.resetHistoryOnce !== 'function') {
            throw new Error('A paper history reset was requested, but the durable store cannot reset history.');
          }
          const reset = await this.stateStore.resetHistoryOnce(
            historyResetRequestId,
            this.emptyHistoryState(),
          );
          if (reset) console.log('BTC paper mispricing history reset completed.');
        }
        const saved = await this.stateStore.loadState();
        if (saved) this.restoreState(saved);
        this.storageHealthy = true;
        this.persistenceStatus = 'CONNECTED';
        if (this.applySizingResetRequest(
          process.env.BTC_MISPRICING_SIZING_RESET_REQUEST_ID,
        ) && !(await this.persist())) {
          throw new Error('The requested base-size reset could not be saved.');
        }
      }
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
    this.priceFeed?.stop?.();
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
    const sameStrategy = state.strategyVersion === this.config.STRATEGY_VERSION;
    const savedPendingOrder = state.pendingEntryOrder;
    this.pendingEntryOrder = sameStrategy
      && savedPendingOrder
      && Number(savedPendingOrder.windowStart) === this.windowStart
      ? { ...savedPendingOrder } : null;
    const discardedSameWindowOrder = savedPendingOrder
      && Number(savedPendingOrder.windowStart) === this.windowStart
      && !sameStrategy;
    this.activeLadder = sameStrategy
      && state.activeLadder
      && Number(state.activeLadder.windowStart) === this.windowStart
      ? {
        ...state.activeLadder,
        rungs: Array.isArray(state.activeLadder.rungs)
          ? state.activeLadder.rungs.map(rung => ({ ...rung }))
          : [],
      }
      : null;
    this.entryTriggeredThisWindow = sameStrategy
      ? Boolean(this.activeLadder || state.entryTriggeredThisWindow)
      : false;
    this.entryConfirmation = { side: null, count: 0, lastTickAt: null };
    this.seenTradeEvents = Array.isArray(state.seenTradeEvents)
      ? state.seenTradeEvents.slice(-2_000) : [];
    this.flipsThisWindow = Math.max(0, Number(state.flipsThisWindow) || 0);
    this.sizingGeneration = Math.max(0, Math.floor(Number(state.sizingGeneration) || 0));
    this.sizingResetRequestId = typeof state.sizingResetRequestId === 'string'
      ? state.sizingResetRequestId : null;
    this.market = null;
    this.books.clear();
    this.quotes = { UP: emptyQuote('UP'), DOWN: emptyQuote('DOWN') };
    this.latestTradePrices = { UP: null, DOWN: null };
    if (discardedSameWindowOrder) {
      this.log(
        'LEGACY_ENTRY_ORDER_CANCELLED',
        'The previous strategy’s unfilled entry order was discarded during the strategy change; prior fills remain in the ledger.',
        {
          orderId: savedPendingOrder.id || null,
          side: savedPendingOrder.side || null,
          filledShares: Number(savedPendingOrder.filledShares) || 0,
          remainingShares: Number(savedPendingOrder.remainingShares) || 0,
        },
      );
    }
    this.statusReason = 'Restored paper history; the new CLOB rung strategy is active.';
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
      activeLadder: this.activeLadder,
      seenTradeEvents: this.seenTradeEvents.slice(-2_000),
      flipsThisWindow: this.flipsThisWindow,
      sizingGeneration: this.sizingGeneration,
      sizingResetRequestId: this.sizingResetRequestId,
    };
  }

  emptyHistoryState() {
    return {
      schemaVersion: 1,
      strategyVersion: this.config.STRATEGY_VERSION,
      startingCapital: this.config.STARTING_CAPITAL,
      cash: this.config.STARTING_CAPITAL,
      realizedPnl: 0,
      trades: [],
      events: [],
      tradeSequence: 0,
      orderSequence: 0,
      eventSequence: 0,
      nextEntryShares: this.config.BASE_SHARES,
      windowStart: null,
      entryTriggeredThisWindow: false,
      pendingEntryOrder: null,
      activeLadder: null,
      seenTradeEvents: [],
      flipsThisWindow: 0,
      sizingGeneration: 0,
      sizingResetRequestId: null,
    };
  }

  applySizingResetRequest(requestId) {
    const normalizedRequestId = String(requestId || '').trim();
    if (!normalizedRequestId || normalizedRequestId === this.sizingResetRequestId) return false;
    const previousShares = this.nextEntryShares;
    this.sizingGeneration += 1;
    this.sizingResetRequestId = normalizedRequestId;
    this.nextEntryShares = this.config.BASE_SHARES;
    this.log(
      'NEXT_ENTRY_SIZE_RESET',
      `Next order size reset to ${this.config.BASE_SHARES} shares; trade history was preserved.`,
      {
        previousShares,
        nextShares: this.nextEntryShares,
        sizingGeneration: this.sizingGeneration,
      },
    );
    return true;
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
    if (this.activeLadder && this.activeLadder.windowStart < start) {
      const unfilledRungs = this.activeLadder.rungs.filter(rung => rung.status === 'RESTING');
      for (const rung of unfilledRungs) {
        rung.status = 'CANCELLED';
        rung.cancelledAt = this.now();
      }
      this.log(
        'LADDER_EXPIRED',
        `The ${this.activeLadder.side} ladder expired at window end; ${unfilledRungs.length} unfilled limit rungs were cancelled.`,
        {
          side: this.activeLadder.side,
          marketId: this.activeLadder.marketId,
          filledRungs: this.activeLadder.rungs.filter(rung => rung.status === 'FILLED').length,
          cancelledRungs: unfilledRungs.length,
          lowestObservedPrice: this.activeLadder.lowestObservedPrice,
        },
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
    this.activeLadder = null;
    this.latestTradePrices = { UP: null, DOWN: null };
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
    else if (type === 'last_trade_price' && !this.liveAccount) {
      this.applyLastTradePrice(payload, this.now());
    }
    if (!this.liveAccount) void this.evaluate();
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
      queueAheadShares: 0,
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
      reason: `Post-only ${side} bid resting at $${passive.limitPrice.toFixed(2)}; full fill when price reaches $${(passive.limitPrice - 0.01).toFixed(2)} or lower.`,
      edgePerShare,
    };
    this.log('MAKER_ORDER_PLACED',
      `Posted a post-only ${shares}-share ${side} buy at $${passive.limitPrice.toFixed(2)}; no taker entry fee applies if it fills as maker.`,
      {
        orderId: order.id,
        side,
        limitPrice: order.limitPrice,
        targetShares: order.targetShares,
        estimatedCost: round(order.estimatedCost, 4),
        estimatedEdgePerShare: round(edgePerShare, 4),
        postOnly: true,
      });
    this.schedulePersist(true);
    return true;
  }

  closeAtThreshold(trade, outcome, triggerBid, now) {
    if (!trade || trade.status !== 'OPEN' || !['WIN', 'LOSS'].includes(outcome)) return false;
    const payout = outcome === 'WIN'
      ? this.config.TAKE_PROFIT_PAYOUT_PER_SHARE
      : this.config.STOP_LOSS_PAYOUT_PER_SHARE;
    const proceeds = trade.shares * payout;
    trade.status = 'SETTLED';
    trade.settlementStatus = 'SETTLED';
    trade.settlementSource = 'INTRAWINDOW_THRESHOLD';
    trade.exitReason = outcome === 'WIN' ? 'TAKE_PROFIT_BID' : 'STOP_LOSS_BID';
    trade.exitPrice = payout;
    trade.exitTriggerBid = triggerBid;
    trade.proceeds = proceeds;
    trade.realizedPnl = round(proceeds - trade.totalCost, 8);
    trade.outcome = outcome;
    trade.settledAt = now;
    trade.closedAt = now;
    this.cash = round(this.cash + proceeds, 8);
    this.realizedPnl = round(this.realizedPnl + trade.realizedPnl, 8);
    this.applySizingAdjustment(
      trade,
      outcome,
      now,
      `${outcome === 'WIN' ? 'Take-profit' : 'Stop-loss'} threshold recorded`,
      outcome === 'WIN' ? 'INTRAWINDOW_TAKE_PROFIT' : 'INTRAWINDOW_STOP_LOSS',
    );
    this.log(outcome === 'WIN' ? 'INTRAWINDOW_TAKE_PROFIT' : 'INTRAWINDOW_STOP_LOSS',
      `${trade.side} best bid reached $${triggerBid.toFixed(3)}; recorded a $${payout.toFixed(2)} per-share paper payout and updated next-window sizing.`,
      {
        tradeId: trade.id,
        side: trade.side,
        shares: trade.shares,
        triggerBid,
        payoutPerShare: payout,
        proceeds: round(proceeds, 4),
        realizedPnl: round(trade.realizedPnl, 4),
        outcome,
      });
    this.schedulePersist(true);
    return true;
  }

  processThresholdExit(now = this.now()) {
    if (!this.market || this.windowEnd == null || now >= this.windowEnd) return false;
    const trade = this.currentOpenTrade();
    if (!trade || !this.sideQuoteIsFresh(trade.side, now)) return false;
    const bestBid = Number(this.quotes[trade.side]?.bestBid);
    if (!Number.isFinite(bestBid)) return false;
    if (bestBid >= this.config.TAKE_PROFIT_BID) {
      return this.closeAtThreshold(
        trade,
        'WIN',
        bestBid,
        now,
      );
    }
    if (bestBid <= this.config.STOP_LOSS_BID) {
      return this.closeAtThreshold(
        trade,
        'LOSS',
        bestBid,
        now,
      );
    }
    return false;
  }

  recordMakerFill(order, shares, now, transactionHash = null, trigger = null) {
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
        rebates: 0,
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
    trade.totalCost += grossCost + makerFee - estimatedRebate;
    trade.entryPrice = trade.grossCost / trade.shares;
    trade.fees += makerFee;
    trade.estimatedMakerRebate += estimatedRebate;
    trade.rebates += estimatedRebate;
    trade.fills.push({
      price: order.limitPrice,
      shares: filledShares,
      gross: grossCost,
      fee: makerFee,
      role: 'MAKER',
      transactionHash,
      at: now,
    });
    this.cash = round(this.cash - grossCost - makerFee + estimatedRebate, 8);
    order.filledShares += filledShares;
    order.remainingShares = Math.max(0, order.targetShares - order.filledShares);
    order.lastFillAt = now;
    order.status = order.remainingShares <= EPSILON ? 'FILLED' : 'PARTIALLY_FILLED';
    const triggerLabel = trigger?.source === 'BEST_ASK' ? 'best ask' : 'last trade price';
    const triggerPrice = Number.isFinite(Number(trigger?.price))
      ? Number(trigger.price) : null;
    this.log('MAKER_BUY_FILLED',
      `Filled ${round(filledShares, 4)} ${order.side} shares at the resting $${order.limitPrice.toFixed(2)} bid after ${triggerLabel} reached ${triggerPrice == null ? 'at least one cent below the limit' : `$${triggerPrice.toFixed(2)}`}; maker fee $0, estimated rebate $${round(estimatedRebate, 4)}.`,
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
        fillTrigger: trigger?.source || 'TRADE_PRINT',
        triggerPrice,
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
    const tokenId = String(event.asset_id || event.assetId || '');
    const side = sideForToken(this.market, tokenId);
    if (!side || this.windowStart == null) return false;
    const price = Number(event.price);
    const size = Number(event.size);
    const tradeAt = timestamp(event.timestamp, now);
    if (!Number.isFinite(price) || price <= 0 || price >= 1
      || !Number.isFinite(size) || size <= 0
      || tradeAt < this.windowStart || tradeAt > now + 1_000
      || tradeAt >= this.windowEnd) return false;
    const txHash = event.transaction_hash || event.transactionHash || event.hash || null;
    const eventKey = txHash
      ? `${tokenId}:${txHash}:${tradeAt}:${price}:${size}`
      : `${tokenId}:${tradeAt}:${price}:${size}:${String(event.side).toUpperCase()}`;
    if (this.seenTradeEvents.includes(eventKey)) return false;
    this.seenTradeEvents.push(eventKey);
    if (this.seenTradeEvents.length > 2_000) {
      this.seenTradeEvents.splice(0, this.seenTradeEvents.length - 2_000);
    }
    this.latestTradePrices[side] = { price, at: tradeAt, size };
    return true;
  }

  modelSnapshot(now = this.now()) {
    const feed = this.priceFeed.snapshot?.() || {};
    const candles = (feed.candles || []).slice(-this.config.VOLATILITY_CANDLES);
    const volatility5m = calculateVolatility(candles, this.config.VOLATILITY_CANDLES);
    const initialSideSelection = selectInitialSideFromCandles(candles);
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
      initialSideSelection,
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
    const rebatePerShare = takerFeeAt(
      order.limitPrice,
      1,
      feeParameters(this.market),
    ) * this.config.CRYPTO_MAKER_REBATE_SHARE;
    return Number.isFinite(Number(probability))
      ? Number(probability) - Number(order.limitPrice) + rebatePerShare
      : null;
  }

  pendingOrderInvalidReason(now) {
    const order = this.pendingEntryOrder;
    if (!order) return null;
    if (now >= this.windowEnd || order.windowStart !== this.windowStart) {
      return 'The market window ended before the passive order filled.';
    }
    return null;
  }

  evaluatePendingEntryOrder(model, now) {
    const order = this.pendingEntryOrder;
    if (!order) return false;
    order.queueAheadShares = 0;
    const edgePerShare = this.pendingOrderEdge(model, order);
    const invalidReason = this.pendingOrderInvalidReason(now);
    if (invalidReason) {
      this.cancelPendingEntryOrder(invalidReason, now);
      this.currentSignal = {
        side: order.side,
        reason: 'The unfilled maker order was canceled because the 5-minute window ended.',
        edgePerShare,
      };
      return false;
    }
    const quote = this.quotes[order.side];
    const bestAsk = Number(quote?.bestAsk);
    const fullFillThreshold = order.limitPrice - 0.01;
    if (quote?.status === 'LIVE'
      && Number(quote.updatedAt) >= order.postedAt
      && Number.isFinite(bestAsk)
      && bestAsk <= fullFillThreshold + EPSILON) {
      order.queueAheadShares = 0;
      return this.recordMakerFill(
        order,
        order.remainingShares,
        now,
        null,
        { source: 'BEST_ASK', price: bestAsk },
      );
    }
    this.currentSignal = {
      side: order.side,
      reason: `The first-signal order remains at $${order.limitPrice.toFixed(2)}; full fill at the limit when price reaches $${fullFillThreshold.toFixed(2)} or lower, or cancel at window end.`,
      edgePerShare,
    };
    return false;
  }

  quoteIsFresh(side, now = this.now()) {
    const quote = this.quotes[side];
    return quote?.status === 'LIVE'
      && Number.isFinite(Number(quote.updatedAt))
      && now >= Number(quote.updatedAt)
      && now - Number(quote.updatedAt) <= this.config.MAX_DATA_AGE_MS;
  }

  priceSnapshot(side, now = this.now(), afterAt = null) {
    const quote = this.quotes[side];
    const observations = [];
    const bestAsk = Number(quote.bestAsk);
    if (this.quoteIsFresh(side, now)
      && Number.isFinite(bestAsk) && bestAsk > 0 && bestAsk < 1
      && (afterAt == null || Number(quote.updatedAt) > afterAt)) {
      observations.push({ source: 'BEST_ASK', price: bestAsk, at: Number(quote.updatedAt) });
    }
    const trade = this.latestTradePrices[side];
    if (trade && Number.isFinite(Number(trade.price))
      && Number.isFinite(Number(trade.at))
      && now >= trade.at && now - trade.at <= this.config.MAX_DATA_AGE_MS
      && (afterAt == null || Number(trade.at) > afterAt)) {
      observations.push({ source: 'LAST_TRADE', price: Number(trade.price), at: Number(trade.at) });
    }
    return observations.length
      ? observations.reduce((lowest, current) => current.price < lowest.price ? current : lowest)
      : null;
  }

  armRungLadder(side, triggerPrice, now) {
    const ladder = {
      side,
      marketId: String(this.market.id),
      tokenId: String(this.market.tokens[side]),
      marketSlug: this.market.slug,
      marketTitle: this.market.title,
      windowStart: this.windowStart,
      windowEnd: this.windowEnd,
      triggerPrice,
      triggeredAt: now,
      lowestObservedPrice: null,
      lowestObservedAt: null,
      lowestObservedSource: null,
      rungs: this.config.LADDER_PRICES.map((limitPrice, index) => ({
        id: `misprice-order-${++this.orderSequence}`,
        rung: index + 1,
        side,
        marketId: String(this.market.id),
        tokenId: String(this.market.tokens[side]),
        windowStart: this.windowStart,
        windowEnd: this.windowEnd,
        limitPrice,
        targetShares: this.config.LADDER_ORDER_SHARES,
        filledShares: 0,
        remainingShares: this.config.LADDER_ORDER_SHARES,
        status: 'RESTING',
        postedAt: now,
      })),
    };
    this.activeLadder = ladder;
    this.entryTriggeredThisWindow = true;
    this.currentSignal = {
      side,
      reason: `${side} reached $${this.config.LADDER_TRIGGER_PRICE.toFixed(2)}; armed eight resting 100-share buy limits from $0.90 to $0.20.`,
      edgePerShare: null,
    };
    this.log(
      'LADDER_ARMED',
      `${side} reached $${this.config.LADDER_TRIGGER_PRICE.toFixed(2)}. Posted eight paper resting buy rungs, 100 shares each, from $0.90 down to $0.20. Only this first side may arm in the window.`,
      {
        side,
        marketId: ladder.marketId,
        triggerPrice,
        rungPrices: this.config.LADDER_PRICES,
        sharesPerRung: this.config.LADDER_ORDER_SHARES,
        armedAt: now,
      },
    );
    this.schedulePersist(true);
    return ladder;
  }

  fillRung(rung, observedPrice, observedSource, now) {
    if (!this.activeLadder || rung.status !== 'RESTING') return false;
    const shares = this.config.LADDER_ORDER_SHARES;
    const grossCost = round(rung.limitPrice * shares, 8);
    if (grossCost > this.cash + EPSILON) {
      rung.status = 'BLOCKED_INSUFFICIENT_CASH';
      rung.blockedAt = now;
      this.log(
        'LADDER_RUNG_BLOCKED',
        `The ${this.activeLadder.side} $${rung.limitPrice.toFixed(2)} rung was not paper-filled because available cash cannot cover all ${shares} shares.`,
        {
          side: this.activeLadder.side,
          rung: rung.rung,
          limitPrice: rung.limitPrice,
          shares,
          requiredCash: grossCost,
          availableCash: round(this.cash, 4),
        },
      );
      return false;
    }

    const trade = {
      id: `misprice-trade-${++this.tradeSequence}`,
      strategyVersion: this.config.STRATEGY_VERSION,
      asset: 'BTC',
      side: this.activeLadder.side,
      marketId: this.activeLadder.marketId,
      marketSlug: this.activeLadder.marketSlug,
      marketTitle: this.activeLadder.marketTitle,
      tokenId: this.activeLadder.tokenId,
      windowStart: this.activeLadder.windowStart,
      windowEnd: this.activeLadder.windowEnd,
      shares,
      entryPrice: rung.limitPrice,
      totalCost: grossCost,
      grossCost,
      fees: 0,
      estimatedMakerRebate: 0,
      rebates: 0,
      fills: [{
        price: rung.limitPrice,
        shares,
        gross: grossCost,
        fee: 0,
        role: 'MAKER',
        at: now,
        fillSource: observedSource,
        observedPrice,
      }],
      openedAt: now,
      entryReason: 'CLOB_PRICE_LADDER',
      entryOrderId: rung.id,
      rung: rung.rung,
      rungLimitPrice: rung.limitPrice,
      executionRole: 'MAKER',
      status: 'OPEN',
      settlementStatus: 'OPEN',
      markPrice: null,
      markValue: null,
      unrealizedPnl: null,
      realizedPnl: null,
      outcome: null,
    };
    this.trades.push(trade);
    this.cash = round(this.cash - grossCost, 8);
    rung.status = 'FILLED';
    rung.filledShares = shares;
    rung.remainingShares = 0;
    rung.filledAt = now;
    rung.tradeId = trade.id;
    rung.fillObservedPrice = observedPrice;
    rung.fillSource = observedSource;
    this.log(
      'LADDER_RUNG_FILLED',
      `${shares} ${trade.side} shares paper-filled at the $${rung.limitPrice.toFixed(2)} resting limit after ${observedSource.toLowerCase().replaceAll('_', ' ')} reached $${observedPrice.toFixed(2)} (one cent through the rung).`,
      {
        tradeId: trade.id,
        orderId: rung.id,
        side: trade.side,
        rung: rung.rung,
        limitPrice: rung.limitPrice,
        shares,
        totalCost: grossCost,
        observedPrice,
        observedSource,
        entryFee: 0,
        estimatedMakerRebate: 0,
      },
    );
    return true;
  }

  processRungLadder(now = this.now()) {
    const ladder = this.activeLadder;
    if (!ladder || ladder.windowStart !== this.windowStart
      || now >= ladder.windowEnd) return false;
    const snapshot = this.priceSnapshot(ladder.side, now, ladder.triggeredAt);
    if (!snapshot) return false;

    if (ladder.lowestObservedPrice == null
      || snapshot.price < ladder.lowestObservedPrice) {
      ladder.lowestObservedPrice = snapshot.price;
      ladder.lowestObservedAt = snapshot.at;
      ladder.lowestObservedSource = snapshot.source;
    }
    const fillThresholdOffset = this.config.LADDER_FILL_OFFSET;
    let fills = 0;
    let changed = false;
    for (const rung of ladder.rungs) {
      if (rung.status !== 'RESTING') continue;
      const threshold = rung.limitPrice - fillThresholdOffset;
      if (ladder.lowestObservedPrice <= threshold + EPSILON) {
        const previousStatus = rung.status;
        if (this.fillRung(
          rung,
          ladder.lowestObservedPrice,
          ladder.lowestObservedSource || snapshot.source,
          now,
        )) fills += 1;
        if (rung.status !== previousStatus) changed = true;
      }
    }
    const filled = ladder.rungs.filter(rung => rung.status === 'FILLED');
    this.currentSignal = {
      side: ladder.side,
      reason: filled.length
        ? `${ladder.side} ladder active: ${filled.length}/8 rungs filled; lowest observed price $${ladder.lowestObservedPrice.toFixed(2)}. Filled positions wait for official resolution.`
        : `${ladder.side} ladder armed; waiting for a post-trigger price at least $0.01 below a rung.`,
      edgePerShare: null,
    };
    if (changed) this.schedulePersist(true);
    return fills > 0;
  }

  evaluate(now = this.now()) {
    if (!this.market || this.windowStart == null || !this.storageHealthy) return false;
    if (now >= this.windowEnd) return false;

    if (this.activeLadder) return this.processRungLadder(now);
    if (this.entryTriggeredThisWindow) {
      this.currentSignal = {
        side: null,
        reason: 'The first-side ladder was already armed this window; the other side is ignored.',
        edgePerShare: null,
      };
      return false;
    }

    const candidates = ['UP', 'DOWN'].map(side => {
      const quote = this.quotes[side];
      const trade = this.latestTradePrices[side];
      const quoteIsFresh = this.quoteIsFresh(side, now);
      const tradeIsFresh = trade
        && Number.isFinite(Number(trade.at))
        && now >= trade.at
        && now - trade.at <= this.config.MAX_DATA_AGE_MS;
      const prices = [
        quoteIsFresh ? Number(quote.bestAsk) : null,
        quoteIsFresh ? Number(quote.bestBid) : null,
        tradeIsFresh ? Number(trade.price) : null,
      ]
        .filter(price => Number.isFinite(price) && price > 0 && price < 1);
      const triggerPrice = prices.length ? Math.max(...prices) : null;
      const updatedAt = Math.max(
        quoteIsFresh ? Number(quote.updatedAt) : -Infinity,
        tradeIsFresh ? Number(trade.at) : -Infinity,
      );
      return triggerPrice != null && triggerPrice >= this.config.LADDER_TRIGGER_PRICE
        ? { side, triggerPrice, updatedAt }
        : null;
    }).filter(Boolean);

    if (!candidates.length) {
      this.currentSignal = {
        side: null,
        reason: `Watching live UP and DOWN prices; the first fresh side to reach $${this.config.LADDER_TRIGGER_PRICE.toFixed(2)} will arm its ladder.`,
        edgePerShare: null,
      };
      return false;
    }

    candidates.sort((left, right) => {
      if (left.updatedAt !== right.updatedAt) return left.updatedAt - right.updatedAt;
      return right.triggerPrice - left.triggerPrice;
    });
    const selected = candidates[0];
    this.armRungLadder(selected.side, selected.triggerPrice, now);
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
        && Math.max(0, Math.floor(Number(trade.sizingGeneration) || 0))
          === this.sizingGeneration
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
    trade.sizingGeneration = this.sizingGeneration;
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
        if (!this.quoteIsFresh(trade.side, now) || !Number.isFinite(quote.bestBid)) {
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
          if (trade.strategyVersion !== this.config.STRATEGY_VERSION) {
            this.applyResolutionSizing(trade, now);
          }
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
      estimatedMakerRebates: round(this.trades.reduce((sum, trade) =>
        sum + (Number(trade.estimatedMakerRebate) || 0), 0), 4),
      tradeCount: this.trades.length,
    };
  }

  snapshot() {
    const now = this.now();
    const currentOpenTrades = this.trades.filter(trade => trade.status === 'OPEN'
      && trade.windowStart === this.windowStart
      && trade.marketId === String(this.market?.id));
    const positionSide = this.activeLadder?.side || currentOpenTrades[0]?.side || null;
    const positionShares = currentOpenTrades.reduce(
      (sum, trade) => sum + (Number(trade.shares) || 0), 0,
    );
    const positionCost = currentOpenTrades.reduce(
      (sum, trade) => sum + (Number(trade.totalCost) || 0), 0,
    );
    const marksComplete = currentOpenTrades.length > 0
      && currentOpenTrades.every(trade => Number.isFinite(Number(trade.markValue))
        && Number.isFinite(Number(trade.unrealizedPnl)));
    const activeRungs = this.activeLadder?.rungs || [];
    const filledRungs = activeRungs.filter(rung => rung.status === 'FILLED');
    const filledShares = filledRungs.reduce(
      (sum, rung) => sum + (Number(rung.filledShares) || 0), 0,
    );
    const filledCost = filledRungs.reduce(
      (sum, rung) => sum + (Number(rung.filledShares) || 0) * Number(rung.limitPrice), 0,
    );
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
        symbol: 'BTC 5-minute Up or Down',
        triggerPrice: this.config.LADDER_TRIGGER_PRICE,
        entryOrderType: 'RESTING LIMIT BUY (PAPER)',
        entryPolicy: 'The first fresh UP or DOWN price to reach $0.92 arms one ladder for that side; the other side is ignored for the rest of the window.',
        rungPrices: this.config.LADDER_PRICES,
        sharesPerRung: this.config.LADDER_ORDER_SHARES,
        rungCount: this.config.LADDER_PRICES.length,
        fillRule: 'A full 100-share rung is paper-filled at its limit when a post-arm best ask or last trade reaches at least $0.01 below that limit. The lowest observed post-arm price is retained to catch gaps.',
        unfilledOrderPolicy: 'Unfilled rungs are canceled at window end.',
        takerFees: false,
        modeledMakerRebate: false,
        exitPolicy: 'No take-profit or stop-loss. Every filled rung is held until the exact original Polymarket market officially resolves.',
        entryTriggeredThisWindow: this.entryTriggeredThisWindow,
        priceSource: 'Polymarket CLOB best bid/ask and last-trade ticks',
        fixedSize: true,
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
      binance: null,
      model: null,
      signal: this.currentSignal,
      ladder: this.activeLadder ? {
        side: this.activeLadder.side,
        marketId: this.activeLadder.marketId,
        windowStart: this.activeLadder.windowStart,
        triggerPrice: this.activeLadder.triggerPrice,
        triggeredAt: this.activeLadder.triggeredAt,
        lowestObservedPrice: this.activeLadder.lowestObservedPrice,
        lowestObservedAt: this.activeLadder.lowestObservedAt,
        totalRungs: activeRungs.length,
        filledRungs: filledRungs.length,
        filledShares,
        averageEntryPrice: filledShares > 0 ? filledCost / filledShares : null,
        remainingRungs: activeRungs.filter(rung => rung.status === 'RESTING').length,
        rungs: activeRungs.map(rung => ({ ...rung })),
      } : null,
      pendingOrder: null,
      quotes: {
        UP: { ...this.quotes.UP },
        DOWN: { ...this.quotes.DOWN },
      },
      lastTradePrices: {
        UP: this.latestTradePrices.UP ? { ...this.latestTradePrices.UP } : null,
        DOWN: this.latestTradePrices.DOWN ? { ...this.latestTradePrices.DOWN } : null,
      },
      websocket: { ...this.websocket },
      position: positionShares > 0 ? {
        side: positionSide,
        shares: positionShares,
        entryPrice: positionCost / positionShares,
        totalCost: positionCost,
        markPrice: marksComplete ? this.quotes[positionSide]?.bestBid ?? null : null,
        markValue: marksComplete
          ? currentOpenTrades.reduce((sum, trade) => sum + Number(trade.markValue), 0)
          : null,
        unrealizedPnl: marksComplete
          ? currentOpenTrades.reduce((sum, trade) => sum + Number(trade.unrealizedPnl), 0)
          : null,
        openedAt: Math.min(...currentOpenTrades.map(trade => Number(trade.openedAt) || now)),
        rungCount: currentOpenTrades.length,
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
  selectInitialSideFromCandles,
  estimateUpProbability,
  normalCdf,
};
