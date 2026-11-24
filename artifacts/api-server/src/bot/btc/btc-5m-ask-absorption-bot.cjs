'use strict';

const {
  BtcDoubleRungBot,
  DEFAULT_CONFIG: BASE_CONFIG,
} = require('./double-rung-bot.cjs');
const { feeParameters, takerFeeAt } = require('./paper-trading.js');

const SIDES = Object.freeze(['UP', 'DOWN']);
const EPSILON = 1e-8;
const TRADE_FLOW_LOOKBACK_MS = 10_000;
const PIVOT_PRICE = 0.50;
const MAX_SHARES_PER_WINDOW = 500;
const ASK_BAND_MIN = 0.15;
const ASK_BAND_MAX = 0.85;
const ENTRY_BEST_ASK_MIN = 0.40;
const ENTRY_BEST_ASK_MAX = 0.60;
const FLIP_CONFIRMATION_TICKS = 2;
const MIN_ABSORBED_SHARES = 10;
const MIN_ABSORPTION_RATIO = 0.10;
const SIDE_DOMINANCE_RATIO = 1.25;

const CONFIG = Object.freeze({
  ...BASE_CONFIG,
  STRATEGY_VERSION: 'btc-5m-clob-ask-absorption-band040-060-flip-confirm2-cap500-v8',
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
    reason: 'Waiting for the next Polymarket CLOB tick.',
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
    this.marketTickSequence = 0;
    this.lastProcessedTickSequence = 0;
    this.lastConsumedTradeSequence = { UP: 0, DOWN: 0 };
    this.tradeTape = [];
    this.lastDecision = null;
    this.pendingFlipConfirmation = null;
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
    // The one-time reset for this strategy was already applied. Future code
    // deployments must restore the existing ledger, not clear it again.
  }

  restoreState(state) {
    super.restoreState(state);
    this.pendingFlipConfirmation = null;
    const currentStart = Math.floor(this.now() / this.config.WINDOW_MS) * this.config.WINDOW_MS;
    if (state.strategyVersion !== this.config.STRATEGY_VERSION
      || Number(state.windowStart) !== currentStart) return;

    const saved = state.askAbsorption || {};
    this.lastCheckIndex = Math.max(0, Number(saved.lastCheckIndex) || 0);
    this.lastCheckAt = Number.isFinite(Number(saved.lastCheckAt))
      ? Number(saved.lastCheckAt) : currentStart;
    this.marketTickSequence = 0;
    this.lastProcessedTickSequence = 0;
    this.lastConsumedTradeSequence = {
      UP: Math.max(0, Number(saved.lastConsumedTradeSequence?.UP) || 0),
      DOWN: Math.max(0, Number(saved.lastConsumedTradeSequence?.DOWN) || 0),
    };
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
        lastConsumedTradeSequence: this.lastConsumedTradeSequence,
        lastDecision: this.lastDecision,
        sides: this.absorptionSides,
      },
    };
  }

  async resetWindow(start) {
    this.lastCheckIndex = 0;
    this.lastCheckAt = start;
    this.marketTickSequence = 0;
    this.lastProcessedTickSequence = 0;
    this.lastConsumedTradeSequence = { UP: 0, DOWN: 0 };
    this.tradeTape = [];
    this.pendingFlipConfirmation = null;
    this.lastDecision = {
      status: 'WAITING',
      side: null,
      at: start,
      reason: 'Waiting for fresh Polymarket CLOB ticks.',
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

    if (this.market && ['book', 'price_change', 'best_bid_ask', 'last_trade_price'].includes(type)) {
      this.marketTickSequence += 1;
    }
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
        this.tradeTape.push({
          side,
          price,
          shares,
          at,
          tickSequence: this.marketTickSequence,
        });
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
    sideState.stopped = false; // A later qualifying CLOB tick may re-enter this side.
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

  hasExecutableBidBook(side, now = this.now()) {
    if (!this.quoteIsFresh(side, now) || !this.bookIsFresh(side, now)) return false;
    const quoteBid = Number(this.quotes[side]?.bestBid);
    const tokenId = String(this.market?.tokens?.[side] || '');
    const bestBookBid = this.books.get(tokenId)?.bids?.[0]?.price;
    return Number.isFinite(quoteBid) && Number.isFinite(Number(bestBookBid))
      && Math.abs(Number(bestBookBid) - quoteBid) < EPSILON;
  }

  sweepBids(side, requestedShares, now) {
    if (!this.hasExecutableBidBook(side, now)) return null;
    const tokenId = String(this.market.tokens[side]);
    const levels = this.books.get(tokenId)?.bids;
    if (!Array.isArray(levels) || !levels.length
      || Math.abs(levels[0].price - Number(this.quotes[side].bestBid)) >= EPSILON) return null;

    const fees = feeParameters(this.market);
    let remaining = requestedShares;
    let grossProceeds = 0;
    let feeTotal = 0;
    const fills = [];
    for (const level of levels) {
      if (remaining <= EPSILON) break;
      const sizeAvailable = Math.max(0, Number(level.availableSize) || 0);
      if (sizeAvailable <= EPSILON) continue;
      const shares = Math.min(remaining, sizeAvailable);
      const gross = shares * level.price;
      const fee = takerFeeAt(level.price, shares, fees);
      fills.push({ price: level.price, shares, grossProceeds: gross, fee });
      grossProceeds += gross;
      feeTotal += fee;
      remaining -= shares;
      level.availableSize -= shares;
    }
    const filledShares = requestedShares - remaining;
    if (filledShares <= EPSILON) return null;
    return {
      requestedShares,
      shares: filledShares,
      remainingShares: Math.max(0, remaining),
      grossProceeds,
      fees: feeTotal,
      netProceeds: grossProceeds - feeTotal,
      averagePrice: grossProceeds / filledShares,
      complete: remaining <= EPSILON,
      fills,
    };
  }

  recordMarketSell(side, requestedShares, now) {
    const openTrades = this.openTradesForSide(side);
    const availableShares = openTrades.reduce((sum, trade) => sum + Number(trade.shares || 0), 0);
    const request = Math.min(Number(requestedShares) || 0, availableShares);
    if (request <= EPSILON) return null;

    const fill = this.sweepBids(side, request, now);
    if (!fill) return null;

    let remainingToAllocate = fill.shares;
    let sidePnl = 0;
    let closedShares = 0;
    const tradeIds = [];
    const residualTrades = [];
    const exitBid = Number(this.quotes[side].bestBid);

    for (const trade of openTrades) {
      if (remainingToAllocate <= EPSILON) break;
      const originalShares = Number(trade.shares) || 0;
      if (originalShares <= EPSILON) continue;

      const closedTradeShares = Math.min(originalShares, remainingToAllocate);
      const closeRatio = closedTradeShares / originalShares;
      const fillRatio = closedTradeShares / fill.shares;
      const allocatedCost = Number(trade.totalCost) * closeRatio;
      const allocatedGrossCost = Number(trade.grossCost) * closeRatio;
      const allocatedEntryFees = Number(trade.fees) * closeRatio;
      const allocatedGrossProceeds = fill.grossProceeds * fillRatio;
      const allocatedExitFees = fill.fees * fillRatio;
      const allocatedNetProceeds = allocatedGrossProceeds - allocatedExitFees;

      if (closedTradeShares + EPSILON < originalShares) {
        const remainderRatio = 1 - closeRatio;
        residualTrades.push({
          ...trade,
          id: `misprice-trade-${++this.tradeSequence}`,
          parentTradeId: trade.id,
          shares: round(originalShares - closedTradeShares, 8),
          requestedShares: round(originalShares - closedTradeShares, 8),
          totalCost: round(Number(trade.totalCost) - allocatedCost, 8),
          grossCost: round(Number(trade.grossCost) - allocatedGrossCost, 8),
          fees: round(Number(trade.fees) - allocatedEntryFees, 8),
          fills: (trade.fills || []).map(item => ({
            ...item,
            shares: round(Number(item.shares) * remainderRatio, 8),
            cost: round(Number(item.cost) * remainderRatio, 8),
            fee: round(Number(item.fee) * remainderRatio, 8),
          })),
          status: 'OPEN',
          settlementStatus: 'OPEN',
          settlementSource: null,
          exitReason: null,
          exitPrice: null,
          exitTriggerBid: null,
          exitFees: 0,
          proceeds: null,
          realizedPnl: null,
          outcome: null,
          markPrice: null,
          markValue: null,
          unrealizedPnl: null,
          markFresh: false,
          markAt: null,
          settledAt: null,
          closedAt: null,
        });
        trade.shares = round(closedTradeShares, 8);
        trade.totalCost = round(allocatedCost, 8);
        trade.grossCost = round(allocatedGrossCost, 8);
        trade.fees = round(allocatedEntryFees, 8);
        trade.fills = (trade.fills || []).map(item => ({
          ...item,
          shares: round(Number(item.shares) * closeRatio, 8),
          cost: round(Number(item.cost) * closeRatio, 8),
          fee: round(Number(item.fee) * closeRatio, 8),
        }));
      }

      trade.status = 'SETTLED';
      trade.settlementStatus = 'SETTLED';
      trade.settlementSource = 'INTRAWINDOW_OPPOSITE_SIGNAL';
      trade.exitReason = 'OPPOSITE_SIGNAL';
      trade.exitPrice = round(fill.averagePrice, 8);
      trade.exitTriggerBid = exitBid;
      trade.exitFees = round(allocatedExitFees, 8);
      trade.proceeds = round(allocatedNetProceeds, 8);
      trade.realizedPnl = round(allocatedNetProceeds - allocatedCost, 8);
      trade.outcome = trade.realizedPnl >= 0 ? 'WIN' : 'LOSS';
      trade.settledAt = now;
      trade.closedAt = now;

      sidePnl += trade.realizedPnl;
      closedShares += closedTradeShares;
      remainingToAllocate -= closedTradeShares;
      tradeIds.push(trade.id);
    }

    this.trades.push(...residualTrades);
    this.cash = round(this.cash + fill.netProceeds, 8);
    this.realizedPnl = round(this.realizedPnl + sidePnl, 8);
    this.sideStates[side].stopped = false;
    this.sideStates[side].stopReason = 'OPPOSITE_SIGNAL';
    this.sideStates[side].stoppedAt = now;
    this.log(
      'MARKET_SELL_FLIP',
      `${side} opposite-signal sell filled ${round(closedShares, 4)} of ${round(request, 4)} shares at an average $${fill.averagePrice.toFixed(4)} bid; net proceeds after $${fill.fees.toFixed(4)} taker fees were $${fill.netProceeds.toFixed(4)}.`,
      {
        side,
        requestedShares: request,
        filledShares: round(closedShares, 8),
        remainingShares: round(Math.max(0, request - closedShares), 8),
        averagePrice: round(fill.averagePrice, 8),
        grossProceeds: round(fill.grossProceeds, 8),
        exitFees: round(fill.fees, 8),
        netProceeds: round(fill.netProceeds, 8),
        realizedPnl: round(sidePnl, 8),
        tradeIds,
      },
    );
    this.schedulePersist(true);
    return {
      shares: round(closedShares, 8),
      requestedShares: round(request, 8),
      averagePrice: round(fill.averagePrice, 8),
      fees: round(fill.fees, 8),
      netProceeds: round(fill.netProceeds, 8),
      complete: fill.complete,
    };
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

  sharesBoughtThisWindow() {
    return this.trades
      .filter(trade => Number(trade.windowStart) === this.windowStart
        && String(trade.marketId) === String(this.market?.id))
      .reduce((sum, trade) => sum + Math.max(0, Number(trade.shares) || 0), 0);
  }

  evaluateAbsorption(now, intervalIndex) {
    const intervalTrades = this.tradeTape.filter(trade =>
      trade.tickSequence > this.lastConsumedTradeSequence[trade.side]
      && trade.at >= now - TRADE_FLOW_LOOKBACK_MS
      && trade.at <= now);
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
      const entryPriceEligible = Number.isFinite(currentAsk)
        && currentAsk >= ENTRY_BEST_ASK_MIN - EPSILON
        && currentAsk <= ENTRY_BEST_ASK_MAX + EPSILON;
      const priceConfirmed = Number.isFinite(currentAsk)
        && (!Number.isFinite(previousAsk) || currentAsk >= previousAsk - EPSILON);
      const qualifies = bothBooksReady
        && buyTradeShares >= MIN_ABSORBED_SHARES
        && absorptionRatio >= MIN_ABSORPTION_RATIO
        && entryPriceEligible
        && priceConfirmed;
      const reason = !bothBooksReady
        ? 'Waiting for fresh, executable UP and DOWN books.'
        : buyTradeShares < MIN_ABSORBED_SHARES
          ? `Only ${round(buyTradeShares, 2)} buy shares traded in the rolling 10-second window; ${MIN_ABSORBED_SHARES} are required.`
          : absorptionRatio < MIN_ABSORPTION_RATIO
            ? `Absorption was ${(absorptionRatio * 100).toFixed(1)}% of visible ask depth; ${(MIN_ABSORPTION_RATIO * 100).toFixed(0)}% is required.`
            : !entryPriceEligible
              ? `Best ask $${Number.isFinite(currentAsk) ? currentAsk.toFixed(2) : '—'} is outside the $${ENTRY_BEST_ASK_MIN.toFixed(2)}–$${ENTRY_BEST_ASK_MAX.toFixed(2)} entry band.`
              : !priceConfirmed
                ? 'The best ask has not held or risen from the previous check.'
                : 'Ask-side buy trades met the absorption, entry-price, and ask-momentum checks.';
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
        entryPriceEligible,
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
    let reason = 'Neither side met the ask-absorption and ask-momentum checks.';
    if (candidates.length === 1) {
      [selected] = candidates;
       reason = `${selected.side} had confirmed buy-side ask absorption.`;
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
      const oppositeSide = selected.side === 'UP' ? 'DOWN' : 'UP';
      const oppositeShares = this.openTradesForSide(oppositeSide)
        .reduce((sum, openTrade) => sum + Number(openTrade.shares || 0), 0);
      const previousFlip = this.pendingFlipConfirmation;
      const flipConfirmed = oppositeShares <= EPSILON || (
        previousFlip?.side === selected.side
        && Number(previousFlip.windowStart) === Number(this.windowStart)
        && Number(previousFlip.tickSequence) < Number(this.marketTickSequence)
      );

      if (oppositeShares > EPSILON && !flipConfirmed) {
        this.pendingFlipConfirmation = {
          side: selected.side,
          windowStart: this.windowStart,
          tickSequence: this.marketTickSequence,
        };
        this.lastDecision.status = 'FLIP_CONFIRMATION_PENDING';
        this.lastDecision.flipConfirmation = {
          side: selected.side,
          observedTicks: 1,
          requiredTicks: FLIP_CONFIRMATION_TICKS,
        };
        this.lastDecision.reason += ` Flip needs the same qualifying signal on ${FLIP_CONFIRMATION_TICKS} consecutive CLOB ticks; this is tick 1 of ${FLIP_CONFIRMATION_TICKS}.`;
        this.log(
          'FLIP_CONFIRMATION_PENDING',
          `${selected.side} flip signal is waiting for one more consecutive qualifying CLOB tick.`,
          {
            side: selected.side,
            observedTicks: 1,
            requiredTicks: FLIP_CONFIRMATION_TICKS,
            bestAsk: selected.currentBestAsk,
          },
        );
      } else {
        this.pendingFlipConfirmation = null;
        this.lastConsumedTradeSequence[selected.side] = Math.max(
          this.lastConsumedTradeSequence[selected.side],
          ...intervalTrades
            .filter(item => item.side === selected.side)
            .map(item => item.tickSequence),
        );
        const sell = oppositeShares > EPSILON
          ? this.recordMarketSell(oppositeSide, oppositeShares, now)
          : null;
        const sharesSold = sell?.shares || 0;
        const windowSharesBefore = this.sharesBoughtThisWindow();
        const windowCapacity = Math.max(0, MAX_SHARES_PER_WINDOW - windowSharesBefore);
        const requestedShares = Math.min(this.config.BASE_ENTRY_SHARES + sharesSold, windowCapacity);
        this.lastDecision.oppositeSide = oppositeSide;
        this.lastDecision.oppositeSharesSold = round(sharesSold, 8);
        this.lastDecision.requestedShares = round(requestedShares, 8);
        this.lastDecision.windowSharesBefore = round(windowSharesBefore, 8);
        this.lastDecision.windowShareCapacity = round(windowCapacity, 8);
        if (oppositeShares > EPSILON) {
          this.lastDecision.flipConfirmation = {
            side: selected.side,
            observedTicks: FLIP_CONFIRMATION_TICKS,
            requiredTicks: FLIP_CONFIRMATION_TICKS,
            confirmed: true,
          };
        }
        if (requestedShares > EPSILON) {
          trade = this.recordMarketBuy(
            selected.side,
            requestedShares,
            'ASK_ABSORPTION_TICK',
            now,
            {
              checkIndex: intervalIndex,
              pivotPrice: PIVOT_PRICE,
              baseShares: this.config.BASE_ENTRY_SHARES,
              oppositeSideSold: oppositeSide,
              oppositeSharesSold: round(sharesSold, 8),
              requestedSharesFromFlip: requestedShares,
              absorptionShares: selected.buyTradeShares,
              absorptionRatio: selected.absorptionRatio,
              askDepthBefore: selected.previousAskDepth,
              askDepthAfter: selected.askDepth,
            },
          );
        }
        if (trade) {
          this.lastDecision.tradeId = trade.id;
          this.lastDecision.filledShares = trade.shares;
          this.lastDecision.entryPrice = trade.entryPrice;
          this.lastDecision.status = trade.shares + EPSILON >= this.config.BASE_ENTRY_SHARES
            ? 'BUY_FILLED' : 'BUY_PARTIAL';
          this.lastDecision.reason += ` Sold ${round(sharesSold, 4)} ${oppositeSide} shares; bought ${round(trade.shares, 4)} of ${round(requestedShares, 4)} ${selected.side} shares including the base.`;
        } else if (requestedShares <= EPSILON) {
          this.lastDecision.status = 'WINDOW_SHARE_CAP_REACHED';
          this.lastDecision.filledShares = 0;
          this.lastDecision.reason += ` Sold ${round(sharesSold, 4)} ${oppositeSide} shares; no buy was placed because the ${MAX_SHARES_PER_WINDOW}-share window cap is reached.`;
          this.log(
            'WINDOW_SHARE_CAP_REACHED',
            `No new buy was placed; this window already reached ${MAX_SHARES_PER_WINDOW} cumulative shares.`,
            {
              side: selected.side,
              sharesBoughtThisWindow: round(windowSharesBefore, 8),
              maxSharesPerWindow: MAX_SHARES_PER_WINDOW,
            },
          );
        } else {
          this.lastDecision.status = 'BUY_SKIPPED';
          this.lastDecision.reason += ' The visible asks or remaining cash could not fill an order.';
        }
      }
    } else {
      this.pendingFlipConfirmation = null;
    }

    this.lastCheckAt = now;
    this.tradeTape = this.tradeTape.filter(trade => trade.at > now - TRADE_FLOW_LOOKBACK_MS);
    if (trade) {
      this.log('ASK_ABSORPTION_SIGNAL', this.lastDecision.reason, {
        checkIndex: intervalIndex,
        pivotPrice: PIVOT_PRICE,
        selectedSide: selected?.side || null,
        sides: interval,
        tradeId: trade.id,
      });
    }
    return Boolean(trade || selected);
  }

  evaluate(now = this.now()) {
    if (!this.market || this.windowStart == null || !this.storageHealthy
      || now >= this.windowEnd) return false;

    let changed = this.processExits(now);
    this.seedBookBaselines(now);

    if (this.marketTickSequence > this.lastProcessedTickSequence) {
      this.lastProcessedTickSequence = this.marketTickSequence;
      this.lastCheckIndex += 1;
      changed = this.evaluateAbsorption(now, this.lastCheckIndex) || changed;
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
    state.strategy = {
      version: this.config.STRATEGY_VERSION,
      timeframe: '5m',
      symbol: 'BTC 5-minute Up or Down',
      executionMode: 'PAPER ONLY',
      checkMode: 'EVERY_CLOB_TICK',
      tradeFlowLookbackMs: TRADE_FLOW_LOOKBACK_MS,
      pivotPrice: PIVOT_PRICE,
      entryBestAskBand: { min: ENTRY_BEST_ASK_MIN, max: ENTRY_BEST_ASK_MAX },
      flipConfirmationTicks: FLIP_CONFIRMATION_TICKS,
      askBand: { min: ASK_BAND_MIN, max: ASK_BAND_MAX },
      sharesPerTick: this.config.BASE_ENTRY_SHARES,
      maxSharesPerWindow: MAX_SHARES_PER_WINDOW,
      entryOrderType: 'TAKER MARKET BUY (PAPER SIMULATION)',
      entryPolicy: `Only enter when the signalled side's best ask is between $${ENTRY_BEST_ASK_MIN.toFixed(2)} and $${ENTRY_BEST_ASK_MAX.toFixed(2)}, inclusive. A flip requires the opposite signal to qualify on ${FLIP_CONFIRMATION_TICKS} consecutive CLOB ticks; the new buy requests ${this.config.BASE_ENTRY_SHARES} base shares plus the shares actually sold.`,
      absorptionRule: `On every CLOB tick, count fresh, not-yet-used Polymarket BUY-side trade prints from the rolling last 10 seconds and visible ask depth from $${ASK_BAND_MIN.toFixed(2)} to $${ASK_BAND_MAX.toFixed(2)}; each print contributes to at most one buy. Require at least ${MIN_ABSORBED_SHARES} traded shares, at least ${(MIN_ABSORPTION_RATIO * 100).toFixed(0)}% of starting visible ask depth, a best ask in the $${ENTRY_BEST_ASK_MIN.toFixed(2)}–$${ENTRY_BEST_ASK_MAX.toFixed(2)} entry band, and an ask that holds or rises from the previous check. The $${PIVOT_PRICE.toFixed(2)} pivot remains informational only. If both sides qualify, the stronger ratio must be at least ${SIDE_DOMINANCE_RATIO.toFixed(2)}× the other.`,
      flipPolicy: `A qualifying opposite signal must appear on ${FLIP_CONFIRMATION_TICKS} consecutive distinct CLOB ticks before the bot sells the held side and buys the new side. The new buy requests ${this.config.BASE_ENTRY_SHARES} base shares plus the shares actually sold.`,
      windowShareCapPolicy: `No more than ${MAX_SHARES_PER_WINDOW} total filled buy shares per 5-minute market window. Selling shares does not replenish the cap.`,
      fillRule: 'Paper taker buys sweep fresh visible asks and flip sells sweep fresh visible bids; both allow partial fills and include modeled taker fees.',
      takeProfitBid: this.config.TAKE_PROFIT_BID,
      takeProfitPayoutPerShare: this.config.TAKE_PROFIT_PAYOUT_PER_SHARE,
      stopLossPrice: 0,
      stopLossRule: 'If a fresh book has no bid on a side with open shares, close all those shares at $0 per share.',
      reentryPolicy: `Every later qualifying CLOB tick can add another base-size buy while holding the same side; flips require ${FLIP_CONFIRMATION_TICKS} consecutive qualifying CLOB ticks.`,
      exitPolicy: 'At best bid $0.99, close all current shares on that side for $1 per share; with no bid in a fresh book, close at $0. Unclosed shares wait for official resolution at their original market end.',
      resolutionSource: 'Official resolution of each original Polymarket market.',
    };
    state.absorption = {
      checkMode: 'EVERY_CLOB_TICK',
      tradeFlowLookbackMs: TRADE_FLOW_LOOKBACK_MS,
      pivotPrice: PIVOT_PRICE,
      entryBestAskBand: { min: ENTRY_BEST_ASK_MIN, max: ENTRY_BEST_ASK_MAX },
      flipConfirmationTicks: FLIP_CONFIRMATION_TICKS,
      pendingFlipConfirmation: this.pendingFlipConfirmation
        ? { side: this.pendingFlipConfirmation.side, observedTicks: 1, requiredTicks: FLIP_CONFIRMATION_TICKS }
        : null,
      maxSharesPerWindow: MAX_SHARES_PER_WINDOW,
      askBand: { min: ASK_BAND_MIN, max: ASK_BAND_MAX },
      lastCheckAt: this.lastCheckAt,
      ticksChecked: this.lastCheckIndex,
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
  TRADE_FLOW_LOOKBACK_MS,
  PIVOT_PRICE,
  MAX_SHARES_PER_WINDOW,
  ASK_BAND_MIN,
  ASK_BAND_MAX,
  MIN_ABSORBED_SHARES,
  MIN_ABSORPTION_RATIO,
  SIDE_DOMINANCE_RATIO,
};
