'use strict';

const config = require('./config');
const marketData = require('./wick-market-data');
const { feed } = require('./chainlink-price-feed');
const { METHOD: TECHNICAL_METHOD } = require('./technical-signal');
const { TAKE_PROFIT_BID, STOP_LOSS_BID, thresholdExit, recoverExpiredPositions } = require('./position-exits');
const {
  ENTRY_TRIGGER_SECONDS,
  ENTRY_TRIGGER_PRICE,
  LIMIT_ORDER_LADDER,
  quoteIsFresh,
  selectTriggeredSide,
  simulateLimitBuyFill,
} = require('./midpoint-limit-strategy');

const WINDOW_MS = 5 * 60 * 1000;
const SHARES_PER_SIGNAL = 500;
const MIN_EDGE = 0.05;
const LOW_PRICE_THRESHOLD = 0.25;
const LOW_PRICE_MIN_EDGE = 0.10;
const STARTING_CASH = 10_000;
const POLL_MS = 500;
const TAKER_FEE_RATE = config.CRYPTO_TAKER_FEE_RATE;
const MIN_ENTRY_PRICE = 0.02;
const OPENING_DELAY_SECONDS = 1;
const ENTRY_CHECKPOINTS = Object.freeze([
  { slot: 0, seconds: 1, endSeconds: 60, maximumAsk: 0.40 },
  { slot: 1, seconds: 61, endSeconds: 120, maximumAsk: 0.60 },
  { slot: 2, seconds: 121, endSeconds: 180, maximumAsk: 0.70 },
  { slot: 3, seconds: 181, endSeconds: 240, maximumAsk: 0.80 },
]);
const MAX_ENTRIES_PER_WINDOW = ENTRY_CHECKPOINTS.length;
const EQUITY_SNAPSHOT_INTERVAL_MS = 30_000;
const EXIT_QUOTE_MAX_AGE_MS = 5000;
const EXIT_START_SECONDS = 295;

function entrySlotAt(start, now) {
  const elapsedMs = now - start;
  if (elapsedMs < ENTRY_CHECKPOINTS[0].seconds * 1000) return -1;
  return Math.min(ENTRY_CHECKPOINTS.length,
    Math.floor((elapsedMs - ENTRY_CHECKPOINTS[0].seconds * 1000) / 60_000));
}

const DEFAULT_STRATEGY_SETTINGS = Object.freeze({
  openingDelaySeconds: OPENING_DELAY_SECONDS,
  minimumNetEdge: MIN_EDGE,
  lowPriceThreshold: LOW_PRICE_THRESHOLD,
  lowPriceMinimumNetEdge: LOW_PRICE_MIN_EDGE,
  volatilityMultiplier: 1,
  sharesPerSignal: SHARES_PER_SIGNAL,
  sideMode: TECHNICAL_METHOD,
});

function parseLevels(levels, direction) {
  return (Array.isArray(levels) ? levels : [])
    .map(level => ({ price: Number(level.price), size: Number(level.size) }))
    .filter(level => Number.isFinite(level.price) && level.price > 0 && level.price < 1
      && Number.isFinite(level.size) && level.size > 0)
    .sort((a, b) => direction === 'ask' ? a.price - b.price : b.price - a.price);
}

function normalCdf(value) {
  const x = Math.abs(value);
  const t = 1 / (1 + 0.2316419 * x);
  const density = 0.3989422804014327 * Math.exp(-0.5 * x * x);
  const tail = density * t * (0.319381530 + t * (-0.356563782 + t *
    (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return value >= 0 ? 1 - tail : tail;
}

function estimateLogReturnVolatility(candles, count = 15) {
  const closes = (Array.isArray(candles) ? candles : [])
    .filter(candle => Number.isFinite(Number(candle.close)) && Number(candle.close) > 0)
    .slice(-count)
    .map(candle => Number(candle.close));
  const returns = closes.slice(1).map((close, index) => Math.log(close / closes[index]))
    .filter(Number.isFinite);
  if (returns.length < Math.min(10, count)) return null;
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1);
  return Number.isFinite(variance) && variance > 0 ? Math.sqrt(variance) : null;
}

function probabilityUp({ openPrice, spotPrice, secondsRemaining, volatility5m }) {
  if (![openPrice, spotPrice, secondsRemaining, volatility5m].every(Number.isFinite)
    || openPrice <= 0 || spotPrice <= 0 || secondsRemaining <= 0 || volatility5m <= 0) return null;
  const remainingVol = volatility5m * Math.sqrt(secondsRemaining / 300);
  if (!Number.isFinite(remainingVol) || remainingVol <= 0) return null;
  return normalCdf(Math.log(spotPrice / openPrice) / remainingVol);
}

function estimateTakerFee(price, shares) {
  if (!Number.isFinite(price) || price < 0 || price > 1
    || !Number.isFinite(shares) || shares < 0) return 0;
  return TAKER_FEE_RATE * price * (1 - price) * shares;
}

function simulateBuy(asks, shares = SHARES_PER_SIGNAL) {
  let remaining = shares;
  let cost = 0;
  let fees = 0;
  let visibleShares = 0;
  for (const level of parseLevels(asks, 'ask')) {
    const fill = Math.min(remaining, level.size);
    cost += fill * level.price;
    fees += estimateTakerFee(level.price, fill);
    visibleShares += fill;
    remaining -= fill;
    if (remaining <= 1e-8) break;
  }
  if (remaining > 1e-8) return null;
  const averagePrice = cost / shares;
  return { shares, averagePrice, cost, fees, totalCost: cost + fees, visibleShares };
}

class ProbabilityBot {
  constructor({
    now = Date.now,
    fetchMarket = marketData.getBtcMarket,
    fetchBook = marketData.getBook,
    fetchMarketDetails = marketData.getMarket,
    priceFeed = feed,
    learningStore = null,
    choosePaperSettings = null,
    strategySettings = {},
  } = {}) {
    this.now = now;
    this.fetchMarket = fetchMarket;
    this.fetchBook = fetchBook;
    this.fetchMarketDetails = fetchMarketDetails;
    this.expiryRecoveryAt = new Map();
    this.priceFeed = priceFeed;
    this.running = false;
    this.timer = null;
    this.busy = false;
    this.market = null;
    this.marketFetchedAt = 0;
    this.quotes = { UP: null, DOWN: null };
    this.referencePrice = null;
    this.latestPrice = null;
    this.priceAt = null;
    this.volatility5m = null;
    this.probabilityUp = null;
    this.edges = { UP: null, DOWN: null };
    this.entryFilter = {
      allowed: false,
      minimumBestAsk: MIN_ENTRY_PRICE,
      blockedSides: ['UP', 'DOWN'],
      openingDelaySeconds: OPENING_DELAY_SECONDS,
      secondsSinceOpen: null,
      openingDelayActive: false,
      secondsRemaining: null,
      blockedReasons: ['PRICE_FLOOR'],
    };
    this.requiredNetEdge = { UP: MIN_EDGE, DOWN: MIN_EDGE };
    this.lastEntryFilterSignature = null;
    this.armed = { UP: true, DOWN: true };
    this.cash = STARTING_CASH;
    this.trades = [];
    this.settledCount = 0;
    this.settledWins = 0;
    this.settledLosses = 0;
    this.realizedPnlBySide = { UP: 0, DOWN: 0 };
    this.events = [];
    this.learningStore = learningStore;
    // Stored adaptive settings and persisted direction must not override this fixed policy.
    this.choosePaperSettings = choosePaperSettings;
    this.strategySettings = { ...DEFAULT_STRATEGY_SETTINGS };
    this.persistenceQueue = Promise.resolve();
    this.persistenceError = null;
    this.lastSampledAt = null;
    this.lastTunedWindowStart = null;
    this.pullback = null;
    this.marketSignal = null;
    this.pendingReversal = null;
    this.activeSide = null;
    this.activeSignalReason = null;
    this.windowDecision = { status: 'OBSERVING', side: null };
    this.lastLoggedSignalKey = null;
    this.lastEntrySlot = -1;
    this.pendingPriceFilteredShares = 0;
    this.priceFilteredSlots = new Map();
    this.entryStageSkipLogs = new Set();
    this.takerOrders = [];
    this.limitOrders = [];
    this.orderWindowStart = null;
    this.limitOrderSequence = 0;
    this.limitOrderTriggerSide = null;
    this.limitOrderTriggeredAt = null;
    this.orderBookLiquidity = { UP: null, DOWN: null };
    this.entrySideSelection = { status: 'WAITING_FOR_TRIGGER', selectedSide: null, prices: {} };
    this.entrySequence = 0;
    this.entryWindowStart = null;
    this.windowResults = new Map();
    this.finalizedWindowStarts = new Set();
    this.accountSessionStartedAt = this.now();
    this.lastEquitySnapshotAt = null;
    this.equitySnapshotRequested = true;
    this.handledClosedSignals = new Set();
    this.lastLiveSignal = null;
    this.learningStatus = {
      enabled: false,
      mode: learningStore ? 'logging-only-fixed-limit-policy' : 'disabled',
      completedWindows: 0,
      lastEvaluation: null,
    };
    this.error = null;
    this.statusReason = 'Starting BTC market and order-book feeds.';
    this.lastUpdateAt = null;
    this.startedAt = this.now();
    this.priceFeed.start();
  }

  log(event, details = {}, windowStart = this.market?.start) {
    const ts = this.now();
    this.events.unshift({ ts, event, ...details });
    this.events.length = Math.min(this.events.length, 60);
    if (this.learningStore) this.queuePersistence(() => this.learningStore.recordEvent({
      ts, windowStart, event, details,
    }));
  }

  queuePersistence(operation) {
    this.persistenceQueue = this.persistenceQueue.then(async () => {
      if (!this.persistenceError) await operation();
    }).catch(error => {
      this.persistenceError = error?.message || 'Learning storage write failed.';
      this.learningStatus = { ...this.learningStatus, mode: 'storage-error', error: this.persistenceError };
    });
  }

  async captureLearningSample(now) {
    if (!this.learningStore || !this.market) return;
    const ts = Math.floor(now / POLL_MS) * POLL_MS;
    if (ts === this.lastSampledAt) return;
    this.lastSampledAt = ts;
    const sample = {
      ts, observedAt: now, windowStart: this.market.start, windowEnd: this.market.end,
      secondsSinceOpen: Math.max(0, (now - this.market.start) / 1000),
      secondsRemaining: Math.max(0, (this.market.end - now) / 1000),
      orderStrategy: 'midpoint-triggered-resting-limit-ladder-v1',
      entrySideSelection: this.entrySideSelection,
      orderSchedule: this.orderSchedule(now),
      referencePrice: this.referencePrice,
      spotPrice: this.latestPrice,
      quotes: Object.fromEntries(['UP', 'DOWN'].map(side => {
        const quote = this.quotes[side];
        return [side, quote ? {
          bestBid: quote.bestBid, bestAsk: quote.bestAsk, asks: quote.asks, bids: quote.bids,
          updatedAt: quote.updatedAt,
        } : null];
      })),
      recentLimitOrders: this.limitOrders.filter(order => order.windowStart === this.market.start)
        .slice(0, 20).map(order => ({
          id: order.id, side: order.side, orderType: order.orderType,
          limitPrice: order.limitPrice, remainingShares: order.remainingShares,
          requestedShares: order.requestedShares, filledShares: order.filledShares,
          averageFillPrice: order.averageFillPrice, status: order.status,
        })),
    };
    this.queuePersistence(() => this.learningStore.recordSample(sample));
  }

  async maybeTune(now) {
    if (!this.learningStore || !this.choosePaperSettings || !this.market
      || this.lastTunedWindowStart === this.market.start) return;
    this.lastTunedWindowStart = this.market.start;
    try {
      await this.persistenceQueue;
      const windows = await this.learningStore.getCompletedWindows(now, 15);
      const result = this.choosePaperSettings(windows, this.strategySettings);
      await this.learningStore.saveTuning(result, now, this.market.start);
      this.learningStatus = {
        enabled: false,
        mode: 'logging-only-fixed-policy',
        completedWindows: result.windows,
        lastEvaluation: { ...result, settings: undefined },
      };
      this.log('PAPER_REGRESSION_EVALUATED', {
        reason: result.reason, windowsEvaluated: result.windows, baseline: result.baseline,
      });
    } catch (error) {
      this.persistenceError = error?.message || 'Learning evaluation failed.';
      this.learningStatus = { ...this.learningStatus, mode: 'storage-error', error: this.persistenceError };
    }
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const now = this.now();
      this.processPositionExits(now);
      this.cancelExpiredLimitOrders(now);
      await recoverExpiredPositions(this, now);
      const start = Math.floor(now / WINDOW_MS) * WINDOW_MS;
      this.beginMarketWindow(start);
      if (!this.market || this.market.start !== start || now - this.marketFetchedAt >= 10_000) {
        this.market = await this.fetchMarket(start, WINDOW_MS);
        this.marketFetchedAt = now;
        if (this.market?.start !== start) this.market = null;
      }
      if (!this.market) {
        this.processPositionExits(now);
        this.maybeFinalizeCompletedWindows(now);
        this.maybeRecordEquitySnapshot(now);
        this.error = 'Waiting for the exact BTC 5-minute UP/DOWN market.';
        this.lastUpdateAt = now;
        return;
      }
      this.beginMarketWindow();
      const [upBook, downBook] = await Promise.all([
        this.fetchBook(this.market.tokens.UP),
        this.fetchBook(this.market.tokens.DOWN),
      ]);
      this.quotes = {
        UP: this.quote(upBook, now),
        DOWN: this.quote(downBook, now),
      };
      this.processPositionExits(now);

      const ticks = this.priceFeed.getTicks?.() ?? [];
      const referenceTick = ticks
        .filter(tick => Math.abs(tick.ts - start) <= 10_000)
        .sort((a, b) => Math.abs(a.ts - start) - Math.abs(b.ts - start))[0];
      const latestTick = ticks[ticks.length - 1];
      this.referencePrice = referenceTick?.price ?? null;
      this.latestPrice = latestTick?.price ?? null;
      this.priceAt = latestTick?.ts ?? null;
      const scanAt = this.now();
      this.probabilityUp = null;
      this.edges = { UP: null, DOWN: null };
      this.processLimitOrderStrategy(scanAt);
      this.processRestingLimitOrders(scanAt);
      this.maybeFinalizeCompletedWindows(scanAt);
      this.maybeRecordEquitySnapshot(scanAt);
      await this.captureLearningSample(scanAt);
      this.error = null;
      this.lastUpdateAt = now;
    } catch (error) {
      const scanAt = this.now();
      this.processPositionExits(scanAt);
      this.maybeFinalizeCompletedWindows(scanAt);
      this.maybeRecordEquitySnapshot(scanAt);
      this.error = error?.message || 'BTC window strategy scan failed.';
      this.statusReason = this.error;
      this.lastUpdateAt = this.now();
    } finally {
      this.busy = false;
    }
  }

  quote(book, updatedAt) {
    const bids = parseLevels(book?.bids, 'bid');
    const asks = parseLevels(book?.asks, 'ask');
    const bestBid = bids[0] || null;
    const bestAsk = asks[0] || null;
    return {
      bestBid: bestBid?.price ?? null,
      bestAsk: bestAsk?.price ?? null,
      midpoint: bestBid && bestAsk ? (bestBid.price + bestAsk.price) / 2 : null,
      updatedAt,
      asks,
      bids,
    };
  }

  calculateEdges() {
    return { UP: null, DOWN: null };
  }

  updateEntryFilter(now = this.now()) {
    const blockedSides = ['UP', 'DOWN'].filter(side => {
      const bestAsk = this.quotes[side]?.bestAsk;
      return !Number.isFinite(bestAsk) || bestAsk < MIN_ENTRY_PRICE;
    });
    const secondsSinceOpen = Number.isFinite(this.market?.start)
      ? Math.max(0, (now - this.market.start) / 1000)
      : null;
    const secondsRemaining = Number.isFinite(this.market?.end)
      ? Math.max(0, (this.market.end - now) / 1000)
      : null;
    const openingDelayActive = Number.isFinite(secondsSinceOpen)
      && secondsSinceOpen < this.strategySettings.openingDelaySeconds;
    const blockedReasons = [];
    if (blockedSides.length) blockedReasons.push('PRICE_FLOOR');
    if (openingDelayActive) blockedReasons.push('OPENING_DELAY');
    this.entryFilter = {
      allowed: blockedReasons.length === 0,
      minimumBestAsk: MIN_ENTRY_PRICE,
      blockedSides,
      openingDelaySeconds: this.strategySettings.openingDelaySeconds,
      secondsSinceOpen,
      openingDelayActive,
      secondsRemaining,
      blockedReasons,
    };
    return this.entryFilter;
  }

  applyTechnicalSignal(signal) {
    this.beginMarketWindow();
    if (!this.market) return;
    this.marketSignal = signal;
    if (signal?.status !== 'READY' || !['UP', 'DOWN'].includes(signal.side)) {
      this.windowDecision = {
        status: signal?.status || 'WAITING_HISTORY',
        side: this.activeSide,
        signalAt: signal?.signalAt ?? null,
        setup: signal?.setup ?? null,
        confirmed: false,
        reason: signal?.reason || 'Waiting for closed-candle signal data.',
      };
      return;
    }

    this.activeSide = signal.side;
    this.activeSignalReason = signal.setup;
    this.windowDecision = {
      status: signal.confirmed ? 'LOCKED' : 'FALLBACK',
      side: signal.side,
      signalAt: signal.signalAt,
      setup: signal.setup,
      confirmed: signal.confirmed,
      reason: signal.reason,
    };

    const signalKey = [
      signal.signalAt,
      signal.side,
      signal.setup,
    ].join(':');
    if (signalKey !== this.lastLoggedSignalKey) {
      this.lastLoggedSignalKey = signalKey;
      this.log('WINDOW_SIGNAL_SELECTED', {
        side: signal.side,
        setup: signal.setup,
        confirmed: signal.confirmed,
        candle: signal.candle,
        signalAt: signal.signalAt,
        reason: signal.reason,
        method: signal.method,
      });
    }
  }

  beginMarketWindow(start = this.market?.start) {
    if (!Number.isFinite(start) || this.entryWindowStart === start) return;
    const now = this.now();
    this.entryWindowStart = start;
    this.orderWindowStart = start;
    this.limitOrderTriggerSide = null;
    this.limitOrderTriggeredAt = null;
    this.orderBookLiquidity = { UP: null, DOWN: null };
    this.entrySideSelection = { status: 'WAITING_FOR_TRIGGER', selectedSide: null, prices: {} };
    this.pendingReversal = null;
    this.windowDecision = {
      status: this.activeSide ? 'HELD' : 'OBSERVING',
      side: this.activeSide,
    };
    this.lastEntrySlot = -1;
    this.pendingPriceFilteredShares = 0;
    this.priceFilteredSlots.clear();
    this.entryStageSkipLogs.clear();
    this.marketSignal = null;
    this.pullback = null;
    this.lastLoggedSignalKey = null;
    this.log('PAPER_WINDOW_LIMIT_TRIGGER_STARTED', {
      windowStart: start,
      triggerAtSeconds: ENTRY_TRIGGER_SECONDS,
      triggerMidpoint: ENTRY_TRIGGER_PRICE,
      limitOrders: LIMIT_ORDER_LADDER.map(({ price, shares }) => ({ price, shares })),
    });
  }

  orderBookAsksAvailable(side, quote) {
    const asks = Array.isArray(quote?.asks) ? quote.asks : [];
    const signature = JSON.stringify(asks.map(level => [level.price, level.size]));
    let state = this.orderBookLiquidity[side];
    if (!state || state.signature !== signature) {
      state = { signature, consumedByPrice: new Map() };
      this.orderBookLiquidity[side] = state;
    }
    return asks.map(level => ({
      price: level.price,
      size: Math.max(0, level.size - (state.consumedByPrice.get(level.price) || 0)),
    }));
  }

  consumeOrderBookAsks(side, fill) {
    const state = this.orderBookLiquidity[side];
    if (!state) return;
    for (const level of fill.fills) {
      state.consumedByPrice.set(level.price,
        (state.consumedByPrice.get(level.price) || 0) + level.shares);
    }
  }

  reservedLimitOrderFunds() {
    return this.limitOrders.reduce((sum, order) => {
      if (!['OPEN', 'PARTIALLY_FILLED'].includes(order.status) || order.remainingShares <= 0) return sum;
      const shareReserve = order.remainingShares * order.limitPrice;
      const feeReserve = order.remainingShares * TAKER_FEE_RATE * 0.25;
      return sum + shareReserve + feeReserve;
    }, 0);
  }

  recordLimitOrder(side, ladderItem, now, selection) {
    const { price: limitPrice, shares: requestedShares, slot } = ladderItem;
    const reserveRequired = requestedShares * (limitPrice + TAKER_FEE_RATE * 0.25);
    const availableCash = Math.max(0, this.cash - this.reservedLimitOrderFunds());
    const id = `paper-limit-${this.market.start}-${slot}-${++this.limitOrderSequence}`;
    const hasFunds = reserveRequired <= availableCash + 1e-8;
    const order = {
      id,
      marketId: this.market.id,
      tokenId: this.market.tokens?.[side] ?? null,
      windowStart: this.market.start,
      windowEnd: this.market.end,
      marketTitle: this.market.title,
      slot,
      side,
      orderType: 'LIMIT',
      limitPrice,
      triggerPrice: selection.triggeringPrice,
      triggerThreshold: ENTRY_TRIGGER_PRICE,
      scheduledAt: this.market.start + ENTRY_TRIGGER_SECONDS * 1000,
      placedAt: now,
      requestedShares,
      filledShares: 0,
      remainingShares: hasFunds ? requestedShares : 0,
      cancelledRemainderShares: 0,
      averageFillPrice: null,
      filledCost: 0,
      fees: 0,
      fillCount: 0,
      tradeIds: [],
      status: hasFunds ? 'OPEN' : 'SKIPPED_INSUFFICIENT_CASH',
      selectionReason: selection.selectionReason,
      reservedFunds: hasFunds ? reserveRequired : 0,
    };
    this.limitOrders.unshift(order);
    this.limitOrders = this.limitOrders.filter((item, index) => (
      ['OPEN', 'PARTIALLY_FILLED'].includes(item.status) || index < 200
    ));
    this.log(hasFunds ? 'PAPER_LIMIT_BUY_SUBMITTED' : 'PAPER_LIMIT_BUY_SKIPPED', {
      orderId: id,
      side,
      limitPrice,
      requestedShares,
      triggerPrice: selection.triggeringPrice,
      triggerThreshold: ENTRY_TRIGGER_PRICE,
      reservedFunds: order.reservedFunds,
      availableCash,
      reason: hasFunds ? undefined : 'Insufficient paper cash after reserving funds for existing open limit orders.',
    }, this.market.start);
    return order;
  }

  processLimitOrderStrategy(now) {
    if (!this.market || now >= this.market.end) return;
    if (this.orderWindowStart !== this.market.start) this.beginMarketWindow(this.market.start);

    const elapsedSeconds = Math.max(0, (now - this.market.start) / 1000);
    if (this.limitOrderTriggerSide) {
      this.entrySideSelection = {
        ...this.entrySideSelection,
        status: 'TRIGGERED',
        selectedSide: this.limitOrderTriggerSide,
        triggeredAt: this.limitOrderTriggeredAt,
      };
      this.statusReason = `${this.limitOrderTriggerSide} midpoint trigger latched at $${Number(this.entrySideSelection.triggeringPrice).toFixed(3)}; resting $0.40 and $0.60 buy limits remain active until window end.`;
      return;
    }

    const selection = selectTriggeredSide(
      this.quotes, now, EXIT_QUOTE_MAX_AGE_MS, ENTRY_TRIGGER_PRICE,
    );
    if (elapsedSeconds < ENTRY_TRIGGER_SECONDS) {
      this.entrySideSelection = {
        ...selection,
        status: 'WAITING_FOR_DELAY',
        selectedSide: null,
      };
      this.statusReason = `Waiting until ${ENTRY_TRIGGER_SECONDS} seconds after the window opens before monitoring for a fresh midpoint at or above $${ENTRY_TRIGGER_PRICE.toFixed(2)}.`;
      return;
    }

    this.entrySideSelection = selection;
    if (selection.status !== 'READY') {
      this.statusReason = selection.status === 'WAITING_FOR_TRIGGER'
        ? `Monitoring fresh UP/DOWN midpoints for a move to $${ENTRY_TRIGGER_PRICE.toFixed(2)} or higher.`
        : 'Waiting for a fresh UP or DOWN midpoint.';
      return;
    }

    this.limitOrderTriggerSide = selection.selectedSide;
    this.limitOrderTriggeredAt = now;
    this.entrySideSelection = {
      ...selection,
      status: 'TRIGGERED',
      triggeredAt: now,
    };
    this.log('PAPER_LIMIT_ORDER_TRIGGERED', {
      side: selection.selectedSide,
      midpoint: selection.triggeringPrice,
      threshold: ENTRY_TRIGGER_PRICE,
      triggerSeconds: elapsedSeconds,
      selectionReason: selection.selectionReason,
    }, this.market.start);
    for (const ladderItem of LIMIT_ORDER_LADDER) {
      this.recordLimitOrder(selection.selectedSide, ladderItem, now, selection);
    }
    this.statusReason = `${selection.selectedSide} midpoint reached $${selection.triggeringPrice.toFixed(3)} after 120 seconds; submitted limit buys for 1,000 at $0.40 and 2,000 at $0.60.`;
  }

  recordLimitOrderFill(order, fill, now) {
    const orderCostBeforeFill = order.filledCost;
    const totalFilledCost = orderCostBeforeFill + fill.cost;
    order.filledShares += fill.shares;
    order.remainingShares = Math.max(0, order.requestedShares - order.filledShares);
    order.filledCost = totalFilledCost;
    order.fees += fill.fees;
    order.averageFillPrice = order.filledShares > 0 ? totalFilledCost / order.filledShares : null;
    order.fillCount += 1;
    order.lastFillAt = now;
    order.status = order.remainingShares <= 1e-8 ? 'FILLED' : 'PARTIALLY_FILLED';
    order.reservedFunds = order.remainingShares * (order.limitPrice + TAKER_FEE_RATE * 0.25);

    const trade = {
      id: `paper-${order.id}-${order.fillCount}`,
      orderId: order.id,
      marketId: order.marketId,
      tokenId: order.tokenId,
      windowStart: order.windowStart,
      windowEnd: order.windowEnd,
      marketTitle: order.marketTitle,
      side: order.side,
      entryKind: 'RESTING_LIMIT',
      orderType: 'LIMIT',
      limitPrice: order.limitPrice,
      requestedShares: order.requestedShares,
      shares: fill.shares,
      entryPrice: fill.averagePrice,
      cost: fill.cost,
      fees: fill.fees,
      totalCost: fill.totalCost,
      openedAt: now,
      status: 'OPEN',
      peakBid: null,
      peakBidAt: null,
      lastOutcomeBid: null,
      lastOutcomeBidAt: null,
      realizedPnl: null,
    };
    order.tradeIds.push(trade.id);
    this.trades.unshift(trade);
    const windowResult = this.windowResults.get(order.windowStart)
      ?? { entryCount: 0, settledCount: 0, netPnl: 0 };
    windowResult.entryCount += 1;
    this.windowResults.set(order.windowStart, windowResult);
    this.cash -= fill.totalCost;
    this.equitySnapshotRequested = true;
    let retainedSettled = 0;
    this.trades = this.trades.filter(item => item.status === 'OPEN' || retainedSettled++ < 200);
    this.log('PAPER_LIMIT_BUY_FILLED', {
      orderId: order.id,
      tradeId: trade.id,
      side: order.side,
      limitPrice: order.limitPrice,
      requestedShares: order.requestedShares,
      filledShares: fill.shares,
      remainingShares: order.remainingShares,
      averageFillPrice: fill.averagePrice,
      fillCost: fill.cost,
      fillFees: fill.fees,
      status: order.status,
    }, order.windowStart);
  }

  processRestingLimitOrders(now) {
    if (!this.market || now >= this.market.end) return;
    const orders = this.limitOrders
      .filter(order => order.windowStart === this.market.start
        && order.windowEnd > now
        && ['OPEN', 'PARTIALLY_FILLED'].includes(order.status)
        && order.remainingShares > 1e-8)
      .sort((a, b) => b.limitPrice - a.limitPrice || a.slot - b.slot);

    for (const order of orders) {
      const quote = this.quotes[order.side];
      if (!quoteIsFresh(quote, now, EXIT_QUOTE_MAX_AGE_MS)) continue;
      const availableAsks = this.orderBookAsksAvailable(order.side, quote);
      const fill = simulateLimitBuyFill(
        availableAsks, order.limitPrice, order.remainingShares, estimateTakerFee,
      );
      if (!fill) continue;
      this.consumeOrderBookAsks(order.side, fill);
      this.recordLimitOrderFill(order, fill, now);
    }
  }

  cancelExpiredLimitOrders(now) {
    for (const order of this.limitOrders) {
      if (!['OPEN', 'PARTIALLY_FILLED'].includes(order.status)
        || order.remainingShares <= 0 || order.windowEnd > now) continue;
      order.cancelledRemainderShares = order.remainingShares;
      order.remainingShares = 0;
      order.reservedFunds = 0;
      order.status = order.filledShares > 0 ? 'PARTIALLY_FILLED_CANCELLED' : 'CANCELLED_WINDOW_END';
      this.log('PAPER_LIMIT_BUY_CANCELLED_AT_EXPIRY', {
        orderId: order.id,
        side: order.side,
        limitPrice: order.limitPrice,
        filledShares: order.filledShares,
        cancelledRemainderShares: order.cancelledRemainderShares,
      }, order.windowStart);
    }
  }

  orderSchedule(now = this.now()) {
    const start = this.market?.start;
    if (!Number.isFinite(start)) {
      return {
        status: 'WAITING_FOR_MARKET',
        triggered: false,
        triggerAt: null,
        nextOrderAt: null,
        ordersPlaced: 0,
        openOrders: 0,
      };
    }
    const currentOrders = this.limitOrders.filter(order => order.windowStart === start);
    const openOrders = currentOrders.filter(order => ['OPEN', 'PARTIALLY_FILLED'].includes(order.status));
    const triggerAt = start + ENTRY_TRIGGER_SECONDS * 1000;
    const triggered = Boolean(this.limitOrderTriggerSide && this.orderWindowStart === start);
    const status = triggered
      ? 'TRIGGERED'
      : now < triggerAt ? 'WAITING_FOR_DELAY'
        : now < this.market.end ? 'MONITORING_TRIGGER' : 'WINDOW_CLOSED';
    return {
      status,
      triggered,
      triggerSide: triggered ? this.limitOrderTriggerSide : null,
      triggerPrice: ENTRY_TRIGGER_PRICE,
      triggerSeconds: ENTRY_TRIGGER_SECONDS,
      triggerAt,
      nextOrderAt: status === 'WAITING_FOR_DELAY' ? triggerAt : null,
      ordersPlaced: currentOrders.filter(order => !order.status.startsWith('SKIPPED_')).length,
      openOrders: openOrders.length,
      filledShares: currentOrders.reduce((sum, order) => sum + order.filledShares, 0),
      reservedFunds: openOrders.reduce((sum, order) => sum + order.reservedFunds, 0),
      ladder: LIMIT_ORDER_LADDER.map(item => ({ ...item })),
    };
  }

  processSignals(now) {
    this.beginMarketWindow();
    const currentSchedule = this.entrySchedule(now);
    if (!this.activeSide || this.marketSignal?.status !== 'READY') return;
    this.finalizeExpiredEntrySlots(currentSchedule.slot);
    const schedule = this.entrySchedule(now);
    if (!schedule.due) return;
    const side = this.activeSide;
    const quote = this.quotes[side];
    const fresh = Number.isFinite(quote?.updatedAt) && now >= quote.updatedAt
      && now - quote.updatedAt <= EXIT_QUOTE_MAX_AGE_MS;
    if (!fresh) {
      this.logEntryStageSkipOnce(schedule.slot, side, 'Stale book');
      return;
    }
    const checkpoint = ENTRY_CHECKPOINTS[schedule.slot];
    const bestAsk = quote.bestAsk == null ? NaN : Number(quote.bestAsk);
    if (!Number.isFinite(bestAsk)) {
      this.logEntryStageSkipOnce(schedule.slot, side, 'No current best ask');
      return;
    }
    if (bestAsk >= checkpoint.maximumAsk) {
      const firstPriceFilterObservation = !this.priceFilteredSlots.has(schedule.slot);
      this.priceFilteredSlots.set(schedule.slot, bestAsk);
      if (firstPriceFilterObservation) {
        this.log('SCHEDULED_ENTRY_PRICE_FILTERED', {
          side,
          slot: schedule.slot,
          stageStartSeconds: checkpoint.seconds,
          stageEndSeconds: checkpoint.endSeconds,
          maximumAsk: checkpoint.maximumAsk,
          bestAsk,
          potentialCarryShares: SHARES_PER_SIGNAL,
          pendingPriceFilteredShares: this.pendingPriceFilteredShares,
          reason: 'Waiting for the price cap during this stage.',
        });
      }
      return;
    }
    // A qualifying price consumes this stage once; other execution safeguards
    // still run as before and are not retried on every 500ms scan.
    this.lastEntrySlot = schedule.slot;
    const filter = this.updateEntryFilter(now);
    if (filter.blockedReasons.length) {
      this.log('SCHEDULED_ENTRY_SKIPPED', {
        side, slot: schedule.slot, reason: filter.blockedReasons.join(','),
        pendingPriceFilteredShares: this.pendingPriceFilteredShares,
      });
      return;
    }
    const carriedShares = this.pendingPriceFilteredShares;
    const sharesToBuy = SHARES_PER_SIGNAL + carriedShares;
    const fill = this.entryFill(side, sharesToBuy);
    if (!fill || fill.totalCost > this.cash) {
      this.log('SCHEDULED_ENTRY_SKIPPED', { side, slot: schedule.slot,
        reason: !fill
          ? `Insufficient visible ask depth for ${sharesToBuy} shares`
          : 'Insufficient paper cash',
        requestedShares: sharesToBuy,
        pendingPriceFilteredShares: carriedShares,
      });
      return;
    }
    const trade = {
      id: `paper-${this.market.start}-${side}-${now}-${++this.entrySequence}`,
      marketId: this.market.id,
      tokenId: this.market.tokens?.[side] ?? null,
      windowStart: this.market.start,
      windowEnd: this.market.end,
      marketTitle: this.market.title,
      side,
      shares: fill.shares,
      entryKind: 'SCHEDULED_SIGNAL',
      scheduledAt: schedule.scheduledAt,
      entrySlot: schedule.slot,
      entryPriceLimit: checkpoint.maximumAsk,
      baseShares: SHARES_PER_SIGNAL,
      priceFilteredSharesIncluded: carriedShares,
      entryPrice: fill.averagePrice,
      cost: fill.cost,
      fees: fill.fees,
      totalCost: fill.totalCost,
      edgeAtEntry: null,
      requiredNetEdge: null,
      modelProbability: null,
      openedAt: now,
      status: 'OPEN',
      peakBid: null,
      peakBidAt: null,
      lastOutcomeBid: null,
      lastOutcomeBidAt: null,
      realizedPnl: null,
    };
    this.cash -= fill.totalCost;
    this.pendingPriceFilteredShares = 0;
    this.trades.unshift(trade);
    const windowResult = this.windowResults.get(this.market.start)
      ?? { entryCount: 0, settledCount: 0, netPnl: 0 };
    windowResult.entryCount += 1;
    this.windowResults.set(this.market.start, windowResult);
    this.equitySnapshotRequested = true;
    let retainedSettled = 0;
    this.trades = this.trades.filter(item => item.status === 'OPEN' || retainedSettled++ < 200);
    this.log('PAPER_BUY', {
      tradeId: trade.id,
      entryKind: trade.entryKind, scheduledAt: trade.scheduledAt, slot: trade.entrySlot,
      side, shares: fill.shares, price: fill.averagePrice,
      priceLimit: checkpoint.maximumAsk,
      priceFilteredSharesIncluded: carriedShares,
    });
  }

  entryFill(side, shares = SHARES_PER_SIGNAL) {
    return simulateBuy(this.quotes[side]?.asks, shares);
  }

  logEntryStageSkipOnce(slot, side, reason) {
    const key = `${slot}:${reason}`;
    if (this.entryStageSkipLogs.has(key)) return;
    this.entryStageSkipLogs.add(key);
    this.log('SCHEDULED_ENTRY_SKIPPED', { side, slot, reason });
  }

  finalizeExpiredEntrySlots(currentSlot) {
    const lastExpiredSlot = Math.min(currentSlot - 1, ENTRY_CHECKPOINTS.length - 1);
    while (this.lastEntrySlot < lastExpiredSlot) {
      const slot = this.lastEntrySlot + 1;
      const checkpoint = ENTRY_CHECKPOINTS[slot];
      const lastFilteredAsk = this.priceFilteredSlots.get(slot);
      if (Number.isFinite(lastFilteredAsk)) {
        this.pendingPriceFilteredShares += SHARES_PER_SIGNAL;
        this.log('SCHEDULED_ENTRY_PRICE_FILTERED_STAGE_ENDED', {
          side: this.activeSide,
          slot,
          stageStartSeconds: checkpoint.seconds,
          stageEndSeconds: checkpoint.endSeconds,
          maximumAsk: checkpoint.maximumAsk,
          lastFilteredAsk,
          sharesAdded: SHARES_PER_SIGNAL,
          pendingPriceFilteredShares: this.pendingPriceFilteredShares,
        });
      }
      this.lastEntrySlot = slot;
    }
  }

  entrySchedule(now = this.now()) {
    const start = this.market?.start;
    if (!Number.isFinite(start)) return { due: false, nextEntryAt: null };
    const slot = entrySlotAt(start, now);
    const checkpoint = ENTRY_CHECKPOINTS[slot];
    const scheduledAt = checkpoint ? start + checkpoint.seconds * 1000 : null;
    const due = Boolean(checkpoint) && slot > this.lastEntrySlot
      && now >= scheduledAt && now < start + (checkpoint.endSeconds + 1) * 1000
      && now < this.market.end;
    const nextCheckpoint = due
      ? checkpoint
      : ENTRY_CHECKPOINTS.find(item => item.slot > this.lastEntrySlot
        && start + item.seconds * 1000 > now);
    const nextEntryAt = nextCheckpoint
      ? due ? now : start + nextCheckpoint.seconds * 1000
      : null;
    return {
      due,
      slot,
      scheduledAt,
      nextEntryAt,
      nextStageStartSeconds: nextCheckpoint?.seconds ?? null,
      nextStageEndSeconds: nextCheckpoint?.endSeconds ?? null,
      nextPriceMaximumAsk: nextCheckpoint?.maximumAsk ?? null,
      nextEntryShares: nextCheckpoint ? SHARES_PER_SIGNAL + this.pendingPriceFilteredShares : null,
      pendingPriceFilteredShares: this.pendingPriceFilteredShares,
      firstEntryAt: start + ENTRY_CHECKPOINTS[0].seconds * 1000,
      lastEntryAt: start + ENTRY_CHECKPOINTS[ENTRY_CHECKPOINTS.length - 1].endSeconds * 1000,
      intervalSeconds: 60,
      maxEntries: MAX_ENTRIES_PER_WINDOW,
      checkpoints: ENTRY_CHECKPOINTS.map(item => ({
        slot: item.slot,
        seconds: item.seconds,
        startSeconds: item.seconds,
        endSeconds: item.endSeconds,
        maximumAsk: item.maximumAsk,
      })),
      lastAttemptedSlot: this.lastEntrySlot,
    };
  }

  processPositionExits(now, { allowWindowPriceExit = false } = {}) {
    for (const trade of this.trades) {
      if (trade.status !== 'OPEN') continue;
      const exitStartAt = (Number.isFinite(trade.windowStart)
        ? trade.windowStart
        : trade.windowEnd - WINDOW_MS) + EXIT_START_SECONDS * 1000;
      const quote = trade.marketId === this.market?.id ? this.quotes[trade.side] : null;
      const bid = quote?.bestBid == null ? NaN : Number(quote.bestBid);
      const fresh = Number.isFinite(quote?.updatedAt)
        && now >= quote.updatedAt
        && now - quote.updatedAt <= EXIT_QUOTE_MAX_AGE_MS
        && Number.isFinite(bid)
        && bid >= 0
        && bid <= 1;

      if (now < trade.windowEnd && fresh && quote.updatedAt >= (trade.openedAt ?? 0)
        && (trade.peakBid == null || bid > trade.peakBid)) {
        trade.peakBid = bid;
        trade.peakBidAt = quote.updatedAt;
      }

      if (now < trade.windowEnd && fresh) {
        trade.lastOutcomeBid = bid;
        trade.lastOutcomeBidAt = quote.updatedAt;
        const exit = thresholdExit(bid);
        const takeProfitHit = exit?.outcome === 'TAKE_PROFIT';
        const stopLossEligible = exit?.outcome === 'STOP_LOSS' && now >= exitStartAt;
        if (takeProfitHit || stopLossEligible) {
          const gateDescription = takeProfitHit
            ? 'Take-profit triggered during the active window'
            : 'Stop-loss triggered after the 295-second exit gate';
          this.closeTrade(trade, exit.price, trade.shares * exit.price, exit.outcome,
            `${gateDescription}; credited $${exit.price.toFixed(2)} per share before fees.`,
            now, bid);
        }
        continue;
      }

      if (now < trade.windowEnd) continue;
      if (allowWindowPriceExit) {
        const closeQuoteFresh = Number.isFinite(trade.lastOutcomeBid)
          && Number.isFinite(trade.lastOutcomeBidAt)
          && trade.lastOutcomeBidAt <= trade.windowEnd
          && trade.windowEnd - trade.lastOutcomeBidAt <= EXIT_QUOTE_MAX_AGE_MS;
        if (closeQuoteFresh) {
          this.closeTrade(
            trade,
            trade.lastOutcomeBid,
            trade.shares * trade.lastOutcomeBid,
            'WINDOW_PRICE_EXIT',
            'Historical replay only: marked at the last own-side bid before window close.',
            now,
            trade.lastOutcomeBid,
          );
        }
        continue;
      }
      const wasPending = trade.settlementStatus === 'AWAITING_SETTLEMENT';
      trade.settlementStatus = 'AWAITING_SETTLEMENT';
      trade.settlementError = 'Window ended without an exit; waiting for confirmed original-market resolution.';
      if (!wasPending) {
        this.log('EXPIRY_RECOVERY_PENDING', {
          tradeId: trade.id,
          marketId: trade.marketId,
          reason: trade.settlementError,
        }, trade.windowStart);
      }
    }
  }

  processOppositeSignalExits(now) {
    // Deliberately disabled: only TP, SL and original-market expiry handling may sell.
  }

  closeTrade(trade, exitPrice, payout, outcome, settlementSource, now, feeExecutionPrice, executionFees) {
    const exitFees = executionFees ?? estimateTakerFee(feeExecutionPrice, trade.shares);
    const netPayout = payout - exitFees;
    trade.status = 'SETTLED';
    trade.settlementStatus = 'SETTLED';
    trade.settlementError = null;
    trade.finalOutcome = outcome;
    trade.closePrice = exitPrice;
    trade.exitPrice = exitPrice;
    trade.grossPayout = payout;
    trade.exitFees = exitFees;
    trade.netPayout = netPayout;
    trade.settlementSource = settlementSource;
    trade.realizedPnl = netPayout - trade.totalCost;
    trade.settledAt = now;
    this.cash += netPayout;
    this.settledCount += 1;
    if (trade.realizedPnl > 0) this.settledWins += 1;
    else if (trade.realizedPnl < 0) this.settledLosses += 1;
    if (trade.side === 'UP' || trade.side === 'DOWN') {
      this.realizedPnlBySide[trade.side] += trade.realizedPnl;
    }
    const windowResult = this.windowResults.get(trade.windowStart);
    if (windowResult) {
      windowResult.settledCount += 1;
      windowResult.netPnl += trade.realizedPnl;
    }
    this.equitySnapshotRequested = true;
    this.log('PAPER_EXIT', {
      tradeId: trade.id,
      modelProbability: trade.modelProbability,
      entryPrice: trade.entryPrice,
      side: trade.side,
      outcome,
      exitPrice,
      grossPayout: payout,
      exitFees,
      netPayout,
      realizedPnl: trade.realizedPnl,
      windowStart: trade.windowStart,
    }, trade.windowStart ?? this.market?.start);
  }

  maybeFinalizeCompletedWindows(now) {
    for (const [windowStart, result] of this.windowResults) {
      if (this.finalizedWindowStarts.has(windowStart)
        || windowStart + WINDOW_MS > now
        || result.settledCount < result.entryCount
        || this.trades.some(trade => trade.windowStart === windowStart && trade.status === 'OPEN')) {
        continue;
      }
      const windowResult = {
        windowStart,
        windowEnd: windowStart + WINDOW_MS,
        completedAt: now,
        tradeCount: result.entryCount,
        netPnl: Number(result.netPnl.toFixed(8)),
        outcome: result.netPnl > 1e-8 ? 'WIN' : result.netPnl < -1e-8 ? 'LOSS' : 'FLAT',
      };
      this.finalizedWindowStarts.add(windowStart);
      this.windowResults.delete(windowStart);
      this.log('PAPER_WINDOW_COMPLETED', windowResult, windowStart);
      if (this.learningStore && typeof this.learningStore.recordWindowResult === 'function') {
        this.queuePersistence(() => this.learningStore.recordWindowResult(windowResult));
      }
    }
  }

  calculateGlobalEquity(now = this.now()) {
    const openTrades = this.trades.filter(trade => trade.status === 'OPEN');
    const openCost = openTrades.reduce((sum, trade) => sum + trade.totalCost, 0);
    let markedValue = 0;
    for (const trade of openTrades) {
      const quote = trade.marketId === this.market?.id ? this.quotes[trade.side] : null;
      const bid = quote?.bestBid == null ? NaN : Number(quote.bestBid);
      const fresh = Number.isFinite(quote?.updatedAt) && now >= quote.updatedAt
        && now - quote.updatedAt <= EXIT_QUOTE_MAX_AGE_MS
        && Number.isFinite(bid) && bid >= 0 && bid <= 1;
      if (!fresh) {
        return {
          valid: false,
          equity: null,
          cash: this.cash,
          markedValue: null,
          unrealizedPnl: null,
        };
      }
      markedValue += trade.shares * bid - estimateTakerFee(bid, trade.shares);
    }
    return {
      valid: true,
      equity: this.cash + markedValue,
      cash: this.cash,
      markedValue,
      unrealizedPnl: markedValue - openCost,
    };
  }

  maybeRecordEquitySnapshot(now = this.now()) {
    if (!this.learningStore || typeof this.learningStore.recordEquitySnapshot !== 'function') return;
    const intervalElapsed = this.lastEquitySnapshotAt == null
      || now - this.lastEquitySnapshotAt >= EQUITY_SNAPSHOT_INTERVAL_MS;
    if (!this.equitySnapshotRequested && !intervalElapsed) return;
    const equity = this.calculateGlobalEquity(now);
    if (!equity.valid) return;
    this.lastEquitySnapshotAt = now;
    this.equitySnapshotRequested = false;
    const openCost = this.trades.filter(trade => trade.status === 'OPEN')
      .reduce((sum, trade) => sum + trade.totalCost, 0);
    const realizedPnl = this.cash + openCost - STARTING_CASH;
    const snapshot = {
      ts: now,
      accountSessionStartedAt: this.accountSessionStartedAt,
      windowStart: this.market?.start ?? null,
      equity: equity.equity,
      cash: equity.cash,
      markedValue: equity.markedValue,
      realizedPnl,
      unrealizedPnl: equity.unrealizedPnl,
    };
    this.queuePersistence(() => this.learningStore.recordEquitySnapshot(snapshot));
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.priceFeed.start();
    this.log('SCANNER_STARTED');
    const loop = async () => {
      if (!this.running) return;
      await this.tick();
      if (this.running) {
        this.timer = setTimeout(loop, POLL_MS);
        this.timer.unref?.();
      }
    };
    void loop();
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    this.timer = null;
    this.log('SCANNER_STOPPED');
  }

  snapshot() {
    const now = this.now();
    const openTrades = this.trades.filter(trade => trade.status === 'OPEN');
    const activeWindowTrades = this.market
      ? openTrades.filter(trade => trade.marketId === this.market.id
        && trade.windowStart === this.market.start
        && trade.windowEnd > now
        && trade.settlementStatus !== 'AWAITING_SETTLEMENT')
      : [];
    const awaitingSettlementTrades = openTrades.filter(
      trade => trade.settlementStatus === 'AWAITING_SETTLEMENT',
    );
    const openCost = openTrades.reduce((sum, trade) => sum + trade.totalCost, 0);
    // Reconcile against the cash ledger, not the bounded display history.
    const realizedPnl = this.cash + openCost - STARTING_CASH;
    const globalEquity = this.calculateGlobalEquity(now);
    const positions = Object.fromEntries(['UP', 'DOWN'].map(side => {
      const sideOpenTrades = activeWindowTrades.filter(trade => trade.side === side);
      const shares = sideOpenTrades.reduce((sum, trade) => sum + trade.shares, 0);
      const costBasis = sideOpenTrades.reduce((sum, trade) => sum + trade.totalCost, 0);
      const currentQuote = this.market ? this.quotes[side] : null;
      const bid = currentQuote?.bestBid;
      const quoteFresh = Boolean(this.market) && Number.isFinite(currentQuote?.updatedAt)
        && now >= currentQuote.updatedAt
        && now - currentQuote.updatedAt <= EXIT_QUOTE_MAX_AGE_MS
        && Number.isFinite(bid) && bid >= 0 && bid <= 1;
      const markedValue = quoteFresh
        ? sideOpenTrades.reduce((sum, trade) => sum
          + trade.shares * bid
          - estimateTakerFee(bid, trade.shares), 0)
        : null;
      const sideRealizedPnl = this.realizedPnlBySide[side] ?? 0;
      return [side, {
        shares,
        costBasis,
        averageCost: shares > 0 ? costBasis / shares : null,
        midpoint: quoteFresh && Number.isFinite(currentQuote?.midpoint)
          ? currentQuote.midpoint : null,
        bestBid: quoteFresh ? bid : null,
        bestAsk: quoteFresh ? currentQuote.bestAsk : null,
        markedValue,
        unrealizedPnl: markedValue == null ? null : markedValue - costBasis,
        realizedPnl: sideRealizedPnl,
      }];
    }));
    const ticks = (() => { try { return this.priceFeed.snapshot(); } catch { return null; } })();
    const openLimitOrders = this.limitOrders.filter(order => (
      ['OPEN', 'PARTIALLY_FILLED'].includes(order.status) && order.remainingShares > 0
    ));
    return {
      mode: 'PAPER ONLY',
      running: this.running,
      now,
      lastUpdateAt: this.lastUpdateAt,
      error: this.error,
      statusReason: this.statusReason,
      strategy: {
        timeframe: '5m',
        pollIntervalMs: POLL_MS,
        orderType: 'LIMIT',
        entryTriggerSeconds: ENTRY_TRIGGER_SECONDS,
        entryTriggerMidpoint: ENTRY_TRIGGER_PRICE,
        limitOrderLadder: LIMIT_ORDER_LADDER.map(item => ({ ...item })),
        maxOrdersPerWindow: LIMIT_ORDER_LADDER.length,
        takerFeeRate: TAKER_FEE_RATE,
        takeProfitBid: TAKE_PROFIT_BID,
        takeProfitPayoutPerShare: 1,
        stopLossBid: STOP_LOSS_BID,
        stopLossPayoutPerShare: 0,
        exitStartSeconds: EXIT_START_SECONDS,
        orderSchedule: LIMIT_ORDER_LADDER.map(item => ({ ...item })),
        orderModel: 'Starting 120 seconds after each window opens, monitor fresh UP/DOWN midpoints. The first side reaching $0.80 or higher is latched for that window and receives one 1,000-share limit buy at $0.40 and one 2,000-share limit buy at $0.60. Orders are not rearmed.',
        fillModel: 'Paper limit buys rest until the window ends. Each scan fills only against fresh visible ask depth at or below the order limit, at the available ask prices, with the existing taker-fee estimate. Partial fills remain open; unfilled shares are cancelled at window expiry. Open orders reserve their maximum limit cost and a conservative fee estimate without deducting that reserve from displayed cash.',
        exitModel: 'During the active window, a fresh own-side best bid >= $0.99 triggers take-profit and credits $1 per share before fees. Stop-loss remains gated until 295 seconds and uses a fresh own-side best bid <= $0.01 to credit $0. Missing or stale bids do not trigger a sale. No opposite-signal exits or reversals. Unsold positions at expiry remain pending until the original market confirms its binary resolution; later CLOB bids do not liquidate them.',
      },
      window: this.market ? { title: this.market.title, slug: this.market.slug, start: this.market.start, end: this.market.end, secondsRemaining: Math.max(0, (this.market.end - now) / 1000) } : null,
      referencePrice: this.referencePrice,
      spotPrice: this.latestPrice,
      priceGap: this.referencePrice && this.latestPrice ? this.latestPrice - this.referencePrice : null,
      priceAt: this.priceAt,
      quotes: {
        UP: this.quotes.UP ? { bestBid: this.quotes.UP.bestBid, bestAsk: this.quotes.UP.bestAsk, midpoint: this.quotes.UP.midpoint, updatedAt: this.quotes.UP.updatedAt } : null,
        DOWN: this.quotes.DOWN ? { bestBid: this.quotes.DOWN.bestBid, bestAsk: this.quotes.DOWN.bestAsk, midpoint: this.quotes.DOWN.midpoint, updatedAt: this.quotes.DOWN.updatedAt } : null,
      },
      paperAccount: {
        startingCash: STARTING_CASH, cash: this.cash, openCost, realizedPnl,
        reservedOrderFunds: this.reservedLimitOrderFunds(),
        availableCashAfterReservations: Math.max(0, this.cash - this.reservedLimitOrderFunds()),
        equity: globalEquity.valid ? globalEquity.equity : null,
        markedValue: globalEquity.markedValue,
        unrealizedPnl: globalEquity.unrealizedPnl,
        equityMarkStatus: globalEquity.valid ? 'FRESH' : 'WAITING_FOR_FRESH_MARKS',
        wins: this.settledWins, losses: this.settledLosses,
        settled: this.settledCount,
        openPositions: openTrades.length,
        activeWindowPositions: activeWindowTrades.length,
        openOrders: openLimitOrders.length,
        positions,
        awaitingSettlement: awaitingSettlementTrades.length,
        awaitingSettlementShares: awaitingSettlementTrades.reduce((sum, trade) => sum + trade.shares, 0),
      },
      trades: this.trades.slice(0, 50),
      takerOrders: this.takerOrders.slice(0, 50),
      limitOrders: this.limitOrders.slice(0, 100),
      openOrders: openLimitOrders,
      events: this.events,
      entrySideSelection: this.entrySideSelection,
      orderSchedule: this.orderSchedule(now),
      learning: {
        ...this.learningStatus,
        persistenceStatus: this.persistenceError ? 'error' : this.learningStore ? 'connected' : 'disabled',
      },
      priceFeed: ticks,
    };
  }
}

module.exports = { ProbabilityBot, probabilityUp, estimateLogReturnVolatility, normalCdf, simulateBuy, DEFAULT_STRATEGY_SETTINGS };
