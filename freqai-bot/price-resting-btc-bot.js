'use strict';
const PreviousBot = require('./freqai-martingale-btc-bot');
const TakerBot = require('./freqai-taker-btc-bot');
const sizing = require('./price-recovery-sizing');
const stops = require('./tiered-paper-stops');
const { feeRateFor } = require('./freqai-open-entry-utils');
const activeOrder = o => ['RESTING', 'PARTIALLY_FILLED'].includes(o.status);
const STRATEGY = Object.freeze({
  ...PreviousBot.STRATEGY,
  id: 'pumpfun-btc85-rest80-capital005-recovery2-reset-v1',
  name: 'BTC 85¢ trigger · 80¢ resting buy',
  version: 'price-resting-recovery-v1',
  prediction: 'Model signal ignored for main entries; independent rebound model unchanged.',
  entry: 'After 45 seconds, the first fresh UP or DOWN best ask >=$0.85 places one fixed $0.80 resting buy for that window.',
  execution: 'Paper only; bid-touch simulated maker fills, not verified queue executions.',
  fill: 'A subsequent fresh best bid <=$0.80 confirms simulated fills at exactly $0.80. Quantity is bounded by that displayed bid level; partial fills allowed. Consumed unchanged depth cannot fill twice.',
  sizing: 'Start $1,000. Base budget 0.5% of settled capital; two-decimal shares rounded down within budget. Freeze cycle base budget during recovery. Recover actual net cycle losses plus $2; no fixed cap.',
  cadence: 'One order/side per window; no replacement, flips or re-entry. Unfilled remainder expires at window end, TP or SL trigger. Unknown recovery outcomes allow base trades at the frozen budget.',
  exit: 'Fresh best bid >=$0.99 credits modeled $1/share TP. Fixed $0.60 best-bid SL triggers actual bid-depth taker sales after >=300ms, including fees and slippage. Unsold remainder resolves officially.',
  assessment: 'Maker entry fee zero. Stop trigger is not a guaranteed sale price. Rebate estimates require the applicable maker tier and never increase cash.',
  accounting: 'Recovery uses final actual net P&L including partial SL proceeds and taker exit fees. TP is the existing modeled $1 payout. No rebate income is assumed.',
  shadow: 'The independent rebound strategy, account and history remain separate and unchanged.',
  stopLossBid: .6, stopLossTiers: null, triggerAsk: .85, limitBuyPrice: .8,
  baseCapitalFraction: .005, recoveryProfitTarget: 2,
});
class PriceRestingBTCBot extends PreviousBot {
  constructor(options = {}) {
    super({ ...options, initialCapital: 1000 });
    this.strategyId = STRATEGY.id; this.strategyDefinition = STRATEGY;
    this.recovery = sizing.newState();
    this.priceRestingOrders = []; this.priceOrderSequence = 0;
    this.statusReason = 'Waiting 45 seconds, then first best ask >=$0.85; resting buy $0.80.';
    this.restingEngine = { expire: now => this.expireOrders(now),
      reserved: () => this.reservedCash(), available: () => this.availablePaperCash() - this.reservedCash() };
  }
  settledCapital() {
    return this.initialCapital + this.shadowTotals[58].realizedPnl
      + this.shadowEntries.filter(stops.active).reduce((n,e) => n + stops.partialPnl(e), 0);
  }
  reservedCash() {
    return this.priceRestingOrders.filter(activeOrder).reduce((n,o) => n + o.remainingShares * .8, 0);
  }
  entrySizing(record) {
    return sizing.plan(this.recovery, Number(record.market.start), this.settledCapital());
  }
  decide(entry, outcome, source, now) {
    if (!sizing.applyOutcome(this.recovery, entry, outcome, source, now)) return;
    this.log(`${entry.side} closed ${outcome}; net $${entry.realizedPnl.toFixed(5)}; ${entry.sizingEffect}.`,
      { type: 'SIZING_OUTCOME', asset: 'BTC', timeframe: '5m', side: entry.side, now });
    this.scheduleLedgerSave();
  }
  cancelOrder(o, reason, now) {
    if (!activeOrder(o)) return;
    o.cancelledShares = o.remainingShares; o.remainingShares = 0;
    o.status = reason; o.cancelledAt = now;
    const e = this.shadowEntries.find(e => e.id === o.entryId);
    if (e) { e.orderStatus = reason; e.remainingShares = 0; e.cancelledShares = o.cancelledShares; }
    this.log(`${o.side} resting remainder ${reason.toLowerCase()}.`,
      { type: 'LIMIT_CANCEL', asset: 'BTC', timeframe: '5m', side: o.side, now });
    this.scheduleLedgerSave();
  }
  expireOrders(now) {
    for (const o of this.priceRestingOrders) if (now >= o.windowEnd) this.cancelOrder(o, 'EXPIRED', now);
  }
  finishPosition(e, source, payout, now) {
    const o = this.priceRestingOrders.find(o => o.entryId === e.id);
    if (o) this.cancelOrder(o, 'CANCELLED_ON_EXIT', now);
    super.finishPosition(e, source, payout, now);
  }
  observeRecordMarks(record, now) {
    super.observeRecordMarks(record, now);
    for (const o of this.priceRestingOrders.filter(activeOrder)) {
      const e = this.shadowEntries.find(e => e.id === o.entryId);
      if (e?.slTriggeredAt) this.cancelOrder(o, 'CANCELLED_ON_SL', now);
    }
  }
  placeOrder(record, side, now) {
    const m = record.market, q = record.quotes[side], choice = this.entrySizing(record);
    const rate = feeRateFor(m), cash = this.availablePaperCash() - this.reservedCash();
    if (rate == null || !(choice.requestedShares > 0) || choice.requestedShares * .8 > cash + 1e-8) {
      this.statusReason = 'Waiting: insufficient available cash for the full planned limit, or invalid fee rate.';
      return;
    }
    const o = { id: `price-limit-${++this.priceOrderSequence}`, marketId: String(m.id || m.slug),
      marketSlug: m.slug, marketTitle: m.title, windowStart: Number(m.start), windowEnd: Number(m.end),
      side, tokenId: String(m.tokens[side]), placedAt: now, eligibleAt: now + this.paperExecutionDelayMs,
      triggerAsk: Number(q.bestAsk), triggerQuoteAt: Number(q.updatedAt),
      limitPrice: .8, requestedShares: choice.requestedShares, filledShares: 0,
      remainingShares: choice.requestedShares, cancelledShares: 0, status: 'RESTING',
      feeRate: rate, sizing: choice, depthBudget: {}, fills: [], recoveryRole: choice.role,
      execution: 'SIMULATED_MAKER', fees: 0 };
    this.priceRestingOrders.unshift(o);
    record.triggeredSide = side;
    Object.assign(record.sideStates[side], { orderId: o.id, orderStatus: o.status,
      limitPrice: .8, requestedShares: o.requestedShares, filledShares: 0,
      reason: `Ask ${q.bestAsk} triggered a resting $0.80 buy; awaiting subsequent bid-touch simulation.` });
    this.statusReason = record.sideStates[side].reason;
    this.log(`${side} ask $${q.bestAsk} >=$0.85: resting ${o.requestedShares} shares at $0.80 (${choice.role}).`,
      { type: 'LIMIT_PLACED', asset: 'BTC', timeframe: '5m', side, now });
    this.scheduleLedgerSave();
  }
  fillOrder(o, record, now) {
    if (!activeOrder(o) || now < o.eligibleAt || now >= o.windowEnd) return;
    const q = record.quotes?.[o.side], identity = { ...o, entryAt: o.placedAt };
    if (!stops.validQuote(identity, q, now) || Number(q.updatedAt) <= o.placedAt
      || (o.depthAt != null && Number(q.updatedAt) < o.depthAt)) return;
    const rows = q.bids.filter(l => Number(l.price) >= 0 && Number.isFinite(Number(l.size)) && Number(l.size) > 0);
    const signature = JSON.stringify(rows.map(l => [Number(l.price), Number(l.size)]).sort((a,b) => b[0]-a[0]));
    if (Number(q.updatedAt) === o.depthAt && signature !== o.depthSignature
      && !(Number.isFinite(q.sequence) && q.sequence > (o.depthSequence ?? -1))) return;
    o.depthAt = Number(q.updatedAt); o.depthSignature = signature; o.depthSequence = q.sequence ?? null;
    const next = {};
    for (const l of rows) {
      const p = Number(l.price), n = Number(l.size), old = o.depthBudget[p];
      next[p] = { observed: n, remaining: old ? Math.min(n, old.remaining + Math.max(0, n-old.observed)) : n };
    }
    o.depthBudget = next;
    if (Number(q.bestBid) > .8) { this.scheduleLedgerSave(); return; }
    const level = next[Number(q.bestBid)];
    if (!level) return;
    const qty = Math.min(o.remainingShares, level.remaining, Math.max(0, this.availablePaperCash()) / .8);
    if (!(qty > 1e-8)) return;
    let e = this.shadowEntries.find(e => e.id === o.entryId);
    if (e && (!stops.active(e) || e.slTriggeredAt)) { this.cancelOrder(o, 'CANCELLED_ON_EXIT', now); return; }
    const fill = { at: now, bookAt: Number(q.updatedAt), price: .8, shares: qty, fee: 0,
      triggerBid: Number(q.bestBid), liquidity: 'SIMULATED_MAKER', rule: 'BID_TOUCH_NOT_QUEUE_VERIFIED' };
    level.remaining -= qty; o.filledShares += qty; o.remainingShares = Math.max(0, o.requestedShares-o.filledShares);
    o.status = o.remainingShares <= 1e-8 ? 'FILLED' : 'PARTIALLY_FILLED';
    o.filledAt = now; o.fills.push(fill);
    if (!e) {
      e = { id: `shadow-58-${++this.shadowSequence}`, thresholdPct: 58,
        orderId: o.id, marketId: o.marketId, marketSlug: o.marketSlug, marketTitle: o.marketTitle,
        tokenId: o.tokenId, side: o.side, asset: 'BTC', timeframe: '5m',
        windowStart: o.windowStart, windowEnd: o.windowEnd, entryAt: now, placedAt: o.placedAt,
        entryDecisionAt: o.placedAt, paperExecutionDelayMs: this.paperExecutionDelayMs,
        entryPrice: .8, requestedShares: o.requestedShares, shares: 0, totalCost: 0, fees: 0,
        feeRate: o.feeRate, fixedStopLossBid: .6, execution: 'SIMULATED_MAKER',
        action: 'BUY_LIMIT', signalSource: 'BEST_ASK_085', signalAsk: o.triggerAsk,
        status: 'OPEN', fills: [], realizedPnl: null, exitPrice: null, exitPayout: null,
        exitReason: null, fillRule: STRATEGY.fill, estimatedMakerRebate: 0 };
      o.entryId = e.id; this.shadowEntries.unshift(e);
      sizing.recordAttempt(this.recovery, e, o.sizing);
      this.shadowTotals[58].entries += 1;
    }
    e.fills.push(fill); e.shares += qty; e.totalCost = e.shares * .8;
    Object.assign(e, { originalShares: e.shares, filledShares: e.shares,
      remainingShares: o.remainingShares, cancelledShares: 0, filledAt: now, orderStatus: o.status });
    stops.prepare(e);
    Object.assign(record.sideStates[o.side], { entryConsumed: true, orderStatus: o.status,
      filledShares: e.shares, reason: `Simulated maker ${e.shares}/${o.requestedShares} at exactly $0.80; SL $0.60.` });
    this.lastDecision = { side: o.side, at: now, source: 'BEST_ASK_085',
      filledShares: e.shares, fillPrice: .8, windowStart: o.windowStart };
    this.log(`${o.side} simulated maker fill ${qty.toFixed(4)} at exactly $0.80; entry fee $0; ${o.remainingShares.toFixed(4)} remain.`,
      { type: 'MAKER_FILL_SIMULATED', asset: 'BTC', timeframe: '5m', side: o.side, now });
    this.scheduleLedgerSave();
  }
  processShadowEntries(record) {
    const now = this.now(), m = record?.market;
    this.expireOrders(now); this.observeRecordMarks(record, now);
    if (!m || now < Number(m.start)+45000 || now >= Number(m.end)) return;
    const existing = this.priceRestingOrders.find(o => o.marketId === String(m.id || m.slug)
      && o.windowStart === Number(m.start));
    if (existing) { this.fillOrder(existing, record, now); this.observeRecordMarks(record, now); return; }
    for (const side of ['UP','DOWN']) {
      const q = record.quotes?.[side];
      const identity = { entryAt: 0, tokenId: String(m.tokens[side]),
        marketId: String(m.id || m.slug), windowStart: Number(m.start) };
      if (!stops.validQuote(identity,q,now) || Number(q.updatedAt)<Number(m.start)
        || q.bestAsk == null || Number(q.bestAsk)<.85) continue;
      this.placeOrder(record,side,now); break;
    }
  }
  exportLedger() {
    const l = super.exportLedger();
    Object.assign(l.snapshot, { recovery: structuredClone(this.recovery),
      priceRestingOrders: structuredClone(this.priceRestingOrders), priceOrderSequence: this.priceOrderSequence });
    return l;
  }
  restoreLedger(ledger) {
    const s = ledger?.snapshot;
    if (s?.account?.initialCapital !== 1000) throw new Error('Unexpected capital for price strategy.');
    const orders = structuredClone(s.priceRestingOrders || []);
    for (const o of orders) {
      if (o.limitPrice !== .8 || !Number.isFinite(o.requestedShares) || !(o.requestedShares>0)
        || !Number.isFinite(o.remainingShares) || !Number.isFinite(o.filledShares)
        || o.remainingShares<0 || o.filledShares<0
        || Math.abs(o.requestedShares-o.remainingShares-o.filledShares-(o.cancelledShares||0))>1e-7
        || !o.depthBudget || !Array.isArray(o.fills))
        throw new Error('Invalid saved resting order.');
      for (const level of Object.values(o.depthBudget)) if (!Number.isFinite(level.remaining)
        || level.remaining< -1e-8 || level.remaining>level.observed+1e-8) throw new Error('Invalid saved entry depth.');
    }
    for (const e of s.shadowEntries || []) {
      stops.validate(e);
      if (e.entryPrice !== .8 || e.fees !== 0 || e.fixedStopLossBid !== .6
        || !Number.isFinite(e.shares) || !(e.shares>0) || !(e.baseBudget>=0)
        || Math.abs(e.totalCost-e.shares*.8)>1e-7) throw new Error('Invalid saved maker position.');
    }
    const recovery = sizing.validateState(s.recovery,s.shadowEntries || []);
    // Skip the old strategy's fixed-50-share recovery validator.
    TakerBot.prototype.restoreLedger.call(this,ledger);
    this.recovery = recovery; this.priceRestingOrders = orders;
    this.priceOrderSequence = Number(s.priceOrderSequence) || orders.length;
    this.expireOrders(this.now()); this.scheduleLedgerSave();
  }
  snapshot() {
    const s = super.snapshot(), now = this.now(), start = Math.floor(now/300000)*300000;
    const choice = sizing.plan(this.recovery,start,this.settledCapital());
    const current = this.priceRestingOrders.find(o => o.windowStart===start);
    const cutoff = now - 30*86400000;
    const weighted = this.shadowEntries.reduce((n,e) => n + (e.entryAt>=cutoff ? e.shares*.8*.2 : 0),0);
    const rebateRate = weighted>=1e7 ? .15 : weighted>=4e6 ? .10 : weighted>=1e6 ? .07 : weighted>=2e5 ? .03 : 0;
    s.strategy = { ...STRATEGY }; s.freqai.usedForEntry = false;
    s.shadowTiers = s.shadowTiers.map(t => ({ ...t,label:'85¢ → 80¢ resting' }));
    s.sizingByAsset.BTC = { baseBudget: choice.baseBudget, baseCapitalFraction: .005,
      minimumProbability: null, oneEntryPerWindow: true, currentShares: current?.requestedShares || choice.requestedShares };
    s.recovery = { ...choice, ...structuredClone(this.recovery), profitTarget: 2,
      outstandingLoss: Math.max(0,-this.recovery.netPnl),
      currentWindowRole: current?.recoveryRole || choice.role,
      currentWindowShares: current?.requestedShares || choice.requestedShares };
    s.shadowSizing = { ...s.shadowSizing,currentShares:s.recovery.currentWindowShares };
    s.shadowRestingOrders = this.priceRestingOrders.slice(0,300).map(o => ({ ...o,depthBudget:undefined }));
    s.restingOrderSummary = { active:this.priceRestingOrders.filter(activeOrder).length,
      reservedCash:this.reservedCash(),availableCash:this.availablePaperCash()-this.reservedCash() };
    delete s.shadowTakerOrders; delete s.takerOrderSummary;
    Object.assign(s.shadowAccount, { cash:this.availablePaperCash(),
      availableCash:s.restingOrderSummary.availableCash,reservedCash:this.reservedCash(),
      accountingBasis:'Bid-touch simulated maker entry exactly $0.80; actual bid-depth SL proceeds and exit fees; modeled $1 TP; rebates excluded.' });
    const feeEquivalent = this.shadowEntries.reduce((n,e) => n
      + (e.entryAt>=cutoff ? e.shares*e.feeRate*.8*.2 : 0),0);
    s.makerRebates = { weightedVolume30d:weighted,standardTierRate:rebateRate,
      feeEquivalent30d:feeEquivalent,illustrationAtCurrentTier:feeEquivalent*rebateRate,
      credited:0,notIncludedInEquity:true,
      note:'Paper-only estimate: no wallet credits. Standard rate 0% below $200,000 maker weighted volume; 3/7/10/15% thereafter. Tiers update daily; campaigns may differ. No guaranteed rebate income.' };
    return s;
  }
}
PriceRestingBTCBot.STRATEGY = STRATEGY;
module.exports = PriceRestingBTCBot;
