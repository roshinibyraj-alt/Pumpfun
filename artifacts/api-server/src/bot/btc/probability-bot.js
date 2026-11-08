'use strict';

const { CRYPTO_TAKER_FEE_RATE } = require('./config');
const marketData = require('./wick-market-data');
const { feed } = require('./chainlink-price-feed');
const { recoverExpiredPositions } = require('./position-exits');
const {
  WINDOW_MS,
  ENTRY_SHARES,
  POLL_INTERVAL_MS,
  MAX_QUOTE_AGE_MS,
  quoteIsFresh,
  feeParameters,
  estimateTakerFee,
  simulateLimitBuyFill,
  simulateTakerBuyFill,
  getWindowToScan,
} = require('./paper-trading');
const {
  STRATEGY_VERSION,
  CANDLE_INTERVAL_MS,
  RENKO_ATR_PERIOD,
  RENKO_HISTORY_CANDLES,
  combineClosedMinuteCandles,
  calculateAtrBrickSize,
  buildRenko,
  appendRenkoClose,
  simulateTakerSellFill,
} = require('./renko-strategy');

const STARTING_CASH = 10_000;
const TAKER_FEE_RATE = CRYPTO_TAKER_FEE_RATE;
const EQUITY_SNAPSHOT_INTERVAL_MS = 30_000;
const EXIT_QUOTE_MAX_AGE_MS = MAX_QUOTE_AGE_MS;
const TAKE_PROFIT_LIMIT_PRICE = 0.99;
const TAKE_PROFIT_PAYOUT_PER_SHARE = 1;

function parseLevels(levels, direction) {
  return (Array.isArray(levels) ? levels : [])
    .map(level => ({ price: Number(level.price), size: Number(level.size) }))
    .filter(level => Number.isFinite(level.price) && level.price > 0 && level.price < 1
      && Number.isFinite(level.size) && level.size > 0)
    .sort((a, b) => direction === 'ask' ? a.price - b.price : b.price - a.price);
}

class ProbabilityBot {
  constructor({
    now = Date.now,
    fetchMarket = marketData.getBtcMarket,
    fetchBook = marketData.getBook,
    fetchMarketDetails = marketData.getMarket,
    priceFeed = feed,
    learningStore = null,
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
    this.startingCash = STARTING_CASH;
    this.cash = this.startingCash;
    this.trades = [];
    this.settledCount = 0;
    this.settledWins = 0;
    this.settledLosses = 0;
    this.realizedPnlBySide = { UP: 0, DOWN: 0 };
    this.events = [];
    this.learningStore = learningStore;
    this.persistenceQueue = Promise.resolve();
    this.persistenceError = null;
    this.lastSampledAt = null;
    this.entryOrders = [];
    this.orderWindowStart = null;
    this.orderSequence = 0;
    this.tickCount = 0;
    this.entrySignal = null;
    this.entrySideSelection = { status: 'WAITING_FOR_RENKO_DATA', selectedSide: null };
    this.renkoState = { status: 'WAITING_FOR_RENKO_DATA', windowStart: null };
    this.renkoEngine = null;
    this.renkoLastProcessedCandleStart = null;
    this.lastRenkoActionKey = new Map();
    this.pendingRenkoFlip = new Map();
    this.entrySideForWindow = null;
    this.entryBookDepthByToken = new Map();
    this.windowResults = new Map();
    this.finalizedWindowStarts = new Set();
    this.accountSessionStartedAt = this.now();
    this.lastEquitySnapshotAt = null;
    this.equitySnapshotRequested = true;
    this.learningStatus = {
      enabled: Boolean(learningStore),
      mode: learningStore ? 'renko-opposite-signal-taker-paper-logging-only' : 'disabled',
      completedWindows: 0,
    };
    this.error = null;
    this.statusReason = 'Starting BTC market and order-book feeds.';
    this.lastUpdateAt = null;
    this.startedAt = this.now();
    this.activeVariantId = 'signal';
    this.variants = {
      signal: {
        id: 'signal', name: 'BTC Renko opposite signal', mode: 'OPPOSITE_SIGNAL',
        startingCash: STARTING_CASH, cash: STARTING_CASH,
        shareSize: ENTRY_SHARES,
        active: true, settledTrades: 0, wins: 0, losses: 0, totalTrades: 0,
        equityCurve: [{ ts: this.startedAt, equity: STARTING_CASH }],
      },
    };
    this.priceFeed.start();
  }

  tradeSideFor(signalSide) {
    if (signalSide === 'UP') return 'DOWN';
    if (signalSide === 'DOWN') return 'UP';
    return null;
  }

  snapshotVariants(now = this.now()) {
    return Object.fromEntries(Object.entries(this.variants).map(([id, variant]) => {
      const trades = this.trades.filter(trade => trade.variantId === id);
      const openTrades = trades.filter(trade => trade.status === 'OPEN');
      const openCost = openTrades.reduce((sum, trade) => sum + trade.totalCost, 0);
      const realizedPnl = variant.cash + openCost - variant.startingCash;
      let markedValue = 0;
      let marksFresh = true;
      for (const trade of openTrades) {
        const quote = trade.marketId === this.market?.id ? this.quotes[trade.side] : null;
        const bid = Number(quote?.bestBid);
        const fresh = Number.isFinite(bid) && Number.isFinite(quote?.updatedAt)
          && now >= quote.updatedAt && now - quote.updatedAt <= EXIT_QUOTE_MAX_AGE_MS;
        if (!fresh) {
          marksFresh = false;
          break;
        }
        markedValue += trade.shares * bid - estimateTakerFee(bid, trade.shares);
      }
      const settledTrades = variant.settledTrades;
      return [id, {
        id,
        name: variant.name,
        mode: variant.mode,
        active: variant.active,
        status: variant.active ? 'ACTIVE' : 'PAUSED',
        startingCash: variant.startingCash,
        cash: variant.cash,
        realizedPnl,
        equity: marksFresh ? variant.cash + markedValue : null,
        unrealizedPnl: marksFresh ? markedValue - openCost : null,
        markedValue: marksFresh ? markedValue : null,
        shareSize: variant.shareSize,
        baseShareSize: ENTRY_SHARES,
        totalTrades: variant.totalTrades,
        settledTrades,
        wins: variant.wins,
        losses: variant.losses,
        winRate: settledTrades ? variant.wins / settledTrades * 100 : 0,
        openPositions: openTrades.length,
        trades,
        equityCurve: variant.equityCurve,
      }];
    }));
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
    const ts = Math.floor(now / POLL_INTERVAL_MS) * POLL_INTERVAL_MS;
    if (ts === this.lastSampledAt) return;
    this.lastSampledAt = ts;
    const sample = {
      ts, observedAt: now, windowStart: this.market.start, windowEnd: this.market.end,
      secondsSinceOpen: Math.max(0, (now - this.market.start) / 1000),
      secondsRemaining: Math.max(0, (this.market.end - now) / 1000),
      orderStrategy: STRATEGY_VERSION,
      activeVariantId: this.activeVariantId,
      activeVariantMode: this.variants[this.activeVariantId]?.mode,
      entrySideSelection: this.entrySideSelection,
      renko: this.renkoState,
      orderSchedule: this.orderSchedule(now),
      referencePrice: this.renkoState?.lastBrickClose ?? this.referencePrice,
      spotPrice: this.latestPrice,
      quotes: Object.fromEntries(['UP', 'DOWN'].map(side => {
        const quote = this.quotes[side];
        return [side, quote ? {
          bestBid: quote.bestBid, bestAsk: quote.bestAsk, asks: quote.asks, bids: quote.bids,
          updatedAt: quote.updatedAt,
        } : null];
      })),
      recentEntryOrders: this.entryOrders.filter(order => order.windowStart === this.market.start)
        .slice(0, 20).map(order => ({
          id: order.id, action: order.action, side: order.side, targetSide: order.targetSide,
          orderType: order.orderType, limitPrice: order.limitPrice, executionRole: order.executionRole,
          brickAt: order.brickAt,
          averageFillPrice: order.averageFillPrice, remainingShares: order.remainingShares,
          requestedShares: order.requestedShares, filledShares: order.filledShares,
          cancelledRemainderShares: order.cancelledRemainderShares,
          cancelReason: order.cancelReason, fees: order.fees, status: order.status,
        })),
    };
    this.queuePersistence(() => this.learningStore.recordSample(sample));
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const now = this.now();
      this.tickCount += 1;
      this.processPositionExits(now);
      await recoverExpiredPositions(this, now);
      const start = getWindowToScan(now);
      this.beginMarketWindow(start, now);
      if (!this.market || this.market.start !== start || now - this.marketFetchedAt >= 10_000) {
        this.market = await this.fetchMarket(start, WINDOW_MS);
        this.marketFetchedAt = now;
        if (this.market?.start !== start) this.market = null;
      }
      if (!this.market) {
        this.processTakerBuyOrders(now);
        this.processPositionExits(now);
        this.maybeFinalizeCompletedWindows(now);
        this.maybeRecordEquitySnapshot(now);
        this.error = 'Waiting for the exact BTC 5-minute UP/DOWN market.';
        this.lastUpdateAt = now;
        return;
      }
      this.beginMarketWindow(this.market.start, now);
      const books = await Promise.allSettled([
        this.fetchBook(this.market.tokens.UP),
        this.fetchBook(this.market.tokens.DOWN),
      ]);
      this.quotes = Object.fromEntries(['UP', 'DOWN'].map((side, index) => {
        const result = books[index];
        if (result.status === 'fulfilled') return [side, this.quote(result.value, now)];
        return [side, {
          ...(this.quotes[side] || {}),
          updatedAt: null,
          status: 'ERROR',
          attemptedAt: now,
          error: result.reason?.message || 'Order book unavailable.',
        }];
      }));
      this.processPositionExits(now);

      const ticks = this.priceFeed.getTicks?.() ?? [];
      const referenceTick = ticks
        .filter(tick => Math.abs(tick.ts - start) <= 10_000)
        .sort((a, b) => Math.abs(a.ts - start) - Math.abs(b.ts - start))[0];
      const latestTick = ticks[ticks.length - 1];
      this.referencePrice = referenceTick?.price ?? this.renkoState?.lastBrickClose ?? null;
      this.latestPrice = latestTick?.price ?? null;
      this.priceAt = latestTick?.ts ?? null;
      const scanAt = this.now();
      this.processRenkoStrategy(scanAt);
      this.processTakerBuyOrders(scanAt);
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
      status: 'FRESH',
      asks,
      bids,
    };
  }

  beginMarketWindow(start = this.market?.start, now = this.now()) {
    if (!Number.isFinite(start) || this.orderWindowStart === start) return;
    this.orderWindowStart = start;
    this.entrySignal = null;
    this.entrySideForWindow = null;
    this.renkoEngine = null;
    this.renkoLastProcessedCandleStart = null;
    this.lastRenkoActionKey.clear();
    this.pendingRenkoFlip.clear();
    this.renkoState = {
      status: 'WAITING_FOR_RENKO_DATA',
      windowStart: start,
      brickSize: null,
      atr: null,
      atrPeriod: RENKO_ATR_PERIOD,
      direction: null,
      selectedSide: null,
      latestBrick: null,
      newBrickPrinted: false,
      bricksPrintedThisTick: 0,
    };
    this.entrySideSelection = {
      status: 'WAITING_FOR_RENKO_DATA',
      selectedSide: null,
    };
    this.log('PAPER_RENKO_WINDOW_STARTED', {
      windowStart: start,
      atrPeriod: RENKO_ATR_PERIOD,
      shares: ENTRY_SHARES,
      entryOrderType: 'MARKET',
      entryExecutionRole: 'TAKER',
      source: 'CLOSED_ONE_MINUTE_BTC_CANDLES',
    });
  }

  reservedLimitOrderFunds() {
    return this.entryOrders
      .filter(order => order.orderType === 'LIMIT'
        && ['RESTING', 'PARTIALLY_FILLED_RESTING'].includes(order.status)
        && Number(order.remainingShares) > 0)
      .reduce((sum, order) => {
        const remaining = Number(order.remainingShares);
        const price = Number(order.limitPrice);
        if (!Number.isFinite(remaining) || remaining <= 0
          || !Number.isFinite(price) || price <= 0) return sum;
        const feeMarket = this.market?.id === order.marketId ? this.market : null;
        return sum + remaining * price + estimateTakerFee(price, remaining, feeMarket);
      }, 0);
  }

  closedMinuteCandles(now) {
    const historical = this.priceFeed.getHistoricalMinuteCandles?.() ?? [];
    const live = this.priceFeed.getMinuteCandles?.() ?? [];
    return combineClosedMinuteCandles({ historical, live, now });
  }

  initializeRenko(candles, now) {
    const beforeWindow = candles
      .filter(candle => candle.end <= this.market.start)
      .slice(-RENKO_HISTORY_CANDLES);
    const atr = calculateAtrBrickSize(beforeWindow, RENKO_ATR_PERIOD);
    if (atr.status !== 'READY') {
      this.renkoState = {
        ...this.renkoState,
        status: atr.status,
        atrPeriod: RENKO_ATR_PERIOD,
        historyCandles: beforeWindow.length,
        newBrickPrinted: false,
        bricksPrintedThisTick: 0,
      };
      this.entrySideSelection = {
        status: atr.status,
        selectedSide: null,
        historyCandles: beforeWindow.length,
        atrPeriod: RENKO_ATR_PERIOD,
      };
      this.statusReason = 'Waiting for enough closed one-minute BTC candles to calculate the Renko ATR brick size.';
      return false;
    }

    const built = buildRenko(beforeWindow, atr.brickSize);
    if (!built.state) {
      this.renkoState = {
        ...this.renkoState, status: 'WAITING_FOR_RENKO_BRICK',
        brickSize: atr.brickSize, atr: atr.atr, historyCandles: beforeWindow.length,
        newBrickPrinted: false, bricksPrintedThisTick: 0,
      };
      this.statusReason = 'Renko is initialized and waiting for its first confirmed brick.';
      return false;
    }

    this.renkoEngine = built.state;
    this.renkoLastProcessedCandleStart = beforeWindow.at(-1)?.t ?? null;
    this.renkoState = {
      status: built.state.lastBrick ? 'READY' : 'WAITING_FOR_RENKO_BRICK',
      windowStart: this.market.start,
      brickSize: atr.brickSize,
      atr: atr.atr,
      atrPeriod: RENKO_ATR_PERIOD,
      historyCandles: beforeWindow.length,
      direction: built.state.direction,
      selectedSide: built.state.lastBrick?.side ?? null,
      lastBrickClose: built.state.lastBrickClose,
      latestBrick: built.state.lastBrick,
      latestBrickAt: built.state.lastBrick?.at ?? null,
      newBrickPrinted: false,
      bricksPrintedThisTick: 0,
      initializedAt: now,
    };
    this.entrySignal = built.state.lastBrick ? {
      selectedSide: built.state.lastBrick.side,
      signalPrice: built.state.lastBrick.close,
      referenceClose: built.state.lastBrickClose,
      signalAt: built.state.lastBrick.at,
      rule: `RENKO_${built.state.lastBrick.color}`,
    } : null;
    return true;
  }

  queueRenkoBuy(signalSide, side, variant, now, signalKey) {
    if (this.entrySideForWindow) return [];
    this.entrySideForWindow = side;
    const id = `paper-taker-${this.market.start}-${variant.id}-${++this.orderSequence}`;
    const order = {
      id,
      variantId: variant.id,
      variantName: variant.name,
      variantMode: variant.mode,
      marketId: this.market.id,
      tokenId: this.market.tokens?.[side] ?? null,
      windowStart: this.market.start,
      windowEnd: this.market.end,
      marketTitle: this.market.title,
      side,
      targetSide: side,
      signalSide,
      action: 'BUY',
      orderType: 'MARKET',
      limitPrice: null,
      executionRole: 'TAKER',
      requestedShares: ENTRY_SHARES,
      filledShares: 0,
      remainingShares: ENTRY_SHARES,
      cancelledRemainderShares: 0,
      averageFillPrice: null,
      filledCost: 0,
      fees: 0,
      estimatedMakerRebate: 0,
      createdAt: now,
      placedAt: null,
      submittedAt: null,
      submittedTick: null,
      status: 'PENDING_SUBMISSION',
      fillModel: 'VISIBLE_ASK_DEPTH_TAKER_SWEEP',
      signalPrice: this.renkoState.latestBrick?.close ?? null,
      brickAt: this.renkoState.latestBrickAt ?? null,
      renkoSignalKey: signalKey,
    };
    this.entryOrders.unshift(order);
    this.entryOrders.length = Math.min(this.entryOrders.length, 200);
    this.lastRenkoActionKey.set(variant.id, signalKey);
    this.statusReason = `Renko signalled ${signalSide}; one 300-share taker buy is queued on the opposite ${side} side.`;
    this.log('PAPER_RENKO_OPPOSITE_TAKER_BUY_QUEUED', {
      side, signalSide, variantId: variant.id,
      orderId: order.id, requestedShares: order.requestedShares,
      brickSize: this.renkoState.brickSize, brickAt: this.renkoState.latestBrickAt,
    }, this.market.start);
    return [order];
  }

  processRenkoStrategy(now) {
    if (!this.market || now < this.market.start || now >= this.market.end) return;
    if (this.orderWindowStart !== this.market.start) this.beginMarketWindow(this.market.start, now);

    const candles = this.closedMinuteCandles(now);
    if (!this.renkoEngine && !this.initializeRenko(candles, now)) return;
    if (this.renkoState.windowStart !== this.market.start) return;

    const newBricks = [];
    const nextCandles = candles.filter(candle => candle.t >= this.market.start
      && candle.end <= now
      && (this.renkoLastProcessedCandleStart == null
        || candle.t > this.renkoLastProcessedCandleStart));
    for (const candle of nextCandles) {
      const result = appendRenkoClose(this.renkoEngine, candle);
      newBricks.push(...result.bricks);
      this.renkoLastProcessedCandleStart = candle.t;
    }

    const latestBrick = this.renkoEngine.lastBrick;
    const signalSide = latestBrick?.side ?? null;
    this.renkoState = {
      ...this.renkoState,
      status: signalSide ? 'READY' : 'WAITING_FOR_RENKO_BRICK',
      direction: this.renkoEngine.direction,
      selectedSide: signalSide,
      lastBrickClose: this.renkoEngine.lastBrickClose,
      latestBrick,
      latestBrickAt: latestBrick?.at ?? null,
      lastProcessedCandleAt: this.renkoLastProcessedCandleStart == null
        ? null : this.renkoLastProcessedCandleStart + CANDLE_INTERVAL_MS,
      newBrickPrinted: newBricks.length > 0,
      bricksPrintedThisTick: newBricks.length,
      newBricks: newBricks.slice(-10),
    };
    this.entrySignal = latestBrick ? {
      selectedSide: signalSide,
      signalPrice: latestBrick.close,
      referenceClose: this.renkoEngine.lastBrickClose,
      signalAt: latestBrick.at,
      rule: `RENKO_${latestBrick.color}`,
    } : null;
    this.entrySideSelection = {
      status: !signalSide ? 'WAITING_FOR_RENKO_BRICK'
        : newBricks.length ? 'RENKO_BRICK_PRINTED' : 'NO_NEW_BRICK_HOLDING',
      selectedSide: signalSide,
      signalPrice: latestBrick?.close ?? null,
      brickSize: this.renkoState.brickSize,
      latestBrickAt: latestBrick?.at ?? null,
      newBrickPrinted: newBricks.length > 0,
      bricksPrintedThisTick: newBricks.length,
      rule: latestBrick ? `RENKO_${latestBrick.color}` : null,
    };

    if (!signalSide) {
      this.statusReason = this.renkoState.status === 'WAITING_FOR_RENKO_BRICK'
        ? 'Renko has no confirmed direction yet; waiting for a closed one-minute BTC price to print a brick.'
        : 'Renko printed no new brick. Any existing position remains open.';
      return;
    }

    const signalKey = `${this.market.start}:${latestBrick.at}:${signalSide}`;
    const entrySide = this.tradeSideFor(signalSide);
    if (!this.entrySideForWindow) {
      const variant = this.variants[this.activeVariantId];
      this.queueRenkoBuy(signalSide, entrySide, variant, now, signalKey);
      return;
    }
    if (this.entrySideForWindow !== entrySide) {
      this.statusReason = `Renko now points ${signalSide}, but this window's one-time taker entry remains on ${this.entrySideForWindow}. Opposite bricks do not sell or re-enter.`;
      return;
    }
    const openTrades = this.trades.filter(trade => trade.status === 'OPEN'
      && trade.marketId === this.market.id
      && trade.windowStart === this.market.start
      && trade.variantId === this.activeVariantId);
    const pendingTakerOrders = this.entryOrders.filter(order => order.marketId === this.market.id
      && order.windowStart === this.market.start
      && order.variantId === this.activeVariantId
      && order.status === 'PENDING_SUBMISSION');
    this.statusReason = pendingTakerOrders.length
      ? `The ${this.entrySideForWindow} taker buy is waiting for a fresh ask book; no second entry will be sent.`
      : openTrades.length
        ? `${openTrades.length} ${this.entrySideForWindow} position(s) remain open with $0.99 TP or original-market resolution.`
        : `The one-time ${this.entrySideForWindow} taker entry has been handled for this window; no re-entry or reversal.`;
  }

  processTakerBuyOrders(now) {
    for (const order of this.entryOrders) {
      if (order.orderType !== 'MARKET' || order.action !== 'BUY'
        || order.status !== 'PENDING_SUBMISSION') continue;
      if (now >= order.windowEnd) {
        order.status = 'CANCELLED_WINDOW_ENDED';
        order.cancelledRemainderShares = Number(order.remainingShares || 0);
        order.remainingShares = 0;
        order.cancelledAt = now;
        order.cancelReason = 'The one-time taker order was not submitted before its original window ended.';
        continue;
      }
      if (this.market?.id !== order.marketId) continue;
      const quote = this.quotes[order.side];
      if (!quoteIsFresh(quote, now, EXIT_QUOTE_MAX_AGE_MS)) {
        this.statusReason = `Renko selected ${order.signalSide}; waiting for a fresh ${order.side} ask book to submit the taker buy.`;
        continue;
      }

      order.placedAt = now;
      order.submittedAt = now;
      order.submittedTick = this.tickCount;
      const variant = this.variants[order.variantId];
      if (!variant) {
        order.status = 'CANCELLED_INVALID_VARIANT';
        order.remainingShares = 0;
        order.cancelReason = 'The active paper account for this order no longer exists.';
        continue;
      }
      let fill = simulateTakerBuyFill(quote.asks, order.requestedShares, this.market);
      if (!fill) {
        order.status = 'CANCELLED_NO_VISIBLE_ASKS';
        order.cancelledRemainderShares = Number(order.requestedShares);
        order.remainingShares = 0;
        order.cancelledAt = now;
        order.cancelReason = 'No ask liquidity was visible when the taker order was submitted.';
        this.statusReason = order.cancelReason;
        this.log('PAPER_TAKER_BUY_NO_VISIBLE_ASKS', {
          orderId: order.id, side: order.side, requestedShares: order.requestedShares,
        }, order.windowStart);
        continue;
      }

      if (fill.totalCost > Number(variant.cash) + 1e-8) {
        let low = 0;
        let high = Math.floor(fill.shares);
        let affordable = null;
        while (low < high) {
          const middle = Math.ceil((low + high) / 2);
          const candidate = simulateTakerBuyFill(quote.asks, middle, this.market);
          if (candidate && candidate.totalCost <= Number(variant.cash) + 1e-8) {
            affordable = candidate;
            low = middle;
          } else {
            high = middle - 1;
          }
        }
        if (!affordable) {
          order.status = 'CANCELLED_INSUFFICIENT_CASH';
          order.cancelledRemainderShares = Number(order.requestedShares);
          order.remainingShares = 0;
          order.cancelledAt = now;
          order.cancelReason = 'Available paper cash could not cover any shares at the visible ask prices.';
          this.statusReason = order.cancelReason;
          this.log('PAPER_TAKER_BUY_INSUFFICIENT_CASH', {
            orderId: order.id, side: order.side, requestedShares: order.requestedShares,
            availableCash: variant.cash,
          }, order.windowStart);
          continue;
        }
        fill = affordable;
      }

      const filledShares = Number(fill.shares);
      const cancelledShares = Math.max(0, Number(order.requestedShares) - filledShares);
      order.filledShares = filledShares;
      order.remainingShares = 0;
      order.cancelledRemainderShares = cancelledShares;
      order.averageFillPrice = fill.averagePrice;
      order.filledCost = fill.cost;
      order.fees = fill.fees;
      order.feeRate = fill.feeRate;
      order.feeExponent = fill.feeExponent;
      order.fillLevels = fill.fills;
      order.status = cancelledShares > 1e-8 ? 'PARTIALLY_FILLED_CANCELLED' : 'FILLED';
      order.cancelReason = cancelledShares > 1e-8
        ? 'Unfilled market-buy remainder was cancelled immediately after the taker sweep.'
        : null;
      order.filledAt = now;

      const trade = {
        id: `paper-${order.id}`,
        orderId: order.id,
        variantId: order.variantId,
        variantName: order.variantName,
        marketId: order.marketId,
        tokenId: order.tokenId,
        slug: this.market.slug,
        windowStart: order.windowStart,
        windowEnd: order.windowEnd,
        marketTitle: order.marketTitle,
        side: order.side,
        signalSide: order.signalSide,
        entryKind: 'TAKER_BUY',
        orderType: 'MARKET',
        requestedShares: order.requestedShares,
        shares: filledShares,
        entryPrice: fill.averagePrice,
        cost: fill.cost,
        fees: fill.fees,
        feeRate: fill.feeRate,
        feeExponent: fill.feeExponent,
        totalCost: fill.totalCost,
        openedAt: now,
        status: 'OPEN',
        settlementStatus: 'OPEN',
        takeProfitPrice: TAKE_PROFIT_LIMIT_PRICE,
        takeProfitOrder: {
          type: 'LIMIT_SELL',
          price: TAKE_PROFIT_LIMIT_PRICE,
          status: 'RESTING',
          remainingShares: filledShares,
          placedAt: now,
        },
        peakBid: null,
        peakBidAt: null,
        lastOutcomeBid: null,
        lastOutcomeBidAt: null,
        realizedPnl: null,
      };
      this.trades.unshift(trade);
      const windowResult = this.windowResults.get(order.windowStart)
        ?? { entryCount: 0, settledCount: 0, netPnl: 0, variantId: order.variantId };
      windowResult.entryCount += 1;
      this.windowResults.set(order.windowStart, windowResult);
      variant.totalTrades += 1;
      this.cash -= fill.totalCost;
      variant.cash -= fill.totalCost;
      this.equitySnapshotRequested = true;
      this.log('PAPER_TAKER_BUY_FILLED', {
        orderId: order.id, tradeId: trade.id, signalSide: order.signalSide,
        side: order.side, requestedShares: order.requestedShares,
        filledShares, cancelledRemainderShares: cancelledShares,
        averageFillPrice: fill.averagePrice, fillCost: fill.cost,
        fees: fill.fees, fillLevels: fill.fills,
      }, order.windowStart);
      this.statusReason = `${filledShares.toLocaleString()} ${order.side} shares bought against visible asks at an average $${fill.averagePrice.toFixed(4)}.`
        + (cancelledShares > 1e-8
          ? ` The unfilled ${cancelledShares.toLocaleString()}-share market-order remainder was cancelled.`
          : '')
        + ' The $0.99 TP remains active; otherwise shares await original-market resolution.';
      let retainedSettled = 0;
      this.trades = this.trades.filter(item => item.status === 'OPEN' || retainedSettled++ < 200);
    }
  }

  processLimitOrders(now) {
    const active = new Set(['RESTING', 'PARTIALLY_FILLED_RESTING']);
    for (const order of this.entryOrders) {
      if (order.orderType !== 'LIMIT' || !active.has(order.status)) continue;
      if (now < order.windowEnd) continue;
      order.status = 'CANCELLED_WINDOW_ENDED';
      order.cancelledRemainderShares = Number(order.remainingShares || 0);
      order.remainingShares = 0;
      order.cancelledAt = now;
      order.cancelReason = 'Unfilled limit remainder cancelled when its original market window ended.';
      this.log('PAPER_LIMIT_BUY_CANCELLED_WINDOW_ENDED', {
        orderId: order.id, side: order.side, limitPrice: order.limitPrice,
        cancelledShares: order.cancelledRemainderShares, reason: order.cancelReason,
      }, order.windowStart);
    }

    if (!this.market) return;
    for (const side of ['UP', 'DOWN']) {
      const quote = this.quotes[side];
      if (!quoteIsFresh(quote, now, EXIT_QUOTE_MAX_AGE_MS)) continue;
      const tokenKey = `${this.market.id}:${side}`;
      const currentDepth = new Map();
      for (const level of quote.asks || []) {
        currentDepth.set(Number(level.price),
          (currentDepth.get(Number(level.price)) || 0) + Number(level.size || 0));
      }
      const observedDepth = new Map(currentDepth);
      const previousDepth = this.entryBookDepthByToken.get(tokenKey) ?? null;
      const newDepth = previousDepth
        ? new Map([...currentDepth].map(([price, size]) => [
          price, Math.max(0, size - Number(previousDepth.get(price) || 0)),
        ]))
        : null;
      const orders = this.entryOrders
        .filter(order => order.orderType === 'LIMIT' && order.action === 'BUY'
          && order.marketId === this.market.id && order.side === side
          && active.has(order.status))
        .sort((a, b) => Number(b.limitPrice) - Number(a.limitPrice));

      for (const order of orders) {
        const submittedThisTick = order.submittedTick === this.tickCount;
        const bestAsk = quote.bestAsk == null ? NaN : Number(quote.bestAsk);
        if (submittedThisTick && (!Number.isFinite(bestAsk)
          || bestAsk > Number(order.limitPrice))) continue;
        const role = submittedThisTick ? 'TAKER' : 'MAKER';
        const availableDepth = submittedThisTick ? new Map(currentDepth) : newDepth;
        if (!availableDepth) continue;
        const variant = this.variants[order.variantId];
        if (!variant) continue;
        const reservedOtherOrders = this.entryOrders
          .filter(other => other.id !== order.id && other.orderType === 'LIMIT'
            && active.has(other.status) && Number(other.remainingShares) > 0)
          .reduce((sum, other) => {
            const feeMarket = this.market?.id === other.marketId ? this.market : null;
            return sum + Number(other.remainingShares) * Number(other.limitPrice)
              + estimateTakerFee(other.limitPrice, other.remainingShares, feeMarket);
          }, 0);
        const availableCash = Math.max(0, Number(variant.cash) - reservedOtherOrders);
        let fill = simulateLimitBuyFill(quote.asks, order.limitPrice, order.remainingShares,
          this.market, { executionRole: role, availableByPrice: new Map(availableDepth) });
        if (!fill) continue;

        if (fill.totalCost > availableCash + 1e-8) {
          let low = 0;
          let high = Math.floor(fill.shares);
          let affordable = null;
          while (low < high) {
            const middle = Math.ceil((low + high) / 2);
            const candidate = simulateLimitBuyFill(quote.asks, order.limitPrice, middle,
              this.market, { executionRole: role, availableByPrice: new Map(availableDepth) });
            if (candidate && candidate.totalCost <= availableCash + 1e-8) {
              affordable = candidate;
              low = middle;
            } else {
              high = middle - 1;
            }
          }
          if (!affordable) continue;
          fill = affordable;
        }

        const fillLevels = fill.fills.map(level => ({
          ...level,
          sourceAskPrice: Number(level.sourceAskPrice),
        }));
        const consumedDepth = new Map(availableDepth);
        for (const level of fillLevels) {
          const price = level.sourceAskPrice;
          consumedDepth.set(price, Math.max(0,
            Number(consumedDepth.get(price) || 0) - Number(level.shares)));
        }
        if (submittedThisTick) {
          for (const [price, amount] of consumedDepth) currentDepth.set(price, amount);
        } else {
          for (const [price, amount] of consumedDepth) newDepth.set(price, amount);
        }

        const previousFilled = Number(order.filledShares || 0);
        const nextFilled = previousFilled + fill.shares;
        order.filledShares = nextFilled;
        order.remainingShares = Math.max(0, Number(order.requestedShares) - nextFilled);
        order.filledCost = Number(order.filledCost || 0) + fill.cost;
        order.fees = Number(order.fees || 0) + fill.fees;
        order.averageFillPrice = order.filledCost / nextFilled;
        order.feeRate = fill.feeRate;
        order.feeExponent = fill.feeExponent;
        order.fillLevels = [...(order.fillLevels || []), ...fillLevels];
        order.executionRoles = [...new Set([...(order.executionRoles || []), role])];
        order.executionRole = order.executionRoles.length > 1 ? 'MIXED' : role;
        order.status = order.remainingShares <= 1e-8 ? 'FILLED' : 'PARTIALLY_FILLED_RESTING';

        let trade = this.trades.find(item => item.orderId === order.id && item.status === 'OPEN');
        const isNewTrade = !trade;
        if (isNewTrade) {
          trade = {
            id: `paper-${order.id}`,
            orderId: order.id,
            variantId: order.variantId,
            variantName: order.variantName,
            marketId: order.marketId,
            tokenId: order.tokenId,
            slug: this.market.slug,
            windowStart: order.windowStart,
            windowEnd: order.windowEnd,
            marketTitle: order.marketTitle,
            side: order.side,
            signalSide: order.signalSide,
            entryKind: 'LIMIT_BUY',
            orderType: 'LIMIT',
            requestedShares: order.requestedShares,
            shares: 0,
            entryPrice: 0,
            cost: 0,
            fees: 0,
            feeRate: fill.feeRate,
            feeExponent: fill.feeExponent,
            totalCost: 0,
            openedAt: now,
            status: 'OPEN',
            settlementStatus: 'OPEN',
            takeProfitPrice: TAKE_PROFIT_LIMIT_PRICE,
            takeProfitOrder: {
              type: 'LIMIT_SELL',
              price: TAKE_PROFIT_LIMIT_PRICE,
              status: 'RESTING',
              remainingShares: 0,
              placedAt: now,
            },
            peakBid: null,
            peakBidAt: null,
            lastOutcomeBid: null,
            lastOutcomeBidAt: null,
            realizedPnl: null,
          };
          this.trades.unshift(trade);
          const windowResult = this.windowResults.get(order.windowStart)
            ?? { entryCount: 0, settledCount: 0, netPnl: 0, variantId: order.variantId };
          windowResult.entryCount += 1;
          this.windowResults.set(order.windowStart, windowResult);
          variant.totalTrades += 1;
        }
        trade.shares += fill.shares;
        trade.cost += fill.cost;
        trade.fees += fill.fees;
        trade.totalCost += fill.totalCost;
        trade.entryPrice = trade.cost / trade.shares;
        trade.feeRate = fill.feeRate;
        trade.feeExponent = fill.feeExponent;
        trade.takeProfitOrder.remainingShares = trade.shares;
        this.cash -= fill.totalCost;
        variant.cash -= fill.totalCost;
        this.equitySnapshotRequested = true;
        this.log('PAPER_LIMIT_BUY_FILLED', {
          orderId: order.id, tradeId: trade.id, side, limitPrice: order.limitPrice,
          executionRole: role, requestedShares: order.requestedShares,
          totalFilledShares: order.filledShares, fillShares: fill.shares,
          remainingShares: order.remainingShares, averageFillPrice: fill.averagePrice,
          fillCost: fill.cost, fees: fill.fees, fillLevels,
        }, order.windowStart);
        this.statusReason = `${fill.shares.toLocaleString()} ${side} shares filled against visible asks for the $${Number(order.limitPrice).toFixed(2)} limit. The $0.99 TP remains active; otherwise shares await original-market resolution.`;
        let retainedSettled = 0;
        this.trades = this.trades.filter(item => item.status === 'OPEN' || retainedSettled++ < 200);
      }
      this.entryBookDepthByToken.set(tokenKey, observedDepth);
    }
  }

  processPendingTakerSellOrder(order, quote, now) {
    const fill = simulateTakerSellFill(quote.bids, order.requestedShares, this.market);
    if (!fill) {
      order.status = 'CANCELLED_NO_VISIBLE_BIDS';
      order.cancelledRemainderShares = order.requestedShares;
      order.remainingShares = 0;
      order.cancelReason = 'The next-tick order book contained no executable bid depth.';
      this.statusReason = `${order.side} reversal sell was not filled: no executable bid depth was visible on the next tick.`;
      this.log('PAPER_TAKER_SELL_NOT_FILLED', {
        orderId: order.id, side: order.side, targetSide: order.targetSide, reason: order.cancelReason,
      }, order.windowStart);
      return;
    }

    order.filledShares = fill.shares;
    order.remainingShares = 0;
    order.cancelledRemainderShares = fill.remainingShares;
    order.averageFillPrice = fill.averagePrice;
    order.fillPrice = fill.averagePrice;
    order.filledCost = fill.grossPayout;
    order.fees = fill.fees;
    order.feeRate = fill.feeRate;
    order.feeExponent = fill.feeExponent;
    order.fillLevels = fill.fills;
    order.status = fill.remainingShares > 1e-8
      ? 'PARTIALLY_FILLED_REMAINDER_CANCELLED' : 'FILLED';

    let remainingFill = fill.shares;
    const heldTrades = this.trades
      .filter(trade => trade.status === 'OPEN'
        && trade.marketId === order.marketId
        && trade.windowStart === order.windowStart
        && trade.variantId === order.variantId
        && trade.side === order.side)
      .sort((a, b) => Number(a.openedAt || 0) - Number(b.openedAt || 0));
    let closedShares = 0;
    for (const trade of heldTrades) {
      if (remainingFill <= 1e-8) break;
      const sharesBefore = Number(trade.shares);
      const sharesToClose = Math.min(sharesBefore, remainingFill);
      if (!Number.isFinite(sharesBefore) || sharesBefore <= 0 || sharesToClose <= 0) continue;

      const ratio = sharesToClose / sharesBefore;
      let closedTrade = trade;
      if (sharesToClose < sharesBefore - 1e-8) {
        closedTrade = {
          ...trade,
          id: `${trade.id}-renko-exit-${order.id}`,
          shares: sharesToClose,
          cost: Number(trade.cost || 0) * ratio,
          fees: Number(trade.fees || 0) * ratio,
          totalCost: Number(trade.totalCost || 0) * ratio,
          status: 'OPEN',
          settlementStatus: 'OPEN',
          realizedPnl: null,
          closePrice: null,
          exitPrice: null,
          grossPayout: null,
          netPayout: null,
          exitFees: null,
          settledAt: null,
        };
        trade.shares = sharesBefore - sharesToClose;
        trade.cost = Number(trade.cost || 0) - closedTrade.cost;
        trade.fees = Number(trade.fees || 0) - closedTrade.fees;
        trade.totalCost = Number(trade.totalCost || 0) - closedTrade.totalCost;
        this.trades.unshift(closedTrade);
      }
      closedTrade.exitOrderId = order.id;
      closedTrade.exitSignalSide = order.signalSide;
      const fillRatio = sharesToClose / fill.shares;
      this.closeTrade(
        closedTrade,
        fill.averagePrice,
        fill.grossPayout * fillRatio,
        'RENKO_SIGNAL_REVERSAL',
        'Taker sell executed against visible bids after an opposite closed one-minute Renko brick.',
        now,
        fill.averagePrice,
        fill.fees * fillRatio,
        'TAKER',
      );
      remainingFill -= sharesToClose;
      closedShares += sharesToClose;
    }

    if (closedShares <= 1e-8) {
      order.status = 'CANCELLED_NO_OPEN_POSITION';
      order.cancelReason = 'No matching open position remained when the sell was confirmed.';
      order.filledShares = 0;
      order.remainingShares = 0;
      order.cancelledRemainderShares = order.requestedShares;
      this.log('PAPER_TAKER_SELL_NOT_FILLED', {
        orderId: order.id, side: order.side, reason: order.cancelReason,
      }, order.windowStart);
      return;
    }

    order.filledShares = closedShares;
    order.cancelledRemainderShares = Math.max(
      order.cancelledRemainderShares,
      order.requestedShares - closedShares,
    );
    order.status = order.cancelledRemainderShares > 1e-8
      ? 'PARTIALLY_FILLED_REMAINDER_CANCELLED' : 'FILLED';
    this.log('PAPER_TAKER_SELL_FILLED', {
      orderId: order.id,
      side: order.side,
      targetSide: order.targetSide,
      signalSide: order.signalSide,
      requestedShares: order.requestedShares,
      filledShares: closedShares,
      cancelledRemainderShares: order.cancelledRemainderShares,
      averageFillPrice: fill.averagePrice,
      grossPayout: fill.grossPayout * (closedShares / fill.shares),
      takerFees: fill.fees * (closedShares / fill.shares),
      fillLevels: fill.fills,
    }, order.windowStart);

    const variant = this.variants[order.variantId];
    const remainingHeld = this.trades.some(trade => trade.status === 'OPEN'
      && trade.marketId === order.marketId
      && trade.windowStart === order.windowStart
      && trade.variantId === order.variantId
      && trade.side === order.side);
    const flip = this.pendingRenkoFlip.get(order.variantId);
    const currentSignalSide = this.renkoState.selectedSide;
    const currentTargetSide = this.tradeSideFor(currentSignalSide);
    if (!remainingHeld && variant?.active && variant.id === this.activeVariantId
      && this.market?.id === order.marketId && now < order.windowEnd
      && flip && currentTargetSide === flip.targetSide) {
      this.pendingRenkoFlip.delete(order.variantId);
      this.queueRenkoBuy(
        currentSignalSide, currentTargetSide, variant, now,
        `${this.market.start}:${this.renkoState.latestBrickAt}:${currentSignalSide}`,
      );
    } else if (!remainingHeld) {
      this.pendingRenkoFlip.delete(order.variantId);
      this.statusReason = `${closedShares.toLocaleString()} ${order.side} shares sold at ${fill.averagePrice.toFixed(4)} average; no opposite buy was sent because the Renko direction or active paper version changed.`;
    } else {
      this.statusReason = `${closedShares.toLocaleString()} ${order.side} shares sold at ${fill.averagePrice.toFixed(4)} average; the unfilled position remains open until another visible bid is available.`;
    }
    let retainedSettled = 0;
    this.trades = this.trades.filter(item => item.status === 'OPEN' || retainedSettled++ < 200);
  }

  orderSchedule(now = this.now()) {
    const start = this.market?.start;
    if (!Number.isFinite(start)) {
      return {
        status: 'WAITING_FOR_MARKET',
        selectedSide: null,
        ordersPlaced: 0,
        openOrders: 0,
      };
    }
    const currentOrders = this.entryOrders.filter(order => order.windowStart === start);
    const openOrders = currentOrders.filter(order => order.status === 'PENDING_SUBMISSION');
    const latestOrder = currentOrders[0] ?? null;
    const buyOrders = currentOrders.filter(order => order.action === 'BUY');
    const sellOrders = currentOrders.filter(order => order.action === 'SELL');
    const status = openOrders.length
      ? openOrders[0].status
      : currentOrders[0]?.status
      ?? (this.renkoState.selectedSide ? this.entrySideSelection.status
        : now >= this.market.end ? 'WINDOW_CLOSED' : this.renkoState.status);
    return {
      status,
      signalSide: this.entrySignal?.selectedSide ?? null,
      tradeSide: this.entrySideForWindow ?? this.tradeSideFor(this.entrySignal?.selectedSide),
      entrySideForWindow: this.entrySideForWindow,
      activeVariantId: this.activeVariantId,
      variantMode: this.variants[this.activeVariantId]?.mode,
      signalPrice: this.entrySignal?.signalPrice ?? null,
      referenceClose: this.entrySignal?.referenceClose ?? null,
      brickSize: this.renkoState.brickSize ?? null,
      latestBrickAt: this.renkoState.latestBrickAt ?? null,
      newBrickPrinted: Boolean(this.renkoState.newBrickPrinted),
      bricksPrintedThisTick: this.renkoState.bricksPrintedThisTick ?? 0,
      heldSide: this.trades.find(trade => trade.status === 'OPEN'
        && trade.marketId === this.market?.id
        && trade.windowStart === start
        && trade.variantId === this.activeVariantId)?.side ?? null,
      lastAction: latestOrder?.action ?? null,
      nextTickConfirmation: false,
      ordersPlaced: currentOrders.length,
      openOrders: openOrders.length,
      buyOrders: buyOrders.length,
      sellOrders: sellOrders.length,
      filledShares: buyOrders.reduce((sum, order) => sum + order.filledShares, 0),
      soldShares: sellOrders.reduce((sum, order) => sum + order.filledShares, 0),
      requestedShares: buyOrders.reduce((sum, order) => sum + order.requestedShares, 0),
      entryOrderType: 'MARKET',
      entryExecutionRole: 'TAKER',
      entryShares: ENTRY_SHARES,
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
        const takeProfitPrice = Number(trade.takeProfitPrice ?? TAKE_PROFIT_LIMIT_PRICE);
        if (quote.updatedAt >= (trade.openedAt ?? 0) && bid >= takeProfitPrice) {
          const executableShares = (quote.bids || [])
            .filter(level => Number(level.price) >= takeProfitPrice)
            .reduce((sum, level) => sum + Number(level.size || 0), 0);
          trade.takeProfitOrder = {
            ...(trade.takeProfitOrder || {}),
            type: 'LIMIT_SELL',
            price: takeProfitPrice,
            status: 'RESTING',
            remainingShares: trade.shares,
            displayedBidShares: executableShares,
            lastCheckedAt: quote.updatedAt,
          };
          if (executableShares + 1e-8 < trade.shares) continue;
          const payout = trade.shares * TAKE_PROFIT_PAYOUT_PER_SHARE;
          this.closeTrade(
            trade,
            TAKE_PROFIT_LIMIT_PRICE,
            payout,
            'TAKE_PROFIT_099',
            'Paper limit take-profit reached: best bid met $0.99; credited at $1 per share as requested.',
            now,
            TAKE_PROFIT_LIMIT_PRICE,
            0,
            'MAKER',
          );
          this.statusReason = `${trade.shares.toLocaleString()} ${trade.side} shares reached the $0.99 take-profit and were credited at $1 per share.`;
        }
        continue;
      }

      if (now < trade.windowEnd) continue;
      const wasPending = trade.settlementStatus === 'AWAITING_SETTLEMENT';
      trade.settlementStatus = 'AWAITING_SETTLEMENT';
      if (trade.takeProfitOrder?.status === 'RESTING') {
        trade.takeProfitOrder.status = 'EXPIRED';
        trade.takeProfitOrder.remainingShares = trade.shares;
      }
      trade.settlementError = 'Window ended before the $0.99 take-profit. Waiting for confirmed original-market resolution.';
      if (!wasPending) {
        this.log('EXPIRY_RECOVERY_PENDING', {
          tradeId: trade.id,
          marketId: trade.marketId,
          reason: trade.settlementError,
        }, trade.windowStart);
      }
    }
  }

  closeTrade(
    trade, exitPrice, payout, outcome, settlementSource, now, feeExecutionPrice,
    executionFees, exitExecutionRole = 'TAKER', estimatedMakerRebate = 0,
  ) {
    if (outcome === 'TAKE_PROFIT_099') {
      const entryOrder = this.entryOrders.find(order => order.id === trade.orderId);
      if (entryOrder && ['RESTING', 'PARTIALLY_FILLED_RESTING'].includes(entryOrder.status)
        && Number(entryOrder.remainingShares) > 0) {
        entryOrder.status = 'CANCELLED_AFTER_TP';
        entryOrder.cancelledRemainderShares = Number(entryOrder.remainingShares);
        entryOrder.remainingShares = 0;
        entryOrder.cancelledAt = now;
        entryOrder.cancelReason = 'Remaining entry quantity cancelled after its position reached take-profit.';
      }
    }
    if (trade.takeProfitOrder?.status === 'RESTING') {
      trade.takeProfitOrder.status = outcome === 'TAKE_PROFIT_099' ? 'FILLED' : 'CANCELLED';
      trade.takeProfitOrder.remainingShares = 0;
      trade.takeProfitOrder.completedAt = now;
    }
    const exitFees = executionFees ?? estimateTakerFee(feeExecutionPrice, trade.shares, {
      raw: { feeSchedule: { rate: trade.feeRate ?? TAKER_FEE_RATE, exponent: trade.feeExponent ?? 1 } },
    });
    const netPayout = payout - exitFees + estimatedMakerRebate;
    trade.status = 'SETTLED';
    trade.settlementStatus = 'SETTLED';
    trade.settlementError = null;
    trade.finalOutcome = outcome;
    trade.closePrice = exitPrice;
    trade.exitPrice = exitPrice;
    trade.grossPayout = payout;
    trade.exitFees = exitFees;
    trade.estimatedMakerRebate = (trade.estimatedMakerRebate || 0) + estimatedMakerRebate;
    trade.netPayout = netPayout;
    trade.exitExecutionRole = exitExecutionRole;
    trade.settlementSource = settlementSource;
    trade.realizedPnl = netPayout - trade.totalCost;
    trade.settledAt = now;
    this.cash += netPayout;
    const variant = this.variants[trade.variantId];
    if (variant) {
      variant.cash += netPayout;
      variant.settledTrades += 1;
      if (trade.realizedPnl > 0) variant.wins += 1;
      else if (trade.realizedPnl < 0) variant.losses += 1;
      const previousEquity = variant.equityCurve.at(-1)?.equity ?? variant.startingCash;
      variant.equityCurve.push({
        ts: now,
        equity: Number((previousEquity + trade.realizedPnl).toFixed(8)),
      });
      if (variant.equityCurve.length > 1000) {
        variant.equityCurve.splice(1, variant.equityCurve.length - 1000);
      }
    }
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
      variantId: trade.variantId,
      entryPrice: trade.entryPrice,
      side: trade.side,
      outcome,
      exitPrice,
      grossPayout: payout,
      exitFees,
      estimatedMakerRebate,
      exitExecutionRole,
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
      strategyVersion: STRATEGY_VERSION,
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
      markedValue += trade.shares * bid - estimateTakerFee(bid, trade.shares, {
        raw: { feeSchedule: { rate: trade.feeRate ?? TAKER_FEE_RATE, exponent: trade.feeExponent ?? 1 } },
      });
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
    const realizedPnl = this.cash + openCost - this.startingCash;
    const snapshot = {
      ts: now,
      accountSessionStartedAt: this.accountSessionStartedAt,
      windowStart: this.market?.start ?? null,
      strategyVersion: STRATEGY_VERSION,
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
        this.timer = setTimeout(loop, POLL_INTERVAL_MS);
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
    const realizedPnl = this.cash + openCost - this.startingCash;
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
    const pendingEntryOrders = this.entryOrders.filter(order => (
      order.orderType === 'MARKET' && order.status === 'PENDING_SUBMISSION'
      && Number(order.remainingShares) > 0
    ));
    const openOrders = pendingEntryOrders;
    const reservedOrderFunds = this.reservedLimitOrderFunds();
    return {
      mode: 'PAPER ONLY',
      running: this.running,
      now,
      lastUpdateAt: this.lastUpdateAt,
      error: this.error,
      statusReason: this.statusReason,
      strategy: {
        version: STRATEGY_VERSION,
        timeframe: '5m',
        signalTimeframe: '1m',
        pollIntervalMs: POLL_INTERVAL_MS,
        orderType: 'MARKET',
        activeVariantId: this.activeVariantId,
        variantMode: this.variants[this.activeVariantId]?.mode,
        sharesPerTrade: ENTRY_SHARES,
        entryExecutionRole: 'TAKER',
        reversalEnabled: false,
        takeProfitPrice: TAKE_PROFIT_LIMIT_PRICE,
        renkoAtrPeriod: RENKO_ATR_PERIOD,
        takerFeeRate: TAKER_FEE_RATE,
        orderModel: `Build Renko from confirmed 1-minute BTC candle closes. The brick size is fixed for each 5-minute market window at the average true range of the preceding ${RENKO_ATR_PERIOD} one-minute bars. Green signals UP and red signals DOWN. Immediately after the window starts, buy 300 shares on the opposite side with one taker market order. If there is no confirmed Renko side yet, wait for one. No re-entry or reversal.`,
        fillModel: 'Taker buys sweep only visible asks and apply the market taker fee schedule. Book the actual average fill price and shares; cancel any unfilled market-order remainder immediately. If the ask book is unavailable, wait for a fresh book before submitting once. Never fabricate fills.',
        exitModel: 'A paper limit take-profit triggers when a fresh original-market best bid reaches $0.99 and is credited at $1 per share with no exit fee. No stop-loss and no Renko reversal sell. Any position not sold by take-profit stays open for confirmed resolution of its exact original market.',
      },
      window: this.market ? {
        title: this.market.title,
        slug: this.market.slug,
        start: this.market.start,
        end: this.market.end,
        secondsUntilOpen: Math.max(0, (this.market.start - now) / 1000),
        secondsRemaining: Math.max(0, (this.market.end - Math.max(now, this.market.start)) / 1000),
      } : null,
      referencePrice: this.referencePrice,
      spotPrice: this.latestPrice,
      priceGap: Number.isFinite(this.latestPrice)
        && Number.isFinite(this.renkoState?.lastBrickClose)
        ? this.latestPrice - this.renkoState.lastBrickClose
        : Number.isFinite(this.referencePrice) && Number.isFinite(this.latestPrice)
          ? this.latestPrice - this.referencePrice : null,
      priceAt: this.priceAt,
      quotes: {
        UP: this.quotes.UP ? {
          bestBid: this.quotes.UP.bestBid, bestAsk: this.quotes.UP.bestAsk,
          midpoint: this.quotes.UP.midpoint, updatedAt: this.quotes.UP.updatedAt,
          status: this.quotes.UP.status, error: this.quotes.UP.error,
        } : null,
        DOWN: this.quotes.DOWN ? {
          bestBid: this.quotes.DOWN.bestBid, bestAsk: this.quotes.DOWN.bestAsk,
          midpoint: this.quotes.DOWN.midpoint, updatedAt: this.quotes.DOWN.updatedAt,
          status: this.quotes.DOWN.status, error: this.quotes.DOWN.error,
        } : null,
      },
      paperAccount: {
        startingCash: this.startingCash, cash: this.cash, openCost, realizedPnl,
        reservedOrderFunds,
        availableCashAfterReservations: Math.max(0, this.cash - reservedOrderFunds),
        equity: globalEquity.valid ? globalEquity.equity : null,
        markedValue: globalEquity.markedValue,
        unrealizedPnl: globalEquity.unrealizedPnl,
        equityMarkStatus: globalEquity.valid ? 'FRESH' : 'WAITING_FOR_FRESH_MARKS',
        wins: this.settledWins, losses: this.settledLosses,
        settled: this.settledCount,
        openPositions: openTrades.length,
        activeWindowPositions: activeWindowTrades.length,
        openOrders: openOrders.length,
        positions,
        awaitingSettlement: awaitingSettlementTrades.length,
        awaitingSettlementShares: awaitingSettlementTrades.reduce((sum, trade) => sum + trade.shares, 0),
      },
      trades: this.trades.slice(0, 50),
      activeVariantId: this.activeVariantId,
      variants: this.snapshotVariants(now),
      entryOrders: this.entryOrders.slice(0, 100),
      openOrders,
      events: this.events,
      entrySideSelection: this.entrySideSelection,
      renko: this.renkoState,
      orderSchedule: this.orderSchedule(now),
      learning: {
        ...this.learningStatus,
        persistenceStatus: this.persistenceError ? 'error' : this.learningStore ? 'connected' : 'disabled',
      },
      priceFeed: ticks,
    };
  }
}

module.exports = { ProbabilityBot, estimateTakerFee };
