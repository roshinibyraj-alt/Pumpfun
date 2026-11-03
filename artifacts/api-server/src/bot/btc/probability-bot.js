'use strict';

const config = require('./config');
const marketData = require('./wick-market-data');
const { feed } = require('./chainlink-price-feed');
const { detectMacdHistogram, windowSignal } = require('./macd-signal');
const { TAKE_PROFIT_BID, STOP_LOSS_BID, thresholdExit, recoverExpiredPositions } = require('./position-exits');

const WINDOW_MS = 5 * 60 * 1000;
const SHARES_PER_SIGNAL = 50;
const MIN_EDGE = 0.05;
const LOW_PRICE_THRESHOLD = 0.25;
const LOW_PRICE_MIN_EDGE = 0.10;
const STARTING_CASH = 10_000;
const POLL_MS = 500;
const TAKER_FEE_RATE = config.CRYPTO_TAKER_FEE_RATE;
const MIN_ENTRY_PRICE = 0.02;
const OPENING_DELAY_SECONDS = 10;
const ENTRY_INTERVAL_MS = 10_000;
const FIRST_ENTRY_SECONDS = OPENING_DELAY_SECONDS;
const LAST_ENTRY_SECONDS = 290;
const MAX_ENTRIES_PER_WINDOW = Math.floor((LAST_ENTRY_SECONDS - FIRST_ENTRY_SECONDS) * 1000
  / ENTRY_INTERVAL_MS) + 1;
// Permit normal polling/network jitter, but never catch up missed slots in a burst.
const SLOT_GRACE_MS = 1000;
const EXIT_QUOTE_MAX_AGE_MS = 5000;
const DEFAULT_STRATEGY_SETTINGS = Object.freeze({
  openingDelaySeconds: OPENING_DELAY_SECONDS,
  minimumNetEdge: MIN_EDGE,
  lowPriceThreshold: LOW_PRICE_THRESHOLD,
  lowPriceMinimumNetEdge: LOW_PRICE_MIN_EDGE,
  volatilityMultiplier: 1,
  sharesPerSignal: SHARES_PER_SIGNAL,
  sideMode: 'window-macd',
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
    activeSide = null,
    fourBarFilter = false,
  } = {}) {
    this.now = now;
    this.fetchMarket = fetchMarket;
    this.fetchBook = fetchBook;
    this.fetchMarketDetails = fetchMarketDetails;
    this.expiryRecoveryAt = new Map();
    this.priceFeed = priceFeed;
    this.fourBarFilter = fourBarFilter;
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
    this.macd = null;
    this.pendingReversal = null;
    this.activeSide = null;
    this.activeSignalReason = null;
    this.windowDecision = { status: 'OBSERVING', side: null };
    this.lastEntrySlot = -1;
    this.entrySequence = 0;
    this.entryWindowStart = null;
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

  log(event, details = {}) {
    const ts = this.now();
    this.events.unshift({ ts, event, ...details });
    this.events.length = Math.min(this.events.length, 60);
    if (this.learningStore) this.queuePersistence(() => this.learningStore.recordEvent({
      ts, windowStart: this.market?.start, event, details,
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
        signalSide: this.pullback.detectedSide,
        regime: this.pullback.regime,
        activeSignalReason: this.pullback.activeSignalReason,
         timeframe: '5m',
      } : null,
      activeSide: this.activeSide,
      windowDecision: this.windowDecision,
      macd: this.macd ? {
        method: this.macd.method, status: this.macd.status,
        latestHistogram: this.macd.latestHistogram, previousHistogram: this.macd.previousHistogram,
        classification: this.macd.classification, signalAt: this.macd.signalAt,
      } : null,
      quotes: Object.fromEntries(['UP', 'DOWN'].map(side => {
        const quote = this.learningQuotes?.[side] ?? this.quotes[side];
        return [side, quote ? {
          bestBid: quote.bestBid, bestAsk: quote.bestAsk, asks: quote.asks, bids: quote.bids,
          updatedAt: quote.updatedAt,
        } : null];
      })),
    };
    // Persist a compact, causal history once per window, not 50 bars every scan.
    const closedBars = (this.macd?.chart?.bars || []).filter(bar =>
      bar.end <= this.market.start && bar.end <= now).slice(-4);
    if (closedBars.length === 4 && closedBars.at(-1).end === this.market.start
      && this.lastHistorySampleWindow !== this.market.start) {
      sample.macd = { ...(sample.macd || {}), closedBars };
      this.lastHistorySampleWindow = this.market.start;
    }
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
      const detectedPullback = detectMacdHistogram(candles, now);
      this.applyPullbackSignal(detectedPullback);
      this.macd = {
        ...detectedPullback,
        detectedSide: detectedPullback.side,
        side: this.activeSide,
        activeSignalReason: this.activeSignalReason,
        regime: this.windowDecision.status,
        windowDecision: this.windowDecision,
      };
      this.pullback = this.macd; // Existing learning/storage contract; never a trendline detector.
      this.statusReason = this.windowDecision.status === 'WAITING_HISTORY'
        ? this.windowDecision.reason === 'FOUR_BAR_HISTORY_REQUIRED'
          ? 'Waiting for four consecutive closed five-minute histogram bars to check the entry filter.'
          : 'Waiting for the prior closed five-minute MACD candle.'
      : this.windowDecision.status === 'SKIP_WINDOW'
          ? this.windowDecision.reason === 'FOUR_BAR_STRENGTHENING_STREAK'
            ? `Four-bar filter: four strengthening ${this.windowDecision.candidateSide === 'UP' ? 'green' : 'red'} bars; skipping ${this.windowDecision.candidateSide} entries for this window.`
            : 'The prior closed five-minute histogram is neutral; skipping this window.'
          : this.activeSide
            ? `Locked ${this.activeSide}; 50-share entries every 10 seconds from 10 through 290 seconds.`
            : 'Waiting for the prior closed five-minute histogram candle.';
      this.probabilityUp = null;
      this.edges = { UP: null, DOWN: null };
      this.processSignals(this.now());
      await this.captureLearningSample(this.now());
      await this.maybeTune(now);
      this.error = null;
      this.lastUpdateAt = now;
    } catch (error) {
      this.processPositionExits(this.now());
      this.error = error?.message || 'BTC window MACD scan failed.';
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

  applyPullbackSignal(signal) {
    this.beginMarketWindow();
    if (!this.market || ['LOCKED', 'SKIP_WINDOW'].includes(this.windowDecision.status)) return;
    const decision = windowSignal(signal, this.market.start, this.now(), {
      fourBarFilter: this.fourBarFilter,
    });
    this.windowDecision = decision;
    this.activeSide = decision.side;
    this.activeSignalReason = decision.side ? 'PREVIOUS_CLOSED_5M_CANDLE' : null;
    if (['LOCKED', 'SKIP_WINDOW'].includes(decision.status)) {
      this.log('WINDOW_MACD_DECIDED', { ...decision, method: signal.method });
    }
  }

  beginMarketWindow(start = this.market?.start) {
    if (!Number.isFinite(start) || this.entryWindowStart === start) return;
    this.entryWindowStart = start;
    this.pendingReversal = null;
    this.activeSide = null;
    this.activeSignalReason = null;
    this.windowDecision = { status: 'OBSERVING', side: null };
    this.lastEntrySlot = -1;
    this.macd = null;
    this.pullback = null;
    this.log('WINDOW_MACD_RESET', { windowStart: start });
  }

  processSignals(now) {
    this.beginMarketWindow();
    const schedule = this.entrySchedule(now);
    if (!this.activeSide || !schedule.due) return;
    // Exactly one attempt per slot, including failures; no every-poll retries or catch-up buys.
    this.lastEntrySlot = schedule.slot;
    const filter = this.updateEntryFilter(now);
    if (!filter.allowed) {
      this.log('SCHEDULED_ENTRY_SKIPPED', { slot: schedule.slot, reason: filter.blockedReasons.join(',') });
      return;
    }
    const side = this.activeSide;
    const quote = this.quotes[side];
    const fresh = Number.isFinite(quote?.updatedAt) && now >= quote.updatedAt
      && now - quote.updatedAt <= EXIT_QUOTE_MAX_AGE_MS;
    const fill = fresh ? this.entryFill(side) : null;
    if (!fill || fill.totalCost > this.cash) {
      this.log('SCHEDULED_ENTRY_SKIPPED', {
        side, slot: schedule.slot,
        reason: !fresh ? 'Stale book' : !fill ? 'Insufficient visible ask depth for 50 shares' : 'Insufficient paper cash',
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
      entryKind: 'SCHEDULED_MACD',
      scheduledAt: schedule.scheduledAt,
      entrySlot: schedule.slot,
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
    this.trades.unshift(trade);
    let retainedSettled = 0;
    this.trades = this.trades.filter(item => item.status === 'OPEN' || retainedSettled++ < 200);
    this.log('PAPER_BUY', {
      tradeId: trade.id,
      entryKind: trade.entryKind, scheduledAt: trade.scheduledAt, slot: trade.entrySlot,
      side, shares: fill.shares, price: fill.averagePrice,
    });
  }

  entryFill(side) {
    return simulateBuy(this.quotes[side]?.asks, SHARES_PER_SIGNAL);
  }

  entrySchedule(now = this.now()) {
    const start = this.market?.start;
    if (!Number.isFinite(start)) return { due: false, nextEntryAt: null };
    const first = start + FIRST_ENTRY_SECONDS * 1000;
    const last = start + LAST_ENTRY_SECONDS * 1000;
    const slot = Math.floor((now - first) / ENTRY_INTERVAL_MS);
    const scheduledAt = first + slot * ENTRY_INTERVAL_MS;
    const due = slot >= 0 && slot < MAX_ENTRIES_PER_WINDOW && slot > this.lastEntrySlot
      && now < scheduledAt + SLOT_GRACE_MS && now < this.market.end;
    const nextSlot = Math.max(0, slot + (slot <= this.lastEntrySlot || now >= scheduledAt + SLOT_GRACE_MS ? 1 : 0));
    const nextEntryAt = first + nextSlot * ENTRY_INTERVAL_MS;
    return { due, slot, scheduledAt, nextEntryAt: nextEntryAt <= last ? nextEntryAt : null,
      firstEntryAt: first, lastEntryAt: last, intervalSeconds: 10, maxEntries: MAX_ENTRIES_PER_WINDOW,
      lastAttemptedSlot: this.lastEntrySlot };
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
    });
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
    const settled = this.trades.filter(trade => trade.status === 'SETTLED');
    const wins = settled.filter(trade => trade.realizedPnl > 0).length;
    const losses = settled.filter(trade => trade.realizedPnl < 0).length;
    const realizedPnl = settled.reduce((sum, trade) => sum + trade.realizedPnl, 0);
    const openTrades = this.trades.filter(trade => trade.status === 'OPEN');
    const openCost = openTrades.reduce((sum, trade) => sum + trade.totalCost, 0);
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
      const sideRealizedPnl = settled
        .filter(trade => trade.side === side)
        .reduce((sum, trade) => sum + trade.realizedPnl, 0);
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
        entryIntervalSeconds: 10,
        lastEntrySeconds: LAST_ENTRY_SECONDS,
        maxEntriesPerWindow: MAX_ENTRIES_PER_WINDOW,
      signalPersistence: 'Reset each window. The immediately prior closed 5-minute MACD candle selects one locked direction; later candles never flip it.',
        entryModel: `50 shares every 10 seconds from ${FIRST_ENTRY_SECONDS} through ${LAST_ENTRY_SECONDS} seconds (${MAX_ENTRIES_PER_WINDOW} scheduled slots). No probability or edge gate; no catch-up bursts. Cash, price-floor, fresh-book and real-depth checks remain active.`,
        model: 'The immediately prior closed 5-minute MACD (12,26,9) histogram chooses the current window: SHRINKING_RED or SOLID_GREEN selects UP; SHRINKING_GREEN or SOLID_RED selects DOWN. Neutral or missing data yields no entry.',
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
        startingCash: STARTING_CASH, cash: this.cash, openCost, realizedPnl, wins, losses,
        settled: settled.length, openPositions: openTrades.length, positions,
        awaitingSettlement: openTrades.filter(trade => trade.settlementStatus === 'AWAITING_SETTLEMENT').length,
      },
      trades: this.trades.slice(0, 50),
      events: this.events,
      pullback: this.pullback,
      macd: this.macd,
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
