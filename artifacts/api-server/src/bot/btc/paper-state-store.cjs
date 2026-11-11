'use strict';

const BOT_KEY = 'btc-5m-price-band';

function sequenceFromIds(items, prefix) {
  return items.reduce((largest, item) => {
    const match = String(item?.id || '').match(new RegExp(`^${prefix}-(\\d+)$`));
    return match ? Math.max(largest, Number(match[1])) : largest;
  }, 0);
}

function stateFromPublicSnapshot(snapshot) {
  const account = snapshot?.account;
  const window = snapshot?.window;
  if (snapshot?.mode !== 'PAPER ONLY' || !account || !window
    || !Array.isArray(snapshot.trades) || !Array.isArray(snapshot.events)) {
    throw new Error('The live BTC bot returned an incomplete state snapshot.');
  }

  const expectedTrades = Number(account.openPositions || 0)
    + Number(account.pendingResolutionPositions || 0)
    + Number(account.settledPositions || 0)
    + Number(account.closedPositions || 0);
  if (!Number.isInteger(expectedTrades) || expectedTrades !== snapshot.trades.length) {
    throw new Error('The live BTC trade list is truncated; refusing an incomplete history migration.');
  }
  if (!Number.isFinite(Number(account.startingCapital))
    || !Number.isFinite(Number(account.cash))
    || !Number.isFinite(Number(account.realizedPnl))) {
    throw new Error('The live BTC account totals are invalid.');
  }
  const ledgerTotals = snapshot.trades.reduce((totals, trade) => {
    const totalCost = Number(trade.totalCost);
    const proceeds = trade.proceeds == null ? 0 : Number(trade.proceeds);
    const realizedPnl = trade.realizedPnl == null ? 0 : Number(trade.realizedPnl);
    if (!Number.isFinite(totalCost) || !Number.isFinite(proceeds) || !Number.isFinite(realizedPnl)) {
      throw new Error('A live BTC trade has invalid accounting values.');
    }
    totals.cash -= totalCost;
    totals.cash += proceeds;
    totals.realizedPnl += realizedPnl;
    return totals;
  }, { cash: Number(account.startingCapital), realizedPnl: 0 });
  if (Math.round(ledgerTotals.cash * 100) !== Math.round(Number(account.cash) * 100)
    || Math.round(ledgerTotals.realizedPnl * 100) !== Math.round(Number(account.realizedPnl) * 100)) {
    throw new Error('The live BTC trade ledger does not reconcile to the account totals.');
  }

  const quotes = snapshot.quotes && typeof snapshot.quotes === 'object'
    ? snapshot.quotes : { UP: null, DOWN: null };
  const terminalEvidence = {
    UP: { winnerHitAt: null, winnerBid: null, loserHitAt: null, loserBid: null },
    DOWN: { winnerHitAt: null, winnerBid: null, loserHitAt: null, loserBid: null },
  };
  const recordEvidence = (side, bid, at) => {
    if (bid == null || at == null
      || !Number.isFinite(Number(bid)) || !Number.isFinite(Number(at))) return;
    const value = terminalEvidence[side];
    if (Number(bid) >= 0.99 && value.winnerHitAt == null) {
      value.winnerHitAt = Number(at);
      value.winnerBid = Number(bid);
    }
    if (Number(bid) < 0.01 && value.loserHitAt == null) {
      value.loserHitAt = Number(at);
      value.loserBid = Number(bid);
    }
  };
  for (const side of ['UP', 'DOWN']) {
    const quote = quotes[side];
    if (quote && window.start != null && window.end != null
      && Number(quote.updatedAt) >= Number(window.start)
      && Number(quote.updatedAt) < Number(window.end)) {
      recordEvidence(side, quote.bestBid, quote.updatedAt);
    }
  }
  const terminalObservation = window.terminalObservation || null;
  if (terminalObservation) {
    recordEvidence('UP', terminalObservation.UP, terminalObservation.at);
    recordEvidence('DOWN', terminalObservation.DOWN, terminalObservation.at);
  }

  const sideState = snapshot.sideState || {};
  const lastAskTrigger = Object.fromEntries(['UP', 'DOWN'].map(side => {
    const quote = quotes[side];
    const fallbackAsk = sideState[side]?.lastBestAsk;
    const bestAsk = quote?.bestAsk != null && Number.isFinite(Number(quote.bestAsk))
      ? Number(quote.bestAsk)
      : fallbackAsk != null && Number.isFinite(Number(fallbackAsk))
        ? Number(fallbackAsk) : null;
    return [side, bestAsk == null ? null : {
      source: quote?.eventType || 'RESTORED',
      timestamp: quote?.sourceTimestamp ?? null,
      bestAsk,
    }];
  }));

  return {
    schemaVersion: 1,
    persistenceSource: 'predeploy-seed',
    strategyVersion: snapshot.strategy?.version || 'legacy-btc-5m',
    startingCapital: Number(account.startingCapital),
    cash: Number(ledgerTotals.cash.toFixed(8)),
    realizedPnl: Number(ledgerTotals.realizedPnl.toFixed(8)),
    trades: snapshot.trades,
    events: snapshot.events,
    tradeSequence: sequenceFromIds(snapshot.trades, 'trade'),
    eventSequence: sequenceFromIds(snapshot.events, 'event'),
    windowStart: Number.isFinite(Number(window.start)) ? Number(window.start) : null,
    windowEnd: Number.isFinite(Number(window.end)) ? Number(window.end) : null,
    marketId: snapshot.market?.id == null ? null : String(snapshot.market.id),
    sideState,
    lastAskTrigger,
    quotes,
    terminalEvidence,
    terminalEvidenceMarketId: snapshot.market?.id == null ? null : String(snapshot.market.id),
    terminalObservation,
  };
}

class PaperStateStore {
  constructor(pool, botKey = BOT_KEY) {
    this.pool = pool;
    this.botKey = botKey;
  }

  async initialize() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS btc_5m_paper_bot_state (
        bot_key text PRIMARY KEY,
        state jsonb NOT NULL,
        updated_at bigint NOT NULL
      )
    `);
  }

  async loadState() {
    const result = await this.pool.query(
      'SELECT state FROM btc_5m_paper_bot_state WHERE bot_key = $1',
      [this.botKey],
    );
    const value = result.rows[0]?.state ?? null;
    return typeof value === 'string' ? JSON.parse(value) : value;
  }

  async saveState(state) {
    await this.pool.query(
      `INSERT INTO btc_5m_paper_bot_state (bot_key, state, updated_at)
       VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (bot_key) DO UPDATE SET
         state = EXCLUDED.state,
         updated_at = EXCLUDED.updated_at`,
      [this.botKey, JSON.stringify(state), Date.now()],
    );
  }

  async seedFromPublicSnapshot(snapshot) {
    const existing = await this.loadState();
    if (existing?.persistenceSource === 'runtime') {
      return { seeded: false, reason: 'runtime-state-already-present' };
    }
    const state = stateFromPublicSnapshot(snapshot);
    await this.saveState(state);
    const saved = await this.loadState();
    if (!saved || saved.trades?.length !== state.trades.length
      || saved.cash !== state.cash) {
      throw new Error('The BTC paper history seed could not be verified.');
    }
    return { seeded: true, tradeCount: saved.trades.length, cash: saved.cash };
  }
}

module.exports = { PaperStateStore, stateFromPublicSnapshot };
