'use strict';
const TakerBot = require('./freqai-taker-btc-bot');
const sizing = require('./martingale-sizing');
const STRATEGY = Object.freeze({
  ...TakerBot.STRATEGY,
  id: 'pumpfun-freqai58-taker-recover-plus10-base50-paper-exits-v2',
  name: 'BTC FreqAI 58% · recovery +$10 · paper TP/SL',
  version: 'recover-plus10-base50-paper-exits-v2',
  entry: 'Fresh above-58% current-window signal after 45 seconds; one immediate taker entry per window.',
  exit: 'Fresh best bid >=$0.99 triggers modeled $1/share paper TP; explicit bid $0.00 triggers zero-payout paper SL. Otherwise official resolution. No flips or live sales.',
  sizing: '50 shares at base. After loss, size the next eligible window to recover cycle losses plus $10 net using actual ask depth and fees. Reset to 50 after the cycle reaches +$10.',
  cadence: 'Recovery is eligible next window, without a doubling ladder or fixed share cap. Unclear recovery outcomes delay recovery only; 50-share base trading continues and its outcomes count toward the cycle. Insufficient cash or depth skips recovery, never fabricates a full fill.',
  assessment: 'Fresh held-side best bid >=$0.99 closes paper TP at a modeled $1/share; an explicit $0.00 bid closes paper SL at $0/share, including intra-window. Missing, crossed or stale quotes never imply zero. Otherwise wait for official resolution.',
  accounting: 'Paper TP/SL immediately realize the modeled payout, release paper capital and update recovery for the next eligible window, once only. These are not actual sales or guaranteed live payouts. Existing history is preserved; official resolution is the fallback.',
  takeProfitBid: .99, takeProfitPayoutPerShare: 1, stopLossBid: 0,
  exitQuote: 'BEST_BID',
});

class MartingaleBTCBot extends TakerBot {
  constructor(options = {}) {
    super(options);
    this.strategyId = STRATEGY.id; this.strategyDefinition = STRATEGY;
    this.recovery = sizing.newState();
    this.statusReason = 'Waiting for fresh above-58% FreqAI after 45 seconds; 50-share base or loss recovery plus $10.';
    this.nextMarkPollAt = 0; this.recoveryTickInFlight = false;
    this.getOrderBook = options.getOrderBook || (async tokenId => {
      const r = await fetch(`https://clob.polymarket.com/book?token_id=${encodeURIComponent(tokenId)}`,
        { signal: AbortSignal.timeout(2500) });
      if (!r.ok) throw new Error(`CLOB book HTTP ${r.status}`);
      return r.json();
    });
  }

  entrySizing(record) { return sizing.plan(this.recovery, Number(record.market.start)); }
  onEntryPlaced(entry, choice) { sizing.recordAttempt(this.recovery, entry, choice); }

  decide(entry, outcome, source, now) {
    if (!sizing.applyOutcome(this.recovery, entry, outcome, source, now)) return;
    this.log(`${entry.side} sizing ${outcome} (${source}); ${entry.sizingEffect.replaceAll('_', ' ').toLowerCase()}.`, {
      type: 'SIZING_OUTCOME', asset: 'BTC', timeframe: '5m', side: entry.side, now,
    });
    this.scheduleLedgerSave();
  }

  closePaper(entry, outcome, now) {
    if (!['OPEN', 'PENDING_RESOLUTION'].includes(entry.status)
      || !['WIN', 'LOSS'].includes(outcome)) return;
    const won = outcome === 'WIN', source = won ? 'PAPER_TP' : 'PAPER_SL';
    const payout = won ? 1 : 0;
    Object.assign(entry, {
      status: won ? 'RESOLVED_WIN' : 'RESOLVED_LOSS',
      resolvedAt: now, exitAt: now, exitPrice: payout, exitPayout: payout,
      exitReason: source, settlementSource: source, modeledPayout: true,
      triggerBid: entry.sizingBid, triggerQuoteAt: entry.sizingMarkAt,
      realizedPnl: entry.shares * payout - entry.totalCost - entry.fees,
      markStatus: 'CLOSED_PAPER', unrealizedPnl: null,
    });
    const totals = this.shadowTotals[entry.thresholdPct];
    totals.resolved += 1;
    totals.realizedPnl += entry.realizedPnl;
    totals[won ? 'wins' : 'losses'] += 1;
    this.decide(entry, outcome, source, now);
    this.log(`${entry.side} ${source}: bid $${entry.triggerBid.toFixed(2)}; modeled payout $${payout.toFixed(2)}/share, net $${entry.realizedPnl.toFixed(2)}. Not a live sale.`, {
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
    this.closePaper(entry, sizing.outcomeForBid(bid), now);
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
    }
  }

  processShadowEntries(record, ...args) {
    this.observeRecordMarks(record, this.now());
    super.processShadowEntries(record, ...args);
  }

  expireMarket(record, now) {
    this.observeRecordMarks(record, now);
    // A fresh last quote remains usable at the boundary even if the record's
    // order book is about to be cleared for the next market.
    for (const e of this.shadowEntries) {
      if (now >= e.windowEnd && e.sizingMarkAt != null
        && now - e.sizingMarkAt <= 5000) {
        this.closePaper(e, sizing.outcomeForBid(e.sizingBid), now);
      }
    }
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
    super.settleMarket(marketId, winner, now);
    for (const e of this.shadowEntries) {
      if (e.marketId !== marketId || e.modeledPayout
        || !['RESOLVED_WIN', 'RESOLVED_LOSS'].includes(e.status)) continue;
      const official = e.side === winner ? 'WIN' : 'LOSS';
      e.sizingOfficialOutcome = official;
      e.sizingDisagreesWithSettlement = !!e.sizingOutcome && e.sizingOutcome !== official;
      if (!e.sizingOutcome) this.decide(e, official, 'OFFICIAL_SETTLEMENT', now);
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
    this.scheduleLedgerSave();
  }

  snapshot() {
    const s = super.snapshot(), now = this.now();
    const m = this.records.get('BTC:5m')?.market;
    const start = Number(m && now >= m.start && now < m.end
      ? m.start : Math.floor(now / sizing.WINDOW_MS) * sizing.WINDOW_MS);
    const choice = sizing.plan(this.recovery, start);
    const current = this.shadowEntries.find(e => e.windowStart === start);
    s.strategy = { ...STRATEGY };
    s.shadowAccount.accountingBasis = 'Mixed paper ledger: historical/ fallback official resolutions plus explicitly labeled modeled TP/SL payouts.';
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
