'use strict';
const TakerBot = require('./freqai-taker-btc-bot');
const sizing = require('./martingale-sizing');
const stops = require('./tiered-paper-stops');
const DipBounceBot = require('./dip-bounce-bot');
const { currentWindowPrediction, normalizedScores } = require('./freqai-open-entry-bot')._test;
const STRATEGY = Object.freeze({
  ...TakerBot.STRATEGY,
  id: 'pumpfun-freqai58-taker-recover-plus10-base50-paper-exits-v2',
  name: 'BTC FreqAI 58% · recovery +$10 · tiered SL',
  version: 'tiered-depth-stop-v3',
  entry: 'Fresh above-58% current-window signal after 45 seconds; one taker entry per window after at least 300ms execution latency, rechecking signal and actual asks.',
  execution: 'Paper-only depth-backed taker buys and stop-loss sales; no live orders.',
  shadow: 'The main 58% paper strategy may sell by its tiered SL. No signal flips. The independent rebound experiment remains separate.',
  exit: 'TP best bid >=$0.99 still pays modeled $1/share. Tiered SL sells held shares at actual visible bids after execution delay; no assumed stop-price fills. Unsold remainder awaits bids or official resolution.',
  fill: 'Minimum 300ms paper execution delay; fresh visible-ask sweep at actual weighted prices and market-specific taker fees. Entry remainder cancelled; no crossed, future or fabricated books.',
  sizing: '50 shares at base. After loss, size the next eligible window to recover cycle losses plus $10 net using actual ask depth and fees. Reset to 50 after the cycle reaches +$10.',
  cadence: 'Recovery is eligible next window, without a doubling ladder or fixed share cap. Unclear recovery outcomes delay recovery only; 50-share base trading continues and its outcomes count toward the cycle. Insufficient cash or depth skips recovery, never fabricates a full fill.',
  assessment: 'SL uses the actual average entry: >0.90 ->0.50; >0.75 ->0.40; >0.65 ->0.30; >0.50 ->0.20; <=0.50 ->0.09. Fresh best bid triggers; displayed depth determines actual sales.',
  accounting: 'SL loss = entry cost + entry fees - bid sale proceeds + exit fees. Recovery uses the completed position net P&L, not full stake or trigger price. Partial unsold shares are not sold or resolved twice. TP remains a modeled $1/share, not an actual sale.',
  takeProfitBid: .99, takeProfitPayoutPerShare: 1, stopLossBid: null,
  stopLossTiers: stops.TIERS, executionDelayMs: 300,
  exitQuote: 'BEST_BID',
});

class MartingaleBTCBot extends TakerBot {
  constructor(options = {}) {
    super(options);
    this.strategyId = STRATEGY.id; this.strategyDefinition = STRATEGY;
    this.recovery = sizing.newState();
    this.statusReason = 'Waiting for fresh above-58% FreqAI after 45 seconds; 50-share base or loss recovery plus $10.';
    this.nextMarkPollAt = 0; this.recoveryTickInFlight = false;
    this.paperExecutionDelayMs = options.paperExecutionDelayMs ?? 300;
    if (!Number.isFinite(this.paperExecutionDelayMs) || this.paperExecutionDelayMs < 0)
      throw new Error('Invalid paper execution latency.');
    this.entryIntent = null;
    this.getOrderBook = options.getOrderBook || (async tokenId => {
      const r = await fetch(`https://clob.polymarket.com/book?token_id=${encodeURIComponent(tokenId)}`,
        { signal: AbortSignal.timeout(2500) });
      if (!r.ok) throw new Error(`CLOB book HTTP ${r.status}`);
      return r.json();
    });
  }

  entrySizing(record) { return sizing.plan(this.recovery, Number(record.market.start)); }
  onEntryPlaced(entry, choice) {
    sizing.recordAttempt(this.recovery, entry, choice); stops.prepare(entry);
    entry.entryDecisionAt = this.entryIntent?.at ?? entry.entryAt;
    entry.paperExecutionDelayMs = this.paperExecutionDelayMs;
    entry.fillRule = STRATEGY.fill;
  }

  availablePaperCash() {
    const unresolved = this.shadowEntries.filter(stops.active);
    return this.initialCapital + this.shadowTotals[58].realizedPnl
      - unresolved.reduce((sum, e) => sum + e.totalCost + e.fees - stops.netSales(e), 0);
  }

  decide(entry, outcome, source, now) {
    if (!sizing.applyOutcome(this.recovery, entry, outcome, source, now)) return;
    this.log(`${entry.side} sizing ${outcome} (${source}); ${entry.sizingEffect.replaceAll('_', ' ').toLowerCase()}.`, {
      type: 'SIZING_OUTCOME', asset: 'BTC', timeframe: '5m', side: entry.side, now,
    });
    this.scheduleLedgerSave();
  }

  closePaper(entry, outcome, now) {
    if (!stops.active(entry) || outcome !== 'WIN' || entry.slTriggeredAt) return;
    this.finishPosition(entry, 'PAPER_TP', entry.shares, now);
  }

  finishPosition(entry, source, terminalPayout, now) {
    if (!stops.active(entry)) return;
    stops.prepare(entry);
    const pnl = stops.netSales(entry) + terminalPayout - entry.totalCost - entry.fees;
    const won = pnl >= 0, modeled = source === 'PAPER_TP';
    Object.assign(entry, {
      status: won ? 'RESOLVED_WIN' : 'RESOLVED_LOSS',
      resolvedAt: now, exitAt: now, terminalPayout,
      exitPrice: (entry.exitProceeds + terminalPayout) / entry.shares,
      exitPayout: (entry.exitProceeds + terminalPayout) / entry.shares,
      exitReason: source, settlementSource: source, modeledPayout: modeled,
      realizedPnl: pnl, remainingHeldShares: 0,
      markStatus: 'CLOSED_PAPER', unrealizedPnl: null,
    });
    if (modeled) Object.assign(entry, { triggerBid: entry.sizingBid, triggerQuoteAt: entry.sizingMarkAt });
    delete entry.slDepthBudget;
    delete entry.slDepthSignature; delete entry.slDepthAt; delete entry.slDepthSequence;
    const totals = this.shadowTotals[entry.thresholdPct];
    totals.resolved += 1;
    totals.realizedPnl += entry.realizedPnl;
    totals[won ? 'wins' : 'losses'] += 1;
    this.decide(entry, won ? 'WIN' : 'LOSS',
      source === 'OFFICIAL_RESOLUTION' ? 'OFFICIAL_SETTLEMENT' : source, now);
    this.log(`${entry.side} ${source}: ${modeled ? 'modeled $1/share TP' : 'gross $' + (entry.exitProceeds + terminalPayout).toFixed(4) + ', exit fees $' + entry.exitFees.toFixed(5)}; net $${pnl.toFixed(4)}.`, {
      type: source, asset: 'BTC', timeframe: '5m', side: entry.side, now,
    });
    this.scheduleLedgerSave();
  }

  saveMark(entry, bid, ask, at, now, source) {
    if (!['OPEN', 'PENDING_RESOLUTION'].includes(entry.status)
      || bid == null || !Number.isFinite(bid) || bid < 0 || bid > 1
      || (ask != null && (!Number.isFinite(ask) || ask < bid || ask > 1))
      || !Number.isFinite(at) || at < entry.entryAt || now < entry.entryAt
      || at > now + 1000 || now - at > 5000) return;
    if (entry.sizingMarkAt != null && at < entry.sizingMarkAt) return;
    entry.sizingBid = bid;
    entry.sizingMidpoint = ask == null ? null : (bid + ask) / 2;
    entry.sizingMarkAt = at; entry.sizingMarkSource = source;
    if (bid >= .99 && !entry.slTriggeredAt) this.closePaper(entry, 'WIN', now);
  }

  observeRecordMarks(record, now) {
    const m = record?.market;
    if (!m) return;
    for (const e of this.shadowEntries) {
      if (!['OPEN', 'PENDING_RESOLUTION'].includes(e.status) || e.marketId !== String(m.id || m.slug)
        || e.windowStart !== Number(m.start)) continue;
      const q = record.quotes?.[e.side];
      if (!q || (q.tokenId && q.tokenId !== e.tokenId)
        || (q.marketId && q.marketId !== e.marketId)
        || (q.windowStart != null && Number(q.windowStart) !== e.windowStart)) continue;
      this.saveMark(e, q.bestBid == null ? null : Number(q.bestBid),
        q.bestAsk == null ? null : Number(q.bestAsk),
        q.updatedAt == null ? NaN : Number(q.updatedAt), now, 'CURRENT_WINDOW_CLOB');
      if (!stops.active(e)) continue;
      // Reject out-of-order books before mutating the persisted depth budget.
      if (Number(q.updatedAt) < e.sizingMarkAt) continue;
      const fills = stops.sweep(e, q, now, this.paperExecutionDelayMs);
      for (const fill of fills) {
        this.shadowTotals[e.thresholdPct].fees += fill.fee;
        this.log(`${e.side} SL sold ${fill.shares.toFixed(4)} at $${fill.price.toFixed(4)}; fee $${fill.fee.toFixed(5)}; ${fill.remainingHeldSharesAfter.toFixed(4)} shares remain.`, {
          type: 'SL_FILL', asset: 'BTC', timeframe: '5m', side: e.side, now,
        });
      }
      if (fills.length && stops.held(e) <= 1e-8) this.finishPosition(e, 'TAKER_SL', 0, now);
      if (fills.length || e.slTriggeredAt) this.scheduleLedgerSave();
    }
  }

  processShadowEntries(record, ...args) {
    const now = this.now(), m = record?.market;
    this.observeRecordMarks(record, now);
    if (!m || now < Number(m.start) + 45000 || now >= Number(m.end)) return;
    const raw = this.freqaiWorker?.snapshot?.()?.lastPrediction;
    if (!currentWindowPrediction(raw, m, now)) { this.entryIntent = null; return; }
    if ([raw.writtenAt, raw.candleCloseAt].some(t => Number(t) > now)) {
      this.entryIntent = null; return;
    }
    const p = normalizedScores(raw);
    if (!p || p.probability <= .58) { this.entryIntent = null; return; }
    if (this.shadowEntries.some(e => e.marketId === String(m.id || m.slug)
      && e.windowStart === Number(m.start))) return;
    const identity = { entryAt: 0, tokenId: String(m.tokens[p.side]),
      marketId: String(m.id || m.slug), windowStart: Number(m.start) };
    if (!stops.validQuote(identity, record.quotes?.[p.side], now, true)) return;
    if (!this.entryIntent || this.entryIntent.marketId !== identity.marketId
      || this.entryIntent.side !== p.side || now - this.entryIntent.at > 2000) {
      this.entryIntent = { ...identity, side: p.side, at: now };
    }
    if (now - this.entryIntent.at < this.paperExecutionDelayMs) return;
    super.processShadowEntries(record, ...args);
    this.observeRecordMarks(record, now);
  }

  expireMarket(record, now) {
    this.observeRecordMarks(record, now);
    super.expireMarket(record, now);
  }

  async pollUnclearMarks(now) {
    if (now < this.nextMarkPollAt) return;
    this.nextMarkPollAt = now + 5000;
    const pending = this.shadowEntries.filter(e => now >= e.windowEnd
      && ['OPEN', 'PENDING_RESOLUTION'].includes(e.status))
      .sort((a, b) => (a.id === this.recovery.awaitingEntryId ? -1
        : b.id === this.recovery.awaitingEntryId ? 1 : (a.markPolledAt || 0) - (b.markPolledAt || 0)));
    await Promise.all(pending.slice(0, 2).map(async e => {
      e.markPolledAt = now;
      try {
        const book = await this.getOrderBook(e.tokenId);
        if (book.asset_id && String(book.asset_id) !== e.tokenId) throw new Error('Book token does not match the held position.');
        const prices = rows => (rows || []).filter(l => Number(l.size) > 0).map(l => Number(l.price))
          .filter(p => Number.isFinite(p) && p >= 0 && p <= 1);
        const bids = prices(book.bids), asks = prices(book.asks);
        let at = Number(book.timestamp);
        if (at > 0 && at < 1e12) at *= 1000;
        this.saveMark(e, bids.length ? Math.max(...bids) : null,
          asks.length ? Math.min(...asks) : null, at, this.now(), 'PENDING_WINDOW_CLOB');
        e.markLookupError = null;
      } catch (error) { e.markLookupError = String(error.message || error).slice(0, 200); }
    }));
    if (pending.length) this.scheduleLedgerSave();
  }

  async tick(now = this.now()) {
    if (!this.running || this.recoveryTickInFlight) return;
    this.recoveryTickInFlight = true;
    try {
      for (const r of this.records.values()) this.observeRecordMarks(r, now);
      await super.tick(now);
      await this.pollUnclearMarks(this.now());
    } finally { this.recoveryTickInFlight = false; }
  }

  settleMarket(marketId, winner, now) {
    if (!['UP', 'DOWN'].includes(winner)) return;
    // Retain the base market/position bookkeeping without the old adapter's
    // full-share shadow payout (which would pay already-sold shares again).
    DipBounceBot.prototype.settleMarket.call(this, marketId, winner, now);
    for (const e of this.shadowEntries) {
      if (e.marketId !== marketId || !stops.active(e) || now < e.windowEnd) continue;
      stops.prepare(e);
      e.resolutionWinner = winner;
      e.sizingOfficialOutcome = e.side === winner ? 'WIN' : 'LOSS';
      this.finishPosition(e, 'OFFICIAL_RESOLUTION', e.side === winner ? stops.held(e) : 0, now);
    }
    this.scheduleLedgerSave();
  }

  exportLedger() {
    const ledger = super.exportLedger();
    ledger.snapshot.recovery = structuredClone(this.recovery);
    // Parent adapter persists an internal fixed-size sentinel; the public
    // snapshot separately exposes the actual dynamic recovery size.
    ledger.snapshot.shadowSizing = { ...this.shadowSizing };
    return ledger;
  }

  restoreLedger(ledger) {
    const s = ledger?.snapshot || ledger;
    for (const e of s?.shadowEntries || []) {
      stops.validate(e);
      if (!['BASE', 'RECOVERY'].includes(e.recoveryRole)
        || !Number.isSafeInteger(e.requestedShares) || e.requestedShares <= 0
        || (e.recoveryRole === 'BASE' && e.requestedShares !== 50)
        || !(e.shares > 0 && e.shares <= e.requestedShares)) {
        throw new Error('Invalid saved recovery trade.');
      }
    }
    const recovery = sizing.validateState(s?.recovery, s?.shadowEntries || []);
    super.restoreLedger(ledger);
    this.recovery = recovery;
    // The older adapter conservatively marks all restored opens pending.
    // Still-current holdings must resume their stop order after fresh quotes,
    // without resetting the persisted consumed-depth budget.
    for (const e of this.shadowEntries) {
      if (stops.active(e) && this.now() >= e.windowStart && this.now() < e.windowEnd) {
        e.status = 'OPEN'; e.markBid = null; e.unrealizedPnl = null;
        e.markStatus = 'WAITING_FOR_FRESH_BOOK';
      }
    }
    this.scheduleLedgerSave();
  }

  shadowPerformance(now) {
    const entries = this.shadowEntries, active = entries.filter(stops.active);
    for (const e of active) {
      stops.prepare(e);
      const record = [...this.records.values()].find(r => String(r.market?.id || r.market?.slug) === e.marketId);
      const q = record?.quotes?.[e.side];
      const known = e.status === 'OPEN' && stops.validQuote(e, q, now) && q.bestBid != null;
      e.markBid = known ? Number(q.bestBid) : null;
      e.markUpdatedAt = known ? Number(q.updatedAt) : null;
      e.markStatus = known ? (e.slTriggeredAt ? 'SL_EXIT_IN_PROGRESS' : 'LIVE') : 'UNKNOWN';
      e.unrealizedPnl = known ? stops.held(e) * e.markBid
        - (e.totalCost + e.fees) * stops.held(e) / e.shares : null;
    }
    const open = active.filter(e => e.status === 'OPEN');
    const pending = active.filter(e => e.status === 'PENDING_RESOLUTION');
    const partial = active.reduce((n, e) => n + stops.partialPnl(e), 0);
    const t = this.shadowTotals[58], realized = t.realizedPnl + partial;
    const floating = open.some(e => e.unrealizedPnl == null) ? null
      : open.reduce((n, e) => n + e.unrealizedPnl, 0);
    return [{ thresholdPct: 58, label: '>58%', entries: t.entries, resolved: t.resolved,
      openPositions: open.length, pendingResolution: pending.length, wins: t.wins, losses: t.losses,
      fees: t.fees, realizedPnl: realized, partialRealizedPnl: partial, openPnl: floating,
      totalPnl: floating == null || pending.length ? null : realized + floating,
      recentEntries: entries.slice(0, 12).map(e => ({ ...e, slDepthBudget: undefined })) }];
  }

  snapshot() {
    const s = super.snapshot(), now = this.now();
    const m = this.records.get('BTC:5m')?.market;
    const start = Number(m && now >= m.start && now < m.end
      ? m.start : Math.floor(now / sizing.WINDOW_MS) * sizing.WINDOW_MS);
    const choice = sizing.plan(this.recovery, start);
    const current = this.shadowEntries.find(e => e.windowStart === start);
    s.strategy = { ...STRATEGY };
    s.shadowAccount.accountingBasis = 'Preserved historical payouts; new SLs use actual depth-backed bid sales and entry/exit fees. TP remains modeled $1/share. Unsold shares remain open or await official resolution.';
    s.shadowAccount.cash = this.availablePaperCash();
    s.shadowAccount.availableCash = this.availablePaperCash();
    s.takerOrderSummary.availableCash = this.availablePaperCash();
    // Plot partial realized losses when they happened, not as a retroactive
    // shift of every historical point or a second loss at final settlement.
    const events = [];
    for (const e of this.shadowEntries) {
      for (const sale of e.slSales || []) events.push({ at: sale.at, pnl: sale.realizedPnl });
      if (!stops.active(e) && Number.isFinite(e.realizedPnl)) {
        events.push({ at: e.resolvedAt, pnl: e.realizedPnl
          - (e.slSales || []).reduce((n, x) => n + x.realizedPnl, 0) });
      }
    }
    const partial = this.shadowEntries.filter(stops.active).reduce((n, e) => n + stops.partialPnl(e), 0);
    let balance = this.initialCapital + this.shadowTotals[58].realizedPnl + partial
      - events.reduce((n, event) => n + event.pnl, 0);
    s.shadowSettledCurve = events.sort((a, b) => a.at - b.at).map(event => {
      balance += event.pnl; return { at: event.at, equity: balance };
    });
    s.shadowEntries = s.shadowEntries.map(e => ({ ...e, slDepthBudget: undefined }));
    s.shadowTakerOrders = s.shadowTakerOrders.map(e => ({ ...e, slDepthBudget: undefined }));
    s.recovery = { ...choice, ...structuredClone(this.recovery),
      nextRecoveryShares: null,
      pendingMarks: this.shadowEntries.filter(e => !e.sizingOutcome && now >= e.windowEnd).length,
      markErrors: this.shadowEntries.filter(e => e.markLookupError && !e.sizingOutcome)
        .slice(0, 3).map(e => ({ entryId: e.id, error: e.markLookupError })),
      currentWindowRole: current?.recoveryRole || choice.role,
      currentWindowShares: current?.requestedShares || (choice.role === 'RECOVERY' ? null : choice.requestedShares),
      outstandingLoss: Math.max(0, -this.recovery.netPnl), profitTarget: 10 };
    s.shadowSizing = { ...s.shadowSizing, currentShares: s.recovery.currentWindowShares };
    s.sizingByAsset.BTC = { ...s.sizingByAsset.BTC, currentShares: s.recovery.currentWindowShares,
      baseShares: 50, maxShares: null, maxRecoverySteps: null };
    return s;
  }
}
MartingaleBTCBot.STRATEGY = STRATEGY;
module.exports = MartingaleBTCBot;
