'use strict';
const PreviousBot = require('./freqai-open-entry-bot');
const { planTakerBuy } = require('./taker-fill');
const { currentWindowPrediction, normalizedScores } = PreviousBot._test;
const STRATEGY = Object.freeze({
  ...PreviousBot.STRATEGY,
  id: 'pumpfun-btc-5m-freqai58-taker-flat100-v1',
  name: 'BTC 5-minute FreqAI 58% immediate taker',
  version: 'taker-flat100-v1',
  execution: 'Paper-only immediate taker buys; no live orders.',
  entry: 'After 45 seconds, a fresh current-window score strictly above 58% immediately buys up to 100 shares at available asks.',
  fill: 'Immediate visible-ask sweep with volume-weighted entry price and market-specific taker fees. Any unfilled remainder is cancelled.',
  cadence: 'One executed entry per window, including partial fills. No resting orders or opposite-signal replacement.',
  sizing: 'Flat 100 shares requested per window; actual quantity depends on executable liquidity.',
  shadow: 'Only the 58% paper strategy is active; no selling or flipping filled shares.',
});

class FreqAITakerBTCBot extends PreviousBot {
  constructor(options = {}) {
    super(options);
    this.strategyId = STRATEGY.id;
    this.strategyDefinition = STRATEGY;
    this.restingEngine = {
      expire() {}, reserved() { return 0; },
      available: () => this.availablePaperCash(),
    };
    this.statusReason = 'Waiting for fresh above-58% FreqAI after 45 seconds; immediate 100-share taker buy.';
  }

  availablePaperCash() {
    const committed = this.shadowEntries.filter(e => ['OPEN', 'PENDING_RESOLUTION'].includes(e.status))
      .reduce((sum, e) => sum + e.totalCost + e.fees, 0);
    return this.initialCapital + this.shadowTotals[58].realizedPnl - committed;
  }

  entrySizing() { return { requestedShares: 100 }; }
  onEntryPlaced() {}

  processShadowEntries(record) {
    const now = this.now(), m = record.market;
    const raw = this.freqaiWorker?.snapshot?.()?.lastPrediction;
    if (!currentWindowPrediction(raw, m, now)) return;
    const p = normalizedScores(raw);
    if (!p || !(p.probability > 0.58)) return;
    const marketId = String(m.id || m.slug), windowStart = Number(m.start);
    if (this.shadowEntries.some(e => e.marketId === marketId && e.windowStart === windowStart)) return;
    const sizing = this.entrySizing(record, now);
    const requestedShares = sizing.requestedShares;
    const fill = planTakerBuy(record, p.side, now, this.availablePaperCash(), requestedShares);
    if (!fill) return;
    const entry = {
      ...fill, id: `shadow-58-${++this.shadowSequence}`, thresholdPct: 58,
      marketId, marketSlug: m.slug, marketTitle: m.title, tokenId: String(m.tokens[p.side]),
      asset: 'BTC', timeframe: '5m', side: p.side, windowStart, windowEnd: Number(m.end),
      entryAt: now, placedAt: now, filledAt: now, execution: 'TAKER', action: 'BUY_TAKER',
      orderStatus: fill.status, status: 'OPEN', requestedShares,
      originalShares: fill.shares, filledShares: fill.shares, remainingShares: 0,
      cancelledShares: fill.unfilledShares, reservedCash: 0,
      signalProbability: p.probability, signalSource: 'FREQAI',
      selectedProbability: p.probability, modelProbabilityUp: p.pUp, modelProbabilityDown: p.pDown,
      modelCandleStart: Number(raw.candleStart), model: raw.model || 'LightGBMClassifier',
      markStatus: fill.markBid == null ? 'WAITING_FOR_MARK' : 'LIVE',
      unrealizedPnl: fill.markBid == null ? null : fill.markBid * fill.shares - fill.totalCost - fill.fees,
      realizedPnl: null, exitPrice: null, exitPayout: null, exitReason: null,
      fillRule: STRATEGY.fill,
    };
    this.shadowEntries.unshift(entry);
    this.onEntryPlaced(entry, sizing);
    this.shadowTotals[58].entries += 1;
    this.shadowTotals[58].fees += fill.fees;
    this.lastDecision = { ...p, at: now, source: 'FREQAI', filledShares: fill.shares,
      fillPrice: fill.entryPrice, windowStart };
    record.triggeredSide = p.side;
    Object.assign(record.sideStates[p.side], { entryConsumed: true,
      orderId: entry.id, orderStatus: fill.status, requestedShares, filledShares: fill.shares,
      reason: `Immediate taker: ${fill.shares}/${requestedShares} at $${fill.entryPrice.toFixed(4)}; fees $${fill.fees.toFixed(5)}. No resting remainder.` });
    this.log(record.sideStates[p.side].reason, {
      type: 'BUY_TAKER', asset: 'BTC', timeframe: '5m', side: p.side, now,
    });
    this.scheduleLedgerSave();
  }

  snapshot() {
    const s = super.snapshot();
    s.strategy = { ...STRATEGY };
    s.shadowTakerOrders = this.shadowEntries.slice(0, 300).map(e => ({ ...e, status: e.orderStatus }));
    delete s.shadowRestingOrders;
    delete s.restingOrderSummary;
    s.takerOrderSummary = { entries: this.shadowTotals[58].entries, reservedCash: 0,
      availableCash: this.availablePaperCash() };
    return s;
  }
}
FreqAITakerBTCBot.STRATEGY = STRATEGY;
module.exports = FreqAITakerBTCBot;
