'use strict';

const marketDataDefault = require('./wick-market-data.js');
const { resolvedPayout } = require('./position-exits.js');

class LegacyPaperSettlementWorker {
  constructor({
    stateStore,
    marketData = marketDataDefault,
    now = Date.now,
    pollIntervalMs = 5_000,
    initialDelayMs = 30_000,
    onError = error => console.error(
      '[legacy-paper-settlement]',
      error?.message || 'Could not reconcile an archived paper position.',
    ),
  } = {}) {
    this.stateStore = stateStore;
    this.marketData = marketData;
    this.now = now;
    this.pollIntervalMs = pollIntervalMs;
    this.initialDelayMs = initialDelayMs;
    this.onError = onError;
    this.running = false;
    this.inProgress = false;
    this.timer = null;
  }

  async start() {
    if (this.running || !this.stateStore) return;
    this.running = true;
    try {
      await this.stateStore.initialize();
    } catch (error) {
      this.onError(error);
    }
    this.timer = setTimeout(() => {
      this.timer = setInterval(() => {
        void this.runOnce();
      }, this.pollIntervalMs);
      this.timer.unref?.();
      void this.runOnce();
    }, this.initialDelayMs);
    this.timer.unref?.();
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    clearInterval(this.timer);
    this.timer = null;
  }

  async runOnce() {
    if (!this.running || this.inProgress || !this.stateStore) return false;
    this.inProgress = true;
    let changed = false;
    try {
      const state = await this.stateStore.loadState();
      if (!state || !Array.isArray(state.trades)) return false;
      const now = this.now();
      const dueTrades = state.trades.filter(trade => trade.status === 'OPEN'
        && Number.isFinite(Number(trade.windowEnd))
        && Number(trade.windowEnd) <= now);
      const marketIds = [...new Set(dueTrades.map(trade => String(trade.marketId)))];
      let nextEventSequence = Math.max(
        Number(state.eventSequence) || 0,
        ...((Array.isArray(state.events) ? state.events : []).map(event => {
          const match = String(event.id || '').match(/^event-(\d+)$/);
          return match ? Number(match[1]) : 0;
        })),
      );

      for (const marketId of marketIds) {
        let market;
        try {
          market = await this.marketData.getMarket(marketId);
        } catch (error) {
          this.onError(error);
          continue;
        }
        for (const trade of dueTrades) {
          if (String(trade.marketId) !== marketId || trade.status !== 'OPEN') continue;
          const payout = resolvedPayout(market, trade);
          if (payout == null) continue;
          const shares = Number(trade.shares);
          const totalCost = Number(trade.totalCost);
          const cash = Number(state.cash);
          const realized = Number(state.realizedPnl);
          if (![shares, totalCost, cash, realized].every(Number.isFinite) || shares <= 0) continue;

          const proceeds = shares * payout;
          const realizedPnl = proceeds - totalCost;
          trade.status = 'SETTLED';
          trade.settlementStatus = 'SETTLED';
          trade.settlementSource = 'ORIGINAL_MARKET_RESOLUTION';
          trade.resolutionPayout = payout;
          trade.proceeds = proceeds;
          trade.realizedPnl = realizedPnl;
          trade.settledAt = now;
          trade.outcome = payout === 1 ? 'WIN' : 'LOSS';
          state.cash = cash + proceeds;
          state.realizedPnl = realized + realizedPnl;
          state.events = Array.isArray(state.events) ? state.events : [];
          state.events.unshift({
            id: `event-${++nextEventSequence}`,
            at: now,
            type: 'LEGACY_POSITION_RESOLVED',
            message: `Archived ${trade.side} paper position settled from its exact original Polymarket market.`,
            tradeId: trade.id,
            marketId,
            payout,
            realizedPnl,
          });
          state.events.length = Math.min(state.events.length, 500);
          changed = true;
        }
      }

      if (changed) {
        state.eventSequence = nextEventSequence;
        await this.stateStore.saveState(state);
      }
      return changed;
    } catch (error) {
      this.onError(error);
      return false;
    } finally {
      this.inProgress = false;
    }
  }
}

module.exports = { LegacyPaperSettlementWorker };
