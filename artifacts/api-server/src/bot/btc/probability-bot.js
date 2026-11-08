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
    this.windowResults = new Map();
    this.finalizedWindowStarts = new Set();
    this.accountSessionStartedAt = this.now();
    this.lastEquitySnapshotAt = null;
    this.equitySnapshotRequested = true;
    this.learningStatus = {
      enabled: Boolean(learningStore),
      mode: learningStore ? 'renko-signal-tp099-paper-logging-only' : 'disabled',
      completedWindows: 0,
    };
    this.error = null;
    this.statusReason = 'Starting BTC market and order-book feeds.';
    this.lastUpdateAt = null;
    this.startedAt = this.now();
    this.activeVariantId = 'signal';
    this.variants = {
      signal: {
        id: 'signal', name: 'BTC Renko signal', mode: 'SIGNAL',
        startingCash: STARTING_CASH, cash: STARTING_CASH,
        shareSize: ENTRY_SHARES,
        active: true, settledTrades: 0, wins: 0, losses: 0, totalTrades: 0,
        equityCurve: [{ ts: this.startedAt, equity: STARTING_CASH }],
      },
    };
    this.priceFeed.start();
  }

  tradeSideFor(signalSide) {
    return signalSide === 'UP' || signalSide === 'DOWN' ? signalSide : null;
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
          orderType: order.orderType, brickAt: order.brickAt,
          averageFillPrice: order.averageFillPrice, remainingShares: order.remainingShares,
          requestedShares: order.requestedShares, filledShares: order.filledShares,
          fees: order.fees, status: order.status,
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
      this.processPendingTakerOrders(scanAt);
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
      shares: this.variants[this.activeVariantId]?.shareSize ?? ENTRY_SHARES,
      entryOrderType: 'TAKER',
      source: 'CLOSED_ONE_MINUTE_BTC_CANDLES',
    });
  }

  reservedLimitOrderFunds() {
    return 0;
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

  cancelPendingTakerOrder(order, reason) {
    if (order.status !== 'PENDING_CONFIRMATION') return false;
    order.status = 'CANCELLED_SIGNAL_REVERSED';
    order.remainingShares = 0;
    order.cancelledRemainderShares = order.requestedShares;
    order.cancelReason = reason;
    order.cancelledAt = this.now();
    this.log('PAPER_TAKER_ORDER_CANCELLED_SIGNAL_REVERSED', {
      orderId: order.id, action: order.action, side: order.side, reason,
    }, order.windowStart);
    return true;
  }

  queueRenkoBuy(signalSide, side, variant, now, signalKey) {
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
      signalSide,
      action: 'BUY',
      orderType: 'TAKER',
      executionRole: 'TAKER',
      requestedShares: variant.shareSize,
      filledShares: 0,
      remainingShares: variant.shareSize,
      cancelledRemainderShares: 0,
      averageFillPrice: null,
      filledCost: 0,
      fees: 0,
      estimatedMakerRebate: 0,
      placedAt: now,
      confirmationDueTick: this.tickCount + 1,
      status: 'PENDING_CONFIRMATION',
      fillModel: 'NEXT_TICK_VISIBLE_ASK_SWEEP',
      signalPrice: this.renkoState.latestBrick?.close ?? null,
      brickAt: this.renkoState.latestBrickAt ?? null,
      renkoSignalKey: signalKey,
    };
    this.entryOrders.unshift(order);
    this.entryOrders.length = Math.min(this.entryOrders.length, 200);
    this.lastRenkoActionKey.set(variant.id, signalKey);
    this.statusReason = `${this.renkoState.newBrickPrinted ? 'A confirmed' : 'The current'} Renko ${signalSide} direction submitted a ${variant.name} paper taker buy on ${side} for ${variant.shareSize} shares. The next tick will confirm only visible ask depth.`;
    this.log('PAPER_RENKO_TAKER_BUY_SUBMITTED', {
      orderId: id, side, signalSide, variantId: variant.id, variantMode: variant.mode,
      cycleNumber: variant.cycleNumber, requestedShares: variant.shareSize,
      confirmationDueTick: order.confirmationDueTick, fillModel: order.fillModel,
      brickSize: this.renkoState.brickSize, brickAt: order.brickAt,
    }, this.market.start);
    return order;
  }

  queueRenkoSell(signalSide, targetSide, trades, variant, now, signalKey) {
    const heldSides = [...new Set(trades.map(trade => trade.side))];
    if (heldSides.length !== 1) {
      this.statusReason = 'Renko reversal paused: the active paper version has mixed UP and DOWN inventory in this market.';
      return null;
    }
    const side = heldSides[0];
    const requestedShares = trades.reduce((sum, trade) => sum + Number(trade.shares || 0), 0);
    if (requestedShares <= 0) return null;
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
      signalSide,
      targetSide,
      action: 'SELL',
      orderType: 'TAKER',
      executionRole: 'TAKER',
      requestedShares,
      filledShares: 0,
      remainingShares: requestedShares,
      cancelledRemainderShares: 0,
      averageFillPrice: null,
      filledCost: 0,
      fees: 0,
      estimatedMakerRebate: 0,
      placedAt: now,
      confirmationDueTick: this.tickCount + 1,
      status: 'PENDING_CONFIRMATION',
      fillModel: 'NEXT_TICK_VISIBLE_BID_SWEEP',
      brickSize: this.renkoState.brickSize,
      brickAt: this.renkoState.latestBrickAt ?? null,
      renkoSignalKey: signalKey,
    };
    this.entryOrders.unshift(order);
    this.entryOrders.length = Math.min(this.entryOrders.length, 200);
    this.pendingRenkoFlip.set(variant.id, { signalSide, targetSide, signalKey });
    this.lastRenkoActionKey.set(variant.id, signalKey);
    this.statusReason = `Renko reversed to ${signalSide}; the bot is submitting a taker sell for ${requestedShares} ${side} shares before buying ${targetSide}.`;
    this.log('PAPER_RENKO_TAKER_SELL_SUBMITTED', {
      orderId: id, side, targetSide, signalSide, variantId: variant.id,
      requestedShares, confirmationDueTick: order.confirmationDueTick,
      fillModel: order.fillModel, brickSize: order.brickSize, brickAt: order.brickAt,
    }, this.market.start);
    return order;
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

    const variant = this.variants[this.activeVariantId];
    const targetSide = this.tradeSideFor(signalSide);
    const signalKey = `${this.market.start}:${latestBrick.at}:${signalSide}`;
    const currentOrders = this.entryOrders.filter(order => order.marketId === this.market.id
      && order.windowStart === this.market.start
      && order.variantId === variant.id);
    const pendingBuys = currentOrders.filter(order =>
      order.action === 'BUY' && order.status === 'PENDING_CONFIRMATION');
    const pendingSells = currentOrders.filter(order =>
      order.action === 'SELL' && order.status === 'PENDING_CONFIRMATION');
    const openTrades = this.trades.filter(trade => trade.status === 'OPEN'
      && trade.marketId === this.market.id
      && trade.windowStart === this.market.start
      && trade.variantId === variant.id);

    for (const order of pendingBuys) {
      if (order.side !== targetSide) {
        this.cancelPendingTakerOrder(order, `Renko direction changed to ${signalSide} before the buy was confirmed.`);
      }
    }

    if (openTrades.some(trade => trade.side === targetSide)) {
      for (const order of pendingSells) {
        this.cancelPendingTakerOrder(order, `Renko returned to the held ${targetSide} side before the sell was confirmed.`);
      }
      this.pendingRenkoFlip.delete(variant.id);
      this.lastRenkoActionKey.set(variant.id, signalKey);
      this.statusReason = this.renkoState.newBrickPrinted
        ? `Renko printed ${signalSide}; the ${variant.name} already holds ${targetSide}, so it keeps the position.`
        : `No new Renko brick printed; the ${variant.name} keeps its ${targetSide} position.`;
      return;
    }

    if (openTrades.length) {
      this.pendingRenkoFlip.set(variant.id, { signalSide, targetSide, signalKey });
      const alreadyActedOnBrick = this.lastRenkoActionKey.get(variant.id) === signalKey;
      if (!pendingSells.length && !alreadyActedOnBrick && this.renkoState.newBrickPrinted) {
        this.queueRenkoSell(signalSide, targetSide, openTrades, variant, now, signalKey);
      }
      return;
    }

    if (pendingSells.length) {
      this.pendingRenkoFlip.set(variant.id, { signalSide, targetSide, signalKey });
      return;
    }
    if (pendingBuys.some(order => order.side === targetSide)) {
      this.lastRenkoActionKey.set(variant.id, signalKey);
      return;
    }
    if (this.lastRenkoActionKey.get(variant.id) === signalKey) return;

    this.queueRenkoBuy(signalSide, targetSide, variant, now, signalKey);
  }

  processPendingTakerOrders(now) {
    for (const order of this.entryOrders) {
      if (order.status !== 'PENDING_CONFIRMATION' || this.tickCount < order.confirmationDueTick) continue;
      order.confirmedAt = now;
      if (!this.market || this.market.id !== order.marketId || now >= order.windowEnd) {
        order.status = 'CANCELLED_WINDOW_ENDED';
        order.remainingShares = 0;
        order.cancelledRemainderShares = order.requestedShares;
        order.cancelReason = 'The original market window ended before next-tick fill confirmation.';
        this.log('PAPER_TAKER_ORDER_NOT_FILLED', {
          orderId: order.id, action: order.action, side: order.side, reason: order.cancelReason,
        }, order.windowStart);
        continue;
      }
      const quote = this.market?.id === order.marketId ? this.quotes[order.side] : null;
      if (!quoteIsFresh(quote, now, EXIT_QUOTE_MAX_AGE_MS)) {
        order.status = 'CANCELLED_NO_FRESH_BOOK';
        order.cancelledRemainderShares = order.requestedShares;
        order.remainingShares = 0;
        order.cancelReason = 'No fresh order book was available on the confirmation tick.';
        this.statusReason = `${order.side} taker ${order.action.toLowerCase()} was not filled: no fresh book was available on the next tick.`;
        this.log(order.action === 'SELL' ? 'PAPER_TAKER_SELL_NOT_FILLED' : 'PAPER_TAKER_BUY_NOT_FILLED', {
          orderId: order.id,
          action: order.action,
          side: order.side,
          reason: order.cancelReason,
        }, order.windowStart);
        continue;
      }

      if (order.action === 'SELL') {
        this.processPendingTakerSellOrder(order, quote, now);
        continue;
      }

      const fill = simulateTakerBuyFill(quote.asks, order.requestedShares, this.market);
      if (!fill) {
        order.status = 'CANCELLED_NO_VISIBLE_ASKS';
        order.cancelledRemainderShares = order.requestedShares;
        order.remainingShares = 0;
        order.cancelReason = 'The next-tick order book contained no executable ask depth.';
        this.statusReason = `${order.side} taker entry was not filled: no executable ask depth was visible on the next tick.`;
        this.log('PAPER_TAKER_BUY_NOT_FILLED', {
          orderId: order.id,
          side: order.side,
          reason: order.cancelReason,
        }, order.windowStart);
        continue;
      }
      const variant = this.variants[order.variantId];
      if (!variant || fill.totalCost > variant.cash + 1e-8) {
        order.status = 'CANCELLED_INSUFFICIENT_CASH';
        order.cancelledRemainderShares = order.requestedShares;
        order.remainingShares = 0;
        order.cancelReason = 'The confirmed taker fill exceeded the remaining paper cash.';
        this.statusReason = 'Taker entry skipped because the confirmed cost and fees exceed available paper cash.';
        this.log('PAPER_TAKER_BUY_NOT_FILLED', {
          orderId: order.id,
          side: order.side,
          requestedShares: order.requestedShares,
          confirmedCost: fill.totalCost,
          availableCash: variant?.cash ?? 0,
          reason: order.cancelReason,
        }, order.windowStart);
        continue;
      }

      const remainder = Math.max(0, order.requestedShares - fill.shares);
      order.filledShares = fill.shares;
      order.remainingShares = 0;
      order.cancelledRemainderShares = remainder;
      order.averageFillPrice = fill.averagePrice;
      order.filledCost = fill.cost;
      order.fees = fill.fees;
      order.feeRate = fill.feeRate;
      order.feeExponent = fill.feeExponent;
      order.fillLevels = fill.fills;
      order.status = remainder > 1e-8 ? 'PARTIALLY_FILLED_REMAINDER_CANCELLED' : 'FILLED';

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
        entryKind: 'TAKER_MARKET',
        orderType: 'TAKER',
        requestedShares: order.requestedShares,
        shares: fill.shares,
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
          remainingShares: fill.shares,
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
        ?? { entryCount: 0, settledCount: 0, netPnl: 0,
          variantId: order.variantId };
      windowResult.entryCount += 1;
      this.windowResults.set(order.windowStart, windowResult);
      this.cash -= fill.totalCost;
      variant.cash -= fill.totalCost;
      variant.totalTrades += 1;
      this.equitySnapshotRequested = true;
      this.log('PAPER_TAKER_BUY_FILLED', {
        orderId: order.id,
        tradeId: trade.id,
        side: order.side,
        requestedShares: order.requestedShares,
        filledShares: fill.shares,
        cancelledRemainderShares: remainder,
        averageFillPrice: fill.averagePrice,
        fillCost: fill.cost,
        takerFees: fill.fees,
        confirmationTick: this.tickCount,
        fillLevels: fill.fills,
      }, order.windowStart);
      this.statusReason = `${fill.shares.toLocaleString()} ${order.side} shares confirmed at a ${fill.averagePrice.toFixed(4)} weighted average. The position has a $0.99 take-profit; otherwise it stays for the original market's resolution.`;
      let retainedSettled = 0;
      this.trades = this.trades.filter(item => item.status === 'OPEN' || retainedSettled++ < 200);
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
    const openOrders = currentOrders.filter(order => order.status === 'PENDING_CONFIRMATION');
    const latestOrder = currentOrders[0] ?? null;
    const buyOrders = currentOrders.filter(order => order.action === 'BUY');
    const sellOrders = currentOrders.filter(order => order.action === 'SELL');
    const status = currentOrders[0]?.status
      ?? (this.renkoState.selectedSide ? this.entrySideSelection.status
        : now >= this.market.end ? 'WINDOW_CLOSED' : this.renkoState.status);
    return {
      status,
      signalSide: this.entrySignal?.selectedSide ?? null,
      tradeSide: this.tradeSideFor(this.entrySignal?.selectedSide),
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
      nextTickConfirmation: Boolean(openOrders.length),
      ordersPlaced: currentOrders.length,
      openOrders: openOrders.length,
      buyOrders: buyOrders.length,
      sellOrders: sellOrders.length,
      filledShares: buyOrders.reduce((sum, order) => sum + order.filledShares, 0),
      soldShares: sellOrders.reduce((sum, order) => sum + order.filledShares, 0),
      requestedShares: buyOrders.reduce((sum, order) => sum + order.requestedShares, 0),
      entryOrderType: 'TAKER',
      entryShares: this.variants[this.activeVariantId]?.shareSize ?? ENTRY_SHARES,
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
      order.status === 'PENDING_CONFIRMATION' && order.remainingShares > 0
    ));
    const openOrders = pendingEntryOrders;
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
        orderType: 'TAKER',
        activeVariantId: this.activeVariantId,
        variantMode: this.variants[this.activeVariantId]?.mode,
        sharesPerTrade: this.variants[this.activeVariantId]?.shareSize ?? ENTRY_SHARES,
        takeProfitPrice: TAKE_PROFIT_LIMIT_PRICE,
        renkoAtrPeriod: RENKO_ATR_PERIOD,
        takerFeeRate: TAKER_FEE_RATE,
        orderModel: `Build Renko from confirmed 1-minute BTC candle closes. The brick size is fixed for each 5-minute market window at the average true range of the preceding ${RENKO_ATR_PERIOD} one-minute bars. Green means UP and red means DOWN; entries always follow the current Renko signal. A new opposite brick closes the current position and enters the newly signalled side. No new brick means hold.`,
        fillModel: 'Paper taker buys and reversal sells are confirmed on the next 500 ms bot tick from fresh visible ask or bid depth. Only actually visible shares are booked at their weighted average price; unfilled remainder is cancelled. Taker entry and reversal fees use the market fee schedule when available.',
        exitModel: 'A paper limit take-profit triggers when a fresh original-market best bid reaches $0.99 and is credited at $1 per share with no exit fee. No stop-loss. Any position not sold by take-profit or a Renko reversal stays open for confirmed resolution of its exact original market.',
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
        reservedOrderFunds: 0,
        availableCashAfterReservations: this.cash,
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
