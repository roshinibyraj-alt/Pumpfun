'use strict';

const config = require('./config');
const marketData = require('./wick-market-data');
const { feed } = require('./chainlink-price-feed');
const { detectPullback } = require('./pullback-signal');

const WINDOW_MS = 5 * 60 * 1000;
const SHARES_PER_SIGNAL = 100;
const MIN_EDGE = 0.05;
const LOW_PRICE_THRESHOLD = 0.25;
const LOW_PRICE_MIN_EDGE = 0.10;
const STARTING_CASH = 10_000;
const POLL_MS = 500;
const FEED_MAX_AGE_MS = 15_000;
const TAKER_FEE_RATE = config.CRYPTO_TAKER_FEE_RATE;
const MIN_ENTRY_PRICE = 0.02;
const OPENING_DELAY_SECONDS = 30;
const EXIT_QUOTE_MAX_AGE_MS = 5000;
const TAKE_PROFIT_BID = 0.99;
const TAKE_PROFIT_PAYOUT = 1;
const STOP_LOSS_BID = 0.01;
const STOP_LOSS_PAYOUT = 0;
const DEFAULT_STRATEGY_SETTINGS = Object.freeze({
  openingDelaySeconds: OPENING_DELAY_SECONDS,
  minimumNetEdge: MIN_EDGE,
  lowPriceThreshold: LOW_PRICE_THRESHOLD,
  lowPriceMinimumNetEdge: LOW_PRICE_MIN_EDGE,
  volatilityMultiplier: 1,
  sharesPerSignal: SHARES_PER_SIGNAL,
  sideMode: 'best-edge',
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

function estimateLogReturnVolatility(candles, count = 20) {
  const closes = (Array.isArray(candles) ? candles : [])
    .filter(candle => Number.isFinite(Number(candle.close)) && Number(candle.close) > 0)
    .slice(-count - 1)
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
    priceFeed = feed,
    learningStore = null,
    choosePaperSettings = null,
    strategySettings = {},
  } = {}) {
    this.now = now;
    this.fetchMarket = fetchMarket;
    this.fetchBook = fetchBook;
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
    this.events = [];
    this.learningStore = learningStore;
    this.choosePaperSettings = choosePaperSettings;
    this.strategySettings = { ...DEFAULT_STRATEGY_SETTINGS, ...strategySettings };
    this.persistenceQueue = Promise.resolve();
    this.persistenceError = null;
    this.lastSampledAt = null;
    this.lastTunedWindowStart = null;
    this.pullback = null;
    this.learningStatus = {
      enabled: Boolean(learningStore && choosePaperSettings),
      mode: learningStore && choosePaperSettings ? 'collecting' : 'disabled',
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
    const ts = Math.floor(now / 2000) * 2000;
    if (ts === this.lastSampledAt) return;
    this.lastSampledAt = ts;
    const sample = {
      ts, windowStart: this.market.start, windowEnd: this.market.end,
      secondsSinceOpen: Math.max(0, (now - this.market.start) / 1000),
      secondsRemaining: Math.max(0, (this.market.end - now) / 1000),
      referencePrice: this.referencePrice, spotPrice: this.latestPrice,
      volatility5m: this.volatility5m, probabilityUp: this.probabilityUp,
      edges: this.edges, pullback: this.pullback,
      quotes: Object.fromEntries(['UP', 'DOWN'].map(side => {
        const quote = this.quotes[side];
        return [side, quote ? {
          bestBid: quote.bestBid, bestAsk: quote.bestAsk, asks: quote.asks.slice(0, 12),
        } : null];
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
      const windows = await this.learningStore.getCompletedWindows(now);
      const result = this.choosePaperSettings(windows, this.strategySettings);
      await this.learningStore.saveTuning(result, now, this.market.start);
      this.learningStatus = {
        enabled: true,
        mode: result.applied ? 'auto-tuned-paper' : 'collecting',
        completedWindows: result.windows,
        lastEvaluation: { ...result, settings: undefined },
      };
      if (result.applied) {
        const previousSettings = this.strategySettings;
        this.strategySettings = { ...result.settings };
        this.log('PAPER_TUNING_APPLIED', {
          previousSettings, settings: this.strategySettings,
          windowsEvaluated: result.windows, baseline: result.baseline, selected: result.selected,
        });
      } else {
        this.log('PAPER_TUNING_HELD', { reason: result.reason, windowsEvaluated: result.windows });
      }
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
      const start = Math.floor(now / WINDOW_MS) * WINDOW_MS;
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

      const [upBook, downBook] = await Promise.all([
        this.fetchBook(this.market.tokens.UP),
        this.fetchBook(this.market.tokens.DOWN),
      ]);
      this.quotes = {
        UP: this.quote(upBook, now),
        DOWN: this.quote(downBook, now),
      };
      this.updateEntryFilter(now);
      this.processPositionExits(now);

      const ticks = this.priceFeed.getTicks();
      const snapshot = this.priceFeed.snapshot();
      if (!ticks.length || snapshot.status !== 'live' || snapshot.ageMs > FEED_MAX_AGE_MS) {
        throw new Error('Waiting for a fresh Polymarket Chainlink BTC/USD price.');
      }
      const candleHistory = this.priceFeed.getHistoricalCandles();
      this.volatility5m = estimateLogReturnVolatility(candleHistory);
      const referenceTick = ticks
        .filter(tick => Math.abs(tick.ts - start) <= 10_000)
        .sort((a, b) => Math.abs(a.ts - start) - Math.abs(b.ts - start))[0];
      const latestTick = ticks[ticks.length - 1];
      this.referencePrice = referenceTick?.price ?? null;
      this.latestPrice = latestTick?.price ?? null;
      this.priceAt = latestTick?.ts ?? null;
      this.pullback = detectPullback(ticks, now, this.volatility5m);
      this.statusReason = !referenceTick
        ? 'Waiting for the next five-minute boundary to capture its Chainlink opening reference.'
        : !this.volatility5m
          ? 'Waiting for at least ten completed five-minute BTC candles.'
          : 'Model and market data are live.';

      const secondsRemaining = Math.max(0, (this.market.end - now) / 1000);
      this.probabilityUp = this.referencePrice && this.latestPrice && this.volatility5m
        ? probabilityUp({
          openPrice: this.referencePrice,
          spotPrice: this.latestPrice,
          secondsRemaining,
          volatility5m: this.volatility5m * this.strategySettings.volatilityMultiplier,
        })
        : null;
      this.expectedMove = this.latestPrice && this.volatility5m
        ? this.latestPrice * this.volatility5m * this.strategySettings.volatilityMultiplier * Math.sqrt(secondsRemaining / 300)
        : null;
      this.standardizedGap = this.referencePrice && this.latestPrice && this.volatility5m && secondsRemaining > 0
        ? Math.log(this.latestPrice / this.referencePrice) / (this.volatility5m * this.strategySettings.volatilityMultiplier * Math.sqrt(secondsRemaining / 300))
        : null;
      this.edges = this.calculateEdges();
      if (this.probabilityUp != null && secondsRemaining > 0) this.processSignals(now);
      await this.captureLearningSample(now);
      await this.maybeTune(now);
      this.error = null;
      this.lastUpdateAt = now;
    } catch (error) {
      this.processPositionExits(this.now());
      this.error = error?.message || 'BTC probability scan failed.';
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
    };
  }

  calculateEdges() {
    if (this.probabilityUp == null) return { UP: null, DOWN: null };
    const upFill = simulateBuy(this.quotes.UP?.asks, this.strategySettings.sharesPerSignal);
    const downFill = simulateBuy(this.quotes.DOWN?.asks, this.strategySettings.sharesPerSignal);
    return {
      UP: upFill ? this.probabilityUp - upFill.totalCost / this.strategySettings.sharesPerSignal : null,
      DOWN: downFill ? (1 - this.probabilityUp) - downFill.totalCost / this.strategySettings.sharesPerSignal : null,
    };
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

  processSignals(now) {
    const filter = this.updateEntryFilter(now);
    if (!filter.allowed) {
      if (!filter.openingDelayActive) {
        for (const side of ['UP', 'DOWN']) {
          const fill = simulateBuy(this.quotes[side]?.asks, this.strategySettings.sharesPerSignal);
          const entryPrice = fill?.averagePrice ?? this.quotes[side]?.bestAsk;
          const threshold = Number.isFinite(entryPrice) && entryPrice < this.strategySettings.lowPriceThreshold
            ? this.strategySettings.lowPriceMinimumNetEdge : this.strategySettings.minimumNetEdge;
          if (this.edges[side] == null || this.edges[side] < threshold) this.armed[side] = true;
        }
      }
      const signature = `${filter.blockedReasons.join(',')}:${filter.blockedSides.join(',')}`;
      if (signature !== this.lastEntryFilterSignature) {
        if (filter.blockedSides.length) {
          this.log('SIGNAL_BLOCKED_PRICE_FLOOR', {
            minimumBestAsk: MIN_ENTRY_PRICE,
            blockedSides: filter.blockedSides,
          });
        }
        if (filter.openingDelayActive) {
          this.log('SIGNAL_BLOCKED_OPENING_DELAY', {
            openingDelaySeconds: this.strategySettings.openingDelaySeconds,
            secondsSinceOpen: filter.secondsSinceOpen,
          });
        }
      }
      this.lastEntryFilterSignature = signature;
      return;
    }
    this.lastEntryFilterSignature = null;
    const fills = {
      UP: simulateBuy(this.quotes.UP?.asks, this.strategySettings.sharesPerSignal),
      DOWN: simulateBuy(this.quotes.DOWN?.asks, this.strategySettings.sharesPerSignal),
    };
    this.requiredNetEdge = Object.fromEntries(['UP', 'DOWN'].map(side => {
      const entryPrice = fills[side]?.averagePrice ?? this.quotes[side]?.bestAsk;
      return [side, Number.isFinite(entryPrice) && entryPrice < this.strategySettings.lowPriceThreshold
        ? this.strategySettings.lowPriceMinimumNetEdge : this.strategySettings.minimumNetEdge];
    }));
    const candidates = ['UP', 'DOWN']
      .filter(side => this.strategySettings.sideMode !== 'pullback'
        || this.pullback?.side === side)
      .filter(side => {
      const edge = this.edges[side];
      const threshold = this.requiredNetEdge[side];
      if (edge == null || edge < threshold) this.armed[side] = true;
      return edge != null && edge >= threshold && this.armed[side];
    }).sort((a, b) => this.edges[b] - this.edges[a]);
    if (!candidates.length) return;
    const side = candidates[0];
    this.armed[side] = false;
    const fill = fills[side];
    if (!fill || fill.totalCost > this.cash) {
      this.log('SIGNAL_SKIPPED', { side, edge: this.edges[side], reason: !fill ? 'Insufficient visible ask depth for 100 shares' : 'Insufficient paper cash' });
      return;
    }
    const trade = {
      id: `paper-${this.market.start}-${side}-${now}`,
      marketId: this.market.id,
      tokenId: this.market.tokens?.[side] ?? null,
      windowStart: this.market.start,
      windowEnd: this.market.end,
      marketTitle: this.market.title,
      side,
      shares: this.strategySettings.sharesPerSignal,
      entryPrice: fill.averagePrice,
      cost: fill.cost,
      fees: fill.fees,
      totalCost: fill.totalCost,
      edgeAtEntry: this.edges[side],
      requiredNetEdge: this.requiredNetEdge[side],
      modelProbability: side === 'UP' ? this.probabilityUp : 1 - this.probabilityUp,
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
      side, shares: this.strategySettings.sharesPerSignal, price: fill.averagePrice,
      edge: this.edges[side], requiredNetEdge: this.requiredNetEdge[side],
    });
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
        if (bid >= TAKE_PROFIT_BID) {
          this.closeTrade(trade, TAKE_PROFIT_PAYOUT, trade.shares * TAKE_PROFIT_PAYOUT, 'TAKE_PROFIT', 'Own-side best bid reached $0.99; credited $1.00 per share before fees.', now, bid);
        } else if (bid <= STOP_LOSS_BID) {
          this.closeTrade(trade, STOP_LOSS_PAYOUT, STOP_LOSS_PAYOUT, 'STOP_LOSS', 'Own-side best bid reached $0.01; credited $0.00 per share before fees.', now, bid);
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

  closeTrade(trade, exitPrice, payout, outcome, settlementSource, now, feeExecutionPrice) {
    const exitFees = estimateTakerFee(feeExecutionPrice, trade.shares);
    const netPayout = payout - exitFees;
    trade.status = 'SETTLED';
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
        minimumNetEdge: this.strategySettings.minimumNetEdge,
        lowPriceThreshold: this.strategySettings.lowPriceThreshold,
        lowPriceMinimumNetEdge: this.strategySettings.lowPriceMinimumNetEdge,
        takerFeeRate: TAKER_FEE_RATE,
        minimumBestAsk: MIN_ENTRY_PRICE,
        openingDelaySeconds: this.strategySettings.openingDelaySeconds,
        volatilityMultiplier: this.strategySettings.volatilityMultiplier,
        sideMode: this.strategySettings.sideMode,
        takeProfitBid: TAKE_PROFIT_BID,
        takeProfitPayoutPerShare: TAKE_PROFIT_PAYOUT,
        stopLossBid: STOP_LOSS_BID,
        stopLossPayoutPerShare: STOP_LOSS_PAYOUT,
        model: '20 closed 5-minute log-return volatility; normal-CDF probability estimate',
        exitModel: 'Own-side CLOB best bid; all exits deduct the configured taker fee; expiry mark uses the last own-side bid, not BTC reference.',
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
      requiredNetEdge: this.requiredNetEdge,
      entryFilter: this.entryFilter,
      quotes: {
        UP: this.quotes.UP ? { bestBid: this.quotes.UP.bestBid, bestAsk: this.quotes.UP.bestAsk, midpoint: this.quotes.UP.midpoint, estimatedAverageAsk: simulateBuy(this.quotes.UP.asks, this.strategySettings.sharesPerSignal)?.averagePrice ?? null } : null,
        DOWN: this.quotes.DOWN ? { bestBid: this.quotes.DOWN.bestBid, bestAsk: this.quotes.DOWN.bestAsk, midpoint: this.quotes.DOWN.midpoint, estimatedAverageAsk: simulateBuy(this.quotes.DOWN.asks, this.strategySettings.sharesPerSignal)?.averagePrice ?? null } : null,
      },
      paperAccount: {
        startingCash: STARTING_CASH, cash: this.cash, openCost, realizedPnl, wins, losses,
        settled: settled.length, openPositions: openTrades.length, positions,
      },
      trades: this.trades.slice(0, 50),
      events: this.events,
      pullback: this.pullback,
      learning: {
        ...this.learningStatus,
        persistenceStatus: this.persistenceError ? 'error' : this.learningStore ? 'connected' : 'disabled',
      },
      priceFeed: ticks,
    };
  }
}

module.exports = { ProbabilityBot, probabilityUp, estimateLogReturnVolatility, normalCdf, simulateBuy };
