'use strict';

const {
  BtcDoubleRungBot,
  DEFAULT_CONFIG: BASE_CONFIG,
} = require('./double-rung-bot.cjs');

const SIDES = Object.freeze(['UP', 'DOWN']);
const EPSILON = 1e-8;
const CHECK_INTERVAL_MS = 10_000;
const PIVOT_PRICE = 0.50;
const ASK_BAND_MIN = 0.45;
const ASK_BAND_MAX = 0.55;
const MIN_ABSORBED_SHARES = 10;
const MIN_ABSORPTION_RATIO = 0.10;
const SIDE_DOMINANCE_RATIO = 1.25;

const CONFIG = Object.freeze({
  ...BASE_CONFIG,
  STRATEGY_VERSION: 'btc-5m-clob-ask-absorption-10s-tp099-sl000-v1',
  WINDOW_MS: 5 * 60 * 1000,
  BASE_ENTRY_SHARES: 10,
  RUNG_PRICES: Object.freeze([]),
  FIRST_RUNG_SHARES: 10,
  TAKE_PROFIT_BID: 0.99,
  TAKE_PROFIT_PAYOUT_PER_SHARE: 1,
  MAX_QUOTE_AGE_MS: 2_000,
  MAX_BOOK_AGE_MS: 2_000,
  POLL_INTERVAL_MS: 500,
  RESOLUTION_POLL_MS: 5_000,
});

function round(value, digits = 6) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function parseTimestamp(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return numeric < 1_000_000_000_000 ? numeric * 1_000 : numeric;
}

function sideForToken(market, tokenId) {
  if (String(tokenId) === String(market?.tokens?.UP || '')) return 'UP';
  if (String(tokenId) === String(market?.tokens?.DOWN || '')) return 'DOWN';
  return null;
}

function emptyAbsorptionSide(side) {
  return {
    side,
    askDepth: null,
    largestAskLevel: null,
    previousAskDepth: null,
    previousBestAsk: null,
    buyTradeShares: 0,
    depthReductionShares: 0,
    absorptionRatio: 0,
    priceConfirmed: false,
    qualifies: false,
    reason: 'Waiting for the next complete 10-second check.',
  };
}

class Btc5mAskAbsorptionBot extends BtcDoubleRungBot {
  constructor(options = {}) {
    super({
      ...options,
      config: { ...CONFIG, ...(options.config || {}) },
    });
    this.lastCheckIndex = 0;
    this.lastCheckAt = null;
    this.tradeTape = [];
    this.lastDecision = null;
    this.absorptionSides = {
      UP: emptyAbsorptionSide('UP'),
      DOWN: emptyAbsorptionSide('DOWN'),
    };
  }

  shouldApplyEnvironmentHistoryReset() {
    // Ignore any leftover reset variable from an earlier deployment. The
    // newly approved reset is performed once through beforeLoadState below.
    return false;
  }

  async beforeLoadState() {
    if (typeof this.stateStore?.resetHistoryOnce !== 'function') {
      throw new Error('The approved paper history reset requires the durable reset operation.');
    }
    await this.stateStore.resetHistoryOnce(
      'pumpfun-btc-5m-ask-absorption-reset-20261122',
      this.emptyHistoryState(),
    );
  }

  restoreState(state) {
    super.restoreState(state);
    const currentStart = Math.floor(this.now() / this.config.WINDOW_MS) * this.config.WINDOW_MS;
    if (state.strategyVersion !== this.config.STRATEGY_VERSION
      || Number(state.windowStart) !== currentStart) return;

    const saved = state.askAbsorption || {};
    this.lastCheckIndex = Math.max(0, Number(saved.lastCheckIndex) || 0);
    this.lastCheckAt = Number.isFinite(Number(saved.lastCheckAt))
      ? Number(saved.lastCheckAt) : currentStart;
    this.lastDecision = saved.lastDecision || null;
    this.absorptionSides = {
      UP: { ...emptyAbsorptionSide('UP'), ...(saved.sides?.UP || {}) },
      DOWN: { ...emptyAbsorptionSide('DOWN'), ...(saved.sides?.DOWN || {}) },
    };
    // Tape data since the last check is intentionally not restored. A restart
    // must not fabricate traded volume from an interval the process did not see.
    this.tradeTape = [];
  }

  persistentStateSnapshot() {
    return {
      ...super.persistentStateSnapshot(),
      askAbsorption: {
        lastCheckIndex: this.lastCheckIndex,
        lastCheckAt: this.lastCheckAt,
        lastDecision: this.lastDecision,
        sides: this.absorptionSides,
      },
    };
  }

  async resetWindow(start) {
    this.lastCheckIndex = 0;
    this.lastCheckAt = start;
    this.tradeTape = [];
    this.lastDecision = {
      status: 'WAITING',
      side: null,
      at: start,
      reason: 'Collecting the first 10 seconds of order-book and trade data.',
    };
    this.absorptionSides = {
      UP: emptyAbsorptionSide('UP'),
      DOWN: emptyAbsorptionSide('DOWN'),
    };
    await super.resetWindow(start);
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
    const type = event.event_type || event.eventType || event.type;

    if (type === 'last_trade_price' && this.market) {
      const side = sideForToken(
        this.market,
        payload.asset_id || payload.assetId,
      );
      const price = Number(payload.price);
      const shares = Number(payload.size);
      const at = parseTimestamp(payload.timestamp, this.now());
      if (side && String(payload.side || '').toUpperCase() === 'BUY'
        && Number.isFinite(price) && price >= ASK_BAND_MIN && price <= ASK_BAND_MAX
        && Number.isFinite(shares) && shares > 0
        && at >= this.windowStart && at < this.windowEnd) {
        this.tradeTape.push({ side, price, shares, at });
        if (this.tradeTape.length > 1_000) this.tradeTape.splice(0, this.tradeTape.length - 1_000);
      }
    }
    super.handleMarketMessage(event);
  }

  askDepthInBand(side) {
    const tokenId = String(this.market?.tokens?.[side] || '');
    const asks = this.books.get(tokenId)?.asks || [];
    const visible = asks.filter(level =>
      level.price >= ASK_BAND_MIN - EPSILON
      && level.price <= ASK_BAND_MAX + EPSILON);
    const depth = visible.reduce((sum, level) => sum + Math.max(0, Number(level.size) || 0), 0);
    const largest = visible.reduce((best, level) =>
      !best || level.size > best.size ? level : best, null);
    return {
      depth: round(depth, 4),
      largestAskLevel: largest
        ? { price: largest.price, shares: round(largest.size, 4) }
        : null,
    };
  }

  seedBookBaselines(now) {
    for (const side of SIDES) {
      const state = this.absorptionSides[side];
      if (state.previousAskDepth != null || !this.hasExecutableAskBook(side, now)) continue;
      const depth = this.askDepthInBand(side);
      state.previousAskDepth = depth.depth;
      state.previousBestAsk = Number(this.quotes[side].bestAsk);
    }
  }

  recordExit(side, payout, triggerBid, reason, now) {
    const trades = this.openTradesForSide(side);
    if (!trades.length) return false;

    let sideShares = 0;
    let sidePnl = 0;
    for (const trade of trades) {
      const proceeds = round(Number(trade.shares) * payout, 8);
      trade.status = 'SETTLED';
      trade.settlementStatus = 'SETTLED';
      trade.settlementSource = reason === 'TAKE_PROFIT'
        ? 'INTRAWINDOW_TAKE_PROFIT' : 'INTRAWINDOW_STOP_LOSS';
      trade.exitReason = reason;
      trade.exitPrice = payout;
      trade.exitTriggerBid = triggerBid;
      trade.proceeds = proceeds;
      trade.realizedPnl = round(proceeds - Number(trade.totalCost), 8);
      trade.outcome = trade.realizedPnl >= 0 ? 'WIN' : 'LOSS';
      trade.settledAt = now;
      trade.closedAt = now;
      this.cash = round(this.cash + proceeds, 8);
      this.realizedPnl = round(this.realizedPnl + trade.realizedPnl, 8);
      sideShares += Number(trade.shares) || 0;
      sidePnl += trade.realizedPnl;
    }

    const sideState = this.sideStates[side];
    sideState.stopped = false; // A later 10-second signal may re-enter this side.
    sideState.stopReason = reason;
    sideState.stoppedAt = now;
    this.log(
      reason === 'TAKE_PROFIT' ? 'SIDE_TAKE_PROFIT' : 'SIDE_STOP_LOSS',
      reason === 'TAKE_PROFIT'
        ? `${side} best bid reached $${Number(triggerBid).toFixed(3)}; all ${round(sideShares, 4)} shares paid at $1 each.`
        : `${side} had no fresh best bid; all ${round(sideShares, 4)} shares were closed at $0.`,
      {
        side,
        shares: round(sideShares, 8),
        triggerBid,
        payoutPerShare: payout,
        realizedPnl: round(sidePnl, 8),
        tradeIds: trades.map(trade => trade.id),
      },
    );
    this.schedulePersist(true);
    return true;
  }

  processExits(now) {
    if (!this.market || now >= this.windowEnd) return false;
    let changed = false;
    for (const side of SIDES) {
      if (!this.openTradesForSide(side).length || !this.quoteIsFresh(side, now)) continue;
      const bid = this.quotes[side].bestBid;
      if (Number.isFinite(Number(bid)) && Number(bid) >= this.config.TAKE_PROFIT_BID) {
        changed = this.recordExit(
          side,
          this.config.TAKE_PROFIT_PAYOUT_PER_SHARE,
          Number(bid),
          'TAKE_PROFIT',
          now,
        ) || changed;
      } else if ((bid == null || !Number.isFinite(Number(bid)) || Number(bid) <= 0)
        && this.bookIsFresh(side, now)
        && this.books.get(String(this.market.tokens[side]))?.bids?.length === 0) {
        changed = this.recordExit(side, 0, null, 'STOP_LOSS', now) || changed;
      }
    }
    return changed;
  }

  evaluateAbsorption(now, intervalIndex) {
    const startAt = this.lastCheckAt ?? this.windowStart;
    const intervalTrades = this.tradeTape.filter(trade =>
      trade.at > startAt && trade.at <= now);
    const bothBooksReady = SIDES.every(side =>
      this.hasExecutableAskBook(side, now) && this.bookIsFresh(side, now));

    const interval = {};
    for (const side of SIDES) {
      const state = this.absorptionSides[side];
      const { depth, largestAskLevel } = this.askDepthInBand(side);
      const quote = this.quotes[side];
      const previousDepth = state.previousAskDepth == null
        ? depth : Number(state.previousAskDepth);
      const previousAsk = Number(state.previousBestAsk);
      const buyTradeShares = intervalTrades
        .filter(trade => trade.side === side)
        .reduce((sum, trade) => sum + trade.shares, 0);
      const absorptionRatio = buyTradeShares / Math.max(previousDepth, MIN_ABSORBED_SHARES);
      const currentAsk = Number(quote.bestAsk);
      const priceConfirmed = Number.isFinite(currentAsk)
        && currentAsk >= PIVOT_PRICE - EPSILON
        && currentAsk <= ASK_BAND_MAX + EPSILON
        && (!Number.isFinite(previousAsk) || currentAsk >= previousAsk - EPSILON);
      const qualifies = bothBooksReady
        && buyTradeShares >= MIN_ABSORBED_SHARES
        && absorptionRatio >= MIN_ABSORPTION_RATIO
        && priceConfirmed;
      const reason = !bothBooksReady
        ? 'Waiting for fresh, executable UP and DOWN books.'
        : buyTradeShares < MIN_ABSORBED_SHARES
          ? `Only ${round(buyTradeShares, 2)} buy shares traded near the pivot; ${MIN_ABSORBED_SHARES} are required.`
          : absorptionRatio < MIN_ABSORPTION_RATIO
            ? `Absorption was ${(absorptionRatio * 100).toFixed(1)}% of visible ask depth; ${(MIN_ABSORPTION_RATIO * 100).toFixed(0)}% is required.`
            : !priceConfirmed
              ? 'The ask flow has not held or advanced above the $0.50 pivot.'
              : 'Ask-side buy trades met the absorption and price-confirmation checks.';
      interval[side] = {
        side,
        askDepth: depth,
        largestAskLevel,
        previousAskDepth: round(previousDepth, 4),
        previousBestAsk: Number.isFinite(previousAsk) ? previousAsk : null,
        currentBestAsk: Number.isFinite(currentAsk) ? currentAsk : null,
        buyTradeShares: round(buyTradeShares, 4),
        depthReductionShares: round(Math.max(0, previousDepth - depth), 4),
        absorptionRatio: round(absorptionRatio, 6),
        priceConfirmed,
        qualifies,
        reason,
      };
      this.absorptionSides[side] = {
        ...interval[side],
        previousAskDepth: depth,
        previousBestAsk: Number.isFinite(currentAsk) ? currentAsk : null,
      };
    }

    const candidates = Object.values(interval).filter(side => side.qualifies)
      .sort((left, right) => right.absorptionRatio - left.absorptionRatio);
    let selected = null;
    let reason = 'Neither side met the ask-absorption and pivot-price checks.';
    if (candidates.length === 1) {
      [selected] = candidates;
      reason = `${selected.side} had confirmed buy-side ask absorption near $0.50.`;
    } else if (candidates.length > 1) {
      const [strongest, next] = candidates;
      if (strongest.absorptionRatio >= next.absorptionRatio * SIDE_DOMINANCE_RATIO) {
        selected = strongest;
        reason = `${strongest.side} absorption was at least ${SIDE_DOMINANCE_RATIO.toFixed(2)}× stronger than ${next.side}.`;
      } else {
        reason = 'Both sides showed similar absorption; no clear side was selected.';
      }
    } else if (!bothBooksReady) {
      reason = 'No entry: both books must be fresh and executable at the check.';
    }

    this.lastDecision = {
      status: selected ? 'SIGNAL' : bothBooksReady ? 'NO_SIGNAL' : 'WAITING_FOR_BOOKS',
      side: selected?.side || null,
      at: now,
      checkIndex: intervalIndex,
      reason,
      sides: interval,
    };

    let trade = null;
    if (selected) {
      trade = this.recordMarketBuy(
        selected.side,
        this.config.BASE_ENTRY_SHARES,
        'ASK_ABSORPTION_10S',
        now,
        {
          checkIndex: intervalIndex,
          pivotPrice: PIVOT_PRICE,
          absorptionShares: selected.buyTradeShares,
          absorptionRatio: selected.absorptionRatio,
          askDepthBefore: selected.previousAskDepth,
          askDepthAfter: selected.askDepth,
        },
      );
      if (trade) {
        this.lastDecision.tradeId = trade.id;
        this.lastDecision.filledShares = trade.shares;
        this.lastDecision.entryPrice = trade.entryPrice;
        this.lastDecision.status = trade.shares + EPSILON >= this.config.BASE_ENTRY_SHARES
          ? 'BUY_FILLED' : 'BUY_PARTIAL';
        this.lastDecision.reason += ` Paper buy filled ${round(trade.shares, 4)} of ${this.config.BASE_ENTRY_SHARES} shares.`;
      } else {
        this.lastDecision.status = 'BUY_SKIPPED';
        this.lastDecision.reason += ' The visible asks or remaining cash could not fill an order.';
      }
    }

    this.lastCheckIndex = intervalIndex;
    this.lastCheckAt = now;
    this.tradeTape = this.tradeTape.filter(trade => trade.at > now - CHECK_INTERVAL_MS);
    this.log(
      selected ? 'ASK_ABSORPTION_SIGNAL' : 'ASK_ABSORPTION_CHECK',
      this.lastDecision.reason,
      {
        checkIndex: intervalIndex,
        pivotPrice: PIVOT_PRICE,
        selectedSide: selected?.side || null,
        sides: interval,
        tradeId: trade?.id || null,
      },
    );
    this.schedulePersist(true);
    return Boolean(trade);
  }

  evaluate(now = this.now()) {
    if (!this.market || this.windowStart == null || !this.storageHealthy
      || now >= this.windowEnd) return false;

    let changed = this.processExits(now);
    this.seedBookBaselines(now);

    const intervalIndex = Math.floor((now - this.windowStart) / CHECK_INTERVAL_MS);
    if (intervalIndex > this.lastCheckIndex) {
      changed = this.evaluateAbsorption(now, intervalIndex) || changed;
    }
    return changed;
  }

  sidePositionSnapshot(side, now) {
    const snapshot = super.sidePositionSnapshot(side, now);
    const openTrades = this.openTradesForSide(side);
    const absorption = this.absorptionSides[side];
    const stopReason = this.sideStates[side]?.stopReason;
    return {
      ...snapshot,
      fillStatus: openTrades.length
        ? 'POSITION_OPEN'
        : stopReason
          ? `REARMED_AFTER_${stopReason}`
          : this.lastDecision?.side === side
            ? this.lastDecision.status
            : 'WAITING_FOR_ABSORPTION',
      lastExitReason: stopReason || null,
      askDepth: absorption?.askDepth ?? null,
      largestAskLevel: absorption?.largestAskLevel ?? null,
      absorbedBuyShares: absorption?.buyTradeShares ?? 0,
      absorptionRatio: absorption?.absorptionRatio ?? 0,
      absorptionQualifies: Boolean(absorption?.qualifies),
    };
  }

  snapshot() {
    const state = super.snapshot();
    const now = this.now();
    const nextCheckAt = this.windowStart == null
      ? null : this.windowStart + (this.lastCheckIndex + 1) * CHECK_INTERVAL_MS;
    state.strategy = {
      version: this.config.STRATEGY_VERSION,
      timeframe: '5m',
      symbol: 'BTC 5-minute Up or Down',
      executionMode: 'PAPER ONLY',
      checkIntervalMs: CHECK_INTERVAL_MS,
      pivotPrice: PIVOT_PRICE,
      askBand: { min: ASK_BAND_MIN, max: ASK_BAND_MAX },
      sharesPerCheck: this.config.BASE_ENTRY_SHARES,
      entryOrderType: 'TAKER MARKET BUY (PAPER SIMULATION)',
      entryPolicy: 'At each completed 10-second check, buy 10 shares on the side with clearly stronger ask absorption around the $0.50 pivot.',
      absorptionRule: 'Count Polymarket BUY-side trade prints between $0.45 and $0.55; require at least 10 traded shares, at least 10% of starting visible ask depth, and a best ask that holds or rises at or above $0.50. If both sides qualify, the stronger ratio must be at least 1.25× the other.',
      fillRule: 'Paper taker buys sweep fresh visible asks, allow partial fills, and include modeled taker fees.',
      takeProfitBid: this.config.TAKE_PROFIT_BID,
      takeProfitPayoutPerShare: this.config.TAKE_PROFIT_PAYOUT_PER_SHARE,
      stopLossPrice: 0,
      stopLossRule: 'If a fresh book has no bid on a side with open shares, close all those shares at $0 per share.',
      reentryPolicy: 'A later qualifying 10-second check can buy that side again after a take-profit or stop-loss exit.',
      exitPolicy: 'At best bid $0.99, close all current shares on that side for $1 per share; with no bid in a fresh book, close at $0. Unclosed shares wait for official resolution at their original market end.',
      resolutionSource: 'Official resolution of each original Polymarket market.',
    };
    state.absorption = {
      checkIntervalMs: CHECK_INTERVAL_MS,
      pivotPrice: PIVOT_PRICE,
      askBand: { min: ASK_BAND_MIN, max: ASK_BAND_MAX },
      lastCheckAt: this.lastCheckAt,
      nextCheckAt,
      nextCheckInMs: nextCheckAt == null
        ? null : Math.max(0, nextCheckAt - now),
      lastDecision: this.lastDecision,
      sides: this.absorptionSides,
    };
    state.selectedSide = this.lastDecision?.side || null;
    state.orderLadder = [];
    state.model = null;
    state.window.timeframe = '5m';
    return state;
  }
}

module.exports = {
  Btc5mAskAbsorptionBot,
  CONFIG,
  CHECK_INTERVAL_MS,
  PIVOT_PRICE,
  ASK_BAND_MIN,
  ASK_BAND_MAX,
  MIN_ABSORBED_SHARES,
  MIN_ABSORPTION_RATIO,
  SIDE_DOMINANCE_RATIO,
};
