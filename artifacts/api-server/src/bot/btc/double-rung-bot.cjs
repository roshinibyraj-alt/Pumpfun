'use strict';

const marketDataDefault = require('./wick-market-data.js');
const { feeParameters, takerFeeAt } = require('./paper-trading.js');
const { resolvedPayout } = require('./position-exits.js');

const EPSILON = 1e-8;
const SIDES = Object.freeze(['UP', 'DOWN']);
const DEFAULT_CONFIG = Object.freeze({
  STRATEGY_VERSION: 'btc-5m-clob-independent-double-rungs-tp099-v1',
  WINDOW_MS: 5 * 60 * 1000,
  STARTING_CAPITAL: 3_000,
  BASE_ENTRY_SHARES: 5,
  RUNG_PRICES: Object.freeze([0.20, 0.30, 0.40, 0.50, 0.60, 0.70, 0.80]),
  FIRST_RUNG_SHARES: 10,
  TAKE_PROFIT_BID: 0.99,
  TAKE_PROFIT_PAYOUT_PER_SHARE: 1,
  MAX_QUOTE_AGE_MS: 2_000,
  MAX_BOOK_AGE_MS: 2_000,
  POLL_INTERVAL_MS: 500,
  RESOLUTION_POLL_MS: 5_000,
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

function emptyQuote(side) {
  return {
    side,
    tokenId: null,
    bestAsk: null,
    askSize: 0,
    bestBid: null,
    bidSize: 0,
    updatedAt: null,
    sourceTimestamp: null,
    status: 'WAITING',
  };
}

function normalizeBookLevels(levels, side) {
  return (Array.isArray(levels) ? levels : [])
    .map(level => ({
      price: Number(level?.price),
      size: Number(level?.size),
      availableSize: Number(level?.size),
    }))
    .filter(level => Number.isFinite(level.price)
      && level.price > 0 && level.price < 1
      && Number.isFinite(level.size) && level.size > 0)
    .sort((left, right) => side === 'asks'
      ? left.price - right.price : right.price - left.price);
}

function sideForToken(market, tokenId) {
  if (String(tokenId) === String(market?.tokens?.UP || '')) return 'UP';
  if (String(tokenId) === String(market?.tokens?.DOWN || '')) return 'DOWN';
  return null;
}

function initialSideState(side, windowStart, rungPrices, firstRungShares) {
  return {
    side,
    windowStart,
    baseEntryDone: false,
    baseRequestedShares: null,
    baseFilledShares: 0,
    baseEntryPrice: null,
    baseEntryAt: null,
    lastObservedAsk: null,
    lastObservedAt: null,
    rungOrderCount: 0,
    nextOrderShares: firstRungShares,
    stopped: false,
    stopReason: null,
    stoppedAt: null,
    rungs: rungPrices.map(price => ({
      price,
      status: 'AVAILABLE',
      requestedShares: null,
      filledShares: 0,
      averageFillPrice: null,
      triggeredAt: null,
      triggerAsk: null,
      tradeIds: [],
    })),
  };
}

function crossedLevels(previous, current, rungs) {
  if (!Number.isFinite(previous) || !Number.isFinite(current)
    || Math.abs(previous - current) < EPSILON) return [];
  if (current > previous) {
    return rungs
      .filter(rung => rung.status === 'AVAILABLE'
        && previous < rung.price - EPSILON
        && current >= rung.price - EPSILON)
      .sort((left, right) => left.price - right.price);
  }
  return rungs
    .filter(rung => rung.status === 'AVAILABLE'
      && previous > rung.price + EPSILON
      && current <= rung.price + EPSILON)
    .sort((left, right) => right.price - left.price);
}

class BtcDoubleRungBot {
  constructor(options = {}) {
    this.config = { ...DEFAULT_CONFIG, ...(options.config || {}) };
    this.now = options.now || Date.now;
    this.marketData = options.marketData || marketDataDefault;
    this.stateStore = options.stateStore || null;
    this.storageHealthy = !this.stateStore;
    this.persistenceStatus = this.stateStore ? 'NOT_STARTED' : 'DISABLED';

    this.running = false;
    this.status = 'STARTING';
    this.statusReason = 'Starting the Polymarket CLOB connection and paper ledger.';
    this.error = null;
    this.startingCapital = this.config.STARTING_CAPITAL;
    this.cash = this.startingCapital;
    this.realizedPnl = 0;
    this.trades = [];
    this.events = [];
    this.tradeSequence = 0;
    this.eventSequence = 0;

    this.windowStart = null;
    this.windowEnd = null;
    this.market = null;
    this.books = new Map();
    this.quotes = { UP: emptyQuote('UP'), DOWN: emptyQuote('DOWN') };
    this.sideStates = {
      UP: initialSideState('UP', null, this.config.RUNG_PRICES, this.config.FIRST_RUNG_SHARES),
      DOWN: initialSideState('DOWN', null, this.config.RUNG_PRICES, this.config.FIRST_RUNG_SHARES),
    };

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
  }

  async start() {
    if (this.running) return this.snapshot();
    this.running = true;
    try {
      if (this.stateStore) {
        this.persistenceStatus = 'CONNECTING';
        await this.stateStore.initialize();
        const resetRequestId = String(
          process.env.BTC_PAPER_MISPRICING_HISTORY_RESET_REQUEST_ID || '',
        ).trim();
        if (resetRequestId) {
          if (typeof this.stateStore.resetHistoryOnce !== 'function') {
            throw new Error('A paper history reset was requested, but the durable store cannot reset history.');
          }
          const reset = await this.stateStore.resetHistoryOnce(
            resetRequestId,
            this.emptyHistoryState(),
          );
          if (reset) console.log('BTC paper double-rung history reset completed.');
        }
        const saved = await this.stateStore.loadState();
        if (saved) this.restoreState(saved);
        this.storageHealthy = true;
        this.persistenceStatus = 'CONNECTED';
      }
      await this.tick();
      this.timer = setInterval(() => {
        void this.tick();
      }, this.config.POLL_INTERVAL_MS);
      this.timer.unref?.();
      if (this.status === 'STARTING') this.status = 'RUNNING';
      this.schedulePersist(true);
    } catch (error) {
      this.error = error?.message || 'The paper bot failed to start.';
      this.status = 'ERROR';
      this.statusReason = 'Trading is paused until the CLOB feed and paper ledger are ready.';
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
    this.status = 'STOPPED';
  }

  restoreState(state) {
    this.startingCapital = Number(state.startingCapital) || this.config.STARTING_CAPITAL;
    this.cash = Number.isFinite(Number(state.cash)) ? Number(state.cash) : this.startingCapital;
    this.realizedPnl = Number(state.realizedPnl) || 0;
    this.trades = Array.isArray(state.trades) ? state.trades : [];
    for (const trade of this.trades) trade.markFresh = false;
    this.events = Array.isArray(state.events) ? state.events.slice(0, 300) : [];
    this.tradeSequence = Math.max(
      Number(state.tradeSequence) || 0,
      ...this.trades.map(trade => {
        const match = String(trade.id || '').match(/^misprice-trade-(\d+)$/);
        return match ? Number(match[1]) : 0;
      }),
    );
    this.eventSequence = Math.max(
      Number(state.eventSequence) || 0,
      ...this.events.map(event => {
        const match = String(event.id || '').match(/^misprice-event-(\d+)$/);
        return match ? Number(match[1]) : 0;
      }),
    );
    const currentStart = Math.floor(this.now() / this.config.WINDOW_MS) * this.config.WINDOW_MS;
    const sameStrategy = state.strategyVersion === this.config.STRATEGY_VERSION;
    this.windowStart = Number.isFinite(Number(state.windowStart))
      ? Number(state.windowStart) : null;
    this.windowEnd = this.windowStart == null ? null : this.windowStart + this.config.WINDOW_MS;
    const restoreCurrentWindow = sameStrategy && this.windowStart === currentStart;
    if (restoreCurrentWindow && state.sideStates) {
      for (const side of SIDES) {
        const saved = state.sideStates[side];
        if (!saved || Number(saved.windowStart) !== currentStart) continue;
        const savedRungs = new Map((Array.isArray(saved.rungs) ? saved.rungs : [])
          .map(rung => [Number(rung.price), rung]));
        this.sideStates[side] = {
          ...initialSideState(side, currentStart, this.config.RUNG_PRICES, this.config.FIRST_RUNG_SHARES),
          ...saved,
          rungs: this.config.RUNG_PRICES.map(price => ({
            ...initialSideState(side, currentStart, [price], this.config.FIRST_RUNG_SHARES).rungs[0],
            ...(savedRungs.get(price) || {}),
          })),
        };
      }
    } else {
      this.windowStart = null;
      this.windowEnd = null;
    }
    if (state.strategyVersion !== this.config.STRATEGY_VERSION) {
      let migratedOpenTrades = 0;
      for (const trade of this.trades) {
        if (trade.status !== 'OPEN') continue;
        trade.status = 'AWAITING_RESOLUTION';
        trade.settlementStatus = 'AWAITING_RESOLUTION';
        trade.awaitingResolutionAt = this.now();
        migratedOpenTrades += 1;
      }
      this.log(
        'STRATEGY_STATE_MIGRATED',
        'The active paper strategy changed; prior open positions remain attached to their original markets for settlement.',
        {
          previousVersion: state.strategyVersion || 'unknown',
          nextVersion: this.config.STRATEGY_VERSION,
          migratedOpenTrades,
        },
      );
    }
    this.market = null;
    this.books.clear();
    this.quotes = { UP: emptyQuote('UP'), DOWN: emptyQuote('DOWN') };
    this.statusReason = 'Restored paper ledger; the independent double-rung strategy is active.';
  }

  persistentStateSnapshot() {
    return {
      schemaVersion: 3,
      strategyVersion: this.config.STRATEGY_VERSION,
      startingCapital: this.startingCapital,
      cash: this.cash,
      realizedPnl: this.realizedPnl,
      trades: this.trades,
      events: this.events,
      tradeSequence: this.tradeSequence,
      eventSequence: this.eventSequence,
      windowStart: this.windowStart,
      sideStates: this.sideStates,
    };
  }

  emptyHistoryState() {
    return {
      schemaVersion: 3,
      strategyVersion: this.config.STRATEGY_VERSION,
      startingCapital: this.config.STARTING_CAPITAL,
      cash: this.config.STARTING_CAPITAL,
      realizedPnl: 0,
      trades: [],
      events: [],
      tradeSequence: 0,
      eventSequence: 0,
      windowStart: null,
      sideStates: null,
    };
  }

  async persist() {
    if (!this.stateStore) return true;
    const state = this.persistentStateSnapshot();
    this.persistInFlight = this.persistInFlight
      .catch(() => undefined)
      .then(() => this.stateStore.saveState(state));
    try {
      await this.persistInFlight;
      this.storageHealthy = true;
      this.persistenceStatus = 'CONNECTED';
      return true;
    } catch (error) {
      this.storageHealthy = false;
      this.persistenceStatus = 'ERROR';
      this.error = error?.message || 'Paper history could not be saved.';
      this.status = 'ERROR';
      this.statusReason = 'The paper ledger is unavailable; new entries are paused.';
      return false;
    }
  }

  schedulePersist(immediate = false) {
    if (!this.stateStore) return;
    clearTimeout(this.persistenceTimer);
    this.persistenceTimer = setTimeout(() => {
      this.persistenceTimer = null;
      void this.persist();
    }, immediate ? 0 : 250);
    this.persistenceTimer.unref?.();
  }

  log(type, message, data = {}) {
    const event = {
      id: `misprice-event-${++this.eventSequence}`,
      type,
      message,
      at: this.now(),
      ...data,
    };
    this.events.unshift(event);
    if (this.events.length > 300) this.events.length = 300;
    return event;
  }

  closeMarketStream() {
    this.streamGeneration += 1;
    try {
      this.marketStream?.close?.();
      this.marketStream?.unsubscribe?.();
    } catch {
      // The stream can already be closed during a window transition.
    }
    this.marketStream = null;
  }

  async resetWindow(start) {
    for (const trade of this.trades) {
      if (trade.status !== 'OPEN' || Number(trade.windowStart) === start) continue;
      trade.status = 'AWAITING_RESOLUTION';
      trade.settlementStatus = 'AWAITING_RESOLUTION';
      trade.awaitingResolutionAt = this.now();
      this.log(
        'POSITION_AWAITING_RESOLUTION',
        `${trade.side} position moved to official resolution for its original 5-minute market.`,
        { tradeId: trade.id, marketId: trade.marketId, shares: trade.shares },
      );
    }
    this.closeMarketStream();
    this.windowStart = start;
    this.windowEnd = start + this.config.WINDOW_MS;
    this.market = null;
    this.books.clear();
    this.quotes = { UP: emptyQuote('UP'), DOWN: emptyQuote('DOWN') };
    this.sideStates = {
      UP: initialSideState('UP', start, this.config.RUNG_PRICES, this.config.FIRST_RUNG_SHARES),
      DOWN: initialSideState('DOWN', start, this.config.RUNG_PRICES, this.config.FIRST_RUNG_SHARES),
    };
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
      await Promise.all(SIDES.map(async side => {
        const book = await this.marketData.getBook(market.tokens[side]);
        this.applyBookSnapshot({
          asset_id: market.tokens[side],
          bids: book?.bids,
          asks: book?.asks,
          timestamp: book?.timestamp || book?.updatedAt || this.now(),
        }, this.now());
      }));
      this.startMarketStream(market);
      this.error = null;
      this.statusReason = 'The BTC 5-minute CLOB is live; UP and DOWN entries are managed independently.';
      this.nextMarketLoadAt = 0;
      return true;
    } catch (error) {
      this.error = error?.message || 'Could not load the current BTC market.';
      this.statusReason = 'Waiting for the current Polymarket market and order books.';
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
      throw new Error('The Polymarket CLOB WebSocket is unavailable.');
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
    if (this.market) this.evaluate(this.now());
  }

  applyBookSnapshot(event, now) {
    const tokenId = String(event.asset_id || event.assetId || '');
    const side = sideForToken(this.market, tokenId);
    if (!side) return false;
    const book = {
      bids: normalizeBookLevels(event.bids, 'bids'),
      asks: normalizeBookLevels(event.asks, 'asks'),
      updatedAt: now,
      sourceTimestamp: timestamp(event.timestamp, now),
    };
    this.books.set(tokenId, book);
    this.updateQuoteFromBook(side, tokenId, book, now);
    return true;
  }

  applyLevelChange(book, change) {
    const price = Number(change.price);
    const size = Number(change.size);
    if (!(price > 0 && price < 1) || !Number.isFinite(size)) return;
    const kind = String(change.side || '').toUpperCase();
    const isAsk = kind === 'SELL' || kind === 'ASK' || kind === 'ASKS';
    const levels = isAsk ? book.asks
      : kind === 'BUY' || kind === 'BID' || kind === 'BIDS' ? book.bids : null;
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
    levels.sort((left, right) => isAsk
      ? left.price - right.price : right.price - left.price);
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
      askSize: Number(event.best_ask_size ?? event.bestAskSize ?? previous.askSize) || 0,
      bidSize: Number(event.best_bid_size ?? event.bestBidSize ?? previous.bidSize) || 0,
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

  quoteIsFresh(side, now = this.now()) {
    const quote = this.quotes[side];
    return quote?.status === 'LIVE'
      && Number.isFinite(Number(quote.updatedAt))
      && now >= Number(quote.updatedAt)
      && now - Number(quote.updatedAt) <= this.config.MAX_QUOTE_AGE_MS;
  }

  bookIsFresh(side, now = this.now()) {
    const tokenId = String(this.market?.tokens?.[side] || '');
    const book = this.books.get(tokenId);
    return Boolean(book
      && Number.isFinite(Number(book.updatedAt))
      && now >= Number(book.updatedAt)
      && now - Number(book.updatedAt) <= this.config.MAX_BOOK_AGE_MS);
  }

  hasExecutableAskBook(side, now = this.now()) {
    if (!this.quoteIsFresh(side, now) || !this.bookIsFresh(side, now)) return false;
    const quoteAsk = Number(this.quotes[side]?.bestAsk);
    const tokenId = String(this.market?.tokens?.[side] || '');
    const bestBookAsk = this.books.get(tokenId)?.asks?.[0]?.price;
    return Number.isFinite(quoteAsk) && Number.isFinite(Number(bestBookAsk))
      && Math.abs(Number(bestBookAsk) - quoteAsk) < EPSILON;
  }

  sweepAsks(side, requestedShares, now) {
    if (!this.hasExecutableAskBook(side, now)) return null;
    const quote = this.quotes[side];
    const tokenId = String(this.market.tokens[side]);
    const book = this.books.get(tokenId);
    const levels = book?.asks;
    if (!Array.isArray(levels) || !levels.length
      || !Number.isFinite(Number(quote.bestAsk))
      || Math.abs(levels[0].price - Number(quote.bestAsk)) >= EPSILON) return null;

    const fees = feeParameters(this.market);
    let remaining = requestedShares;
    let grossCost = 0;
    let feeTotal = 0;
    const fills = [];
    for (const level of levels) {
      if (remaining <= EPSILON || this.cash - grossCost - feeTotal <= EPSILON) break;
      const sizeAvailable = Math.max(0, Number(level.availableSize) || 0);
      if (sizeAvailable <= EPSILON) continue;
      const feePerShare = takerFeeAt(level.price, 1, fees);
      const affordable = (this.cash - grossCost - feeTotal) / (level.price + feePerShare);
      const shares = Math.min(remaining, sizeAvailable, Math.max(0, affordable));
      if (shares <= EPSILON) continue;
      const cost = shares * level.price;
      const fee = takerFeeAt(level.price, shares, fees);
      fills.push({ price: level.price, shares, grossCost: cost, fee });
      grossCost += cost;
      feeTotal += fee;
      remaining -= shares;
      level.availableSize -= shares;
    }
    const filledShares = requestedShares - remaining;
    if (filledShares <= EPSILON) return null;
    return {
      requestedShares,
      shares: filledShares,
      remainingShares: Math.max(0, remaining),
      grossCost,
      fees: feeTotal,
      totalCost: grossCost + feeTotal,
      averagePrice: grossCost / filledShares,
      complete: remaining <= EPSILON,
      fills,
    };
  }

  recordMarketBuy(side, requestedShares, reason, now, extra = {}) {
    const fill = this.sweepAsks(side, requestedShares, now);
    if (!fill) return null;
    const trade = {
      id: `misprice-trade-${++this.tradeSequence}`,
      asset: 'BTC',
      side,
      marketId: String(this.market.id),
      marketSlug: this.market.slug,
      marketTitle: this.market.title || this.market.slug,
      tokenId: String(this.market.tokens[side]),
      windowStart: this.windowStart,
      windowEnd: this.windowEnd,
      shares: round(fill.shares, 8),
      requestedShares,
      entryPrice: round(fill.averagePrice, 8),
      totalCost: round(fill.totalCost, 8),
      grossCost: round(fill.grossCost, 8),
      fees: round(fill.fees, 8),
      exitFees: 0,
      fills: fill.fills.map(item => ({
        price: round(item.price, 8),
        shares: round(item.shares, 8),
        cost: round(item.grossCost, 8),
        fee: round(item.fee, 8),
      })),
      openedAt: now,
      entryOrderType: 'MARKET',
      entryReason: reason,
      strategyVersion: this.config.STRATEGY_VERSION,
      ...extra,
      status: 'OPEN',
      settlementStatus: 'OPEN',
      settlementSource: null,
      markPrice: null,
      markValue: null,
      unrealizedPnl: null,
      markFresh: false,
      markAt: null,
      realizedPnl: null,
      outcome: null,
    };
    this.trades.push(trade);
    this.cash = round(this.cash - fill.totalCost, 8);
    this.log('MARKET_BUY_FILLED',
      `${side} ${fill.complete ? 'market buy filled' : 'market buy partially filled'}: ${round(fill.shares, 4)} of ${requestedShares} requested shares.`,
      {
        tradeId: trade.id,
        side,
        requestedShares,
        filledShares: round(fill.shares, 8),
        remainingShares: round(fill.remainingShares, 8),
        averagePrice: round(fill.averagePrice, 6),
        totalCost: round(fill.totalCost, 6),
        fees: round(fill.fees, 6),
        entryReason: reason,
        rungPrice: extra.rungPrice ?? null,
      });
    this.schedulePersist(true);
    return trade;
  }

  recordSeedEntry(side, now) {
    const state = this.sideStates[side];
    if (state.baseEntryDone || state.stopped || !this.hasExecutableAskBook(side, now)) return false;
    const ask = Number(this.quotes[side].bestAsk);
    if (!(ask > 0 && ask < 1)) return false;
    const trade = this.recordMarketBuy(
      side,
      this.config.BASE_ENTRY_SHARES,
      'WINDOW_SEED',
      now,
      { rungPrice: null, orderSequence: 0 },
    );
    if (!trade) return false;
    state.baseEntryDone = true;
    state.baseRequestedShares = this.config.BASE_ENTRY_SHARES;
    state.baseFilledShares = trade.shares;
    state.baseEntryPrice = trade.entryPrice;
    state.baseEntryAt = now;
    state.lastObservedAsk = ask;
    state.lastObservedAt = now;
    const seedLevel = state.rungs.find(rung => Math.abs(rung.price - ask) < EPSILON);
    if (seedLevel) {
      seedLevel.status = 'USED_BY_SEED';
      seedLevel.requestedShares = 0;
      seedLevel.filledShares = 0;
      seedLevel.triggeredAt = now;
      seedLevel.triggerAsk = ask;
    }
    this.log('BASE_ENTRY_OPENED',
      `${side} window seed entered with ${round(trade.shares, 4)} shares at the current ask.`,
      {
        tradeId: trade.id,
        side,
        requestedShares: this.config.BASE_ENTRY_SHARES,
        filledShares: trade.shares,
        averagePrice: trade.entryPrice,
      });
    return true;
  }

  processRungCrossings(side, now) {
    const state = this.sideStates[side];
    if (!state.baseEntryDone || state.stopped || !this.hasExecutableAskBook(side, now)) return false;
    const currentAsk = Number(this.quotes[side].bestAsk);
    if (!(currentAsk > 0 && currentAsk < 1)) return false;
    const previousAsk = Number(state.lastObservedAsk);
    if (!Number.isFinite(previousAsk)) {
      state.lastObservedAsk = currentAsk;
      state.lastObservedAt = now;
      return false;
    }

    const crossed = crossedLevels(previousAsk, currentAsk, state.rungs);
    let changed = false;
    for (const rung of crossed) {
      const requestedShares = state.nextOrderShares;
      rung.status = 'TRIGGERED';
      rung.requestedShares = requestedShares;
      rung.triggeredAt = now;
      rung.triggerAsk = currentAsk;
      state.rungOrderCount += 1;
      state.nextOrderShares = requestedShares * 2;
      const trade = this.recordMarketBuy(
        side,
        requestedShares,
        'RUNG_CROSS',
        now,
        {
          rungPrice: rung.price,
          rungOrderIndex: state.rungOrderCount,
          triggerAsk: currentAsk,
        },
      );
      if (trade) {
        rung.filledShares = trade.shares;
        rung.averageFillPrice = trade.entryPrice;
        rung.tradeIds.push(trade.id);
        rung.status = trade.shares + EPSILON >= requestedShares ? 'FILLED' : 'PARTIAL';
        this.log('RUNG_TRIGGERED',
          `${side} crossed $${rung.price.toFixed(2)}; requested ${requestedShares} shares at the current ask.`,
          {
            side,
            rungPrice: rung.price,
            orderIndex: state.rungOrderCount,
            requestedShares,
            filledShares: trade.shares,
            triggerAsk: currentAsk,
            tradeId: trade.id,
          });
      } else {
        rung.status = 'NO_FILL';
        this.log('RUNG_NO_FILL',
          `${side} crossed $${rung.price.toFixed(2)}, but no fresh executable ask depth or cash was available.`,
          { side, rungPrice: rung.price, requestedShares, triggerAsk: currentAsk });
      }
      changed = true;
    }
    state.lastObservedAsk = currentAsk;
    state.lastObservedAt = now;
    if (changed) this.schedulePersist(true);
    return changed;
  }

  openTradesForSide(side) {
    return this.trades.filter(trade => trade.status === 'OPEN'
      && trade.side === side
      && Number(trade.windowStart) === this.windowStart
      && String(trade.marketId) === String(this.market?.id));
  }

  closeSideAtTakeProfit(side, bid, now) {
    const state = this.sideStates[side];
    const trades = this.openTradesForSide(side);
    if (!trades.length || state.stopped) return false;
    let sidePnl = 0;
    let sideShares = 0;
    for (const trade of trades) {
      const proceeds = trade.shares * this.config.TAKE_PROFIT_PAYOUT_PER_SHARE;
      trade.status = 'SETTLED';
      trade.settlementStatus = 'SETTLED';
      trade.settlementSource = 'INTRAWINDOW_TAKE_PROFIT';
      trade.exitReason = 'TAKE_PROFIT_BID';
      trade.exitPrice = this.config.TAKE_PROFIT_PAYOUT_PER_SHARE;
      trade.exitTriggerBid = bid;
      trade.proceeds = proceeds;
      trade.realizedPnl = round(proceeds - trade.totalCost, 8);
      trade.outcome = trade.realizedPnl >= 0 ? 'WIN' : 'LOSS';
      trade.settledAt = now;
      trade.closedAt = now;
      this.cash = round(this.cash + proceeds, 8);
      this.realizedPnl = round(this.realizedPnl + trade.realizedPnl, 8);
      sidePnl += trade.realizedPnl;
      sideShares += trade.shares;
    }
    state.stopped = true;
    state.stopReason = 'TAKE_PROFIT';
    state.stoppedAt = now;
    this.log('SIDE_TAKE_PROFIT',
      `${side} best bid reached $${bid.toFixed(3)}; all ${round(sideShares, 4)} shares paid out at $1 each. This side is done for the window.`,
      {
        side,
        shares: round(sideShares, 8),
        triggerBid: bid,
        payoutPerShare: this.config.TAKE_PROFIT_PAYOUT_PER_SHARE,
        realizedPnl: round(sidePnl, 8),
        tradeIds: trades.map(trade => trade.id),
      });
    this.schedulePersist(true);
    return true;
  }

  processTakeProfits(now) {
    if (!this.market || this.windowEnd == null || now >= this.windowEnd) return false;
    let changed = false;
    for (const side of SIDES) {
      if (!this.quoteIsFresh(side, now)) continue;
      const bid = Number(this.quotes[side].bestBid);
      if (Number.isFinite(bid) && bid >= this.config.TAKE_PROFIT_BID) {
        changed = this.closeSideAtTakeProfit(side, bid, now) || changed;
      }
    }
    return changed;
  }

  evaluate(now = this.now()) {
    if (!this.market || this.windowStart == null || !this.storageHealthy
      || now >= this.windowEnd) return false;
    let changed = this.processTakeProfits(now);
    for (const side of SIDES) {
      const state = this.sideStates[side];
      if (state.stopped) continue;
      if (!state.baseEntryDone) {
        if (this.recordSeedEntry(side, now)) changed = true;
        continue;
      }
      changed = this.processRungCrossings(side, now) || changed;
    }
    return changed;
  }

  updateOpenMarks(now) {
    for (const trade of this.trades) {
      if (trade.status !== 'OPEN') continue;
      const quote = this.quotes[trade.side];
      if (!this.quoteIsFresh(trade.side, now)
        || !Number.isFinite(Number(quote.bestBid))) {
        trade.markFresh = false;
        continue;
      }
      trade.markPrice = Number(quote.bestBid);
      trade.markValue = trade.shares * trade.markPrice;
      trade.unrealizedPnl = trade.markValue - trade.totalCost;
      trade.markAt = now;
      trade.markFresh = true;
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
          trade.outcome = trade.realizedPnl >= 0 ? 'WIN' : 'LOSS';
          this.cash = round(this.cash + proceeds, 8);
          this.realizedPnl = round(this.realizedPnl + trade.realizedPnl, 8);
          this.log('POSITION_RESOLVED',
            `${trade.side} settled from its exact original Polymarket market at $${payout.toFixed(2)} per share.`,
            {
              tradeId: trade.id,
              marketId,
              payout,
              realizedPnl: round(trade.realizedPnl, 8),
              outcome: trade.outcome,
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
      this.error = error?.message || 'Double-rung evaluation failed.';
      this.status = 'ERROR';
      this.statusReason = 'The paper bot paused after an evaluation error.';
      return this.snapshot();
    } finally {
      this.tickInProgress = false;
    }
  }

  sidePositionSnapshot(side, now) {
    const trades = this.openTradesForSide(side);
    const shares = trades.reduce((sum, trade) => sum + (Number(trade.shares) || 0), 0);
    const totalCost = trades.reduce((sum, trade) => sum + (Number(trade.totalCost) || 0), 0);
    const markComplete = trades.length > 0
      && trades.every(trade => Number.isFinite(Number(trade.markValue))
        && Number.isFinite(Number(trade.unrealizedPnl))
        && trade.markFresh === true);
    const markValue = markComplete
      ? trades.reduce((sum, trade) => sum + Number(trade.markValue), 0)
      : null;
    const unrealizedPnl = markComplete
      ? trades.reduce((sum, trade) => sum + Number(trade.unrealizedPnl), 0)
      : null;
    const state = this.sideStates[side];
    return {
      ...state,
      shares: round(shares, 8),
      totalCost: round(totalCost, 8),
      averageCost: shares > 0 ? round(totalCost / shares, 8) : null,
      markPrice: this.quoteIsFresh(side, now)
        ? this.quotes[side].bestBid : null,
      markValue: markValue == null ? null : round(markValue, 8),
      unrealizedPnl: unrealizedPnl == null ? null : round(unrealizedPnl, 8),
      openTradeCount: trades.length,
      fillStatus: state.stopped
        ? 'STOPPED_AFTER_TP'
        : state.baseEntryDone
          ? (Number(state.baseFilledShares) + EPSILON < Number(state.baseRequestedShares)
            ? (state.rungs.some(rung => ['FILLED', 'PARTIAL'].includes(rung.status))
              ? 'BASE_PARTIAL_AND_RUNGS_ACTIVE' : 'BASE_PARTIAL')
            : state.rungs.some(rung => ['FILLED', 'PARTIAL'].includes(rung.status))
              ? 'BASE_AND_RUNGS_ACTIVE' : 'BASE_FILLED')
          : this.quoteIsFresh(side, now) ? 'WAITING_FOR_EXECUTABLE_BOOK' : 'WAITING_FOR_LIVE_BOOK',
    };
  }

  accountSnapshot() {
    const openTrades = this.trades.filter(trade => trade.status === 'OPEN');
    const awaiting = this.trades.filter(trade => trade.status === 'AWAITING_RESOLUTION');
    const settled = this.trades.filter(trade => trade.status === 'SETTLED');
    const markedValue = openTrades.reduce((sum, trade) =>
      sum + (Number(trade.markValue) || 0), 0);
    const pendingMarkValue = awaiting.reduce((sum, trade) =>
      sum + (Number(trade.markValue) || 0), 0);
    const markedPnl = [...openTrades, ...awaiting].reduce((sum, trade) =>
      sum + (Number(trade.unrealizedPnl) || 0), 0);
    return {
      startingCapital: round(this.startingCapital, 2),
      cash: round(this.cash, 2),
      openCost: round(openTrades.reduce((sum, trade) => sum + trade.totalCost, 0), 2),
      pendingResolutionCost: round(awaiting.reduce((sum, trade) => sum + trade.totalCost, 0), 2),
      realizedPnl: round(this.realizedPnl, 2),
      unrealizedPnl: round(markedPnl, 2),
      markedValue: round(markedValue, 2),
      pendingResolutionMarkedValue: round(pendingMarkValue, 2),
      equity: round(this.cash + markedValue + pendingMarkValue, 2),
      openPositions: openTrades.length,
      pendingResolutionPositions: awaiting.length,
      settledPositions: settled.length,
      wins: settled.filter(trade => trade.outcome === 'WIN').length,
      losses: settled.filter(trade => trade.outcome === 'LOSS').length,
      takerFees: round(this.trades.reduce((sum, trade) =>
        sum + (Number(trade.fees) || 0) + (Number(trade.exitFees) || 0), 0), 2),
      staleMarkPositions: [...openTrades, ...awaiting]
        .filter(trade => !trade.markFresh && Number.isFinite(Number(trade.markValue))).length,
      estimatedMakerRebates: 0,
      tradeCount: this.trades.length,
    };
  }

  snapshot() {
    const now = this.now();
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
        entryOrderType: 'MARKET BUY (PAPER)',
        entryPolicy: 'UP and DOWN are independent: buy 5 shares on each side at the first fresh executable ask each window.',
        baseShares: this.config.BASE_ENTRY_SHARES,
        rungPrices: this.config.RUNG_PRICES,
        rungSizing: 'Each crossed price level can trigger once per side per window; successive rung requests double from 10 shares.',
        fillRule: 'Market buys sweep the fresh visible CLOB asks; actual depth, partial fills, cash limits, and taker fees are recorded.',
        takeProfitBid: this.config.TAKE_PROFIT_BID,
        takeProfitPayoutPerShare: this.config.TAKE_PROFIT_PAYOUT_PER_SHARE,
        exitPolicy: 'At a side best bid of $0.99, pay $1 per share, close all shares on that side, and stop that side for the window. No stop-loss; other open shares wait for official resolution.',
        priceSource: 'Polymarket CLOB best ask for entries and rung crossings; best bid for take-profit and position marks.',
        takerFees: true,
        modeledMakerRebate: false,
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
      websocket: { ...this.websocket },
      quotes: {
        UP: {
          ...this.quotes.UP,
          bookUpdatedAt: this.books.get(String(this.market?.tokens?.UP || ''))?.updatedAt ?? null,
        },
        DOWN: {
          ...this.quotes.DOWN,
          bookUpdatedAt: this.books.get(String(this.market?.tokens?.DOWN || ''))?.updatedAt ?? null,
        },
      },
      sideState: {
        UP: this.sidePositionSnapshot('UP', now),
        DOWN: this.sidePositionSnapshot('DOWN', now),
      },
      account: this.accountSnapshot(),
      trades: this.trades.slice().sort((left, right) =>
        Number(right.openedAt) - Number(left.openedAt)),
      events: this.events.slice(0, 100),
    };
  }
}

module.exports = {
  BtcDoubleRungBot,
  DEFAULT_CONFIG,
  crossedLevels,
};
