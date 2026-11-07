'use strict';

const { CRYPTO_TAKER_FEE_RATE } = require('./config');
const marketData = require('./wick-market-data');
const { feed } = require('./chainlink-price-feed');
const { recoverExpiredPositions } = require('./position-exits');
const {
  STRATEGY_VERSION,
  WINDOW_MS,
  SIGNAL_SCAN_LEAD_MS,
  SIGNAL_COMPARE_LEAD_MS,
  ENTRY_SHARES,
  POLL_INTERVAL_MS,
  MAX_QUOTE_AGE_MS,
  quoteIsFresh,
  feeParameters,
  estimateTakerFee,
  simulateTakerBuyFill,
  selectClosedCandleSignal,
  getWindowToScan,
} = require('./signal-taker-strategy');

const STARTING_CASH = 10_000;
const TAKER_FEE_RATE = CRYPTO_TAKER_FEE_RATE;
const EQUITY_SNAPSHOT_INTERVAL_MS = 30_000;
const EXIT_QUOTE_MAX_AGE_MS = MAX_QUOTE_AGE_MS;

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
    this.cash = STARTING_CASH;
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
    this.entryOrderAttempted = false;
    this.entrySignal = null;
    this.entrySideSelection = { status: 'WAITING_FOR_PREOPEN_SIGNAL', selectedSide: null };
    this.windowResults = new Map();
    this.finalizedWindowStarts = new Set();
    this.accountSessionStartedAt = this.now();
    this.lastEquitySnapshotAt = null;
    this.equitySnapshotRequested = true;
    this.learningStatus = {
      enabled: Boolean(learningStore),
      mode: learningStore ? 'fixed-candle-signal-taker-logging-only' : 'disabled',
      completedWindows: 0,
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
    const ts = Math.floor(now / POLL_INTERVAL_MS) * POLL_INTERVAL_MS;
    if (ts === this.lastSampledAt) return;
    this.lastSampledAt = ts;
    const sample = {
      ts, observedAt: now, windowStart: this.market.start, windowEnd: this.market.end,
      secondsSinceOpen: Math.max(0, (now - this.market.start) / 1000),
      secondsRemaining: Math.max(0, (this.market.end - now) / 1000),
      orderStrategy: STRATEGY_VERSION,
      entrySideSelection: this.entrySideSelection,
      orderSchedule: this.orderSchedule(now),
      referencePrice: this.entrySignal?.referenceClose ?? this.referencePrice,
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
          id: order.id, side: order.side, orderType: order.orderType,
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
      this.referencePrice = referenceTick?.price ?? this.entrySignal?.referenceClose ?? null;
      this.latestPrice = latestTick?.price ?? null;
      this.priceAt = latestTick?.ts ?? null;
      const scanAt = this.now();
      this.processCandleSignalStrategy(scanAt);
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
    this.entryOrderAttempted = now >= start;
    this.entrySignal = null;
    this.entrySideSelection = {
      status: now >= start ? 'MISSED_PREOPEN_SIGNAL' : 'WAITING_FOR_PREOPEN_SIGNAL',
      selectedSide: null,
    };
    this.log('PAPER_CANDLE_SIGNAL_WINDOW_STARTED', {
      windowStart: start,
      signalScanLeadMs: SIGNAL_SCAN_LEAD_MS,
      signalCompareLeadMs: SIGNAL_COMPARE_LEAD_MS,
      shares: ENTRY_SHARES,
      entryOrderType: 'TAKER',
      startedAfterOpen: now >= start,
    });
  }

  reservedLimitOrderFunds() {
    return 0;
  }

  processCandleSignalStrategy(now) {
    if (!this.market || now >= this.market.end) return;
    if (this.orderWindowStart !== this.market.start) this.beginMarketWindow(this.market.start, now);
    if (this.entryOrderAttempted) return;

    const signalAt = this.market.start - SIGNAL_COMPARE_LEAD_MS;
    if (!this.entrySignal && now >= signalAt && now < this.market.start) {
      try {
        const signal = selectClosedCandleSignal({
          candles: this.priceFeed.getMinuteCandles?.() ?? [],
          ticks: this.priceFeed.getTicks?.() ?? [],
          signalAt,
          now,
        });
        this.entrySideSelection = signal;
        if (signal.status === 'SIGNAL_LATCHED') {
          this.entrySignal = signal;
          this.referencePrice = signal.referenceClose;
          this.log('PAPER_CANDLE_SIGNAL_LATCHED', {
            side: signal.selectedSide,
            signalPrice: signal.signalPrice,
            referenceClose: signal.referenceClose,
            signalAt: signal.signalAt,
            referenceCandleAt: signal.referenceCandleAt,
            rule: signal.rule,
          }, this.market.start);
        } else {
          this.statusReason = signal.status === 'STALE_CLOSED_CANDLE'
            ? 'The previous closed BTC 1-minute candle is stale; no entry will be made without a valid pre-open signal.'
            : 'Waiting for the previous closed BTC 1-minute candle and a fresh pre-open BTC price.';
        }
      } catch (error) {
        this.entrySideSelection = {
          status: 'WAITING_FOR_SIGNAL_DATA',
          selectedSide: null,
          error: error?.message || 'BTC signal data unavailable.',
        };
        this.statusReason = 'Waiting for fresh BTC signal data before the window opens.';
      }
      return;
    }

    if (now < this.market.start) {
      this.statusReason = 'Waiting for the final 3 seconds before the next window to select the signal.';
      return;
    }

    this.entryOrderAttempted = true;
    if (!this.entrySignal?.selectedSide) {
      this.entrySideSelection = {
        ...this.entrySideSelection,
        status: 'MISSED_PREOPEN_SIGNAL',
        selectedSide: null,
      };
      this.statusReason = 'No valid BTC candle signal was latched before the window opened; this window is skipped.';
      this.log('PAPER_ENTRY_SKIPPED_NO_PREOPEN_SIGNAL', {
        signalAt,
        signalStatus: this.entrySideSelection.status,
      }, this.market.start);
      return;
    }

    const side = this.entrySignal.selectedSide;
    const id = `paper-taker-${this.market.start}-${++this.orderSequence}`;
    const order = {
      id,
      marketId: this.market.id,
      tokenId: this.market.tokens?.[side] ?? null,
      windowStart: this.market.start,
      windowEnd: this.market.end,
      marketTitle: this.market.title,
      side,
      action: 'BUY',
      orderType: 'TAKER',
      executionRole: 'TAKER',
      requestedShares: ENTRY_SHARES,
      filledShares: 0,
      remainingShares: ENTRY_SHARES,
      cancelledRemainderShares: 0,
      averageFillPrice: null,
      filledCost: 0,
      fees: 0,
      estimatedMakerRebate: 0,
      placedAt: now,
      confirmationDueTick: this.tickCount + 1,
      status: 'PENDING_CONFIRMATION',
      fillModel: 'NEXT_TICK_VISIBLE_ASK_SWEEP',
      signalPrice: this.entrySignal.signalPrice,
      referenceClose: this.entrySignal.referenceClose,
    };
    this.entryOrders.unshift(order);
    this.entryOrders.length = Math.min(this.entryOrders.length, 200);
    this.entrySideSelection = { ...this.entrySignal, status: 'ENTRY_SUBMITTED' };
    this.statusReason = `${side} signal latched; submitted one paper taker buy for ${ENTRY_SHARES} shares. Fill price and actual quantity will be confirmed from the next tick's visible ask depth.`;
    this.log('PAPER_TAKER_BUY_SUBMITTED', {
      orderId: id,
      side,
      requestedShares: ENTRY_SHARES,
      confirmationDueTick: order.confirmationDueTick,
      fillModel: order.fillModel,
      signalPrice: this.entrySignal.signalPrice,
      referenceClose: this.entrySignal.referenceClose,
    }, this.market.start);
  }

  processPendingTakerOrders(now) {
    for (const order of this.entryOrders) {
      if (order.status !== 'PENDING_CONFIRMATION' || this.tickCount < order.confirmationDueTick) continue;
      order.confirmedAt = now;
      const quote = this.market?.id === order.marketId ? this.quotes[order.side] : null;
      if (!quoteIsFresh(quote, now, EXIT_QUOTE_MAX_AGE_MS)) {
        order.status = 'CANCELLED_NO_FRESH_BOOK';
        order.cancelledRemainderShares = order.requestedShares;
        order.remainingShares = 0;
        order.cancelReason = 'No fresh order book was available on the confirmation tick.';
        this.statusReason = `${order.side} taker entry was not filled: no fresh ask book was available on the next tick.`;
        this.log('PAPER_TAKER_BUY_NOT_FILLED', {
          orderId: order.id,
          side: order.side,
          reason: order.cancelReason,
        }, order.windowStart);
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
      if (fill.totalCost > this.cash + 1e-8) {
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
          availableCash: this.cash,
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
        marketId: order.marketId,
        tokenId: order.tokenId,
        windowStart: order.windowStart,
        windowEnd: order.windowEnd,
        marketTitle: order.marketTitle,
        side: order.side,
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
        peakBid: null,
        peakBidAt: null,
        lastOutcomeBid: null,
        lastOutcomeBidAt: null,
        realizedPnl: null,
      };
      this.trades.unshift(trade);
      const windowResult = this.windowResults.get(order.windowStart)
        ?? { entryCount: 0, settledCount: 0, netPnl: 0 };
      windowResult.entryCount += 1;
      this.windowResults.set(order.windowStart, windowResult);
      this.cash -= fill.totalCost;
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
      this.statusReason = `${fill.shares.toLocaleString()} ${order.side} shares confirmed at a ${fill.averagePrice.toFixed(4)} weighted average on the next tick; ${remainder.toLocaleString()} unfilled shares were cancelled. Filled shares will be held until the original market’s official Polymarket resolution.`;
      let retainedSettled = 0;
      this.trades = this.trades.filter(item => item.status === 'OPEN' || retainedSettled++ < 200);
    }
  }

  orderSchedule(now = this.now()) {
    const start = this.market?.start;
    if (!Number.isFinite(start)) {
      return {
        status: 'WAITING_FOR_MARKET',
        signalAt: null,
        selectedSide: null,
        ordersPlaced: 0,
        openOrders: 0,
      };
    }
    const currentOrders = this.entryOrders.filter(order => order.windowStart === start);
    const openOrders = currentOrders.filter(order => order.status === 'PENDING_CONFIRMATION');
    const signalAt = start - SIGNAL_COMPARE_LEAD_MS;
    const status = currentOrders[0]?.status
      ?? (this.entrySignal?.selectedSide ? this.entrySideSelection.status
        : now >= this.market.end ? 'WINDOW_CLOSED'
          : now >= start ? 'MISSED_PREOPEN_SIGNAL'
            : now >= signalAt ? this.entrySideSelection.status : 'WAITING_FOR_PREOPEN_SIGNAL');
    return {
      status,
      signalAt,
      signalSide: this.entrySignal?.selectedSide ?? null,
      signalPrice: this.entrySignal?.signalPrice ?? null,
      referenceClose: this.entrySignal?.referenceClose ?? null,
      nextTickConfirmation: Boolean(openOrders.length),
      ordersPlaced: currentOrders.length,
      openOrders: openOrders.length,
      filledShares: currentOrders.reduce((sum, order) => sum + order.filledShares, 0),
      requestedShares: currentOrders.reduce((sum, order) => sum + order.requestedShares, 0),
      signalScanLeadMs: SIGNAL_SCAN_LEAD_MS,
      signalCompareLeadMs: SIGNAL_COMPARE_LEAD_MS,
      entryOrderType: 'TAKER',
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
        continue;
      }

      if (now < trade.windowEnd) continue;
      const wasPending = trade.settlementStatus === 'AWAITING_SETTLEMENT';
      trade.settlementStatus = 'AWAITING_SETTLEMENT';
      trade.settlementError = 'Window ended; no take-profit or stop-loss exit is active. Waiting for confirmed original-market resolution.';
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
    const realizedPnl = this.cash + openCost - STARTING_CASH;
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
        pollIntervalMs: POLL_INTERVAL_MS,
        orderType: 'TAKER',
        sharesPerTrade: ENTRY_SHARES,
        signalScanLeadMs: SIGNAL_SCAN_LEAD_MS,
        signalCompareLeadMs: SIGNAL_COMPARE_LEAD_MS,
        takerFeeRate: TAKER_FEE_RATE,
        orderModel: 'Use the most recent closed BTC 1-minute candle. Three seconds before the 5-minute window opens, compare the live BTC price with that candle close: higher selects UP; equal or lower selects DOWN. At window open, submit one 500-share paper taker buy on that side.',
        fillModel: 'The taker entry is confirmed on the next 500 ms bot tick from fresh visible asks, sweeping asks from lowest to highest. Only available shares are booked at their actual weighted average price; the unfilled remainder is cancelled. Taker fees use the market fee schedule when available.',
        exitModel: 'There is no take-profit or stop-loss. Filled shares remain open through the window and settle only when the original Polymarket market is officially confirmed resolved.',
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
      priceGap: Number.isFinite(this.entrySignal?.signalPrice)
        && Number.isFinite(this.entrySignal?.referenceClose)
        ? this.entrySignal.signalPrice - this.entrySignal.referenceClose
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
        startingCash: STARTING_CASH, cash: this.cash, openCost, realizedPnl,
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
      entryOrders: this.entryOrders.slice(0, 100),
      openOrders,
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

module.exports = { ProbabilityBot, estimateTakerFee };
