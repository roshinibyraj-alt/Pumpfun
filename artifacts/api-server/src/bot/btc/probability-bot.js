'use strict';

const config = require('./config');
const marketData = require('./wick-market-data');
const { feed } = require('./chainlink-price-feed');
const { detectTechnicalSignal, METHOD: TECHNICAL_METHOD } = require('./technical-signal');
const { TAKE_PROFIT_BID, STOP_LOSS_BID, thresholdExit, recoverExpiredPositions } = require('./position-exits');

const WINDOW_MS = 5 * 60 * 1000;
const SHARES_PER_SIGNAL = 500;
const MIN_EDGE = 0.05;
const LOW_PRICE_THRESHOLD = 0.25;
const LOW_PRICE_MIN_EDGE = 0.10;
const STARTING_CASH = 10_000;
const POLL_MS = 500;
const TAKER_FEE_RATE = config.CRYPTO_TAKER_FEE_RATE;
const MIN_ENTRY_PRICE = 0.02;
const OPENING_DELAY_SECONDS = 10;
const ENTRY_CHECKPOINTS = Object.freeze([
  { slot: 0, seconds: 60, maximumAsk: 0.40 },
  { slot: 1, seconds: 120, maximumAsk: 0.60 },
  { slot: 2, seconds: 180, maximumAsk: 0.70 },
  { slot: 3, seconds: 240, maximumAsk: 0.80 },
]);
const MAX_ENTRIES_PER_WINDOW = ENTRY_CHECKPOINTS.length;
// The 500ms scan loop gets a small tolerance for network and scheduler jitter.
const SLOT_GRACE_MS = 5000;
const EQUITY_SNAPSHOT_INTERVAL_MS = 30_000;
const EXIT_QUOTE_MAX_AGE_MS = 5000;
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
      mode: learningStore ? 'logging-only-fixed-policy' : 'disabled',
      completedWindows: 0,
      lastEvaluation: null,
    };
    this.error = null;
    this.statusReason = 'Starting price and market feeds.';
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
      referencePrice: this.referencePrice, spotPrice: this.latestPrice,
      volatility5m: this.volatility5m, probabilityUp: this.probabilityUp,
      edges: this.edges,
      pullback: this.pullback ? {
        method: this.pullback.method,
        side: this.pullback.side,
        signalSide: this.pullback.signalSide,
        regime: this.pullback.regime,
        activeSignalReason: this.pullback.activeSignalReason,
         timeframe: '5m',
      } : null,
      activeSide: this.activeSide,
      windowDecision: this.windowDecision,
      quotes: Object.fromEntries(['UP', 'DOWN'].map(side => {
        const quote = this.learningQuotes?.[side] ?? this.quotes[side];
        return [side, quote ? {
          bestBid: quote.bestBid, bestAsk: quote.bestAsk, asks: quote.asks, bids: quote.bids,
          updatedAt: quote.updatedAt,
        } : null];
      })),
    };
    sample.technicalSignal = this.marketSignal ? {
      method: this.marketSignal.method,
      timeframe: this.marketSignal.timeframe,
      status: this.marketSignal.status,
      side: this.marketSignal.side,
      setup: this.marketSignal.setup,
      confirmed: this.marketSignal.confirmed,
      regime: this.marketSignal.regime,
      score: this.marketSignal.score,
      votes: this.marketSignal.votes,
      tieBreak: this.marketSignal.tieBreak,
      fallbackRule: this.marketSignal.fallbackRule,
      reason: this.marketSignal.reason,
      signalAt: this.marketSignal.signalAt,
      indicators: this.marketSignal.indicators,
    } : null;
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
      this.learningQuotes = structuredClone(this.quotes);
      this.updateEntryFilter(now);
      this.processPositionExits(now);

      const ticks = this.priceFeed.getTicks?.() ?? [];
      const referenceTick = ticks
        .filter(tick => Math.abs(tick.ts - start) <= 10_000)
        .sort((a, b) => Math.abs(a.ts - start) - Math.abs(b.ts - start))[0];
      const latestTick = ticks[ticks.length - 1];
      this.referencePrice = referenceTick?.price ?? null;
      this.latestPrice = latestTick?.price ?? null;
      this.priceAt = latestTick?.ts ?? null;
      const candles = this.priceFeed.getHistoricalCandles?.() ?? [];
      const candles15m = this.priceFeed.getHistoricalFifteenMinuteCandles?.() ?? [];
      const candles1m = this.priceFeed.getHistoricalMinuteCandles?.() ?? [];
      this.applyTechnicalSignal(detectTechnicalSignal({
        candles5m: candles,
        candles15m,
        candles1m,
        now,
        previousSide: this.activeSide,
      }));
      this.pullback = this.marketSignal ? {
        method: this.marketSignal.method,
        timeframe: this.marketSignal.timeframe,
        side: this.activeSide,
        signalSide: this.marketSignal.side,
        setup: this.marketSignal.setup,
        confirmed: this.marketSignal.confirmed,
        regime: this.marketSignal.regime,
        activeSignalReason: this.activeSignalReason,
      } : null;
      this.statusReason = this.marketSignal?.status !== 'READY'
        ? this.marketSignal?.reason || 'Waiting for valid closed-candle strategy data.'
        : `${this.marketSignal.confirmed ? 'Confirmed' : 'Fallback'} ${this.marketSignal.setup} · ${this.activeSide}; 500-share minute checkpoints with price-filter catch-up.`;
      this.probabilityUp = null;
      this.edges = { UP: null, DOWN: null };
      const scanAt = this.now();
      this.processSignals(scanAt);
      this.maybeFinalizeCompletedWindows(scanAt);
      this.maybeRecordEquitySnapshot(scanAt);
      await this.captureLearningSample(scanAt);
      await this.maybeTune(now);
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

    const previousSide = this.activeSide;
    this.activeSide = signal.side;
    this.activeSignalReason = signal.setup;
    this.windowDecision = {
      status: signal.confirmed ? 'LOCKED' : 'FALLBACK',
      side: signal.side,
      signalAt: signal.signalAt,
      setup: signal.setup,
      confirmed: signal.confirmed,
      regime: signal.regime,
      score: signal.score,
      fallbackRule: signal.fallbackRule ?? signal.tieBreak ?? null,
      reason: signal.reason,
      targetPrice: signal.targetPrice ?? null,
      targetLabel: signal.targetLabel ?? null,
    };

    const signalKey = [
      signal.signalAt,
      signal.side,
      signal.setup,
      signal.confirmed,
      signal.indicators?.volume?.signalAt ?? '',
    ].join(':');
    if (signalKey !== this.lastLoggedSignalKey) {
      this.lastLoggedSignalKey = signalKey;
      this.log('WINDOW_SIGNAL_SELECTED', {
        side: signal.side,
        previousSide,
        setup: signal.setup,
        confirmed: signal.confirmed,
        regime: signal.regime,
        score: signal.score,
        fallbackRule: signal.fallbackRule ?? signal.tieBreak ?? null,
        signalAt: signal.signalAt,
        reason: signal.reason,
        method: signal.method,
      });
    }
  }

  beginMarketWindow(start = this.market?.start) {
    if (!Number.isFinite(start) || this.entryWindowStart === start) return;
    this.entryWindowStart = start;
    this.pendingReversal = null;
    this.windowDecision = {
      status: this.activeSide ? 'HELD' : 'OBSERVING',
      side: this.activeSide,
    };
    this.lastEntrySlot = -1;
    this.pendingPriceFilteredShares = 0;
    this.marketSignal = null;
    this.pullback = null;
    this.lastLoggedSignalKey = null;
    this.log('WINDOW_SIGNAL_RESET', { windowStart: start, side: this.activeSide });
  }

  processSignals(now) {
    this.beginMarketWindow();
    const schedule = this.entrySchedule(now);
    if (!this.activeSide || this.marketSignal?.status !== 'READY' || !schedule.due) return;
    this.lastEntrySlot = schedule.slot;
    const side = this.activeSide;
    const quote = this.quotes[side];
    const fresh = Number.isFinite(quote?.updatedAt) && now >= quote.updatedAt
      && now - quote.updatedAt <= EXIT_QUOTE_MAX_AGE_MS;
    if (!fresh) {
      this.log('SCHEDULED_ENTRY_SKIPPED', {
        side, slot: schedule.slot,
        reason: 'Stale book',
      });
      return;
    }
    const checkpoint = ENTRY_CHECKPOINTS[schedule.slot];
    const bestAsk = quote.bestAsk == null ? NaN : Number(quote.bestAsk);
    if (!Number.isFinite(bestAsk)) {
      this.log('SCHEDULED_ENTRY_SKIPPED', {
        side, slot: schedule.slot, reason: 'No current best ask',
      });
      return;
    }
    if (bestAsk >= checkpoint.maximumAsk) {
      this.pendingPriceFilteredShares += SHARES_PER_SIGNAL;
      this.log('SCHEDULED_ENTRY_PRICE_FILTERED', {
        side,
        slot: schedule.slot,
        checkpointSeconds: checkpoint.seconds,
        maximumAsk: checkpoint.maximumAsk,
        bestAsk: Number.isFinite(bestAsk) ? bestAsk : null,
        sharesAdded: SHARES_PER_SIGNAL,
        pendingPriceFilteredShares: this.pendingPriceFilteredShares,
      });
      return;
    }
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

  entrySchedule(now = this.now()) {
    const start = this.market?.start;
    if (!Number.isFinite(start)) return { due: false, nextEntryAt: null };
    const slot = Math.floor((now - start) / 60_000) - 1;
    const checkpoint = ENTRY_CHECKPOINTS[slot];
    const scheduledAt = checkpoint ? start + checkpoint.seconds * 1000 : null;
    const due = Boolean(checkpoint) && slot > this.lastEntrySlot
      && now >= scheduledAt && now < scheduledAt + SLOT_GRACE_MS
      && now < this.market.end;
    const nextCheckpoint = due
      ? checkpoint
      : ENTRY_CHECKPOINTS.find(item => item.slot > this.lastEntrySlot
        && start + item.seconds * 1000 > now);
    const nextEntryAt = nextCheckpoint ? start + nextCheckpoint.seconds * 1000 : null;
    return {
      due,
      slot,
      scheduledAt,
      nextEntryAt,
      nextPriceMaximumAsk: nextCheckpoint?.maximumAsk ?? null,
      nextEntryShares: nextCheckpoint ? SHARES_PER_SIGNAL + this.pendingPriceFilteredShares : null,
      pendingPriceFilteredShares: this.pendingPriceFilteredShares,
      firstEntryAt: start + ENTRY_CHECKPOINTS[0].seconds * 1000,
      lastEntryAt: start + ENTRY_CHECKPOINTS[ENTRY_CHECKPOINTS.length - 1].seconds * 1000,
      intervalSeconds: 60,
      maxEntries: MAX_ENTRIES_PER_WINDOW,
      checkpoints: ENTRY_CHECKPOINTS.map(item => ({
        slot: item.slot,
        seconds: item.seconds,
        maximumAsk: item.maximumAsk,
      })),
      lastAttemptedSlot: this.lastEntrySlot,
    };
  }

  processPositionExits(now) {
    for (const trade of this.trades) {
      if (trade.status !== 'OPEN') continue;
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
        if (exit) {
          this.closeTrade(trade, exit.price, trade.shares * exit.price, exit.outcome,
            `Own-side bid reached the ${exit.outcome === 'TAKE_PROFIT' ? '$0.99 TP' : '$0.01 SL'}; credited $${exit.price.toFixed(2)} per share before fees.`,
            now, bid);
        }
        continue;
      }

      if (now < trade.windowEnd) continue;
      const closeQuoteFresh = Number.isFinite(trade.lastOutcomeBid)
        && Number.isFinite(trade.lastOutcomeBidAt)
        && trade.lastOutcomeBidAt <= trade.windowEnd
        && trade.windowEnd - trade.lastOutcomeBidAt <= EXIT_QUOTE_MAX_AGE_MS;
      if (closeQuoteFresh) {
        const payout = trade.shares * trade.lastOutcomeBid;
        this.closeTrade(
          trade,
          trade.lastOutcomeBid,
          payout,
          'WINDOW_PRICE_EXIT',
          'Window ended; marked at the last own-side best bid before close, less taker fee.',
          now,
          trade.lastOutcomeBid,
        );
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
    const openCost = openTrades.reduce((sum, trade) => sum + trade.totalCost, 0);
    // Reconcile against the cash ledger, not the bounded display history.
    const realizedPnl = this.cash + openCost - STARTING_CASH;
    const globalEquity = this.calculateGlobalEquity(now);
    const positions = Object.fromEntries(['UP', 'DOWN'].map(side => {
      const sideOpenTrades = openTrades.filter(trade => trade.side === side);
      const shares = sideOpenTrades.reduce((sum, trade) => sum + trade.shares, 0);
      const costBasis = sideOpenTrades.reduce((sum, trade) => sum + trade.totalCost, 0);
      const currentQuote = this.market ? this.quotes[side] : null;
      const bid = currentQuote?.bestBid;
      const quoteFresh = Number.isFinite(currentQuote?.updatedAt)
        && now >= currentQuote.updatedAt
        && now - currentQuote.updatedAt <= EXIT_QUOTE_MAX_AGE_MS
        && Number.isFinite(bid)
        && bid >= 0
        && bid <= 1
        && sideOpenTrades.every(trade => trade.marketId === this.market?.id);
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
        bestBid: quoteFresh ? bid : null,
        markedValue,
        unrealizedPnl: markedValue == null ? null : markedValue - costBasis,
        realizedPnl: sideRealizedPnl,
      }];
    }));
    const ticks = (() => { try { return this.priceFeed.snapshot(); } catch { return null; } })();
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
        sharesPerSignal: this.strategySettings.sharesPerSignal,
        minimumNetEdge: null,
        lowPriceThreshold: this.strategySettings.lowPriceThreshold,
        lowPriceMinimumNetEdge: null,
        takerFeeRate: TAKER_FEE_RATE,
        minimumBestAsk: MIN_ENTRY_PRICE,
        openingDelaySeconds: this.strategySettings.openingDelaySeconds,
        volatilityMultiplier: this.strategySettings.volatilityMultiplier,
        sideMode: this.strategySettings.sideMode,
        takeProfitBid: TAKE_PROFIT_BID,
        takeProfitPayoutPerShare: 1,
        stopLossBid: STOP_LOSS_BID,
        stopLossPayoutPerShare: 0,
        probabilityModelEnabled: false,
        reversalsEnabled: false,
        entryIntervalSeconds: 60,
        lastEntrySeconds: ENTRY_CHECKPOINTS[ENTRY_CHECKPOINTS.length - 1].seconds,
        maxEntriesPerWindow: MAX_ENTRIES_PER_WINDOW,
        sharesPerEntry: SHARES_PER_SIGNAL,
        entryPriceCheckpoints: ENTRY_CHECKPOINTS.map(item => ({
          seconds: item.seconds,
          maximumAsk: item.maximumAsk,
        })),
        signalPersistence: 'Select Scenario A in aligned trends, Scenario B in confirmed ranges, otherwise use the aligned 15m EMA200 trend, latest closed 5m candle, previous side on doji, then closed-candle fallback for each valid five-minute window. Stale or insufficient data blocks entries.',
        entryModel: 'At 60s / 120s / 180s / 240s, buy 500 shares on the selected side if its best ask is below $0.40 / $0.60 / $0.70 / $0.80 respectively. Shares skipped by those price checks accumulate for the next qualifying checkpoint in the same window. Cash, $0.02 minimum ask, fresh-book and real-depth checks remain active.',
        model: 'Trend continuation uses 5m EMA9/EMA21 alignment with 15m EMA200, an EMA21/VWAP pullback, Stoch RSI crossing from an extreme, and signed-volume confirmation. Range mean reversion uses a flat 15m EMA200, parallel 5m Bollinger Bands, an outer-band touch, and RSI(7) divergence. A deterministic trend-first fallback selects a side when neither setup confirms. All signals use closed candles; stale history blocks entries.',
        exitModel: 'TP: own-side bid >= $0.99 credits $1; SL: bid <= $0.01 credits $0, before fees. No opposite-signal exits or reversals. Expiry retries the original market when needed; unavailable data remains explicitly pending.',
      },
      window: this.market ? { title: this.market.title, slug: this.market.slug, start: this.market.start, end: this.market.end, secondsRemaining: Math.max(0, (this.market.end - now) / 1000) } : null,
      referencePrice: this.referencePrice,
      spotPrice: this.latestPrice,
      priceGap: this.referencePrice && this.latestPrice ? this.latestPrice - this.referencePrice : null,
      priceAt: this.priceAt,
      volatility5m: this.volatility5m,
      expectedMove: this.expectedMove ?? null,
      standardizedGap: this.standardizedGap ?? null,
      probability: this.probabilityUp == null ? null : { UP: this.probabilityUp, DOWN: 1 - this.probabilityUp },
      edges: this.edges,
      requiredNetEdge: { UP: null, DOWN: null },
      entryArmed: { ...this.armed },
      entryFilter: this.entryFilter,
      quotes: {
        UP: this.quotes.UP ? { bestBid: this.quotes.UP.bestBid, bestAsk: this.quotes.UP.bestAsk, midpoint: this.quotes.UP.midpoint, estimatedAverageAsk: this.entryFill('UP')?.averagePrice ?? null } : null,
        DOWN: this.quotes.DOWN ? { bestBid: this.quotes.DOWN.bestBid, bestAsk: this.quotes.DOWN.bestAsk, midpoint: this.quotes.DOWN.midpoint, estimatedAverageAsk: this.entryFill('DOWN')?.averagePrice ?? null } : null,
      },
      paperAccount: {
        startingCash: STARTING_CASH, cash: this.cash, openCost, realizedPnl,
        equity: globalEquity.valid ? globalEquity.equity : null,
        markedValue: globalEquity.markedValue,
        unrealizedPnl: globalEquity.unrealizedPnl,
        equityMarkStatus: globalEquity.valid ? 'FRESH' : 'WAITING_FOR_FRESH_MARKS',
        wins: this.settledWins, losses: this.settledLosses,
        settled: this.settledCount, openPositions: openTrades.length, positions,
        awaitingSettlement: openTrades.filter(trade => trade.settlementStatus === 'AWAITING_SETTLEMENT').length,
      },
      trades: this.trades.slice(0, 50),
      events: this.events,
      pullback: this.pullback,
      technicalSignal: this.marketSignal,
      pendingReversal: this.pendingReversal ? { ...this.pendingReversal } : null,
      activeSide: this.activeSide,
      windowDecision: this.windowDecision,
      entrySchedule: this.entrySchedule(now),
      learning: {
        ...this.learningStatus,
        persistenceStatus: this.persistenceError ? 'error' : this.learningStore ? 'connected' : 'disabled',
      },
      priceFeed: ticks,
    };
  }
}

module.exports = { ProbabilityBot, probabilityUp, estimateLogReturnVolatility, normalCdf, simulateBuy, DEFAULT_STRATEGY_SETTINGS };
