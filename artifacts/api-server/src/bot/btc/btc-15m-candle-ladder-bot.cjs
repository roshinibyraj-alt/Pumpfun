'use strict';

const {
  BtcDoubleRungBot,
  DEFAULT_CONFIG: BASE_CONFIG,
} = require('./double-rung-bot.cjs');
const { BinanceMultiTimeframeFeed } = require('./binance-multitimeframe-feed.cjs');
const { analyze15mWindow } = require('./btc-15m-candle-model.cjs');

const RUNG_PRICES = Object.freeze([0.30, 0.25, 0.20, 0.15, 0.10, 0.05]);
const SHARES_PER_RUNG = 100;
const EPSILON = 1e-8;
const HISTORY_RESET_REQUEST_ID = 'pumpfun-btc-15m-candle-ladder-reset-20261121';

const CONFIG = Object.freeze({
  ...BASE_CONFIG,
  STRATEGY_VERSION: 'btc-15m-candle-score-limit-ladder-v1',
  WINDOW_MS: 15 * 60 * 1000,
  BASE_ENTRY_SHARES: 0,
  RUNG_PRICES,
  FIRST_RUNG_SHARES: SHARES_PER_RUNG,
  POLL_INTERVAL_MS: 500,
  RESOLUTION_POLL_MS: 5_000,
});

const MAX_LADDER_COST = RUNG_PRICES.reduce(
  (sum, price) => sum + price * SHARES_PER_RUNG,
  0,
);

function newOrder(price, side, windowStart, placedAt, initialAsk) {
  return {
    id: `btc-15m-order-${windowStart}-${side}-${Math.round(price * 100)}`,
    side,
    price,
    requestedShares: SHARES_PER_RUNG,
    filledShares: 0,
    status: 'RESTING',
    placedAt,
    expiresAt: windowStart + CONFIG.WINDOW_MS,
    lastObservedAsk: initialAsk == null || !Number.isFinite(Number(initialAsk))
      ? null : Number(initialAsk),
    fillAt: null,
    fillPrice: null,
    triggerAsk: null,
    tradeId: null,
  };
}

class Btc15mCandleLadderBot extends BtcDoubleRungBot {
  constructor(options = {}) {
    super({
      ...options,
      config: { ...CONFIG, ...(options.config || {}) },
    });
    this.candleFeed = options.candleFeed || new BinanceMultiTimeframeFeed({
      now: this.now,
      fetchImpl: options.fetchImpl,
    });
    this.modelResult = null;
    this.modelDecided = false;
    this.selectedSide = null;
    this.ladderOrders = [];
    this.lastCandleRefreshRequestedAt = 0;
    this.beforeLoadState = async () => {
      if (typeof this.stateStore?.resetHistoryOnce !== 'function') {
        throw new Error('The requested 15-minute paper-history reset requires a durable reset-capable store.');
      }
      const reset = await this.stateStore.resetHistoryOnce(
        HISTORY_RESET_REQUEST_ID,
        this.emptyHistoryState(),
      );
      if (reset) console.log('BTC 15-minute paper history reset completed.');
    };
  }

  async start() {
    await this.candleFeed.start();
    return super.start();
  }

  stop() {
    this.candleFeed.stop();
    super.stop();
  }

  restoreState(state) {
    super.restoreState(state);
    const currentStart = Math.floor(this.now() / this.config.WINDOW_MS) * this.config.WINDOW_MS;
    if (state.strategyVersion !== this.config.STRATEGY_VERSION
      || Number(state.windowStart) !== currentStart) return;
    this.modelResult = state.modelResult || null;
    this.modelDecided = Boolean(state.modelDecided);
    this.selectedSide = state.selectedSide === 'UP' || state.selectedSide === 'DOWN'
      ? state.selectedSide : null;
    this.ladderOrders = Array.isArray(state.ladderOrders)
      ? state.ladderOrders.map(order => ({ ...order })) : [];
  }

  persistentStateSnapshot() {
    return {
      ...super.persistentStateSnapshot(),
      modelResult: this.modelResult,
      modelDecided: this.modelDecided,
      selectedSide: this.selectedSide,
      ladderOrders: this.ladderOrders,
    };
  }

  async resetWindow(start) {
    this.cancelRestingOrders(this.now(), 'WINDOW_ENDED');
    this.modelResult = null;
    this.modelDecided = false;
    this.selectedSide = null;
    this.ladderOrders = [];
    const refreshPromise = this.candleFeed.lastUpdatedAt == null
      || this.now() - this.candleFeed.lastUpdatedAt > 5_000
      ? this.candleFeed.refresh()
      : Promise.resolve(true);
    await super.resetWindow(start);
    await refreshPromise;
    this.tryChooseSide(this.now());
    this.statusReason = this.market
      ? `BTC 15-minute market active; Polymarket WebSocket ${this.websocket.status.toLowerCase()}.`
      : 'Waiting for the current Polymarket BTC 15-minute market and order books.';
  }

  async loadMarket(start) {
    const loaded = await super.loadMarket(start);
    if (loaded) {
      this.statusReason = `BTC 15-minute market active; Polymarket WebSocket ${this.websocket.status.toLowerCase()}.`;
    }
    return loaded;
  }

  requestCandleRefresh(now) {
    if (now - this.lastCandleRefreshRequestedAt < 5_000) return;
    this.lastCandleRefreshRequestedAt = now;
    void this.candleFeed.refresh();
  }

  tryChooseSide(now) {
    if (this.modelDecided || this.windowStart == null || !this.market) return false;
    const feed = this.candleFeed.snapshot();
    const result = analyze15mWindow({
      candles: feed.candles,
      feedUpdatedAt: feed.lastUpdatedAt,
      windowStart: this.windowStart,
      now,
    });
    this.modelResult = result;
    if (result.status === 'WAITING_DATA') {
      this.requestCandleRefresh(now);
      return false;
    }

    this.modelDecided = true;
    if (result.status === 'SIGNAL' && result.side) {
      if (this.cash + EPSILON < MAX_LADDER_COST) {
        this.modelResult = {
          ...result,
          status: 'NO_TRADE_INSUFFICIENT_CASH',
          reason: `The model selected ${result.side}, but the paper account cannot cover the full $${MAX_LADDER_COST.toFixed(2)} ladder.`,
        };
        this.log(
          'MODEL_SIGNAL_SKIPPED',
          this.modelResult.reason,
          { modelSide: result.side, requiredCash: MAX_LADDER_COST, availableCash: this.cash },
        );
      } else {
        this.selectedSide = result.side;
        const initialAsk = this.quoteIsFresh(this.selectedSide, now)
          ? Number(this.quotes[this.selectedSide].bestAsk) : null;
        this.ladderOrders = RUNG_PRICES.map(price =>
          newOrder(price, this.selectedSide, this.windowStart, now, initialAsk));
        for (const rung of this.sideStates[this.selectedSide].rungs) {
          rung.status = 'RESTING';
          rung.requestedShares = SHARES_PER_RUNG;
          rung.triggeredAt = now;
          rung.tradeIds = [];
        }
        this.log(
          'MODEL_SIGNAL',
          `${result.side} selected for the 15-minute window with an evidence score of ${result.score > 0 ? '+' : ''}${result.score}; six 100-share paper limit orders are resting.`,
          {
            side: result.side,
            score: result.score,
            factors: result.factors,
            slot: result.slot,
            rungPrices: RUNG_PRICES,
            sharesPerRung: SHARES_PER_RUNG,
            maximumLadderCost: MAX_LADDER_COST,
          },
        );
      }
    } else {
      this.log('MODEL_NO_TRADE', result.reason, {
        score: result.score,
        threshold: result.threshold,
        factors: result.factors,
        slot: result.slot,
      });
    }
    this.schedulePersist(true);
    return true;
  }

  cancelRestingOrders(now, reason) {
    const resting = this.ladderOrders.filter(order => order.status === 'RESTING');
    if (!resting.length) return false;
    for (const order of resting) {
      order.status = 'CANCELLED';
      order.cancelledAt = now;
      order.cancelReason = reason;
      const rung = this.sideStates[order.side]?.rungs.find(
        item => Math.abs(Number(item.price) - order.price) < EPSILON,
      );
      if (rung?.status === 'RESTING') rung.status = 'CANCELLED';
    }
    this.log(
      'LIMIT_ORDERS_CANCELLED',
      `${resting.length} unfilled paper limit order${resting.length === 1 ? '' : 's'} cancelled at the 15-minute window end.`,
      { reason, orderIds: resting.map(order => order.id) },
    );
    return true;
  }

  recordLimitFill(order, ask, now) {
    const totalCost = order.price * order.requestedShares;
    if (this.cash + EPSILON < totalCost) {
      order.status = 'REJECTED_INSUFFICIENT_CASH';
      order.cancelledAt = now;
      order.cancelReason = 'INSUFFICIENT_CASH_AT_FILL';
      this.log(
        'LIMIT_ORDER_REJECTED',
        `${order.side} $${order.price.toFixed(2)} limit order could not fill because available paper cash was insufficient.`,
        { orderId: order.id, requiredCash: totalCost, availableCash: this.cash },
      );
      return false;
    }

    const trade = {
      id: `misprice-trade-${++this.tradeSequence}`,
      asset: 'BTC',
      side: order.side,
      marketId: String(this.market.id),
      marketSlug: this.market.slug,
      marketTitle: this.market.title || this.market.slug,
      tokenId: String(this.market.tokens[order.side]),
      windowStart: this.windowStart,
      windowEnd: this.windowEnd,
      shares: order.requestedShares,
      requestedShares: order.requestedShares,
      entryPrice: order.price,
      totalCost,
      grossCost: totalCost,
      fees: 0,
      exitFees: 0,
      fills: [{ price: order.price, shares: order.requestedShares, cost: totalCost, fee: 0 }],
      openedAt: now,
      entryOrderType: 'LIMIT',
      entryReason: 'MODEL_LADDER_LIMIT',
      rungPrice: order.price,
      orderId: order.id,
      strategyVersion: this.config.STRATEGY_VERSION,
      status: 'OPEN',
      settlementStatus: 'OPEN',
      settlementSource: null,
      markPrice: null,
      markValue: null,
      unrealizedPnl: null,
      markFresh: false,
      markAt: null,
      realizedPnl: null,
      outcome: null,
    };
    this.trades.push(trade);
    this.cash = Math.round((this.cash - totalCost + Number.EPSILON) * 1e8) / 1e8;
    order.status = 'FILLED';
    order.filledShares = order.requestedShares;
    order.fillAt = now;
    order.fillPrice = order.price;
    order.triggerAsk = ask;
    order.tradeId = trade.id;
    const rung = this.sideStates[order.side].rungs.find(
      item => Math.abs(Number(item.price) - order.price) < EPSILON,
    );
    if (rung) {
      rung.status = 'FILLED';
      rung.filledShares = order.requestedShares;
      rung.averageFillPrice = order.price;
      rung.triggerAsk = ask;
      rung.tradeIds = [trade.id];
    }
    this.log(
      'LIMIT_RUNG_FILLED',
      `${order.side} $${order.price.toFixed(2)} paper limit rung filled: ${order.requestedShares} shares recorded at the limit price.`,
      {
        orderId: order.id,
        tradeId: trade.id,
        side: order.side,
        limitPrice: order.price,
        observedAsk: ask,
        shares: order.requestedShares,
        totalCost,
      },
    );
    this.schedulePersist(true);
    return true;
  }

  processLimitOrders(now) {
    if (!this.selectedSide || !this.market || now >= this.windowEnd
      || !this.quoteIsFresh(this.selectedSide, now)) return false;
    const ask = Number(this.quotes[this.selectedSide]?.bestAsk);
    if (!(ask > 0 && ask < 1)) return false;
    let changed = false;
    for (const order of this.ladderOrders) {
      if (order.side !== this.selectedSide || order.status !== 'RESTING') continue;
      const previousAsk = order.lastObservedAsk == null
        ? NaN : Number(order.lastObservedAsk);
      const firstObservation = !Number.isFinite(previousAsk);
      const exactInitialTouch = order.placedAt === now
        && Math.abs(ask - order.price) < EPSILON;
      const crossedLimitDown = Number.isFinite(previousAsk)
        && previousAsk > order.price + EPSILON
        && ask <= order.price + EPSILON;
      order.lastObservedAsk = ask;
      if (!exactInitialTouch && !crossedLimitDown
        && !(firstObservation && Math.abs(ask - order.price) < EPSILON)) continue;
      changed = this.recordLimitFill(order, ask, now) || changed;
    }
    return changed;
  }

  evaluate(now = this.now()) {
    if (!this.market || this.windowStart == null || !this.storageHealthy
      || now >= this.windowEnd) return false;
    let changed = false;
    if (!this.modelDecided) changed = this.tryChooseSide(now) || changed;
    return this.processLimitOrders(now) || changed;
  }

  sidePositionSnapshot(side, now) {
    const trades = this.openTradesForSide(side);
    const shares = trades.reduce((sum, trade) => sum + (Number(trade.shares) || 0), 0);
    const totalCost = trades.reduce((sum, trade) => sum + (Number(trade.totalCost) || 0), 0);
    const marksFresh = trades.length > 0 && trades.every(trade =>
      trade.markFresh === true
      && Number.isFinite(Number(trade.markValue))
      && Number.isFinite(Number(trade.unrealizedPnl)));
    const rungs = this.ladderOrders.filter(order => order.side === side);
    return {
      side,
      selected: side === this.selectedSide,
      shares: Math.round(shares * 1e8) / 1e8,
      totalCost: Math.round(totalCost * 1e8) / 1e8,
      averageCost: shares > 0 ? totalCost / shares : null,
      markPrice: this.quoteIsFresh(side, now) ? this.quotes[side].bestBid : null,
      markValue: marksFresh
        ? trades.reduce((sum, trade) => sum + Number(trade.markValue), 0) : null,
      unrealizedPnl: marksFresh
        ? trades.reduce((sum, trade) => sum + Number(trade.unrealizedPnl), 0) : null,
      openTradeCount: trades.length,
      fillStatus: rungs.some(order => order.status === 'FILLED')
        ? 'POSITION_OPEN'
        : rungs.some(order => order.status === 'RESTING')
          ? 'LIMITS_RESTING' : 'NO_POSITION',
      rungs: rungs.map(order => ({ ...order })),
    };
  }

  snapshot() {
    const state = super.snapshot();
    state.strategy = {
      version: this.config.STRATEGY_VERSION,
      timeframe: '15m',
      symbol: 'BTC 15-minute Up or Down',
      executionMode: 'PAPER ONLY',
      entryOrderType: 'RESTING LIMIT (PAPER SIMULATION)',
      entryPolicy: 'One model-selected side per 15-minute window; no entry on the opposite side.',
      model: 'Closed Binance 15m, 1h, and 4h candles; 15m extension/rejection mean-reversion check; UTC hour slot shown as context.',
      rungPrices: RUNG_PRICES,
      sharesPerRung: SHARES_PER_RUNG,
      maxLadderCost: MAX_LADDER_COST,
      fillRule: 'A fresh Polymarket best ask must touch or cross down through a rung after it is placed. The full 100 shares are recorded at exactly the rung price; an ask already below the rung does not fill it immediately.',
      orderExpiry: 'Unfilled limits are cancelled at the 15-minute window end.',
      exitPolicy: 'Filled shares are held for the exact original Polymarket market resolution; no take-profit or stop-loss.',
      resolutionSource: 'Official resolution of the original Polymarket market.',
    };
    state.model = this.modelResult;
    state.modelDecided = this.modelDecided;
    state.selectedSide = this.selectedSide;
    state.orderLadder = this.ladderOrders.map(order => ({ ...order }));
    state.candleFeed = this.candleFeed.snapshot();
    state.window.timeframe = '15m';
    return state;
  }
}

module.exports = {
  Btc15mCandleLadderBot,
  CONFIG,
  MAX_LADDER_COST,
  RUNG_PRICES,
  SHARES_PER_RUNG,
  HISTORY_RESET_REQUEST_ID,
};
