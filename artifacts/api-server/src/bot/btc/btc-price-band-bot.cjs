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
    this.stateStore = options.stateStore || null;
    this.requirePersistedState = options.requirePersistedState === true;
    this.storageHealthy = !this.stateStore;
    this.persistenceStatus = this.stateStore ? 'NOT_STARTED' : 'DISABLED';
    this.lastStateSavedAt = null;
    this.pendingPersistedState = null;
    this.persistenceTimer = null;
    this.persistenceWriteInProgress = false;
    this.startupPromise = null;
    this.restoredMarketId = null;
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
    this.terminalEvidence = this.emptyTerminalEvidence();
    this.terminalEvidenceMarketId = null;
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
    this.terminalObservation = null;
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

  emptyTerminalEvidence() {
    const emptySide = () => ({
      winnerHitAt: null,
      winnerBid: null,
      loserHitAt: null,
      loserBid: null,
    });
    return { UP: emptySide(), DOWN: emptySide() };
  }

  start() {
    if (this.running) return this.startupPromise;
    this.running = true;
    if (!this.stateStore) {
      this.log('BOT_STARTED', 'BTC 5-minute ask-band paper bot started.');
      void this.tick();
      this.interval = setInterval(() => void this.tick(), this.config.POLL_INTERVAL_MS);
      this.interval.unref?.();
      return Promise.resolve();
    }
    this.persistenceStatus = 'LOADING';
    this.startupPromise = (async () => {
      await this.stateStore.initialize();
      const savedState = await this.stateStore.loadState();
      if (savedState) {
        this.restorePersistentState(savedState);
      } else if (this.requirePersistedState) {
        throw new Error('The durable BTC paper ledger is missing; refusing to start a fresh account.');
      } else {
        await this.stateStore.saveState(this.persistentStateSnapshot());
      }
      this.storageHealthy = true;
      this.persistenceStatus = 'CONNECTED';
      this.error = null;
      this.log('BOT_STARTED', savedState
        ? 'BTC 5-minute ask-band bot restored its paper history from PostgreSQL.'
        : 'BTC 5-minute ask-band paper bot started with a new durable ledger.');
      void this.tick();
      this.interval = setInterval(() => void this.tick(), this.config.POLL_INTERVAL_MS);
      this.interval.unref?.();
    })().catch(error => {
      this.storageHealthy = false;
      this.persistenceStatus = 'ERROR';
      this.running = false;
      this.error = 'BTC paper-history storage is unavailable; trading is paused.';
      this.statusReason = this.error;
      this.log('STORAGE_ERROR', this.error, {
        errorType: error?.name || 'Error',
      });
    });
    return this.startupPromise;
  }

  stop() {
    this.running = false;
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    if (this.persistenceTimer) clearTimeout(this.persistenceTimer);
    this.persistenceTimer = null;
    void this.flushPersistedState();
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
    const immediate = new Set([
      'BUY_FILLED',
      'OPPOSITE_SIGNAL_SELL',
      'TERMINAL_THRESHOLD_RECORDED',
      'TERMINAL_PRICE_SETTLEMENT',
      'POSITION_RESOLVED',
      'WINDOW_EXPIRED',
    ]).has(type);
    this.schedulePersistedState(immediate);
  }

  restorePersistentState(state) {
    if (state?.schemaVersion !== 1 || !Array.isArray(state.trades)
      || !Array.isArray(state.events) || !Number.isFinite(Number(state.cash))
      || !Number.isFinite(Number(state.startingCapital))
      || !Number.isFinite(Number(state.realizedPnl))) {
      throw new Error('The saved BTC paper ledger has an unsupported or invalid format.');
    }
    this.startingCapital = Number(state.startingCapital);
    this.cash = Number(state.cash);
    this.realizedPnl = Number(state.realizedPnl);
    this.trades = state.trades;
    this.events = state.events.slice(0, 150);
    this.windowStart = state.windowStart == null ? null : Number(state.windowStart);
    this.windowEnd = state.windowEnd == null ? null : Number(state.windowEnd);
    this.restoredMarketId = state.marketId == null ? null : String(state.marketId);
    this.sideState = {
      UP: { ...this.emptySideState(), ...(state.sideState?.UP || {}) },
      DOWN: { ...this.emptySideState(), ...(state.sideState?.DOWN || {}) },
    };
    this.lastAskTrigger = {
      UP: state.lastAskTrigger?.UP ?? null,
      DOWN: state.lastAskTrigger?.DOWN ?? null,
    };
    this.quotes = Object.fromEntries(['UP', 'DOWN'].map(side => {
      const quote = state.quotes?.[side];
      if (!quote || typeof quote !== 'object') return [side, null];
      return [side, {
        ...quote,
        status: 'STALE',
        updatedAt: Number.isFinite(Number(quote.updatedAt)) ? Number(quote.updatedAt) : 0,
      }];
    }));
    this.terminalEvidence = state.terminalEvidence || this.emptyTerminalEvidence();
    this.terminalEvidenceMarketId = state.terminalEvidenceMarketId == null
      ? this.restoredMarketId : String(state.terminalEvidenceMarketId);
    this.terminalObservation = state.terminalObservation || null;
    this.tradeSequence = Math.max(
      Number(state.tradeSequence) || 0,
      ...this.trades.map(trade => {
        const match = String(trade.id || '').match(/^trade-(\d+)$/);
        return match ? Number(match[1]) : 0;
      }),
    );
    this.eventSequence = Math.max(
      Number(state.eventSequence) || 0,
      ...this.events.map(event => {
        const match = String(event.id || '').match(/^event-(\d+)$/);
        return match ? Number(match[1]) : 0;
      }),
    );
    this.books.clear();
    this.seenMarketEvents.clear();
    this.lastResolutionCheckAt = 0;
    this.statusReason = 'Restored the durable BTC paper ledger; reconnecting to the live market.';
  }

  persistentStateSnapshot() {
    const state = {
      schemaVersion: 1,
      strategyVersion: this.config.STRATEGY_VERSION,
      startingCapital: this.startingCapital,
      cash: this.cash,
      realizedPnl: this.realizedPnl,
      trades: this.trades,
      events: this.events,
      tradeSequence: this.tradeSequence,
      eventSequence: this.eventSequence,
      windowStart: this.windowStart,
      windowEnd: this.windowEnd,
      marketId: this.market?.id == null ? this.restoredMarketId : String(this.market.id),
      sideState: this.sideState,
      lastAskTrigger: this.lastAskTrigger,
      quotes: this.quotes,
      terminalEvidence: this.terminalEvidence,
      terminalEvidenceMarketId: this.terminalEvidenceMarketId,
      terminalObservation: this.terminalObservation,
    };
    return JSON.parse(JSON.stringify(state));
  }

  schedulePersistedState(immediate = false) {
    if (!this.stateStore || !this.storageHealthy) return;
    this.pendingPersistedState = this.persistentStateSnapshot();
    if (immediate) {
      if (this.persistenceTimer) clearTimeout(this.persistenceTimer);
      this.persistenceTimer = null;
      void this.flushPersistedState();
      return;
    }
    if (this.persistenceTimer) return;
    this.persistenceTimer = setTimeout(() => {
      this.persistenceTimer = null;
      void this.flushPersistedState();
    }, 500);
    this.persistenceTimer.unref?.();
  }

  async flushPersistedState() {
    if (!this.stateStore || !this.storageHealthy || this.persistenceWriteInProgress) return;
    this.persistenceWriteInProgress = true;
    try {
      while (this.pendingPersistedState && this.storageHealthy) {
        const state = this.pendingPersistedState;
        this.pendingPersistedState = null;
        await this.stateStore.saveState(state);
        this.lastStateSavedAt = this.now();
      }
    } catch (error) {
      this.storageHealthy = false;
      this.persistenceStatus = 'ERROR';
      this.error = 'BTC paper-history storage is unavailable; new buys are paused.';
      this.statusReason = this.error;
    } finally {
      this.persistenceWriteInProgress = false;
      if (this.pendingPersistedState && this.storageHealthy) {
        void this.flushPersistedState();
      }
    }
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
    this.terminalObservation = null;
    this.terminalEvidence = this.emptyTerminalEvidence();
    this.terminalEvidenceMarketId = null;
    this.restoredMarketId = null;
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

    const restoredSameMarket = !this.market && this.restoredMarketId != null
      && String(this.restoredMarketId) === String(market.id);
    const changed = !restoredSameMarket && (!this.market
      || String(this.market.id) !== String(market.id)
      || this.market.tokens.UP !== market.tokens.UP
      || this.market.tokens.DOWN !== market.tokens.DOWN);
    this.market = market;
    if (changed) {
      this.quotes = { UP: null, DOWN: null };
      this.books.clear();
      this.sideState = { UP: this.emptySideState(), DOWN: this.emptySideState() };
      this.lastAskTrigger = { UP: null, DOWN: null };
      this.terminalEvidence = this.emptyTerminalEvidence();
      this.terminalEvidenceMarketId = String(market.id);
      this.terminalObservation = null;
      this.startMarketStream(market);
    } else if (restoredSameMarket) {
      this.restoredMarketId = null;
      this.terminalEvidenceMarketId = String(market.id);
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
    this.maybeSettleAtTerminalPrice(now);
    this.markOpenPositions(now);
  }

  handleBookSnapshot(event, now) {
    const tokenId = String(event.asset_id || event.assetId || '');
    const side = this.sideForToken(tokenId);
    if (!side) return;
    const previous = this.books.get(tokenId);
    const previousBestAsk = previous?.asks?.[0]?.price ?? this.quotes[side]?.bestAsk ?? null;
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
      && this.handleAskTrigger(side, now, 'BEST_ASK_PRICE_CHANGE')) {
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
        if (this.handleAskTrigger(group.side, now, 'ASK_PRICE_UPDATE')) {
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
    this.recordTerminalEvidence(side, now);
    const bestAskChanged = bestAsk != null
      && (previousBestAsk == null || Math.abs(bestAsk - previousBestAsk) >= EPSILON);
    if (bestAskChanged) {
      if (this.isDuplicateAskTrigger(side, 'BEST_BID_ASK', event.timestamp)) {
        this.lastAskTrigger[side] = null;
      } else if (this.handleAskTrigger(side, now, 'BEST_BID_ASK')) {
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
    this.recordTerminalEvidence(side, now);
  }

  recordTerminalEvidence(side, now) {
    if (!this.market || this.windowStart == null || now >= this.windowEnd) return;
    const marketId = String(this.market.id);
    if (this.terminalEvidenceMarketId !== marketId) {
      this.terminalEvidence = this.emptyTerminalEvidence();
      this.terminalEvidenceMarketId = marketId;
      this.terminalObservation = null;
    }
    const quote = this.quotes[side];
    if (!this.quoteIsFresh(quote, now) || !Number.isFinite(quote.bestBid)) return;
    const evidence = this.terminalEvidence[side];
    if (quote.bestBid >= this.config.TERMINAL_WINNER_BID && evidence.winnerHitAt == null) {
      evidence.winnerHitAt = now;
      evidence.winnerBid = quote.bestBid;
      this.log('TERMINAL_THRESHOLD_RECORDED',
        `${side} reached the $0.99 winner threshold during this BTC window.`,
        { side, threshold: 'WINNER', bid: quote.bestBid, observedAt: now });
    }
    if (quote.bestBid < this.config.TERMINAL_LOSER_BID && evidence.loserHitAt == null) {
      evidence.loserHitAt = now;
      evidence.loserBid = quote.bestBid;
      this.log('TERMINAL_THRESHOLD_RECORDED',
        `${side} fell below the $0.01 loser threshold during this BTC window.`,
        { side, threshold: 'LOSER', bid: quote.bestBid, observedAt: now });
    }
  }

  quoteIsFresh(quote, now) {
    return quote?.status === 'LIVE'
      && Number.isFinite(quote.updatedAt)
      && now >= quote.updatedAt
      && now - quote.updatedAt <= this.config.MAX_QUOTE_AGE_MS;
  }

  sweepAsks(side, requestedShares, { consume = true } = {}) {
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
    if (complete && consume) {
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

  sweepBids(side, requestedShares, { consume = true } = {}) {
    const market = this.market;
    const quote = this.quotes[side];
    const tokenId = String(market?.tokens?.[side] || '');
    const book = this.books.get(tokenId);
    if (!book || !this.quoteIsFresh(quote, this.now())) return null;
    if (Math.abs((book.bids[0]?.price ?? NaN) - quote.bestBid) >= EPSILON) return null;
    const parameters = feeParameters(market);
    let remaining = requestedShares;
    let grossProceeds = 0;
    let fees = 0;
    const fills = [];
    for (const level of book.bids) {
      if (remaining <= EPSILON) break;
      const shares = Math.min(remaining, Math.max(0, level.availableSize));
      if (shares <= EPSILON) continue;
      const proceeds = shares * level.price;
      const fee = takerFeeAt(level.price, shares, parameters);
      fills.push({ level, price: level.price, shares, proceeds, fee });
      grossProceeds += proceeds;
      fees += fee;
      remaining -= shares;
    }
    const complete = remaining <= EPSILON;
    if (complete && consume) {
      for (const fill of fills) fill.level.availableSize -= fill.shares;
    }
    const sharesFilled = requestedShares - remaining;
    return {
      tokenId,
      shares: sharesFilled,
      remainingShares: Math.max(0, remaining),
      grossProceeds,
      fees,
      netProceeds: grossProceeds - fees,
      averagePrice: grossProceeds / Math.max(EPSILON, sharesFilled),
      fills: fills.map(({ level, ...fill }) => fill),
      complete,
    };
  }

  handleAskTrigger(side, now, triggerType) {
    if (this.stateStore && !this.storageHealthy) {
      this.sideState[side].status = 'PAPER_HISTORY_STORAGE_ERROR';
      this.sideState[side].reason = 'Trading is paused until durable paper history storage is available.';
      return false;
    }
    const oppositeSide = side === 'UP' ? 'DOWN' : 'UP';
    const oppositeTrades = this.trades.filter(trade =>
      trade.status === 'OPEN'
      && trade.marketId === String(this.market?.id || '')
      && trade.windowStart === this.windowStart
      && trade.side === oppositeSide);
    const sharesToReverse = oppositeTrades.reduce((sum, trade) => sum + trade.shares, 0);
    if (sharesToReverse <= EPSILON) return this.tryBuy(side, now, triggerType);
    return this.tryReverse(side, oppositeSide, oppositeTrades, sharesToReverse, now, triggerType);
  }

  tryReverse(side, oppositeSide, oppositeTrades, sharesToReverse, now, triggerType) {
    const state = this.sideState[side];
    const quote = this.quotes[side];
    state.lastUpdateAt = now;
    state.lastBestAsk = quote?.bestAsk ?? null;
    if (!this.quoteIsFresh(quote, now) || !Number.isFinite(quote.bestAsk)
      || quote.bestAsk < this.config.MIN_ENTRY_ASK || quote.bestAsk > this.config.MAX_ENTRY_ASK) {
      return this.tryBuy(side, now, triggerType, sharesToReverse, 'OPPOSITE_SIGNAL_REVERSAL');
    }

    const sellPreview = this.sweepBids(oppositeSide, sharesToReverse, { consume: false });
    if (!sellPreview?.complete) {
      state.status = 'WAITING_FOR_REVERSAL_DEPTH';
      state.reason = `Waiting for visible ${oppositeSide} bids to sell all ${round(sharesToReverse)} shares.`;
      this.log('REVERSAL_WAITING_FOR_DEPTH', state.reason, {
        side, oppositeSide, shares: round(sharesToReverse), triggerType,
      });
      return false;
    }
    const buyPreview = this.sweepAsks(side, sharesToReverse, { consume: false });
    if (!buyPreview?.complete) {
      state.status = 'WAITING_FOR_FULL_DEPTH';
      state.reason = `Waiting for full ${round(sharesToReverse)}-share ${side} ask depth before reversing.`;
      this.log('REVERSAL_WAITING_FOR_DEPTH', state.reason, {
        side, oppositeSide, shares: round(sharesToReverse), triggerType,
      });
      return false;
    }
    if (this.cash + sellPreview.netProceeds + EPSILON < buyPreview.totalCost) {
      state.status = 'INSUFFICIENT_CAPITAL';
      state.reason = `Reversal needs $${buyPreview.totalCost.toFixed(2)} after the sale; only $${(this.cash + sellPreview.netProceeds).toFixed(2)} would be available.`;
      this.log('REVERSAL_BLOCKED_CAPITAL', state.reason, {
        side, oppositeSide, shares: round(sharesToReverse),
        requiredCash: round(buyPreview.totalCost),
        availableAfterSale: round(this.cash + sellPreview.netProceeds),
        triggerType,
      });
      return false;
    }

    const sellExecution = this.sweepBids(oppositeSide, sharesToReverse);
    if (!sellExecution?.complete) return false;
    this.closePositionsOnOppositeSignal(oppositeTrades, sellExecution, now, side);
    this.log('OPPOSITE_SIGNAL_SELL',
      `Sold all ${round(sharesToReverse)} ${oppositeSide} shares at available live bids before reversing to ${side}.`,
      {
        side, oppositeSide, shares: round(sharesToReverse),
        averagePrice: round(sellExecution.averagePrice),
        grossProceeds: round(sellExecution.grossProceeds),
        fees: round(sellExecution.fees),
        netProceeds: round(sellExecution.netProceeds),
        triggerType,
      });
    return this.tryBuy(side, now, triggerType, sharesToReverse, 'OPPOSITE_SIGNAL_REVERSAL');
  }

  closePositionsOnOppositeSignal(trades, execution, now, newSide) {
    const totalShares = execution.shares;
    this.cash = round(this.cash + execution.netProceeds, 8);
    let totalRealized = 0;
    for (const trade of trades) {
      const ratio = trade.shares / totalShares;
      const grossProceeds = execution.grossProceeds * ratio;
      const exitFees = execution.fees * ratio;
      const netProceeds = grossProceeds - exitFees;
      trade.status = 'CLOSED';
      trade.settlementStatus = 'CLOSED';
      trade.closedAt = now;
      trade.exitSide = newSide;
      trade.exitReason = 'OPPOSITE_SIGNAL';
      trade.exitPrice = execution.averagePrice;
      trade.exitGrossProceeds = grossProceeds;
      trade.exitFees = exitFees;
      trade.proceeds = netProceeds;
      trade.realizedPnl = netProceeds - trade.totalCost;
      trade.finalOutcome = 'OPPOSITE_SIGNAL_EXIT';
      trade.settlementSource = 'OPPOSITE_SIGNAL';
      trade.outcome = 'EXIT';
      trade.exitFills = execution.fills;
      totalRealized += trade.realizedPnl;
    }
    this.realizedPnl += totalRealized;
  }

  tryBuy(side, now, triggerType, requestedShares = this.config.SHARES_PER_BUY, entryMode = null) {
    const quote = this.quotes[side];
    const state = this.sideState[side];
    state.lastUpdateAt = now;
    state.lastBestAsk = quote?.bestAsk ?? null;
    if (this.stateStore && !this.storageHealthy) {
      state.status = 'PAPER_HISTORY_STORAGE_ERROR';
      state.reason = 'Trading is paused until durable paper history storage is available.';
      return false;
    }
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
    const execution = this.sweepAsks(side, requestedShares);
    if (!execution || !execution.complete) {
      state.status = 'WAITING_FOR_FULL_DEPTH';
      state.reason = `Ask is in range, but ${requestedShares} shares are not available within the price band.`;
      this.log('ENTRY_WAITING_FOR_DEPTH',
        `${side} ask is in range; waiting for full ${requestedShares}-share visible depth.`,
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
      shares: requestedShares,
      entryPrice: execution.averagePrice,
      triggerAsk: quote.bestAsk,
      triggerType,
      entryMode,
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
    state.reason = `Bought ${trade.shares} ${side} shares at ${trade.entryPrice.toFixed(3)} average${entryMode ? ' after the opposite-side sale' : ''}.`;
    state.buys += 1;
    state.sharesBought += trade.shares;
    this.log('BUY_FILLED',
      `${side} buy filled: ${trade.shares} shares at ${trade.entryPrice.toFixed(3)} average${entryMode ? ' to match the opposite-side shares sold' : ''}.`,
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

  maybeSettleAtTerminalPrice(now) {
    if (!this.market || this.windowStart == null || this.terminalObservation?.winner
      || now < this.windowStart + this.config.TERMINAL_CHECK_SECONDS * 1000
      || now >= this.windowEnd) return;
    const evidence = this.terminalEvidence;
    const upIsWinner = evidence.UP.winnerHitAt != null
      && evidence.DOWN.loserHitAt != null;
    const downIsWinner = evidence.DOWN.winnerHitAt != null
      && evidence.UP.loserHitAt != null;
    const winner = upIsWinner === downIsWinner ? null : upIsWinner ? 'UP' : 'DOWN';
    const evidenceSignature = JSON.stringify(evidence);
    if (this.terminalObservation?.evidenceSignature === evidenceSignature) return;
    const observed = {
      at: now,
      UP: this.quotes.UP?.bestBid ?? null,
      DOWN: this.quotes.DOWN?.bestBid ?? null,
      winner,
      ambiguous: upIsWinner && downIsWinner,
      evidence: JSON.parse(evidenceSignature),
      evidenceSignature,
    };
    this.terminalObservation = observed;

    if (!observed.winner) {
      this.log(observed.ambiguous ? 'TERMINAL_PRICE_AMBIGUOUS' : 'TERMINAL_PRICE_UNCONFIRMED',
        observed.ambiguous
          ? 'Both directions reached terminal thresholds during this window; positions will wait for official resolution.'
          : 'No paired terminal thresholds have been recorded by the 297-second check; positions will wait for official resolution unless both are observed before window end.',
        { at: now, ambiguous: observed.ambiguous, evidence: observed.evidence });
      return;
    }

    const currentTrades = this.trades.filter(trade =>
      trade.status === 'OPEN' && trade.marketId === String(this.market.id));
    for (const trade of currentTrades) {
      const payout = trade.side === observed.winner ? 1 : 0;
      const proceeds = trade.shares * payout;
      trade.status = 'SETTLED';
      trade.settlementStatus = 'SETTLED';
      trade.finalOutcome = 'TERMINAL_PRICE_297S';
      trade.settlementSource = 'TERMINAL_PRICE_297S';
      trade.resolutionPayout = payout;
      trade.proceeds = proceeds;
      trade.realizedPnl = proceeds - trade.totalCost;
      trade.settledAt = now;
      trade.outcome = payout === 1 ? 'WIN' : 'LOSS';
      this.cash = round(this.cash + proceeds, 8);
      this.realizedPnl += trade.realizedPnl;
      this.log('TERMINAL_PRICE_SETTLEMENT',
        `BTC ${trade.side} counted as ${payout ? '$1' : '$0'} per share from terminal prices recorded this window.`,
        {
          tradeId: trade.id, winner: observed.winner, payout,
          upWinnerBid: observed.evidence.UP.winnerBid,
          upLoserBid: observed.evidence.UP.loserBid,
          downWinnerBid: observed.evidence.DOWN.winnerBid,
          downLoserBid: observed.evidence.DOWN.loserBid,
          realizedPnl: round(trade.realizedPnl),
        });
    }
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
      this.maybeSettleAtTerminalPrice(now);
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
      this.schedulePersistedState();
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
      closedPositions: this.trades.filter(trade => trade.status === 'CLOSED').length,
      wins: settled.filter(trade => trade.outcome === 'WIN').length,
      losses: settled.filter(trade => trade.outcome === 'LOSS').length,
      takerFees: round(this.trades.reduce((sum, trade) => sum + trade.fees + (trade.exitFees || 0), 0), 2),
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
      status: this.persistenceStatus === 'LOADING'
        ? 'STARTING'
        : this.error ? 'WARNING' : this.running ? 'RUNNING' : 'STOPPED',
      statusReason: this.statusReason,
      error: this.error,
      persistence: {
        status: this.persistenceStatus,
        lastSavedAt: this.lastStateSavedAt,
      },
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
        intraWindowSales: true,
        reversalRule: 'On an opposite-side qualifying ask trigger, sell all current-window shares at available live bids, then buy the same share count on the triggered side.',
        terminalCheckSeconds: this.config.TERMINAL_CHECK_SECONDS,
        terminalThresholds: {
          winnerBestBidAtLeast: this.config.TERMINAL_WINNER_BID,
          loserBestBidBelow: this.config.TERMINAL_LOSER_BID,
        },
        settlement: 'At 297 seconds or later, use any recorded in-window $0.99+ winner bid and opposing below-$0.01 loser bid; if both directions qualify or neither qualifies, use exact original-market resolution.',
        resolutionPollMs: this.config.RESOLUTION_POLL_MS,
        priceSource: 'Polymarket CLOB market WebSocket',
      },
      window: {
        start: this.windowStart,
        end: this.windowEnd,
        secondsRemaining: windowSeconds,
        terminalObservation: this.terminalObservation,
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
