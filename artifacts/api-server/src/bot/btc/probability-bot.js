'use strict';

const { CRYPTO_TAKER_FEE_RATE, CRYPTO_MAKER_REBATE_RATE } = require('./config');
const marketData = require('./wick-market-data');
const { feed } = require('./chainlink-price-feed');
const { TAKE_PROFIT_BID, STOP_LOSS_BID, thresholdExit, recoverExpiredPositions } = require('./position-exits');
const {
  ENTRY_TRIGGER_SECONDS,
  ENTRY_TRIGGER_PRICE,
  STRATEGY_VERSION,
  LIMIT_ORDER_LADDER,
  quoteIsFresh,
  selectTriggeredSide,
  simulateLimitBuyFill,
} = require('./midpoint-limit-strategy');

const WINDOW_MS = 5 * 60 * 1000;
const STARTING_CASH = 10_000;
const POLL_MS = 500;
const TAKER_FEE_RATE = CRYPTO_TAKER_FEE_RATE;
const EQUITY_SNAPSHOT_INTERVAL_MS = 30_000;
const EXIT_QUOTE_MAX_AGE_MS = 5000;
const EXIT_START_SECONDS = 295;

function parseLevels(levels, direction) {
  return (Array.isArray(levels) ? levels : [])
    .map(level => ({ price: Number(level.price), size: Number(level.size) }))
    .filter(level => Number.isFinite(level.price) && level.price > 0 && level.price < 1
      && Number.isFinite(level.size) && level.size > 0)
    .sort((a, b) => direction === 'ask' ? a.price - b.price : b.price - a.price);
}

function estimateTakerFee(price, shares) {
  if (!Number.isFinite(price) || price < 0 || price > 1
    || !Number.isFinite(shares) || shares < 0) return 0;
  return TAKER_FEE_RATE * price * (1 - price) * shares;
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
    this.limitOrders = [];
    this.orderWindowStart = null;
    this.limitOrderSequence = 0;
    this.limitOrderTriggerSide = null;
    this.limitOrderTriggeredAt = null;
    this.orderBookLiquidity = { UP: null, DOWN: null };
    this.entrySideSelection = { status: 'WAITING_FOR_TRIGGER', selectedSide: null, prices: {} };
    this.windowResults = new Map();
    this.finalizedWindowStarts = new Set();
    this.accountSessionStartedAt = this.now();
    this.lastEquitySnapshotAt = null;
    this.equitySnapshotRequested = true;
    this.learningStatus = {
      enabled: Boolean(learningStore),
      mode: learningStore ? 'fixed-limit-strategy-logging-only' : 'disabled',
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
    const ts = Math.floor(now / POLL_MS) * POLL_MS;
    if (ts === this.lastSampledAt) return;
    this.lastSampledAt = ts;
    const sample = {
      ts, observedAt: now, windowStart: this.market.start, windowEnd: this.market.end,
      secondsSinceOpen: Math.max(0, (now - this.market.start) / 1000),
      secondsRemaining: Math.max(0, (this.market.end - now) / 1000),
      orderStrategy: STRATEGY_VERSION,
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

  beginMarketWindow(start = this.market?.start) {
    if (!Number.isFinite(start) || this.orderWindowStart === start) return;
    this.orderWindowStart = start;
    this.limitOrderTriggerSide = null;
    this.limitOrderTriggeredAt = null;
    this.orderBookLiquidity = { UP: null, DOWN: null };
    this.entrySideSelection = { status: 'WAITING_FOR_TRIGGER', selectedSide: null, prices: {} };
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
      return sum + order.remainingShares * order.limitPrice;
    }, 0);
  }

  recordLimitOrder(side, ladderItem, now, selection) {
    const { price: limitPrice, shares: requestedShares, slot } = ladderItem;
    const reserveRequired = requestedShares * limitPrice;
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
      makerFees: 0,
      rebateFeeEquivalent: 0,
      estimatedMakerRebate: 0,
      rebatePoolShareRate: CRYPTO_MAKER_REBATE_RATE,
      rebateStatus: 'PAPER_ESTIMATE_NOT_ACTUAL',
      executionRole: 'MAKER',
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
    const unfilledShares = Math.max(0, order.requestedShares - order.filledShares);
    const completesOnPartialFill = unfilledShares > 1e-8;
    order.cancelledRemainderShares += unfilledShares;
    order.remainingShares = 0;
    order.filledCost = totalFilledCost;
    order.fees = 0;
    order.makerFees = 0;
    order.rebateFeeEquivalent += fill.rebateFeeEquivalent;
    order.estimatedMakerRebate += fill.rebateFeeEquivalent * CRYPTO_MAKER_REBATE_RATE;
    order.averageFillPrice = order.filledShares > 0 ? totalFilledCost / order.filledShares : null;
    order.fillCount += 1;
    order.lastFillAt = now;
    order.status = 'FILLED';
    order.completionReason = completesOnPartialFill ? 'FIRST_PARTIAL_FILL_COMPLETES_ORDER' : 'FULL_QUANTITY_FILLED';
    order.reservedFunds = 0;

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
      fees: 0,
      makerFees: 0,
      rebateFeeEquivalent: fill.rebateFeeEquivalent,
      estimatedMakerRebate: fill.rebateFeeEquivalent * CRYPTO_MAKER_REBATE_RATE,
      rebatePoolShareRate: CRYPTO_MAKER_REBATE_RATE,
      rebateStatus: 'PAPER_ESTIMATE_NOT_ACTUAL',
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
      remainingShares: 0,
      cancelledRemainderShares: order.cancelledRemainderShares,
      averageFillPrice: fill.averagePrice,
      fillCost: fill.cost,
      fillFees: fill.fees,
      estimatedMakerRebate: fill.rebateFeeEquivalent * CRYPTO_MAKER_REBATE_RATE,
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
        availableAsks, order.limitPrice, order.remainingShares, TAKER_FEE_RATE,
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
      entryPrice: trade.entryPrice,
      side: trade.side,
      outcome,
      exitPrice,
      grossPayout: payout,
      exitFees,
      exitExecutionRole: 'TAKER_ESTIMATE',
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
        version: STRATEGY_VERSION,
        timeframe: '5m',
        pollIntervalMs: POLL_MS,
        orderType: 'LIMIT',
        makerFeeRate: 0,
        takerFeeRate: TAKER_FEE_RATE,
        makerRebatePoolShareRate: CRYPTO_MAKER_REBATE_RATE,
        rebateAccounting: 'Maker fees are zero. Filled crypto maker liquidity has an estimated rebate based on fee-equivalent × the 20% crypto pool share. Actual daily payout depends on the eligible market pool and competing maker liquidity; this paper estimate is not credited to cash or P&L.',
        entryTriggerSeconds: ENTRY_TRIGGER_SECONDS,
        entryTriggerMidpoint: ENTRY_TRIGGER_PRICE,
        limitOrderLadder: LIMIT_ORDER_LADDER.map(item => ({ ...item })),
        maxOrdersPerWindow: LIMIT_ORDER_LADDER.length,
        takeProfitBid: TAKE_PROFIT_BID,
        takeProfitPayoutPerShare: 1,
        stopLossBid: STOP_LOSS_BID,
        stopLossPayoutPerShare: 0,
        exitStartSeconds: EXIT_START_SECONDS,
        orderSchedule: LIMIT_ORDER_LADDER.map(item => ({ ...item })),
        orderModel: 'Starting 120 seconds after each window opens, monitor fresh UP/DOWN midpoints. The first side reaching $0.80 or higher is latched for that window and receives one 1,000-share limit buy at $0.40 and one 2,000-share limit buy at $0.60. Orders are not rearmed.',
        fillModel: 'Paper maker buys fill only when visible ask depth is exactly at the posted limit price. No price improvement or worse-price fills are simulated. Maker fees are zero. Any partial fill completes that rung and cancels its unfilled remainder; only shares actually filled are booked. Rebate is estimated for display and is not credited to paper cash or P&L. A live marketable limit can instead take liquidity.',
        exitModel: 'During the active window, a fresh own-side best bid >= $0.99 triggers take-profit and credits $1 per share. After 295 seconds, a fresh own-side best bid <= $0.01 triggers the stop-loss. These simulated bid-triggered exits use the taker-fee estimate. Missing or stale bids do not trigger a sale. Unsold positions at expiry wait for confirmed resolution of the original market.',
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

module.exports = { ProbabilityBot, estimateTakerFee };
