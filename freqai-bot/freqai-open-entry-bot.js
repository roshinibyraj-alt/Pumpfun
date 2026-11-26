'use strict';

const DipBounceBot = require('./dip-bounce-bot');
const config = require('./config');
const { feeRateFor, isFresh } = require('./freqai-open-entry-utils');
const { FreqAIRestingOrders, SHARES, THRESHOLD_PCT, active: restingActive } = require('./freqai-resting-orders');

const OPEN_SCORE_GRACE_MS = 5000;
const ENTRY_DELAY_MS = 45_000;
const SHARES_PER_WINDOW = 50;
const MIN_PROBABILITY = 0.51;
const MAX_BUY_PRICE = 1;
const SIDES = ['UP', 'DOWN'];
const SHADOW_THRESHOLDS = [THRESHOLD_PCT];

const STRATEGY = Object.freeze({
  id: 'pumpfun-btc-5m-freqai58-resting-minus10-flat100-v1',
  name: 'BTC 5-minute FreqAI 58% resting limits',
  version: 'resting-flat100-v1',
  execution: 'Paper-only resting maker orders; no live orders.',
  market: 'BTC Up/Down 5-minute market only.',
  features: 'Binance 1-minute OHLCV return, candle shape, relative volume, volatility and minute-in-window features.',
  target: 'For each completed 1-minute candle, classify the direction of the BTC 5-minute window containing its close.',
  prediction: 'Use fresh current-window FreqAI scores. The selected side must have probability strictly above 58%.',
  entry: 'After 45 seconds, confidence strictly above 58% places a 100-share resting buy at that side’s best ask minus $0.10, fixed until fill, expiry or an opposite >58% signal.',
  fill: 'Paper maker fills require fresh subsequent asks strictly below the fixed limit, backed by displayed depth. Partial fills remain held. Maker fee zero; no assumed rebate income.',
  exit: 'No flips, take-profit, or stop-loss. Hold filled shares to official market resolution.',
  sizing: 'Always 100 shares per new limit order; no progression after wins or losses.',
  cadence: 'An opposite fresh >58% signal cancels the unfilled remainder and places a fresh 100-share opposite limit. No repricing on same-side signals. All unfilled orders expire at window end.',
  shadow: 'Only the 58% paper strategy is active. Fully filled orders consume the window; no selling or flipping filled shares.',
});

function freshPredictionAtOpen(prediction, windowStart, now) {
  if (!prediction) return false;
  const candleStart = Number(prediction.candleStart);
  const candleCloseAt = Number(prediction.candleCloseAt);
  const writtenAt = Number(prediction.writtenAt);
  return Number.isFinite(candleStart)
    && Number.isFinite(candleCloseAt)
    && Number.isFinite(writtenAt)
    && Number(prediction.windowStart) === windowStart
    && candleStart < windowStart
    && candleCloseAt >= windowStart - 1000
    && candleCloseAt <= windowStart + 1000
    && writtenAt >= windowStart - 120_000
    && writtenAt <= windowStart + OPEN_SCORE_GRACE_MS
    && now >= windowStart
    && now <= windowStart + OPEN_SCORE_GRACE_MS;
}

function currentWindowPrediction(prediction, market, now) {
  if (!prediction || !market) return false;
  const start = Number(market.start);
  const end = Number(market.end);
  const closeAt = Number(prediction.candleCloseAt);
  const writtenAt = Number(prediction.writtenAt);
  return Number(prediction.windowStart) === start
    && Number.isFinite(closeAt)
    && Number.isFinite(writtenAt)
    && closeAt >= start - 1000
    && closeAt <= now + 1000
    && now - closeAt <= 70_000
    && writtenAt >= closeAt - 10_000
    && writtenAt <= now + 5000
    && now < end;
}

function normalizedScores(prediction) {
  const up = Number(prediction?.pUp);
  const down = Number(prediction?.pDown);
  if (!Number.isFinite(up) || !Number.isFinite(down) || up < 0 || down < 0 || up + down <= 0) return null;
  const total = up + down;
  const pUp = up / total;
  const pDown = down / total;
  const side = pUp >= pDown ? 'UP' : 'DOWN';
  return { pUp, pDown, side, probability: side === 'UP' ? pUp : pDown };
}

function emptyShadowTotals() {
  return Object.fromEntries(SHADOW_THRESHOLDS.map((thresholdPct) => [thresholdPct, {
    entries: 0, resolved: 0, wins: 0, losses: 0, fees: 0, realizedPnl: 0,
  }]));
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
    this.openingPredictionCandidates = new Map();
    this.shadowEntries = [];
    this.shadowTotals = emptyShadowTotals();
    this.shadowSequence = 0;
    this.shadowSizing = { version: 2, currentShares: SHARES, startedAt: this.now(), lastOutcome: null };
    this.shadowRestingOrders = [];
    this.shadowOrderSequence = 0;
    this.restingEngine = new FreqAIRestingOrders(this);
    this.shadowEquityCurve = [];
    this.statusReason = 'Waiting for the latest 1-minute FreqAI score and BTC 5-minute market.';
  }

  restoreLedger(ledger) {
    super.restoreLedger(ledger);
    const savedShadowEntries = ledger?.snapshot?.shadowEntries;
    const sizing = ledger?.snapshot?.shadowSizing;
    if (sizing && (sizing.version !== 2 || sizing.currentShares !== SHARES)) {
      throw new Error('Invalid saved flat 100-share sizing.');
    }
    this.shadowSizing = sizing ? { ...sizing } : { version: 2, currentShares: SHARES, startedAt: this.now(), lastOutcome: null };
    this.shadowRestingOrders = (ledger?.snapshot?.shadowRestingOrders || []).map(order => structuredClone(order));
    for (const order of this.shadowRestingOrders) {
      if (order.requestedShares !== SHARES || !(order.limitPrice > 0 && order.limitPrice < 1)
        || !Number.isFinite(order.remainingShares) || order.remainingShares < 0 || order.remainingShares > SHARES) {
        throw new Error('Invalid saved resting limit order.');
      }
    }
    this.shadowOrderSequence = Number(ledger?.snapshot?.shadowOrderSequence) || this.shadowRestingOrders.length;
    this.shadowEquityCurve = (ledger?.snapshot?.shadowEquityCurve || []).filter(
      p => Number.isFinite(p.at) && Number.isFinite(p.equity),
    ).map(p => ({ ...p }));
    this.shadowEntries = Array.isArray(savedShadowEntries)
      ? savedShadowEntries.filter((entry) => SHADOW_THRESHOLDS.includes(Number(entry.thresholdPct)))
        .map((entry) => ({ ...entry, fills: Array.isArray(entry.fills) ? entry.fills.map((fill) => ({ ...fill })) : [] }))
      : [];
    const savedShadowTotals = ledger?.snapshot?.shadowTotals;
    if (savedShadowTotals && typeof savedShadowTotals === 'object') {
      for (const thresholdPct of SHADOW_THRESHOLDS) {
        const saved = savedShadowTotals[thresholdPct] || {};
        this.shadowTotals[thresholdPct] = {
          entries: Math.max(0, Number(saved.entries) || 0),
          resolved: Math.max(0, Number(saved.resolved) || 0),
          wins: Math.max(0, Number(saved.wins) || 0),
          losses: Math.max(0, Number(saved.losses) || 0),
          fees: Number(saved.fees) || 0,
          realizedPnl: Number(saved.realizedPnl) || 0,
        };
      }
    } else {
      this.shadowTotals = emptyShadowTotals();
      for (const entry of this.shadowEntries) {
        const totals = this.shadowTotals[Number(entry.thresholdPct)];
        totals.entries += 1;
        totals.fees += Number(entry.fees) || 0;
        if (entry.status === 'RESOLVED_WIN' || entry.status === 'RESOLVED_LOSS') {
          totals.resolved += 1;
          totals.realizedPnl += Number(entry.realizedPnl) || 0;
          if (entry.status === 'RESOLVED_WIN') totals.wins += 1;
          else totals.losses += 1;
        }
      }
    }
    this.shadowSequence = this.shadowEntries.reduce((max, entry) => {
      const suffix = Number(String(entry.id || '').split('-').at(-1));
      return Number.isFinite(suffix) ? Math.max(max, suffix) : max;
    }, 0);
    for (const entry of this.shadowEntries) {
      if (entry.status === 'OPEN' && Number(entry.windowEnd) <= this.now()) {
        entry.status = 'PENDING_RESOLUTION';
        entry.pendingResolutionAt = this.now();
      }
      if (entry.status === 'OPEN') {
        entry.markBid = null;
        entry.unrealizedPnl = null;
      } else if (entry.status === 'PENDING_RESOLUTION') {
        entry.unrealizedPnl = null;
      }
    }
    for (const position of this.positions) {
      if (position.status === 'OPEN' || position.status === 'PENDING_RESOLUTION') {
        position.realizedPnl = null;
      }
    }
    this.updateAccountMetrics(this.now(), true);
    this.restingEngine.expire(this.now());
    this.scheduleLedgerSave();
  }

  exportLedger() {
    const ledger = super.exportLedger();
    ledger.snapshot.shadowEntries = this.shadowEntries.map((entry) => ({
      ...entry,
      fills: (entry.fills || []).map((fill) => ({ ...fill })),
    }));
    ledger.snapshot.shadowTotals = Object.fromEntries(
      Object.entries(this.shadowTotals).map(([threshold, totals]) => [threshold, { ...totals }]),
    );
    ledger.snapshot.shadowSizing = { ...this.shadowSizing };
    ledger.snapshot.shadowRestingOrders = this.shadowRestingOrders.map(order => structuredClone(order));
    ledger.snapshot.shadowOrderSequence = this.shadowOrderSequence;
    ledger.snapshot.shadowEquityCurve = this.shadowEquityCurve.map(p => ({ ...p }));
    return ledger;
  }

  setMarketDataHelpers({ binanceFeed, freqaiWorker } = {}) {
    if (binanceFeed) this.binanceFeed = binanceFeed;
    if (freqaiWorker) this.freqaiWorker = freqaiWorker;
  }

  async tick(now = this.now()) {
    this.restingEngine.expire(now);
    if (this.tickInFlight || !this.running) return;
    await super.tick(now);
    if (this.status === 'ERROR') return;
    const record = this.records.get('BTC:5m');
    if (!record?.market || record.marketStatus !== 'OPEN') return;
    for (const side of SIDES) {
      const quote = record.quotes[side];
      this.processShadowEntries(record, side, quote, quote?.sequence || this.marketUpdateSequence);
    }
  }

  openingDecision(record, now) {
    const market = record.market;
    if (!market) return { waiting: true, reason: 'No current BTC window.' };
    const windowStart = Number(market.start);
    const marketKey = `${market.id || market.slug}:${windowStart}`;
    if (this.openingDecisions.has(marketKey)) return this.openingDecisions.get(marketKey);
    if (now < windowStart) return { waiting: true, reason: 'Waiting for window open.' };

    const modelState = this.freqaiWorker?.snapshot?.() || {};
    const livePrediction = modelState.lastPrediction;
    if (!this.openingPredictionCandidates.has(marketKey)
      && freshPredictionAtOpen(livePrediction, windowStart, now)) {
      this.openingPredictionCandidates.set(marketKey, {
        pUp: Number(livePrediction.pUp),
        pDown: Number(livePrediction.pDown),
        candleStart: Number(livePrediction.candleStart),
        model: livePrediction.model || 'LightGBMClassifier',
      });
    }

    const delayRemainingMs = windowStart + ENTRY_DELAY_MS - now;
    if (delayRemainingMs > 0) {
      this.modelStatus = modelState.status || 'WAITING';
      const candidateReady = this.openingPredictionCandidates.has(marketKey);
      return {
        waiting: true,
        stage: 'ENTRY_DELAY',
        delayRemainingSeconds: Math.ceil(delayRemainingMs / 1000),
        reason: `Waiting for the 45-second entry delay; the opening score ${candidateReady ? 'is captured' : 'has not arrived yet'}.`,
      };
    }

    const prediction = this.openingPredictionCandidates.get(marketKey);
    if (!prediction) {
      const skipped = {
        side: null, source: 'FREQAI', windowStart,
        reason: 'The opening score was not available within five seconds; no entry this window.',
      };
      this.openingDecisions.set(marketKey, skipped);
      return skipped;
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
        this.openingPredictionCandidates.delete(oldKey);
      }
    }
    this.modelStatus = 'READY';
    this.lastDecision = { ...decision, at: now };
    return decision;
  }

  processSide(record, side, quote, sequence) {
    this.processShadowEntries(record, side, quote, sequence);
  }

  processShadowEntries(record, side, quote, sequence) {
    const now = this.now();
    const prediction = this.freqaiWorker?.snapshot?.()?.lastPrediction;
    const scores = currentWindowPrediction(prediction, record.market, now) ? normalizedScores(prediction) : null;
    this.restingEngine.process(record, scores, prediction, now);
  }

  archivedTakerShadowEntries(record, side, quote, sequence) {
    const market = record.market;
    const now = this.now();
    if (!market || record.marketStatus !== 'OPEN'
      || now < Number(market.start) + ENTRY_DELAY_MS || now >= Number(market.end)) return;

    const worker = this.freqaiWorker?.snapshot?.() || {};
    const prediction = worker.lastPrediction;
    if (!currentWindowPrediction(prediction, market, now)) return;
    const scores = normalizedScores(prediction);
    if (!scores || scores.side !== side) return;
    if (!isFresh(quote, now) || !Array.isArray(quote.asks) || !quote.asks.length) return;

    const marketId = String(market.id || market.slug);
    const windowStart = Number(market.start);
    const feeRate = feeRateFor(market);
    if (feeRate == null) return;

    for (const thresholdPct of SHADOW_THRESHOLDS) {
      if (scores.probability <= thresholdPct / 100) continue;
      const alreadyEntered = this.shadowEntries.some((entry) => entry.marketId === marketId
        && Number(entry.windowStart) === windowStart
        && Number(entry.thresholdPct) === thresholdPct);
      if (alreadyEntered) continue;

      const requestedShares = this.shadowSizing.currentShares;
      let remaining = requestedShares;
      let cost = 0;
      let fees = 0;
      const fills = [];
      for (const level of [...quote.asks].sort((a, b) => Number(a.price) - Number(b.price))) {
        const price = Number(level.price);
        const available = Number(level.size);
        if (!Number.isFinite(price) || price <= 0 || price > MAX_BUY_PRICE
          || !Number.isFinite(available) || available <= 0) continue;
        const filled = Math.min(remaining, available);
        const fee = filled * feeRate * price * (1 - price);
        fills.push({ price, shares: filled, fee });
        cost += price * filled;
        fees += fee;
        remaining -= filled;
        if (remaining <= 1e-8) break;
      }
      const filledShares = requestedShares - remaining;
      if (filledShares <= 1e-8) continue;

      const bestBid = Number.isFinite(Number(quote.bestBid)) ? Number(quote.bestBid) : null;
      const entry = {
        id: `shadow-${thresholdPct}-${++this.shadowSequence}`,
        thresholdPct,
        marketId,
        marketSlug: market.slug || null,
        marketTitle: market.title || null,
        tokenId: String(market.tokens?.[side] || ''),
        asset: 'BTC',
        timeframe: '5m',
        side,
        windowStart,
        windowEnd: Number(market.end),
        entryAt: now,
        entryPrice: cost / filledShares,
        requestedShares,
        shares: filledShares,
        originalShares: filledShares,
        totalCost: cost,
        fees,
        fills,
        modelProbabilityUp: scores.pUp,
        modelProbabilityDown: scores.pDown,
        selectedProbability: scores.probability,
        modelCandleStart: Number(prediction.candleStart),
        model: prediction.model || 'LightGBMClassifier',
        placedSequence: sequence,
        status: 'OPEN',
        markBid: bestBid,
        markUpdatedAt: quote.updatedAt,
        markStatus: bestBid == null ? 'WAITING_FOR_MARK' : 'LIVE',
        unrealizedPnl: bestBid == null ? null : bestBid * filledShares - cost - fees,
        realizedPnl: null,
        exitPrice: null,
        exitPayout: null,
        exitReason: null,
        fillRule: 'Independent shadow sweep of visible asks up to $1.00; no paper cash is reserved.',
      };
      this.shadowEntries.unshift(entry);
      const totals = this.shadowTotals[thresholdPct];
      totals.entries += 1;
      totals.fees += fees;
      this.log(
        `Shadow >${thresholdPct}% chose BTC ${side} at ${(scores.probability * 100).toFixed(1)}%; filled ${filledShares.toFixed(2)} / ${requestedShares} shares at $${entry.entryPrice.toFixed(3)} average.`,
        { asset: 'BTC', timeframe: '5m', side, type: `SHADOW_${thresholdPct}`, now },
      );
      this.scheduleLedgerSave();
    }
    while (this.shadowEntries.length > 10_000) {
      const oldestResolved = this.shadowEntries.findLastIndex((entry) =>
        entry.status === 'RESOLVED_WIN' || entry.status === 'RESOLVED_LOSS');
      if (oldestResolved < 0) break;
      this.shadowEntries.splice(oldestResolved, 1);
    }
  }

  processMainSide(record, side, quote, sequence) {
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
      state.orderStatus = decision.stage === 'ENTRY_DELAY'
        ? 'WAITING_FOR_45_SECOND_DELAY'
        : 'WAITING_FOR_OPENING_SCORE';
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

  expireMarket(record, now) {
    this.restingEngine.expire(now);
    super.expireMarket(record, now);
    const market = record.market;
    if (!market) return;
    const marketId = String(market.id || market.slug);
    for (const entry of this.shadowEntries) {
      if (entry.marketId !== marketId || entry.status !== 'OPEN') continue;
      entry.status = 'PENDING_RESOLUTION';
      entry.pendingResolutionAt = now;
      entry.markStatus = entry.markBid == null ? 'PENDING_RESOLUTION' : 'LAST_MARK_PENDING_RESOLUTION';
      entry.unrealizedPnl = null;
    }
    this.scheduleLedgerSave();
  }

  async checkResolutions(now) {
    await super.checkResolutions(now);
    const pending = new Map();
    for (const entry of this.shadowEntries) {
      if (entry.status === 'PENDING_RESOLUTION' && entry.marketId && !pending.has(entry.marketId)) {
        pending.set(entry.marketId, entry);
      }
    }
    await Promise.all([...pending.entries()].map(async ([marketId, sample]) => {
      if (this.resolutionInFlight.has(marketId)) return;
      const lastAttempt = this.resolutionAttempts.get(marketId) || 0;
      if (now - lastAttempt < config.DIP_BOUNCE_RESOLUTION_POLL_MS) return;
      this.resolutionAttempts.set(marketId, now);
      this.resolutionInFlight.add(marketId);
      try {
        const market = await this.marketData.getMarket(marketId);
        const winner = this.marketData.resolvedWinner(market);
        if (winner) this.settleMarket(marketId, winner, now);
      } catch (error) {
        sample.resolutionError = error?.message || 'Shadow resolution check failed.';
      } finally {
        this.resolutionInFlight.delete(marketId);
      }
    }));
  }

  settleMarket(marketId, winner, now) {
    super.settleMarket(marketId, winner, now);
    for (const entry of this.shadowEntries) {
      if (entry.marketId !== marketId || entry.status !== 'PENDING_RESOLUTION') continue;
      const won = entry.side === winner;
      const payout = won ? entry.shares : 0;
      entry.status = won ? 'RESOLVED_WIN' : 'RESOLVED_LOSS';
      entry.resolvedAt = now;
      entry.resolutionWinner = winner;
      entry.exitPrice = won ? 1 : 0;
      entry.exitPayout = won ? 1 : 0;
      entry.exitReason = 'OFFICIAL_RESOLUTION';
      entry.realizedPnl = payout - entry.totalCost - entry.fees;
      const totals = this.shadowTotals[Number(entry.thresholdPct)];
      totals.resolved += 1;
      totals.realizedPnl += entry.realizedPnl;
      if (won) totals.wins += 1;
      else totals.losses += 1;
      this.shadowSizing.currentShares = SHARES;
      this.shadowSizing.lastOutcome = entry.realizedPnl < 0 ? 'LOSS' : entry.realizedPnl > 0 ? 'WIN' : 'FLAT';
      this.shadowSizing.lastUpdatedAt = now;
      this.shadowSizing.lastEntryId = entry.id;
      entry.markStatus = 'CLOSED';
      entry.unrealizedPnl = null;
      this.log(
        `Shadow >${entry.thresholdPct}% ${entry.side} resolved ${won ? 'WIN' : 'LOSS'}; net P&L ${entry.realizedPnl >= 0 ? '+' : ''}$${entry.realizedPnl.toFixed(2)}.`,
        { asset: 'BTC', timeframe: '5m', side: entry.side, type: `SHADOW_${entry.thresholdPct}_RESOLUTION`, outcome: won ? 'good' : 'bad', now },
      );
    }
    this.scheduleLedgerSave();
  }

  updateSizingAfterClose(position) {
    position.sizingApplied = true;
  }

  shadowPerformance(now) {
    const grouped = SHADOW_THRESHOLDS.map((thresholdPct) => {
      const entries = this.shadowEntries.filter((entry) => Number(entry.thresholdPct) === thresholdPct);
      for (const entry of entries) {
        if (entry.status !== 'OPEN') continue;
        const record = [...this.records.values()].find((candidate) =>
          String(candidate.market?.id || candidate.market?.slug || '') === entry.marketId);
        const quote = record?.quotes?.[entry.side];
        if (quote?.bestBid != null && isFresh(quote, now)) {
          entry.markBid = Number(quote.bestBid);
          entry.markUpdatedAt = quote.updatedAt;
          entry.markStatus = 'LIVE';
          entry.unrealizedPnl = entry.markBid * entry.shares - entry.totalCost - entry.fees;
        } else {
          entry.markBid = null;
          entry.markUpdatedAt = quote?.updatedAt || null;
          entry.markStatus = 'STALE';
          entry.unrealizedPnl = null;
        }
      }
      const open = entries.filter((entry) => entry.status === 'OPEN');
      const pending = entries.filter((entry) => entry.status === 'PENDING_RESOLUTION');
      const totals = this.shadowTotals[thresholdPct];
      const realizedPnl = Number(totals.realizedPnl) || 0;
      const unmarkedOpen = open.some((entry) => entry.unrealizedPnl == null
        || !Number.isFinite(Number(entry.unrealizedPnl)));
      const openPnl = unmarkedOpen ? null
        : open.reduce((sum, entry) => sum + (Number(entry.unrealizedPnl) || 0), 0);
      const totalPnl = openPnl == null || pending.length ? null : realizedPnl + openPnl;
      return {
        thresholdPct,
        label: `>${thresholdPct}%`,
        entries: Number(totals.entries) || 0,
        resolved: Number(totals.resolved) || 0,
        openPositions: open.length,
        pendingResolution: pending.length,
        wins: Number(totals.wins) || 0,
        losses: Number(totals.losses) || 0,
        fees: Number(totals.fees) || 0,
        realizedPnl,
        openPnl,
        totalPnl,
        recentEntries: entries.slice(0, 12).map((entry) => ({ ...entry })),
      };
    });
    return grouped;
  }

  snapshot() {
    const state = super.snapshot();
    const worker = this.freqaiWorker?.snapshot?.() || {};
    const prediction = worker.lastPrediction || null;
    const shadowTiers = this.shadowPerformance(Number(state.now) || this.now());
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
      BTC: { baseShares: SHARES, currentShares: SHARES,
        minimumProbability: THRESHOLD_PCT / 100, probabilityComparison: 'strictly above', oneEntryPerWindow: true },
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
      resolutionLabel: 'Direction of the 5-minute window containing the completed minute candle close.',
      warmupFallback: 'Disabled. The 58% strategy requires a fresh current-window model score after the 45-second delay.',
    };
    state.shadowTiers = shadowTiers;
    state.shadowEntries = this.shadowEntries.map(entry => ({ ...entry }))
      .sort((a, b) => Number(b.entryAt) - Number(a.entryAt))
      .slice(0, 300);
    state.shadowSizing = { ...this.shadowSizing };
    state.shadowRestingOrders = this.shadowRestingOrders.map(order => ({
      ...order, depthBudget: undefined,
    })).slice(0, 300);
    state.restingOrderSummary = {
      active: this.shadowRestingOrders.filter(restingActive).length,
      reservedCash: this.restingEngine.reserved(),
      availableCash: this.restingEngine.available(),
    };
    const tier = shadowTiers[0];
    if (tier) {
      const unresolved = this.shadowEntries.filter(e => ['OPEN', 'PENDING_RESOLUTION'].includes(e.status));
      const pending = unresolved.filter(e => e.status === 'PENDING_RESOLUTION');
      const cost = unresolved.reduce((sum, e) => sum + e.totalCost + e.fees, 0);
      const cash = this.initialCapital + tier.realizedPnl - cost;
      // Unknown marks must never be presented as zero floating P&L.
      const marksKnown = !pending.length && tier.openPnl != null;
      const equity = marksKnown ? this.initialCapital + tier.realizedPnl + tier.openPnl : null;
      state.shadowAccount = {
        initialCapital: this.initialCapital, cash, equity,
        reservedCash: this.restingEngine.reserved(),
        availableCash: this.restingEngine.available(),
        realizedPnl: tier.realizedPnl, unrealizedPnl: marksKnown ? tier.openPnl : null,
        settledBalance: this.initialCapital + tier.realizedPnl,
        totalFees: tier.fees, settledPositions: tier.resolved, openPositions: tier.openPositions,
        winRate: tier.resolved ? 100 * tier.wins / tier.resolved : null,
      };
      if (equity != null && (!this.shadowEquityCurve.length
        || state.now - this.shadowEquityCurve.at(-1).at >= 10_000)) {
        this.shadowEquityCurve.push({ at: state.now, equity });
        this.scheduleLedgerSave();
      }
      state.shadowEquityCurve = this.shadowEquityCurve.slice(-3000).map(p => ({ ...p }));
      const settled = this.shadowEntries.filter(e => e.realizedPnl != null)
        .sort((a, b) => a.resolvedAt - b.resolvedAt);
      let historicalBalance = this.initialCapital + tier.realizedPnl
        - settled.reduce((sum, e) => sum + e.realizedPnl, 0);
      state.shadowSettledCurve = settled.map(e => {
        historicalBalance += e.realizedPnl;
        return { at: e.resolvedAt, equity: historicalBalance };
      });
    }
    state.currentDecision = this.lastDecision;
    return state;
  }
}

FreqAIOpenEntryBot.STRATEGY = STRATEGY;
FreqAIOpenEntryBot._test = {
  STRATEGY, OPEN_SCORE_GRACE_MS, SHARES_PER_WINDOW, MIN_PROBABILITY,
  SHADOW_THRESHOLDS, MAX_BUY_PRICE, freshPredictionAtOpen,
  currentWindowPrediction, normalizedScores,
};
module.exports = FreqAIOpenEntryBot;
