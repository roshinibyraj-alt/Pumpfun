'use strict';

const { BinanceTickFeed, CANDLE_MS } = require('./binance-tick-feed.cjs');
const marketDataDefault = require('./wick-market-data.js');
const { feeParameters, takerFeeAt } = require('./paper-trading.js');
const { resolvedPayout } = require('./position-exits.js');
const { normalizeLevels } = require('./btc-price-band-bot.cjs');

const EPSILON = 1e-8;
const DEFAULT_CONFIG = Object.freeze({
  STRATEGY_VERSION: 'btc-5m-binance-mispricing-3candle-v1',
  WINDOW_MS: CANDLE_MS,
  STARTING_CAPITAL: 3_000,
  BASE_SHARES: 100,
  VOLATILITY_CANDLES: 3,
  MIN_NET_EDGE_PER_SHARE: 0.05,
  MAX_FLIPS_PER_WINDOW: 1,
  MAX_DATA_AGE_MS: 2_000,
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
    this.eventSequence = 0;
    this.windowStart = null;
    this.windowEnd = null;
    this.market = null;
    this.books = new Map();
    this.quotes = { UP: emptyQuote('UP'), DOWN: emptyQuote('DOWN') };
    this.entryTriggeredThisWindow = false;
    this.flipsThisWindow = 0;
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
    this.eventSequence = Math.max(
      Number(state.eventSequence) || 0,
      ...this.events.map(event => {
        const match = String(event.id || '').match(/^misprice-event-(\d+)$/);
        return match ? Number(match[1]) : 0;
      }),
    );
    this.windowStart = Number.isFinite(Number(state.windowStart))
      ? Number(state.windowStart) : null;
    this.windowEnd = this.windowStart == null ? null : this.windowStart + this.config.WINDOW_MS;
    this.entryTriggeredThisWindow = state.entryTriggeredThisWindow === true;
    this.flipsThisWindow = Math.max(0, Number(state.flipsThisWindow) || 0);
    this.market = null;
    this.books.clear();
    this.quotes = { UP: emptyQuote('UP'), DOWN: emptyQuote('DOWN') };
    this.statusReason = 'Restored the separate mispricing paper ledger.';
  }

  persistentStateSnapshot() {
    return {
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
      entryTriggeredThisWindow: this.entryTriggeredThisWindow,
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
    this.flipsThisWindow = 0;
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
    const type = event.event_type || event.eventType;
    if (!type || type === 'PONG') return;
    this.websocket.lastMessageAt = this.now();
    this.websocket.error = null;
    if (type === 'book') this.applyBookSnapshot(event, this.now());
    else if (type === 'price_change') this.applyPriceChanges(event, this.now());
    else if (type === 'best_bid_ask') this.applyBestBidAsk(event, this.now());
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

  evaluate(now = this.now()) {
    if (!this.market || this.windowStart == null || !this.storageHealthy) return false;
    const model = this.modelSnapshot(now);
    this.model = model;
    if (!model.ready) {
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
    const candidates = ['UP', 'DOWN'].map(side => {
      if (!this.sideQuoteIsFresh(side, now)) return null;
      const preview = this.sweep(side, 'asks', this.config.BASE_SHARES);
      if (!preview?.complete) return null;
      const probability = side === 'UP' ? model.probabilityUp : model.probabilityDown;
      const expectedProfit = probability * this.config.BASE_SHARES - preview.totalCost;
      return {
        side,
        preview,
        expectedProfit,
        edgePerShare: expectedProfit / this.config.BASE_SHARES,
      };
    }).filter(candidate => candidate
      && candidate.edgePerShare >= this.config.MIN_NET_EDGE_PER_SHARE);
    if (!candidates.length) {
      this.currentSignal = {
        side: null,
        reason: 'No side clears the minimum net edge after visible sweep costs and fees.',
        edgePerShare: null,
      };
      return false;
    }
    candidates.sort((left, right) => right.edgePerShare - left.edgePerShare);
    const selected = candidates[0];
    if (selected.preview.totalCost > this.cash + EPSILON) {
      this.currentSignal = {
        side: selected.side,
        reason: `The ${selected.side} edge qualifies, but paper cash is insufficient.`,
        edgePerShare: selected.edgePerShare,
      };
      return false;
    }
    const execution = this.sweep(selected.side, 'asks', this.config.BASE_SHARES, { consume: true });
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

  evaluateFlip(openTrade, model, now) {
    const opposite = openTrade.side === 'UP' ? 'DOWN' : 'UP';
    if (this.flipsThisWindow >= this.config.MAX_FLIPS_PER_WINDOW
      || now >= this.windowEnd
      || !this.sideQuoteIsFresh(openTrade.side, now)
      || !this.sideQuoteIsFresh(opposite, now)) {
      this.currentSignal = {
        side: opposite,
        reason: 'Holding the current position; no eligible flip is available this window.',
        edgePerShare: null,
      };
      return false;
    }
    const salePreview = this.sweep(openTrade.side, 'bids', openTrade.shares);
    if (!salePreview?.complete) {
      this.currentSignal = {
        side: opposite,
        reason: 'The opposite model signal appeared, but visible bids cannot close the full position.',
        edgePerShare: null,
      };
      return false;
    }
    const liquidationPnl = salePreview.netProceeds - openTrade.totalCost;
    const buyPreview = this.sweep(opposite, 'asks', this.config.BASE_SHARES);
    const oppositeProbability = opposite === 'UP' ? model.probabilityUp : model.probabilityDown;
    const expectedProfit = buyPreview?.complete
      ? oppositeProbability * this.config.BASE_SHARES - buyPreview.totalCost
      : null;
    const edgePerShare = expectedProfit == null
      ? null : expectedProfit / this.config.BASE_SHARES;
    if (liquidationPnl <= EPSILON) {
      this.currentSignal = {
        side: opposite,
        reason: 'Holding: the current position is not net-profitable to liquidate at visible bids.',
        edgePerShare,
      };
      return false;
    }
    if (!buyPreview?.complete || edgePerShare < this.config.MIN_NET_EDGE_PER_SHARE) {
      this.currentSignal = {
        side: opposite,
        reason: 'Holding: the opposite side does not have enough depth or net edge after fees.',
        edgePerShare,
      };
      return false;
    }
    if (this.cash + salePreview.netProceeds + EPSILON < buyPreview.totalCost) {
      this.currentSignal = {
        side: opposite,
        reason: 'Holding: paper cash cannot fund the full opposite-side buy.',
        edgePerShare,
      };
      return false;
    }
    const sale = this.sweep(openTrade.side, 'bids', openTrade.shares, { consume: true });
    const buy = this.sweep(opposite, 'asks', this.config.BASE_SHARES, { consume: true });
    if (!sale?.complete || !buy?.complete) return false;
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
      `Closed profitable ${openTrade.side} shares and bought ${this.config.BASE_SHARES} ${opposite} shares on the opposite model edge.`,
      {
        fromSide: openTrade.side,
        toSide: opposite,
        sharesSold: sale.shares,
        sharesBought: buy.shares,
        liquidationPnl: round(liquidationPnl, 2),
        oppositeEdgePerShare: round(edgePerShare, 4),
        flipsThisWindow: this.flipsThisWindow,
      });
    this.currentSignal = {
      side: opposite,
      reason: `Flipped after a profitable exit; the opposite edge remained above threshold.`,
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
      shares: this.config.BASE_SHARES,
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
    return trade;
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
        volatilityLookbackCandles: this.config.VOLATILITY_CANDLES,
        minimumNetEdgePerShare: this.config.MIN_NET_EDGE_PER_SHARE,
        maximumFlipsPerWindow: this.config.MAX_FLIPS_PER_WINDOW,
        flipsThisWindow: this.flipsThisWindow,
        entryTriggeredThisWindow: this.entryTriggeredThisWindow,
        exitPolicy: 'Hold to exact original-market resolution unless a net-profitable opposite-model flip qualifies.',
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
