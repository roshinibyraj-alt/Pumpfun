'use strict';

const DipBounceBot = require('./dip-bounce-bot');
const { feeRateFor, isFresh } = require('./freqai-open-entry-utils');

const OPEN_SCORE_GRACE_MS = 5000;
const SHARES_PER_WINDOW = 50;
const MIN_PROBABILITY = 0.51;
const MAX_BUY_PRICE = 1;
const SIDES = ['UP', 'DOWN'];

const STRATEGY = Object.freeze({
  id: 'pumpfun-btc-5m-freqai-open-score-paper-v1',
  name: 'BTC 5-minute FreqAI opening-score bot',
  version: '1',
  execution: 'Paper-only taker sweep. Freqtrade/FreqAI runs dry for Binance spot data and never places orders.',
  market: 'BTC Up/Down 5-minute market only.',
  features: 'Binance 1-minute OHLCV return, candle shape, relative volume, volatility and minute-in-window features.',
  target: 'For each 1-minute sample, classify whether the next BTC 5-minute window closes above or below its first-minute open.',
  prediction: 'At each window open, use the latest score from the just-closed 1-minute candle. Buy only if UP or DOWN probability is at least 51%.',
  entry: 'One 50-share entry per 5-minute window, with no fixed post-open delay. The opening score is captured once and does not change the entry side.',
  fill: 'Sweep fresh visible Polymarket asks up to $1.00; record depth-weighted fills and modeled taker fees. Partial fills are recorded.',
  exit: 'No flips, take-profit, or stop-loss. Hold filled shares to official market resolution.',
  sizing: 'Fixed 50-share request per window; no recovery sizing or carry-over.',
  cadence: 'At most one buy per window. If the opening score is unavailable or neither side reaches 51%, skip that window.',
});

function freshPredictionAtOpen(prediction, windowStart, now) {
  if (!prediction) return false;
  const candleStart = Number(prediction.candleStart);
  const candleCloseAt = Number(prediction.candleCloseAt);
  const writtenAt = Number(prediction.writtenAt);
  return Number.isFinite(candleStart)
    && Number.isFinite(candleCloseAt)
    && Number.isFinite(writtenAt)
    && candleStart < windowStart
    && candleCloseAt >= windowStart - 1000
    && candleCloseAt <= windowStart + 1000
    && writtenAt >= windowStart - 120_000
    && writtenAt <= windowStart + OPEN_SCORE_GRACE_MS
    && now >= windowStart
    && now <= windowStart + OPEN_SCORE_GRACE_MS;
}

class FreqAIOpenEntryBot extends DipBounceBot {
  constructor(options = {}) {
    super(options);
    this.strategyDefinition = STRATEGY;
    this.strategyId = STRATEGY.id;
    this.records = new Map([...this.records.entries()].filter(([key]) => key === 'BTC:5m'));
    this.freqaiWorker = options.freqaiWorker || null;
    this.binanceFeed = options.binanceFeed || null;
    this.modelStatus = 'WAITING_FOR_MODEL';
    this.lastDecision = null;
    this.openingDecisions = new Map();
    this.statusReason = 'Waiting for the latest 1-minute FreqAI score and BTC 5-minute market.';
  }

  restoreLedger(ledger) {
    super.restoreLedger(ledger);
    for (const position of this.positions) {
      if (position.status === 'OPEN' || position.status === 'PENDING_RESOLUTION') {
        position.realizedPnl = null;
      }
    }
    this.updateAccountMetrics(this.now(), true);
    this.scheduleLedgerSave();
  }

  setMarketDataHelpers({ binanceFeed, freqaiWorker } = {}) {
    if (binanceFeed) this.binanceFeed = binanceFeed;
    if (freqaiWorker) this.freqaiWorker = freqaiWorker;
  }

  openingDecision(record, now) {
    const market = record.market;
    if (!market) return { waiting: true, reason: 'No current BTC window.' };
    const windowStart = Number(market.start);
    const marketKey = `${market.id || market.slug}:${windowStart}`;
    if (this.openingDecisions.has(marketKey)) return this.openingDecisions.get(marketKey);
    if (now < windowStart) return { waiting: true, reason: 'Waiting for window open.' };
    if (now > windowStart + OPEN_SCORE_GRACE_MS) {
      const skipped = {
        side: null, source: 'FREQAI', windowStart, reason: 'The opening score was not available within five seconds; no entry this window.',
      };
      this.openingDecisions.set(marketKey, skipped);
      return skipped;
    }

    const modelState = this.freqaiWorker?.snapshot?.() || {};
    const prediction = modelState.lastPrediction;
    if (!freshPredictionAtOpen(prediction, windowStart, now)) {
      this.modelStatus = modelState.status || 'WAITING';
      return { waiting: true, reason: 'Waiting briefly for the latest score from the just-closed 1-minute candle.' };
    }

    const pUp = Number(prediction.pUp);
    const pDown = Number(prediction.pDown);
    if (!Number.isFinite(pUp) || !Number.isFinite(pDown)
      || pUp < 0 || pDown < 0 || pUp + pDown <= 0) {
      const skipped = {
        side: null, source: 'FREQAI', windowStart, reason: 'The opening model score was invalid; no entry this window.',
      };
      this.openingDecisions.set(marketKey, skipped);
      return skipped;
    }
    const total = pUp + pDown;
    const normalizedUp = pUp / total;
    const normalizedDown = pDown / total;
    const selectedSide = normalizedUp >= normalizedDown ? 'UP' : 'DOWN';
    const selectedProbability = selectedSide === 'UP' ? normalizedUp : normalizedDown;
    const decision = {
      side: selectedProbability >= MIN_PROBABILITY ? selectedSide : null,
      selectedSide,
      selectedProbability,
      pUp: normalizedUp,
      pDown: normalizedDown,
      source: 'FREQAI',
      windowStart,
      candleStart: Number(prediction.candleStart),
      model: prediction.model || 'LightGBMClassifier',
      reason: selectedProbability >= MIN_PROBABILITY
        ? `Opening score selected ${selectedSide} at ${(selectedProbability * 100).toFixed(1)}%.`
        : `Opening score was ${(selectedProbability * 100).toFixed(1)}%; below the 51% entry threshold.`,
    };
    this.openingDecisions.set(marketKey, decision);
    for (const oldKey of this.openingDecisions.keys()) {
      const oldStart = Number(oldKey.slice(oldKey.lastIndexOf(':') + 1));
      if (Number.isFinite(oldStart) && oldStart < windowStart - 6 * 60 * 60_000) {
        this.openingDecisions.delete(oldKey);
      }
    }
    this.modelStatus = 'READY';
    this.lastDecision = { ...decision, at: now };
    return decision;
  }

  processSide(record, side, quote, sequence) {
    const market = record.market;
    const now = this.now();
    if (!market || record.marketStatus !== 'OPEN'
      || now < Number(market.start) || now >= Number(market.end)) return;

    const state = record.sideStates[side];
    const currentId = String(market.id || market.slug);
    const windowStart = Number(market.start);
    const priorEntry = this.orders.find((order) => order.action === 'BUY_TAKER'
      && order.marketId === currentId && order.windowStart === windowStart);
    if (priorEntry) {
      state.orderStatus = 'WINDOW_ENTRY_CONSUMED';
      state.reason = `The ${priorEntry.side} entry is the only buy allowed this window; remaining shares go to resolution.`;
      return;
    }

    const decision = this.openingDecision(record, now);
    if (decision.waiting) {
      state.orderStatus = 'WAITING_FOR_OPENING_SCORE';
      state.reason = decision.reason;
      this.modelStatus = this.freqaiWorker?.snapshot?.().status || this.modelStatus;
      return;
    }
    if (!decision.side) {
      state.orderStatus = 'NO_ENTRY_SCORE';
      state.reason = decision.reason;
      return;
    }
    if (decision.side !== side) {
      state.orderStatus = 'OTHER_SIDE_SELECTED';
      state.reason = `${decision.side} was selected by the opening probability; the other side is not eligible this window.`;
      return;
    }
    if (!isFresh(quote, now) || !Array.isArray(quote.asks) || !quote.asks.length) {
      state.orderStatus = 'WAITING_FOR_LIQUIDITY';
      state.reason = 'Opening score selected this side; waiting for a fresh executable ask book.';
      return;
    }

    const feeRate = feeRateFor(market);
    if (feeRate == null) {
      state.orderStatus = 'BLOCKED_INVALID_FEE';
      state.reason = 'Market fee rate is invalid; no paper order was recorded.';
      return;
    }
    let remaining = SHARES_PER_WINDOW;
    let cost = 0;
    let fees = 0;
    const fills = [];
    for (const level of [...quote.asks].sort((a, b) => Number(a.price) - Number(b.price))) {
      const price = Number(level.price);
      const available = Number(level.size);
      if (!Number.isFinite(price) || price <= 0 || price > MAX_BUY_PRICE
        || !Number.isFinite(available) || available <= 0) continue;
      const shares = Math.min(remaining, available);
      const fee = shares * feeRate * price * (1 - price);
      fills.push({ price, shares, fee });
      cost += price * shares;
      fees += fee;
      remaining -= shares;
      if (remaining <= 1e-8) break;
    }
    const filledShares = SHARES_PER_WINDOW - remaining;
    if (filledShares <= 1e-8) {
      state.orderStatus = 'WAITING_FOR_EXECUTABLE_ASKS';
      state.reason = 'No visible asks are available at or below $1.00.';
      return;
    }
    const totalCost = cost + fees;
    if (this.availableCash() + 1e-8 < totalCost) {
      state.orderStatus = 'WAITING_FOR_PAPER_CASH';
      state.reason = `Paper cash is short of the $${totalCost.toFixed(2)} entry cost.`;
      return;
    }

    const marketId = currentId;
    const tokenId = String(market.tokens?.[side] || '');
    const orderId = `freqai-entry-${++this.orderSequence}`;
    const order = {
      id: orderId,
      strategyId: this.strategyId,
      marketId,
      marketSlug: market.slug || null,
      marketTitle: market.title || null,
      asset: 'BTC',
      timeframe: '5m',
      windowStart,
      windowEnd: Number(market.end),
      side,
      action: 'BUY_TAKER',
      orderType: 'PAPER_MARKETABLE_SWEEP',
      status: remaining > 1e-8 ? 'PARTIALLY_FILLED' : 'FILLED',
      requestedShares: SHARES_PER_WINDOW,
      filledShares,
      unfilledShares: remaining,
      averageFillPrice: cost / filledShares,
      limitPrice: MAX_BUY_PRICE,
      fees,
      fills,
      placedAt: now,
      filledAt: now,
      placedSequence: sequence,
      signalSource: 'FREQAI',
      modelProbabilityUp: decision.pUp,
      modelProbabilityDown: decision.pDown,
      modelCandleStart: decision.candleStart,
      model: decision.model,
      isRecoveryFlip: false,
      fillRule: 'Sweep fresh visible asks up to $1.00; unfilled remainder is cancelled.',
    };
    const bestBid = Number.isFinite(Number(quote.bestBid)) ? Number(quote.bestBid) : null;
    const position = {
      id: `freqai-position-${++this.positionSequence}`,
      orderId,
      marketId,
      tokenId,
      marketSlug: market.slug || null,
      marketTitle: market.title || null,
      asset: 'BTC',
      timeframe: '5m',
      side,
      windowStart,
      windowEnd: Number(market.end),
      entryAt: now,
      entryPrice: cost / filledShares,
      requestedShares: SHARES_PER_WINDOW,
      shares: filledShares,
      originalShares: filledShares,
      totalCost: cost,
      fees,
      estimatedMakerRebate: 0,
      realizedPnl: null,
      status: 'OPEN',
      markBid: bestBid,
      markUpdatedAt: quote.updatedAt,
      markStatus: 'LIVE',
      unrealizedPnl: bestBid == null ? null : bestBid * filledShares - totalCost - fees,
      signalSource: 'FREQAI',
      modelProbabilityUp: decision.pUp,
      modelProbabilityDown: decision.pDown,
      modelCandleStart: decision.candleStart,
      model: decision.model,
      isRecoveryFlip: false,
    };

    this.cash -= totalCost;
    this.orders.unshift(order);
    this.positions.unshift(position);
    record.triggeredSide = side;
    state.entryConsumed = true;
    state.orderId = orderId;
    state.orderStatus = order.status;
    state.requestedShares = SHARES_PER_WINDOW;
    state.filledShares = filledShares;
    state.limitPrice = MAX_BUY_PRICE;
    state.reason = `${decision.reason} Swept ${filledShares.toFixed(2)} of 50 shares at $${(cost / filledShares).toFixed(3)} average.`;
    const other = record.sideStates[side === 'UP' ? 'DOWN' : 'UP'];
    other.orderStatus = 'WINDOW_ENTRY_CONSUMED';
    other.reason = `${side} used this window's single entry; no flips or additional buys.`;
    this.cash = Math.max(0, this.cash);
    this.lastDecision = { ...decision, at: now, requestedShares: SHARES_PER_WINDOW };
    this.log(
      `Opening FreqAI score chose BTC ${side} at ${(decision.selectedProbability * 100).toFixed(1)}%; bought ${filledShares.toFixed(2)} / 50 shares at $${(cost / filledShares).toFixed(3)} average; fee $${fees.toFixed(3)}.`,
      { asset: 'BTC', timeframe: '5m', side, type: 'FREQAI_ENTRY', now },
    );
    this.updateAccountMetrics(now, true);
    this.scheduleLedgerSave();
  }

  checkTakeProfits() {}

  checkStopLosses() {}

  updateSizingAfterClose(position) {
    position.sizingApplied = true;
  }

  snapshot() {
    const state = super.snapshot();
    const worker = this.freqaiWorker?.snapshot?.() || {};
    const prediction = worker.lastPrediction || null;
    const currentMarket = state.markets?.find((market) => market.asset === 'BTC'
      && market.timeframe === '5m' && market.marketStatus === 'OPEN');
    const openDecision = currentMarket
      ? this.openingDecisions.get(`${currentMarket.id || currentMarket.slug}:${Number(currentMarket.start)}`)
      : null;
    state.statusReason = this.statusReason;
    state.strategy = { ...STRATEGY };
    state.scanner = {
      ...state.scanner,
      assets: ['BTC'],
      timeframes: ['5m'],
      totalMarkets: 1,
      marketData: 'BTC spot features from Binance/FreqAI; Polymarket CLOB WebSocket for paper execution, marks and resolution.',
    };
    state.sizingByAsset = {
      BTC: { baseShares: SHARES_PER_WINDOW, minimumProbability: MIN_PROBABILITY, oneEntryPerWindow: true },
    };
    state.freqai = {
      status: worker.status || this.modelStatus,
      lastError: worker.lastError || null,
      startedAt: worker.startedAt || null,
      prediction,
      latestPrediction: prediction,
      openingDecision: openDecision || null,
      model: 'Freqtrade FreqAI LightGBMClassifier',
      input: 'Binance 1-minute OHLCV only; no Polymarket order-book pressure features.',
      resolutionLabel: 'Direction of the next BTC 5-minute window at its official close, predicted from the preceding minute data.',
      warmupFallback: 'Disabled. The bot uses the latest model score from the just-closed 1-minute candle at window open.',
    };
    state.currentDecision = this.lastDecision;
    return state;
  }
}

FreqAIOpenEntryBot.STRATEGY = STRATEGY;
FreqAIOpenEntryBot._test = {
  STRATEGY, OPEN_SCORE_GRACE_MS, SHARES_PER_WINDOW, MIN_PROBABILITY,
  MAX_BUY_PRICE, freshPredictionAtOpen,
};
module.exports = FreqAIOpenEntryBot;
