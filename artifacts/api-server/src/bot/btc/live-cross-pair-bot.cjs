'use strict';

const marketDataDefault = require('./wick-market-data.js');
const { feeParameters, takerFeeAt } = require('./paper-trading.js');

const WINDOW_MS = 5 * 60 * 1000;
const ENTRY_ASK_SUM = 0.8;
const INVERSE_EXIT_ASK_SUM = 1.22;
const TAKE_PROFIT_BID = 0.99;
const BUY_PRICE_CAP = 0.99;
const SELL_PRICE_FLOOR = 0.01;
const SHARES_PER_LEG = 7;
const MAX_QUOTE_AGE_MS = 2_000;
const MAX_QUOTE_SKEW_MS = 1_000;
const RESOLUTION_POLL_MS = 5_000;
const PAIR_AUDIT_INTERVAL_MS = 5_000;
const LOOP_MS = 500;
const MIN_BUY_NOTIONAL_USD = 1;
const EPSILON = 1e-8;
const STRATEGY_ID = 'btc-eth-mixed-pairs-live';
const LIVE_BOT_KEY = 'btc-eth-live-cross-pair';

const PAIRS = Object.freeze([
  Object.freeze({
    id: 'btc-up-eth-down',
    label: 'BTC UP + ETH DOWN',
    legs: Object.freeze([
      Object.freeze({ asset: 'BTC', side: 'UP' }),
      Object.freeze({ asset: 'ETH', side: 'DOWN' }),
    ]),
  }),
  Object.freeze({
    id: 'eth-up-btc-down',
    label: 'ETH UP + BTC DOWN',
    legs: Object.freeze([
      Object.freeze({ asset: 'ETH', side: 'UP' }),
      Object.freeze({ asset: 'BTC', side: 'DOWN' }),
    ]),
  }),
]);

function round(value, digits = 6) {
  if (!Number.isFinite(Number(value))) return null;
  const scale = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * scale) / scale;
}

function finite(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeSide(value) {
  const side = String(value || '').trim().toUpperCase();
  return side === 'UP' || side === 'DOWN' ? side : null;
}

function normalizeLevels(levels, descending = false) {
  return (Array.isArray(levels) ? levels : [])
    .map(level => ({ price: Number(level.price), size: Number(level.size) }))
    .filter(level => Number.isFinite(level.price) && level.price > 0 && level.price < 1
      && Number.isFinite(level.size) && level.size > 0)
    .sort((left, right) => descending
      ? right.price - left.price
      : left.price - right.price);
}

function matchedShares(order) {
  const shares = Number(order?.sizeMatched
    ?? order?.size_matched
    ?? order?.matchedSize
    ?? order?.matched_size
    ?? order?.matchedShares
    ?? order?.matched_shares);
  return Number.isFinite(shares) && shares > 0 ? shares : 0;
}

function orderStatus(order) {
  const status = String(order?.status || order?.state || 'UNKNOWN').toUpperCase();
  return status === 'CANCELED' ? 'CANCELLED' : status;
}

function isTerminal(order) {
  return ['MATCHED', 'FILLED', 'CANCELLED', 'REJECTED', 'EXPIRED', 'UNFILLED', 'UNMATCHED']
    .includes(orderStatus(order));
}

function sweep(levels, shares, side) {
  const requested = Math.max(0, Number(shares) || 0);
  let remaining = requested;
  let notional = 0;
  const fills = [];
  const sorted = normalizeLevels(levels, side === 'bids');
  for (const level of sorted) {
    if (remaining <= EPSILON) break;
    const filled = Math.min(remaining, level.size);
    if (filled <= EPSILON) continue;
    fills.push({ price: level.price, shares: filled });
    notional += level.price * filled;
    remaining -= filled;
  }
  const filledShares = requested - remaining;
  return {
    requestedShares: requested,
    filledShares,
    remainingShares: remaining,
    notional,
    averagePrice: filledShares > EPSILON ? notional / filledShares : null,
    fills,
    complete: remaining <= EPSILON,
  };
}

function winningOutcome(market) {
  const outcomes = Array.isArray(market?.outcomes)
    ? market.outcomes
    : typeof market?.outcomes === 'string'
      ? safeJsonArray(market.outcomes)
      : [];
  const prices = Array.isArray(market?.outcomePrices)
    ? market.outcomePrices
    : typeof market?.outcomePrices === 'string'
      ? safeJsonArray(market.outcomePrices)
      : [];
  if (!outcomes.length || outcomes.length !== prices.length) return null;
  const candidates = outcomes.map((outcome, index) => ({
    outcome: String(typeof outcome === 'string' ? outcome : outcome?.name || outcome?.label || ''),
    price: Number(prices[index]),
  })).filter(item => Number.isFinite(item.price));
  const winner = candidates.find(item => item.price >= 0.99);
  return winner?.outcome || null;
}

function safeJsonArray(value) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function emptyBook() {
  return { bids: [], asks: [], updatedAt: null, sourceTimestamp: null };
}

class LiveCrossPairBot {
  constructor({
    stateStore,
    trader,
    tradingEnabled = false,
    marketData = marketDataDefault,
    auditLogger = null,
    now = Date.now,
    orderTimeoutMs = 1_500,
    orderPollMs = 250,
    accountRefreshMs = 15_000,
  } = {}) {
    if (!stateStore) throw new Error('A durable live state store is required.');
    this.stateStore = stateStore;
    this.trader = trader || null;
    this.tradingEnabled = tradingEnabled === true;
    this.marketData = marketData;
    this.auditLogger = typeof auditLogger === 'function' ? auditLogger : null;
    this.now = now;
    this.orderTimeoutMs = Math.max(500, Number(orderTimeoutMs) || 1_500);
    this.orderPollMs = Math.max(100, Number(orderPollMs) || 250);
    this.accountRefreshMs = Math.max(5_000, Number(accountRefreshMs) || 15_000);

    this.status = 'STARTING';
    this.statusReason = 'Starting live BTC/ETH CLOB monitoring.';
    this.error = null;
    this.running = false;
    this.storageHealthy = false;
    this.persistence = { status: 'NOT_STARTED', lastSavedAt: null, error: null };
    this.liveAccount = {
      authenticated: false,
      accountReady: false,
      status: this.trader ? 'STARTING' : 'NOT_CONFIGURED',
      collateral: null,
      positionValue: null,
      equity: null,
      positions: [],
      orders: [],
      transactions: [],
      asOf: null,
      error: null,
    };
    this.marketContexts = new Map();
    this.books = new Map();
    this.tokenRefs = new Map();
    this.marketStream = null;
    this.streamSignature = '';
    this.streamGeneration = 0;
    this.websocket = {
      status: 'WAITING',
      connectedAt: null,
      lastMessageAt: null,
      reconnectCount: 0,
      error: null,
    };
    this.windowStart = null;
    this.windowEnd = null;
    this.earliestTradableWindowStart = null;
    this.lastMarketLookupAt = 0;
    this.lastAccountRefreshAt = 0;
    this.accountRefreshInFlight = false;
    this.accountAuthInFlight = false;
    this.nextAuthRetryAt = 0;
    this.lastResolutionPollAt = 0;
    this.timer = null;
    this.tickInProgress = false;
    this.tickPromise = null;
    this.positionSequence = 0;
    this.orderSequence = 0;
    this.cycleSequence = 0;
    this.positions = [];
    this.cycles = [];
    this.orders = [];
    this.events = [];
    this.windowPairs = new Map();
    this.lastPairAudit = new Map();
    this.activeOrderTokens = new Set();
    this.lastSellAttemptAt = new Map();
    this.unmanagedLegacy = {
      note: 'The previous bot ledger stays separate. Existing positions from that strategy are not auto-managed by this one.',
    };
  }

  async start() {
    if (this.running) return this.snapshot();
    try {
      await this.stateStore.initialize();
      const saved = await this.stateStore.loadState();
      if (saved?.strategy?.id === STRATEGY_ID) this.restoreState(saved);
      this.storageHealthy = true;
      this.persistence = { status: 'READY', lastSavedAt: null, error: null };
    } catch (error) {
      this.storageHealthy = false;
      this.persistence = {
        status: 'ERROR',
        lastSavedAt: null,
        error: String(error?.message || error).slice(0, 180),
      };
      this.status = 'ERROR';
      this.statusReason = 'The live trade ledger could not be loaded; trading is paused.';
      return this.snapshot();
    }

    const startedAt = Number(this.now());
    const currentWindowStart = Math.floor(startedAt / WINDOW_MS) * WINDOW_MS;
    this.earliestTradableWindowStart = startedAt === currentWindowStart
      ? currentWindowStart
      : currentWindowStart + WINDOW_MS;
    this.running = true;
    this.status = 'SEARCHING_MARKETS';
    this.statusReason = 'Connecting account and loading BTC/ETH markets.';
    this.emitAudit('BOT_STARTED', {
      strategyId: STRATEGY_ID,
      tradingEnabled: this.tradingEnabled,
      windowStart: this.windowStart,
      earliestTradableWindowStart: this.earliestTradableWindowStart,
    });
    this.timer = setInterval(() => { void this.tick(); }, LOOP_MS);
    this.timer.unref?.();
    if (this.trader) void this.authenticateAccount(Number(this.now()));
    void this.tick();
    return this.snapshot();
  }

  async authenticateAccount(now = Number(this.now())) {
    if (!this.trader || this.liveAccount.authenticated || this.accountAuthInFlight
      || now < this.nextAuthRetryAt) return;
    this.accountAuthInFlight = true;
    try {
      await this.trader.authenticate();
      this.liveAccount.authenticated = true;
      this.liveAccount.accountReady = false;
      this.liveAccount.status = 'READY';
      this.liveAccount.error = null;
      this.nextAuthRetryAt = 0;
      void this.refreshAccount(true);
    } catch (error) {
      this.liveAccount.authenticated = false;
      this.liveAccount.accountReady = false;
      this.liveAccount.status = 'AUTH_ERROR';
      this.liveAccount.error = String(error?.message || error).slice(0, 180);
      this.nextAuthRetryAt = now + 10_000;
      await this.log('ACCOUNT_AUTH_ERROR',
        'Polymarket authentication failed; live orders stay paused while the bot continues market monitoring.');
    } finally {
      this.accountAuthInFlight = false;
    }
  }

  async stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.closeMarketStream();
    await this.persist();
    this.status = 'STOPPED';
    this.statusReason = 'The live strategy has stopped.';
  }

  restoreState(state) {
    this.positions = Array.isArray(state.positions) ? state.positions : [];
    this.cycles = Array.isArray(state.cycles) ? state.cycles : [];
    this.orders = Array.isArray(state.orders) ? state.orders : [];
    this.events = Array.isArray(state.events) ? state.events.slice(0, 200) : [];
    this.positionSequence = Number(state.positionSequence) || this.positions.length;
    this.orderSequence = Number(state.orderSequence) || this.orders.length;
    this.cycleSequence = Number(state.cycleSequence) || this.cycles.length;
    this.windowPairs = new Map(Object.entries(state.windowPairs || {}));
  }

  persistentStateSnapshot() {
    return {
      strategy: this.strategySnapshot(),
      positions: this.positions,
      cycles: this.cycles,
      orders: this.orders,
      events: this.events.slice(0, 200),
      positionSequence: this.positionSequence,
      orderSequence: this.orderSequence,
      cycleSequence: this.cycleSequence,
      windowPairs: Object.fromEntries(this.windowPairs),
      savedAt: this.now(),
    };
  }

  async persist() {
    if (!this.storageHealthy) return false;
    try {
      await this.stateStore.saveState(this.persistentStateSnapshot());
      this.persistence = { status: 'READY', lastSavedAt: this.now(), error: null };
      return true;
    } catch (error) {
      this.persistence = {
        status: 'ERROR',
        lastSavedAt: this.persistence.lastSavedAt,
        error: String(error?.message || error).slice(0, 180),
      };
      this.storageHealthy = false;
      this.status = 'ERROR';
      this.statusReason = 'The live ledger could not be saved; new entries are paused.';
      return false;
    }
  }

  log(type, message, details = {}) {
    this.events.unshift({
      id: `event-${this.now()}-${this.events.length + 1}`,
      at: this.now(),
      type,
      message,
      ...details,
    });
    if (this.events.length > 200) this.events.length = 200;
    return this.persist();
  }

  async tick(now = Number(this.now())) {
    if (!this.running || this.tickInProgress) return this.snapshot();
    this.tickInProgress = true;
    try {
      const currentStart = Math.floor(now / WINDOW_MS) * WINDOW_MS;
      if (this.windowStart !== currentStart) {
        await this.advanceWindow(currentStart, now);
      }
      if (this.trader && !this.liveAccount.authenticated && now >= this.nextAuthRetryAt) {
        void this.authenticateAccount(now);
      }
      if (now - this.lastMarketLookupAt >= 5_000 || !this.marketContexts.size) {
        this.lastMarketLookupAt = now;
        await this.loadCurrentMarkets(currentStart, now);
      }
      this.syncMarketStream();
      this.updateOpenMarks(now);
      void this.refreshAccount(false);
      await this.checkOpenPositionExits(now);
      this.auditPairEvaluations(now);
      await this.checkEntries(now);
      await this.resolveDue(now);

      const connected = this.websocket.status === 'CONNECTED';
      this.status = !this.storageHealthy
        ? 'ERROR'
        : this.tradingEnabled && !this.liveAccount.accountReady
          ? 'ACCOUNT_NOT_READY'
          : connected
            ? 'RUNNING'
            : this.marketContexts.size
              ? 'WAITING_FOR_FEED'
              : 'SEARCHING_MARKETS';
      this.statusReason = !this.storageHealthy
        ? 'The ledger is unavailable; new orders are paused.'
        : !this.tradingEnabled
          ? 'Read-only monitoring; live order submission is disabled.'
          : !this.liveAccount.accountReady
            ? this.liveAccount.status === 'AUTH_ERROR'
              ? 'Polymarket authentication failed; live orders are paused.'
              : 'Waiting for the Polymarket account snapshot before submitting orders.'
            : connected
              ? 'Trading the two BTC/ETH mixed pairs from live Polymarket CLOB updates.'
              : 'Waiting for the Polymarket CLOB WebSocket to connect.';
    } catch (error) {
      this.error = String(error?.message || error).slice(0, 240);
      this.status = 'ERROR';
      this.statusReason = 'The live strategy paused after a market or exchange error.';
    } finally {
      this.tickInProgress = false;
    }
    return this.snapshot();
  }

  async advanceWindow(start, now) {
    const previousStart = this.windowStart;
    const previousOpenPositions = previousStart == null ? 0 : this.positions.filter(position =>
      position.windowStart === previousStart && position.status === 'OPEN').length;
    if (previousStart != null) {
      for (const position of this.positions) {
        if (position.windowStart === previousStart && position.status === 'OPEN') {
          position.status = 'PENDING_RESOLUTION';
          position.pendingResolutionAt = now;
          position.unrealizedPnlEstimate = null;
        }
      }
      for (const cycle of this.cycles) {
        if (cycle.windowStart === previousStart && cycle.status === 'OPEN') {
          cycle.status = 'PENDING_RESOLUTION';
          cycle.pendingResolutionAt = now;
        }
      }
    }
    this.closeMarketStream();
    this.windowStart = start;
    this.windowEnd = start + WINDOW_MS;
    this.marketContexts.clear();
    this.tokenRefs.clear();
    this.books.clear();
    this.windowPairs = new Map(PAIRS.map(pair => [
      `${pair.id}:${start}`,
      { pairId: pair.id, windowStart: start, entered: false, status: 'ARMED', reason: 'Waiting for fresh books.' },
    ]));
    this.lastPairAudit.clear();
    this.emitAudit('WINDOW_STARTED', {
      windowStart: start,
      windowEnd: start + WINDOW_MS,
      previousWindowStart: previousStart,
      previousOpenPositions,
    });
    await this.persist();
  }

  async loadCurrentMarkets(start, now) {
    const assets = ['BTC', 'ETH'];
    const results = await Promise.allSettled(assets.map(asset =>
      this.marketData.getAssetMarket(asset.toLowerCase(), start, WINDOW_MS)));
    for (let index = 0; index < assets.length; index += 1) {
      const asset = assets[index];
      const result = results[index];
      if (result.status !== 'fulfilled' || !result.value) {
        this.marketContexts.delete(asset);
        continue;
      }
      const market = result.value;
      if (Number(market.start) !== start || Number(market.end) !== start + WINDOW_MS
        || !market.tokens?.UP || !market.tokens?.DOWN) {
        this.marketContexts.delete(asset);
        continue;
      }
      const prior = this.marketContexts.get(asset);
      if (prior?.id === market.id && prior.start === start) continue;
      const context = { ...market, asset, start, end: start + WINDOW_MS };
      this.marketContexts.set(asset, context);
      for (const side of ['UP', 'DOWN']) {
        const tokenId = String(context.tokens[side]);
        this.tokenRefs.set(tokenId, { asset, side, market: context });
        this.books.set(tokenId, emptyBook());
      }
      await Promise.all(['UP', 'DOWN'].map(async side => {
        const tokenId = String(context.tokens[side]);
        try {
          const book = await this.marketData.getBook(tokenId);
          this.applyBookSnapshot({ asset_id: tokenId, bids: book?.bids, asks: book?.asks }, now);
        } catch (error) {
          this.log('BOOK_LOAD_ERROR', `${asset} ${side} order book could not be loaded.`, {
            asset,
            side,
            error: String(error?.message || error).slice(0, 140),
          });
        }
      }));
    }
  }

  syncMarketStream() {
    const tokenIds = [];
    for (const market of this.marketContexts.values()) {
      if (Number(market.start) !== Number(this.windowStart)) continue;
      tokenIds.push(String(market.tokens.UP), String(market.tokens.DOWN));
    }
    const uniqueTokens = [...new Set(tokenIds)].filter(Boolean).sort();
    const signature = uniqueTokens.join('|');
    if (signature === this.streamSignature) return;
    this.closeMarketStream();
    this.streamSignature = signature;
    if (!uniqueTokens.length) {
      this.websocket = { ...this.websocket, status: 'WAITING', error: null };
      return;
    }
    if (typeof this.marketData.connectMarketStream !== 'function') {
      this.websocket = { ...this.websocket, status: 'ERROR', error: 'CLOB WebSocket is unavailable.' };
      return;
    }
    const generation = ++this.streamGeneration;
    this.websocket = { ...this.websocket, status: 'CONNECTING', error: null };
    this.marketStream = this.marketData.connectMarketStream(uniqueTokens, {
      heartbeatMs: 10_000,
      reconnectMinMs: 1_000,
      reconnectMaxMs: 15_000,
      onMessage: event => {
        if (generation !== this.streamGeneration) return;
        this.handleMarketMessage(event);
      },
      onStatus: update => {
        if (generation !== this.streamGeneration) return;
        this.websocket = {
          ...this.websocket,
          ...update,
          connectedAt: String(update?.status || '').toUpperCase() === 'CONNECTED'
            ? this.now() : this.websocket.connectedAt,
        };
      },
    });
  }

  closeMarketStream() {
    this.streamGeneration += 1;
    try { this.marketStream?.close?.(); } catch {}
    this.marketStream = null;
    this.streamSignature = '';
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
    const type = String(payload.event_type || payload.eventType || payload.type || '');
    if (!type || type === 'PONG' || type === 'price_change' && !Array.isArray(payload.price_changes)) return;
    this.websocket.lastMessageAt = this.now();
    if (type === 'book') this.applyBookSnapshot(payload, this.now());
    else if (type === 'price_change') this.applyPriceChanges(payload, this.now());
    else if (type === 'best_bid_ask') this.applyBestBidAsk(payload, this.now());
    void this.tick();
  }

  applyBookSnapshot(event, now) {
    const tokenId = String(event.asset_id || event.assetId || '');
    if (!this.tokenRefs.has(tokenId)) return false;
    const book = {
      bids: normalizeLevels(event.bids, true),
      asks: normalizeLevels(event.asks),
      updatedAt: now,
      sourceTimestamp: finite(event.timestamp, now),
    };
    this.books.set(tokenId, book);
    return true;
  }

  applyPriceChanges(event, now) {
    const changes = Array.isArray(event.price_changes)
      ? event.price_changes
      : Array.isArray(event.priceChanges) ? event.priceChanges : [];
    for (const change of changes) {
      const tokenId = String(change.asset_id || change.assetId || event.asset_id || '');
      const book = this.books.get(tokenId);
      if (!book) continue;
      const bookSide = String(change.side || '').toUpperCase() === 'BUY' ? 'bids' : 'asks';
      const price = Number(change.price);
      const size = Number(change.size);
      if (!Number.isFinite(price) || price <= 0 || price >= 1 || !Number.isFinite(size)) continue;
      const levels = new Map(book[bookSide].map(level => [level.price, level.size]));
      if (size <= 0) levels.delete(price);
      else levels.set(price, size);
      book[bookSide] = normalizeLevels([...levels].map(([levelPrice, levelSize]) => ({
        price: levelPrice,
        size: levelSize,
      })), bookSide === 'bids');
      book.updatedAt = now;
      book.sourceTimestamp = finite(event.timestamp, now);
    }
  }

  applyBestBidAsk(event, now) {
    const tokenId = String(event.asset_id || event.assetId || '');
    const book = this.books.get(tokenId);
    if (!book) return false;
    for (const [key, side] of [['best_bid', 'bids'], ['bestBid', 'bids'], ['best_ask', 'asks'], ['bestAsk', 'asks']]) {
      if (event[key] == null) continue;
      const price = Number(event[key]);
      if (!Number.isFinite(price) || price <= 0 || price >= 1) continue;
      const sizeKey = key === 'best_bid' || key === 'bestBid'
        ? (event.best_bid_size ?? event.bestBidSize)
        : (event.best_ask_size ?? event.bestAskSize);
      const size = Math.max(EPSILON, Number(sizeKey) || 0);
      const rest = book[side].filter(level => Math.abs(level.price - price) > EPSILON);
      book[side] = normalizeLevels([...rest, { price, size }], side === 'bids');
    }
    book.updatedAt = now;
    return true;
  }

  quote(asset, side) {
    const market = this.marketContexts.get(asset);
    const tokenId = String(market?.tokens?.[side] || '');
    const book = this.books.get(tokenId);
    return {
      asset,
      side,
      tokenId,
      marketId: market?.id || null,
      marketSlug: market?.slug || null,
      conditionId: market?.conditionId || market?.id || null,
      start: market?.start ?? null,
      end: market?.end ?? null,
      bestBid: book?.bids?.[0]?.price ?? null,
      bidSize: book?.bids?.[0]?.size ?? 0,
      bestAsk: book?.asks?.[0]?.price ?? null,
      askSize: book?.asks?.[0]?.size ?? 0,
      bids: book?.bids || [],
      asks: book?.asks || [],
      updatedAt: book?.updatedAt ?? null,
    };
  }

  pairState(pair, start = this.windowStart) {
    const key = `${pair.id}:${start}`;
    if (!this.windowPairs.has(key)) {
      this.windowPairs.set(key, {
        pairId: pair.id,
        windowStart: start,
        entered: false,
        status: 'ARMED',
        reason: 'Waiting for fresh books.',
      });
    }
    return this.windowPairs.get(key);
  }

  pairQuote(pair, now = Number(this.now())) {
    const legs = pair.legs.map(leg => this.quote(leg.asset, leg.side));
    const marketsAligned = legs.every(leg => leg.start === this.windowStart
      && leg.end === this.windowEnd && leg.marketId && leg.tokenId);
    const timestamps = legs.map(leg => Number(leg.updatedAt));
    const quoteSkewMs = timestamps.every(Number.isFinite)
      ? Math.max(...timestamps) - Math.min(...timestamps)
      : null;
    const fresh = marketsAligned
      && legs.every(leg => Number.isFinite(Number(leg.updatedAt))
        && now >= Number(leg.updatedAt)
        && now - Number(leg.updatedAt) <= MAX_QUOTE_AGE_MS
        && Number.isFinite(Number(leg.bestAsk))
        && Number(leg.bestAsk) > 0 && Number(leg.bestAsk) < 1)
      && quoteSkewMs <= MAX_QUOTE_SKEW_MS;
    return {
      pairId: pair.id,
      label: pair.label,
      marketsAligned,
      fresh,
      quoteSkewMs,
      askSum: fresh ? round(legs.reduce((sum, leg) => sum + Number(leg.bestAsk), 0), 4) : null,
      legs,
    };
  }

  emitAudit(type, fields = {}) {
    if (!this.auditLogger) return;
    const record = {
      source: 'btc-eth-live-cross-pair',
      type,
      at: Number(this.now()),
      ...fields,
    };
    try {
      this.auditLogger(record);
    } catch {
      // Audit output must never block or alter live trading decisions.
    }
  }

  auditPairEvaluations(now) {
    if (this.windowStart == null || this.windowEnd == null) return;
    const orderReady = this.storageHealthy && this.tradingEnabled
      && this.liveAccount.accountReady;
    for (const pair of PAIRS) {
      const quote = this.pairQuote(pair, now);
      const state = this.pairState(pair);
      const qualifies = quote.fresh && quote.askSum < ENTRY_ASK_SUM;
      let gateReason = 'ENTRY_QUALIFIED';
      if (now >= this.windowEnd) gateReason = 'WINDOW_ENDED';
      else if (this.windowStart < this.earliestTradableWindowStart) gateReason = 'WINDOW_NOT_TRADABLE';
      else if (state.entered) gateReason = 'PAIR_ALREADY_ENTERED';
      else if (!quote.fresh) gateReason = 'WAITING_FOR_FRESH_ALIGNED_QUOTES';
      else if (!qualifies) gateReason = 'ASK_SUM_NOT_BELOW_0_80';
      else if (!this.storageHealthy) gateReason = 'LEDGER_NOT_READY';
      else if (!this.tradingEnabled) gateReason = 'LIVE_TRADING_DISABLED';
      else if (!this.liveAccount.accountReady) gateReason = 'ACCOUNT_NOT_READY';

      const signature = JSON.stringify({
        fresh: quote.fresh,
        qualifies,
        entered: state.entered,
        gateReason,
      });
      const key = `${pair.id}:${this.windowStart}`;
      const previous = this.lastPairAudit.get(key);
      if (previous?.signature === signature
        && now - previous.at < PAIR_AUDIT_INTERVAL_MS) continue;
      this.lastPairAudit.set(key, { signature, at: now });

      this.emitAudit('PAIR_EVALUATION', {
        pairId: pair.id,
        pairLabel: pair.label,
        windowStart: this.windowStart,
        windowEnd: this.windowEnd,
        marketAligned: quote.marketsAligned,
        quotesFresh: quote.fresh,
        quoteSkewMs: quote.quoteSkewMs,
        askSum: quote.askSum,
        entryThreshold: ENTRY_ASK_SUM,
        entryConditionMet: qualifies,
        entryEligible: qualifies && !state.entered && orderReady
          && now < this.windowEnd
          && this.windowStart >= this.earliestTradableWindowStart,
        pairAlreadyEntered: state.entered,
        gateReason,
        legs: quote.legs.map(leg => ({
          asset: leg.asset,
          side: leg.side,
          marketId: leg.marketId,
          marketSlug: leg.marketSlug,
          marketStart: leg.start,
          marketEnd: leg.end,
          bestBid: leg.bestBid == null ? null : round(leg.bestBid, 4),
          bestAsk: leg.bestAsk == null ? null : round(leg.bestAsk, 4),
          quoteAt: leg.updatedAt,
          quoteAgeMs: Number.isFinite(Number(leg.updatedAt))
            ? Math.max(0, now - Number(leg.updatedAt))
            : null,
        })),
      });
    }
  }

  async checkEntries(now) {
    if (!this.storageHealthy || !this.tradingEnabled || !this.liveAccount.accountReady
      || now >= this.windowEnd || this.windowStart < this.earliestTradableWindowStart) return;
    for (const pair of PAIRS) {
      const pairState = this.pairState(pair);
      const quote = this.pairQuote(pair, now);
      pairState.lastAskSum = quote.askSum;
      if (pairState.entered) continue;
      if (!quote.fresh) {
        pairState.status = 'WAITING_FOR_QUOTES';
        pairState.reason = 'Waiting for fresh, aligned asks on both assets.';
        continue;
      }
      if (quote.askSum >= ENTRY_ASK_SUM) {
        pairState.status = 'ARMED';
        pairState.reason = `Combined asks are $${quote.askSum.toFixed(4)}; waiting below $0.80.`;
        continue;
      }
      await this.enterPair(pair, quote, now);
    }
  }

  async enterPair(pair, quote, now) {
    const pairState = this.pairState(pair);
    if (pairState.entered) return;
    pairState.entered = true;
    pairState.status = 'ENTRY_SUBMITTED';
    pairState.reason = `Combined asks $${quote.askSum.toFixed(4)} are below $0.80.`;
    const cycle = {
      id: `${pair.id}-${this.windowStart}-${++this.cycleSequence}`,
      pairId: pair.id,
      pairLabel: pair.label,
      windowStart: this.windowStart,
      windowEnd: this.windowEnd,
      entryAt: now,
      entryAskSum: quote.askSum,
      status: 'OPEN',
      reverseExitTriggeredAt: null,
      reverseExitAskSum: null,
      positionIds: [],
      legs: [],
    };
    this.cycles.unshift(cycle);
    const plans = [];
    for (const leg of quote.legs) {
      const executableAsks = leg.asks.filter(level => Number(level.price) <= BUY_PRICE_CAP);
      const preview = sweep(executableAsks, SHARES_PER_LEG, 'asks');
      const estimatedBuyShares = preview.filledShares;
      const amountUsd = round(preview.notional, 4);
      const legState = {
        asset: leg.asset,
        side: leg.side,
        tokenId: leg.tokenId,
        marketId: leg.marketId,
        conditionId: leg.conditionId,
        requestedShares: SHARES_PER_LEG,
        estimatedShares: estimatedBuyShares,
        filledShares: 0,
        positionId: null,
        status: 'WAITING',
      };
      cycle.legs.push(legState);
      if (estimatedBuyShares <= EPSILON) {
        legState.status = 'NO_VISIBLE_ASKS';
        continue;
      }
      if (amountUsd < MIN_BUY_NOTIONAL_USD) {
        legState.status = 'SKIPPED_MINIMUM_NOTIONAL';
        legState.reason = `Estimated cost $${amountUsd.toFixed(4)} is below Polymarket's $1 buy minimum.`;
        continue;
      }
      const order = {
        localId: `cross-live-${this.now()}-${++this.orderSequence}`,
        id: null,
        cycleId: cycle.id,
        pairId: pair.id,
        pairLabel: pair.label,
        action: 'BUY_ENTRY',
        asset: leg.asset,
        side: leg.side,
        tokenId: leg.tokenId,
        marketId: leg.marketId,
        marketSlug: leg.marketSlug,
        conditionId: leg.conditionId,
        windowStart: this.windowStart,
        windowEnd: this.windowEnd,
        requestedShares: SHARES_PER_LEG,
        estimatedShares: estimatedBuyShares,
        amountUsd,
        limitPrice: BUY_PRICE_CAP,
        averagePriceEstimate: preview.averagePrice,
        previewFills: preview.fills,
        matchedShares: 0,
        status: 'SUBMITTING',
        submittedAt: this.now(),
        processed: false,
        error: null,
      };
      this.orders.unshift(order);
      legState.orderLocalId = order.localId;
      legState.status = 'SUBMITTING';
      plans.push({ order, legState });
    }
    await this.persist();
    // Each pair leg is independent; a rejection or empty book on one leg must
    // not prevent the other leg from being submitted and recorded.
    await Promise.all(plans.map(({ order, legState }) =>
      this.submitOrder(order).then(() => {
        legState.status = order.status;
        legState.filledShares = order.matchedShares;
        legState.positionId = order.positionId || null;
      })));
    const filled = cycle.legs.reduce((sum, leg) => sum + Number(leg.filledShares || 0), 0);
    cycle.status = filled > EPSILON ? 'OPEN' : 'NO_FILL';
    pairState.status = filled > EPSILON ? 'IN_POSITION' : 'NO_FILL';
    pairState.reason = filled > EPSILON
      ? `Entry triggered. ${cycle.legs.map(leg =>
        `${leg.asset} ${leg.side}: ${round(leg.filledShares, 2)} filled (${leg.status})`).join(' · ')}.`
      : `Entry condition fired, but no shares filled. ${cycle.legs.map(leg =>
        `${leg.asset} ${leg.side}: ${leg.reason || leg.status}`).join(' · ')}.`;
    await this.persist();
    await this.log('PAIR_ENTRY_TRIGGERED', pairState.reason, {
      pairId: pair.id,
      cycleId: cycle.id,
      askSum: quote.askSum,
      legs: cycle.legs.map(leg => ({ asset: leg.asset, side: leg.side, filledShares: leg.filledShares, status: leg.status })),
    });
    this.emitAudit('PAIR_ENTRY_RESULT', {
      pairId: pair.id,
      pairLabel: pair.label,
      cycleId: cycle.id,
      windowStart: cycle.windowStart,
      windowEnd: cycle.windowEnd,
      askSum: quote.askSum,
      status: cycle.status,
      legs: cycle.legs.map(leg => ({
        asset: leg.asset,
        side: leg.side,
        status: leg.status,
        requestedShares: round(leg.requestedShares, 6),
        matchedShares: round(leg.filledShares, 6),
      })),
    });
  }

  async submitOrder(order) {
    if (!this.trader || !this.tradingEnabled || !this.liveAccount.accountReady) {
      order.status = 'NOT_SUBMITTED';
      order.error = 'Live account is not ready.';
      this.emitAudit('ORDER_NOT_SUBMITTED', this.auditOrderFields(order));
      return order;
    }
    const lock = `${order.tokenId}:${order.action}`;
    if (this.activeOrderTokens.has(lock)) {
      order.status = 'BLOCKED_DUPLICATE';
      order.error = 'Another live order is active for this outcome token.';
      this.emitAudit('ORDER_NOT_SUBMITTED', this.auditOrderFields(order));
      return order;
    }
    this.activeOrderTokens.add(lock);
    this.emitAudit('ORDER_SUBMISSION_STARTED', this.auditOrderFields(order));
    await this.persist();
    try {
      const isSell = order.action.startsWith('SELL');
      const response = await this.trader.placeTakerOrder(
        order.tokenId,
        isSell ? 'SELL' : 'BUY',
        Number(order.limitPrice),
        isSell ? Number(order.requestedShares) : Number(order.amountUsd),
      );
      order.id = String(response.id);
      order.status = orderStatus(response);
      order.updatedAt = this.now();
      await this.persist();
      await this.pollOrder(order);
      this.applyOrderFill(order);
      this.emitAudit('ORDER_RESULT', this.auditOrderFields(order));
      return order;
    } catch (error) {
      order.error = String(error?.message || error).slice(0, 220);
      order.updatedAt = this.now();
      order.status = error?.submissionUncertain === false ? 'REJECTED' : 'SUBMISSION_UNCERTAIN';
      order.retryPolicy = order.action.startsWith('SELL')
        ? 'RECHECK_SELLABLE_BALANCE_BEFORE_ANY_RETRY'
        : 'DO_NOT_RETRY_THIS_PAIR_WINDOW';
      this.emitAudit('ORDER_UNCERTAIN', this.auditOrderFields(order));
      await this.persist();
      await this.log(order.action.startsWith('SELL') ? 'SELL_ORDER_UNCERTAIN' : 'BUY_ORDER_UNCERTAIN',
        `${order.action} result is ${order.status}; the record is retained and no blind duplicate order will be sent.`,
        { localOrderId: order.localId, orderId: order.id, pairId: order.pairId, asset: order.asset, side: order.side });
      return order;
    } finally {
      this.activeOrderTokens.delete(lock);
      await this.persist();
    }
  }

  auditOrderFields(order) {
    return {
      localOrderRef: order.localId,
      cycleId: order.cycleId,
      pairId: order.pairId,
      windowStart: order.windowStart,
      windowEnd: order.windowEnd,
      action: order.action,
      exitReason: order.exitReason || null,
      asset: order.asset,
      side: order.side,
      status: order.status,
      requestedShares: round(order.requestedShares, 6),
      requestedUsd: order.amountUsd == null ? null : round(order.amountUsd, 4),
      matchedShares: round(order.matchedShares, 6),
      minimumPrice: order.limitPrice == null ? null : round(order.limitPrice, 4),
      bookPriceEstimate: order.averagePriceEstimate == null
        ? null : round(order.averagePriceEstimate, 6),
      fillPriceBasis: order.fillPriceBasis || 'not_available',
      submittedAt: order.submittedAt,
      updatedAt: order.updatedAt || Number(this.now()),
    };
  }

  async pollOrder(order) {
    if (!order.id || typeof this.trader.fetchOrder !== 'function') {
      order.status = 'SUBMISSION_UNCERTAIN';
      order.error ||= 'The exchange order ID or order lookup is unavailable.';
      return;
    }
    const deadline = Number(this.now()) + this.orderTimeoutMs;
    let latest = null;
    do {
      latest = await this.trader.fetchOrder(order.id);
      order.exchangeStatus = orderStatus(latest);
      order.matchedShares = Math.max(order.matchedShares, matchedShares(latest));
      order.updatedAt = this.now();
      if (isTerminal(latest)) {
        order.status = orderStatus(latest);
        break;
      }
      if (Number(this.now()) >= deadline) break;
      await new Promise(resolve => setTimeout(resolve, this.orderPollMs));
    } while (Number(this.now()) <= deadline);

    if (latest && !isTerminal(latest)) {
      try {
        await this.trader.cancelOrder(order.id);
        latest = await this.trader.fetchOrder(order.id);
        order.matchedShares = Math.max(order.matchedShares, matchedShares(latest));
        order.status = isTerminal(latest) ? orderStatus(latest) : 'CANCELLED';
      } catch (error) {
        order.status = 'CANCEL_UNCERTAIN';
        order.error = String(error?.message || error).slice(0, 220);
        order.retryPolicy = order.action.startsWith('SELL')
          ? 'RECHECK_SELLABLE_BALANCE_BEFORE_ANY_RETRY'
          : 'DO_NOT_RETRY_THIS_PAIR_WINDOW';
      }
    }
  }

  applyOrderFill(order) {
    const filled = Number(order.matchedShares) || 0;
    if (filled <= EPSILON) {
      if (!['REJECTED', 'CANCELLED', 'UNFILLED', 'UNMATCHED', 'SUBMISSION_UNCERTAIN', 'CANCEL_UNCERTAIN'].includes(order.status)) {
        order.status = 'UNFILLED';
      }
      order.processed = true;
      order.processedMatchedShares = 0;
      return;
    }
    const estimate = Number(order.averagePriceEstimate)
      || (order.action.startsWith('SELL') ? SELL_PRICE_FLOOR : BUY_PRICE_CAP);
    const price = estimate;
    const fees = takerFeeAt(price, filled, feeParameters(this.marketContexts.get(order.asset)));
    order.averagePrice = price;
    order.feesEstimate = round(fees, 6);
    order.fillPriceBasis = 'fresh-order-book-estimate; verify against account activity';
    if (order.action === 'BUY_ENTRY') {
      const gross = filled * price;
      const position = {
        id: `cross-position-${++this.positionSequence}`,
        cycleId: order.cycleId,
        pairId: order.pairId,
        pairLabel: order.pairLabel,
        asset: order.asset,
        side: order.side,
        tokenId: order.tokenId,
        marketId: order.marketId,
        marketSlug: order.marketSlug,
        conditionId: order.conditionId,
        windowStart: order.windowStart,
        windowEnd: order.windowEnd,
        entryAt: order.submittedAt,
        orderId: order.id,
        shares: filled,
        initialShares: filled,
        entryPrice: price,
        totalCostEstimate: round(gross, 6),
        entryFeesEstimate: round(fees, 6),
        soldShares: 0,
        exitProceedsEstimate: 0,
        exitFeesEstimate: 0,
        realizedPnlEstimate: 0,
        unrealizedPnlEstimate: null,
        markBid: null,
        markUpdatedAt: null,
        status: 'OPEN',
        exitReason: null,
      };
      this.positions.unshift(position);
      order.positionId = position.id;
      const cycle = this.cycles.find(item => item.id === order.cycleId);
      if (cycle) cycle.positionIds.push(position.id);
    } else if (order.action.startsWith('SELL')) {
      const position = this.positions.find(item => item.id === order.positionId);
      if (!position) {
        order.status = 'RECONCILIATION_REQUIRED';
        order.error = 'The exchange confirmed a sale without a linked live position.';
      } else {
        const beforeShares = Number(position.shares) || 0;
        const sold = Math.min(beforeShares, filled);
        const proceeds = sold * price;
        const allocatedCost = Number(position.totalCostEstimate || 0)
          * (sold / Math.max(EPSILON, beforeShares));
        const entryFeeShare = Number(position.entryFeesEstimate || 0)
          * (sold / Math.max(EPSILON, beforeShares));
        const realized = proceeds - allocatedCost - entryFeeShare - fees;
        position.shares = round(Math.max(0, beforeShares - sold), 6);
        position.soldShares = round((Number(position.soldShares) || 0) + sold, 6);
        position.totalCostEstimate = round(Math.max(0,
          (Number(position.totalCostEstimate) || 0) - allocatedCost), 6);
        position.entryFeesEstimate = round(Math.max(0,
          (Number(position.entryFeesEstimate) || 0) - entryFeeShare), 6);
        position.exitProceedsEstimate = round((Number(position.exitProceedsEstimate) || 0) + proceeds, 6);
        position.exitFeesEstimate = round((Number(position.exitFeesEstimate) || 0) + fees, 6);
        position.realizedPnlEstimate = round((Number(position.realizedPnlEstimate) || 0) + realized, 6);
        position.lastExitOrderId = order.id;
        position.lastExitPrice = price;
        position.lastExitReason = order.exitReason;
        if (position.shares <= EPSILON) {
          position.shares = 0;
          position.status = order.exitReason === 'TAKE_PROFIT_099' ? 'TAKE_PROFIT' : 'CLOSED';
          position.closedAt = this.now();
          position.exitReason = order.exitReason;
        }
      }
    }
    order.processed = true;
    order.processedMatchedShares = filled;
  }

  async checkOpenPositionExits(now) {
    for (const cycle of this.cycles) {
      if (cycle.windowStart !== this.windowStart || cycle.status !== 'OPEN') continue;
      const pair = PAIRS.find(item => item.id === cycle.pairId);
      if (!pair) continue;
      const pairQuote = this.pairQuote(pair, now);
      if (pairQuote.fresh && !cycle.reverseExitTriggeredAt
        && pairQuote.askSum >= INVERSE_EXIT_ASK_SUM) {
        cycle.reverseExitTriggeredAt = now;
        cycle.reverseExitAskSum = pairQuote.askSum;
        cycle.reverseExitStatus = 'SELLING';
        this.emitAudit('PAIR_INVERSE_EXIT_TRIGGERED', {
          pairId: pair.id,
          cycleId: cycle.id,
          windowStart: cycle.windowStart,
          askSum: pairQuote.askSum,
          threshold: INVERSE_EXIT_ASK_SUM,
        });
        await this.log('PAIR_INVERSE_EXIT_TRIGGERED',
          `${pair.label} combined asks reached $${pairQuote.askSum.toFixed(4)}; selling its remaining exchange-confirmed shares.`,
          { pairId: pair.id, cycleId: cycle.id, askSum: pairQuote.askSum });
      }
    }

    for (const position of this.positions) {
      if (position.status !== 'OPEN' || position.windowStart !== this.windowStart
        || Number(position.shares) <= EPSILON) continue;
      const quote = this.quote(position.asset, position.side);
      if (!quote.updatedAt || now - Number(quote.updatedAt) > MAX_QUOTE_AGE_MS) continue;
      position.markBid = quote.bestBid;
      position.markUpdatedAt = quote.updatedAt;
      position.unrealizedPnlEstimate = quote.bestBid == null
        ? -Number(position.totalCostEstimate || 0) - Number(position.entryFeesEstimate || 0)
        : round(Number(quote.bestBid) * position.shares
          - (Number(position.totalCostEstimate) || 0)
          - (Number(position.entryFeesEstimate) || 0), 6);

      let reason = null;
      let minPrice = SELL_PRICE_FLOOR;
      if (quote.bestBid != null && Number(quote.bestBid) >= TAKE_PROFIT_BID) {
        reason = 'TAKE_PROFIT_099';
        minPrice = TAKE_PROFIT_BID;
      } else if (quote.bestBid == null && Array.isArray(quote.bids) && quote.bids.length === 0) {
        // The demo writes this position down to zero. A live market order cannot
        // execute into an empty bid book, so retain the shares for resolution.
        position.stopLossObservedAt ||= now;
        position.stopLossStatus = 'NO_BID_CANNOT_SELL';
      }
      const cycle = this.cycles.find(item => item.id === position.cycleId);
      if (cycle?.reverseExitTriggeredAt) {
        reason = 'INVERSE_PAIR_ASK_SUM_1.22';
        minPrice = SELL_PRICE_FLOOR;
      }
      if (!reason) continue;
      const lock = `${position.tokenId}:SELL`;
      const lastAttemptAt = Number(this.lastSellAttemptAt.get(position.tokenId)) || 0;
      if (this.activeOrderTokens.has(lock) || now - lastAttemptAt < 1_000) continue;
      this.lastSellAttemptAt.set(position.tokenId, now);
      await this.sellPosition(position, reason, minPrice);
    }
  }

  async sellPosition(position, reason, minPrice) {
    const unresolvedSell = this.orders.find(order =>
      order.positionId === position.id
      && order.action.startsWith('SELL')
      && ['SUBMISSION_UNCERTAIN', 'CANCEL_UNCERTAIN', 'RECONCILIATION_REQUIRED']
        .includes(order.status));
    if (unresolvedSell) {
      position.sellReconciliationRequired = true;
      position.sellReconciliationOrderId = unresolvedSell.id || null;
      return null;
    }
    let balance;
    try {
      if (typeof this.trader?.getSellableShares !== 'function') {
        throw new Error('A fresh Polymarket sellable-share check is unavailable.');
      }
      balance = await this.trader.getSellableShares(position.tokenId);
    } catch (error) {
      position.lastSellError = String(error?.message || error).slice(0, 180);
      await this.log('SELL_BALANCE_CHECK_FAILED',
        `${position.asset} ${position.side} sale was not submitted because the current token balance could not be verified.`,
        { positionId: position.id, pairId: position.pairId });
      return null;
    }
    const available = Math.max(0, Number(balance?.shares) || 0);
    const requestedShares = Math.min(Number(position.shares) || 0, available);
    if (requestedShares <= EPSILON) {
      position.lastSellError = 'No currently sellable shares were returned for this market token.';
      return null;
    }
    const order = {
      localId: `cross-live-${this.now()}-${++this.orderSequence}`,
      id: null,
      cycleId: position.cycleId,
      pairId: position.pairId,
      pairLabel: position.pairLabel,
      positionId: position.id,
      action: reason === 'TAKE_PROFIT_099' ? 'SELL_TAKE_PROFIT' : 'SELL_PAIR_EXIT',
      exitReason: reason,
      asset: position.asset,
      side: position.side,
      tokenId: position.tokenId,
      marketId: position.marketId,
      marketSlug: position.marketSlug,
      conditionId: position.conditionId,
      windowStart: position.windowStart,
      windowEnd: position.windowEnd,
      requestedShares,
      sellableSharesBefore: available,
      amountUsd: null,
      limitPrice: minPrice,
      averagePriceEstimate: this.quote(position.asset, position.side).bestBid,
      matchedShares: 0,
      status: 'SUBMITTING',
      submittedAt: this.now(),
      processed: false,
      error: null,
    };
    this.orders.unshift(order);
    await this.persist();
    return this.submitOrder(order);
  }

  async resolveDue(now) {
    const waiting = this.positions.filter(position => position.status === 'PENDING_RESOLUTION');
    if (!waiting.length || now - this.lastResolutionPollAt < RESOLUTION_POLL_MS) return;
    this.lastResolutionPollAt = now;
    let resolutionChanged = false;
    const marketIds = [...new Set(waiting.map(position =>
      position.marketId || position.conditionId).filter(Boolean))];
    for (const marketId of marketIds) {
      const relatedPositions = waiting.filter(position =>
        (position.marketId || position.conditionId) === marketId);
      const conditionId = relatedPositions[0]?.conditionId || null;
      try {
        const result = await this.marketData.getMarket(marketId);
        const winner = winningOutcome(result);
        this.emitAudit('RESOLUTION_CHECK', {
          marketId,
          conditionId,
          windowStart: relatedPositions[0]?.windowStart ?? null,
          marketSlug: relatedPositions[0]?.marketSlug ?? null,
          status: winner ? 'RESOLVED' : 'PENDING',
          winner,
          positionsChecked: relatedPositions.length,
        });
        if (!winner) continue;
        for (const position of relatedPositions) {
          const sharesAtResolution = Number(position.shares) || 0;
          const won = winner.toUpperCase() === position.side;
          const payout = won ? sharesAtResolution : 0;
          position.status = won ? 'RESOLVED_WIN' : 'RESOLVED_LOSS';
          position.resolvedAt = now;
          position.winner = winner;
          position.resolutionPayoutEstimate = round(payout, 6);
          position.realizedPnlEstimate = round(
            (Number(position.realizedPnlEstimate) || 0)
            + payout
            - (Number(position.totalCostEstimate) || 0)
            - (Number(position.entryFeesEstimate) || 0),
            6,
          );
          this.emitAudit('RESOLUTION_POSITION_RESULT', {
            positionId: position.id,
            cycleId: position.cycleId,
            pairId: position.pairId,
            asset: position.asset,
            side: position.side,
            marketId: position.marketId,
            marketSlug: position.marketSlug,
            windowStart: position.windowStart,
            windowEnd: position.windowEnd,
            winner,
            result: won ? 'WIN' : 'LOSS',
            sharesAtResolution: round(sharesAtResolution, 6),
            payoutEstimate: round(payout, 6),
            realizedPnlEstimate: round(position.realizedPnlEstimate, 6),
            pnlBasis: 'book-based price estimate; not confirmed collateral redemption',
          });
          resolutionChanged = true;
        }
        await this.log('MARKET_RESOLVED', `Official market result: ${winner}. Live collateral changes only when Polymarket credits or redeems the tokens.`, {
          conditionId,
          winner,
        });
      } catch (error) {
        this.error = String(error?.message || error).slice(0, 180);
        this.emitAudit('RESOLUTION_LOOKUP_ERROR', {
          marketId,
          conditionId,
          windowStart: relatedPositions[0]?.windowStart ?? null,
          errorName: String(error?.name || 'Error').slice(0, 48),
        });
      }
    }
    for (const cycle of this.cycles) {
      if (cycle.status !== 'PENDING_RESOLUTION') continue;
      const cyclePositions = this.positions.filter(position => position.cycleId === cycle.id);
      if (cyclePositions.length && cyclePositions.every(position =>
        ['RESOLVED_WIN', 'RESOLVED_LOSS', 'TAKE_PROFIT', 'CLOSED'].includes(position.status))) {
        cycle.status = 'RESOLVED';
        cycle.resolvedAt = now;
        resolutionChanged = true;
      }
    }
    if (resolutionChanged) await this.persist();
  }

  async refreshAccount(force) {
    if (!this.trader || !this.liveAccount.authenticated || this.accountRefreshInFlight) return;
    const now = Number(this.now());
    if (!force && now - this.lastAccountRefreshAt < this.accountRefreshMs) return;
    this.lastAccountRefreshAt = now;
    this.accountRefreshInFlight = true;
    try {
      const snapshot = await this.trader.getTradingSnapshot();
      this.liveAccount = {
        ...this.liveAccount,
        ...snapshot,
        authenticated: true,
        accountReady: snapshot.accountReady === true,
        status: snapshot.status || 'READY',
        error: null,
      };
      if (typeof this.trader.refreshDisplaySnapshot === 'function') {
        const display = await this.trader.refreshDisplaySnapshot();
        this.liveAccount = { ...this.liveAccount, ...display, authenticated: true };
      }
    } catch (error) {
      this.liveAccount.error = String(error?.message || error).slice(0, 180);
      this.liveAccount.accountReady = false;
      this.liveAccount.status = 'STALE';
    } finally {
      this.accountRefreshInFlight = false;
    }
  }

  updateOpenMarks(now) {
    for (const position of this.positions) {
      if (!['OPEN', 'PENDING_RESOLUTION'].includes(position.status)) continue;
      const quote = this.quote(position.asset, position.side);
      if (!quote.updatedAt || now - Number(quote.updatedAt) > MAX_QUOTE_AGE_MS) {
        position.markStatus = 'STALE';
        continue;
      }
      position.markStatus = quote.bestBid == null ? 'NO_BID' : 'LIVE';
      position.markBid = quote.bestBid;
      position.markUpdatedAt = quote.updatedAt;
      if (position.status === 'OPEN') {
        position.unrealizedPnlEstimate = quote.bestBid == null
          ? -Number(position.totalCostEstimate || 0) - Number(position.entryFeesEstimate || 0)
          : round(Number(quote.bestBid) * Number(position.shares)
            - Number(position.totalCostEstimate || 0)
            - Number(position.entryFeesEstimate || 0), 6);
      } else {
        position.unrealizedPnlEstimate = null;
      }
    }
  }

  async evaluateNow(now = Number(this.now())) {
    await this.checkOpenPositionExits(now);
    await this.checkEntries(now);
    return this.snapshot();
  }

  strategySnapshot() {
    return {
      id: STRATEGY_ID,
      name: 'BTC/ETH mixed-pair live strategy',
      version: 'mixed-pairs-080-inverse-122-tp-099-empty-bid-stop-resolution-live-v1',
      assets: ['BTC', 'ETH'],
      timeframes: ['5m'],
      activeEntryPairIds: PAIRS.map(pair => pair.id),
      sharesPerLeg: SHARES_PER_LEG,
      approximateLiveSizing: true,
      entryAskSumBelow: ENTRY_ASK_SUM,
      orderType: 'FAK TAKER',
      buyPriceCap: BUY_PRICE_CAP,
      minimumBuyNotionalUsd: MIN_BUY_NOTIONAL_USD,
      inverseExitAskSumAtOrAbove: INVERSE_EXIT_ASK_SUM,
      takeProfitBid: TAKE_PROFIT_BID,
      entry: 'BTC UP + ETH DOWN and ETH UP + BTC DOWN are evaluated independently. One entry per pair per 5-minute window when that pair’s fresh combined best asks are below $0.80.',
      sizing: 'Target 7 shares on each leg. Taker buys use a USD FAK amount calculated from fresh visible asks; exchange-confirmed share fills can vary. Legs below the $1 minimum notional are skipped, never upsized.',
      inverseExit: 'When a pair’s own combined asks reach $1.22, independently submit FAK sells for the exchange-confirmed remaining shares in each leg.',
      takeProfit: 'When a leg’s best bid reaches $0.99, submit a FAK sell with a $0.99 minimum price; record actual matched shares and estimated proceeds.',
      stopLoss: 'A fresh empty bid book is the paper strategy’s $0 stop. Live orders cannot execute into an empty book, so retain the shares for official resolution.',
      settlement: 'At the exact 5-minute market end, retain unsold tokens and poll the corresponding official market result every 5 seconds. Resolution is an estimate until Polymarket credits or redeems the tokens.',
      quoteRequirements: `CLOB quotes no older than ${MAX_QUOTE_AGE_MS}ms and pair leg timestamps within ${MAX_QUOTE_SKEW_MS}ms.`,
      execution: 'LIVE TAKER FAK; account-confirmed order IDs and matched quantities only. No real-money test order is generated outside strategy triggers.',
    };
  }

  snapshot() {
    const pairSnapshots = PAIRS.map(pair => {
      const quote = this.pairQuote(pair, Number(this.now()));
      const state = this.pairState(pair);
      const cycles = this.cycles.filter(cycle => cycle.pairId === pair.id);
      const openPositions = this.positions.filter(position =>
        position.pairId === pair.id && ['OPEN', 'PENDING_RESOLUTION'].includes(position.status));
      return {
        ...state,
        label: pair.label,
        askSum: quote.askSum,
        fresh: quote.fresh,
        quoteSkewMs: quote.quoteSkewMs,
        legs: quote.legs.map(leg => ({
          asset: leg.asset,
          side: leg.side,
          marketId: leg.marketId,
          marketSlug: leg.marketSlug,
          bestBid: leg.bestBid,
          bestAsk: leg.bestAsk,
          bidSize: leg.bidSize,
          askSize: leg.askSize,
          updatedAt: leg.updatedAt,
        })),
        openPositions,
        cycles,
      };
    });
    const openPositions = this.positions.filter(position => position.status === 'OPEN');
    const heldPositions = this.positions.filter(position =>
      ['OPEN', 'PENDING_RESOLUTION'].includes(position.status));
    const exposure = heldPositions.reduce((sum, position) =>
      sum + (Number(position.totalCostEstimate) || 0), 0);
    const floatingPnl = openPositions.reduce((sum, position) =>
      sum + (Number(position.unrealizedPnlEstimate) || 0), 0);
    return {
      mode: 'LIVE',
      status: this.status,
      statusReason: this.statusReason,
      error: this.error,
      tradingEnabled: this.tradingEnabled,
      liveHalted: false,
      strategy: this.strategySnapshot(),
      account: this.liveAccount,
      window: {
        start: this.windowStart,
        end: this.windowEnd,
        secondsRemaining: this.windowEnd == null
          ? null : Math.max(0, Math.ceil((this.windowEnd - Number(this.now())) / 1000)),
      },
      markets: ['BTC', 'ETH'].map(asset => {
        const market = this.marketContexts.get(asset);
        return {
          asset,
          marketId: market?.id || null,
          marketSlug: market?.slug || null,
          title: market?.title || null,
          start: market?.start ?? null,
          end: market?.end ?? null,
        };
      }),
      pairs: pairSnapshots,
      positions: this.positions.slice(0, 100),
      openPositions,
      heldPositions,
      cycles: this.cycles.slice(0, 100),
      liveOrders: this.orders.slice(0, 100),
      events: this.events.slice(0, 100),
      totals: {
        openPositionCount: heldPositions.length,
        exposureEstimate: round(exposure, 4),
        floatingPnlEstimate: round(floatingPnl, 4),
        realizedPnlEstimate: round(this.positions.reduce((sum, position) =>
          sum + (Number(position.realizedPnlEstimate) || 0), 0), 4),
      },
      websocket: this.websocket,
      persistence: this.persistence,
      legacy: this.unmanagedLegacy,
    };
  }
}

module.exports = {
  LiveCrossPairBot,
  LIVE_BOT_KEY,
  _test: {
    PAIRS,
    STRATEGY_ID,
    LIVE_BOT_KEY,
    ENTRY_ASK_SUM,
    INVERSE_EXIT_ASK_SUM,
    TAKE_PROFIT_BID,
    BUY_PRICE_CAP,
    SELL_PRICE_FLOOR,
    SHARES_PER_LEG,
    sweep,
    matchedShares,
    winningOutcome,
  },
};
