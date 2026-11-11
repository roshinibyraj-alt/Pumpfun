'use strict';

const config = require('./btc-price-band-config.cjs');
const marketDataDefault = require('./wick-market-data.js');
const { feeParameters, takerFeeAt } = require('./paper-trading.js');
const { resolvedPayout } = require('./position-exits.js');

const EPSILON = 1e-8;

function numeric(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value, digits = 6) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function normalizeLevels(levels, side) {
  return (Array.isArray(levels) ? levels : [])
    .map(level => ({ price: numeric(level.price), size: numeric(level.size) }))
    .filter(level => level.price > 0 && level.price < 1 && level.size > 0)
    .sort((a, b) => side === 'asks' ? a.price - b.price : b.price - a.price);
}

function reconcileLevels(previous, next, { refreshVisibleDepth = false } = {}) {
  const oldLevels = new Map((previous || []).map(level => [level.price, level]));
  return next.map(level => {
    if (refreshVisibleDepth) {
      return { ...level, availableSize: level.size };
    }
    const old = oldLevels.get(level.price);
    const availableSize = old
      ? Math.max(0, old.availableSize + level.size - old.size)
      : level.size;
    return { ...level, availableSize };
  });
}

function emptyInventoryBox() {
  return {
    shares: 0,
    averageEntryPrice: null,
    grossCost: 0,
    fees: 0,
    totalCost: 0,
    markValue: null,
    unrealizedPnl: null,
    positions: 0,
    unmarkedPositions: 0,
  };
}

function groupInventory(trades, selector) {
  const result = { UP: emptyInventoryBox(), DOWN: emptyInventoryBox() };
  for (const trade of trades) {
    if (!selector(trade)) continue;
    const box = result[trade.side];
    if (!box) continue;
    box.shares += trade.shares;
    box.grossCost += trade.grossCost;
    box.fees += trade.fees;
    box.totalCost += trade.totalCost;
    box.positions += 1;
    if (trade.markValue != null) {
      box.markValue = (box.markValue || 0) + trade.markValue;
      box.unrealizedPnl = (box.unrealizedPnl || 0) + trade.unrealizedPnl;
    } else {
      box.unmarkedPositions += 1;
    }
  }
  for (const side of ['UP', 'DOWN']) {
    const box = result[side];
    box.shares = round(box.shares) || 0;
    box.grossCost = round(box.grossCost) || 0;
    box.fees = round(box.fees) || 0;
    box.totalCost = round(box.totalCost) || 0;
    box.averageEntryPrice = box.shares > 0 ? round(box.grossCost / box.shares) : null;
    box.markValue = box.markValue == null ? null : round(box.markValue);
    box.unrealizedPnl = box.unrealizedPnl == null ? null : round(box.unrealizedPnl);
  }
  return result;
}

function sourceTimestamp(value) {
  const number = Number(value);
  if (Number.isFinite(number) && number > 0) return number;
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function bestAskPriceChanged(previous, next) {
  if (next == null) return false;
  if (previous == null) return true;
  return Math.abs(previous - next) >= EPSILON;
}

function splitFillLevels(fills, sharesToClose) {
  let remainingToClose = sharesToClose;
  const closedFills = [];
  const remainingFills = [];
  for (const fill of Array.isArray(fills) ? fills : []) {
    const originalShares = Number(fill.shares) || 0;
    if (originalShares <= EPSILON) continue;
    const closedShares = Math.min(originalShares, remainingToClose);
    const openShares = originalShares - closedShares;
    const makeFill = shares => {
      const ratio = shares / originalShares;
      return {
        ...fill,
        shares: round(shares, 8),
        cost: round((Number(fill.cost) || 0) * ratio, 8),
        fee: round((Number(fill.fee) || 0) * ratio, 8),
      };
    };
    if (closedShares > EPSILON) closedFills.push(makeFill(closedShares));
    if (openShares > EPSILON) remainingFills.push(makeFill(openShares));
    remainingToClose -= closedShares;
  }
  return { closedFills, remainingFills };
}

function scaleExecutionFills(fills, ratio) {
  return (Array.isArray(fills) ? fills : [])
    .map(fill => ({
      ...fill,
      shares: round((Number(fill.shares) || 0) * ratio, 8),
      proceeds: round((Number(fill.proceeds) || 0) * ratio, 8),
      fee: round((Number(fill.fee) || 0) * ratio, 8),
    }))
    .filter(fill => fill.shares > EPSILON);
}

function tradeSequenceFromId(id) {
  return Number(String(id || '').match(/^trade-(\d+)$/)?.[1]) || 0;
}

class BtcPriceBandBot {
  constructor(options = {}) {
    this.marketData = options.marketData || marketDataDefault;
    this.now = options.now || Date.now;
    this.config = options.config || config;
    this.startingCapital = Number(options.startingCapital ?? this.config.STARTING_CAPITAL);
    this.cash = this.startingCapital;
    this.realizedPnl = 0;
    this.trades = [];
    this.events = [];
    this.running = false;
    this.error = null;
    this.stateStore = options.stateStore || null;
    this.requirePersistedState = options.requirePersistedState === true;
    this.storageHealthy = !this.stateStore;
    this.persistenceStatus = this.stateStore ? 'NOT_STARTED' : 'DISABLED';
    this.lastStateSavedAt = null;
    this.pendingPersistedState = null;
    this.persistenceTimer = null;
    this.persistenceHeartbeat = null;
    this.persistenceWriteInProgress = false;
    this.startupPromise = null;
    this.restoredMarketId = null;
    this.statusReason = 'Starting the BTC 5-minute price-band paper bot.';
    this.windowStart = null;
    this.windowEnd = null;
    this.market = null;
    this.quotes = { UP: null, DOWN: null };
    this.books = new Map();
    this.sideState = {
      UP: this.emptySideState(),
      DOWN: this.emptySideState(),
    };
    this.activeSide = null;
    this.lastBaseBuyAt = null;
    this.pendingTrigger = null;
    this.entryTriggeredThisWindow = false;
    this.recoveryAdditions = 0;
    this.consecutiveWins = 0;
    this.nextEntryShares = this.config.SHARES_PER_BUY;
    this.martingalePivot = null;
    this.martingaleReentryArmed = false;
    this.martingaleReentriesThisWindow = 0;
    this.martingalePivotedSides = { UP: false, DOWN: false };
    this.martingaleNextShares = this.config.SHARES_PER_BUY;
    this.triggerSequence = 0;
    this.lastAskTrigger = { UP: null, DOWN: null };
    this.terminalEvidence = this.emptyTerminalEvidence();
    this.terminalEvidenceMarketId = null;
    this.websocket = {
      status: 'DISCONNECTED',
      connectedAt: null,
      lastMessageAt: null,
      reconnectCount: 0,
      error: null,
    };
    this.marketStream = null;
    this.streamGeneration = 0;
    this.seenMarketEvents = new Set();
    this.lastMarketRefreshAt = 0;
    this.lastResolutionCheckAt = 0;
    this.terminalObservation = null;
    this.resolutionLastAttemptAt = new Map();
    this.resolutionInFlight = new Set();
    this.interval = null;
    this.tickInProgress = false;
    this.tradeSequence = 0;
    this.eventSequence = 0;
  }

  emptySideState() {
    return {
      status: 'WAITING_FOR_MARKET',
      reason: 'Waiting for the BTC market and its live ask book.',
      lastUpdateAt: null,
      lastBestAsk: null,
      qualifyingUpdates: 0,
      buys: 0,
      sharesBought: 0,
    };
  }

  emptyTerminalEvidence() {
    const emptySide = () => ({
      winnerHitAt: null,
      winnerBid: null,
      loserHitAt: null,
      loserBid: null,
    });
    return { UP: emptySide(), DOWN: emptySide() };
  }

  start() {
    if (this.running) return this.startupPromise;
    this.running = true;
    if (!this.stateStore) {
      this.log('BOT_STARTED', 'BTC 5-minute ask-band paper bot started.');
      void this.tick();
      this.interval = setInterval(() => void this.tick(), this.config.POLL_INTERVAL_MS);
      this.interval.unref?.();
      return Promise.resolve();
    }
    this.persistenceStatus = 'LOADING';
    this.startupPromise = (async () => {
      await this.stateStore.initialize();
      const resetRequestId = String(process.env.BTC_HISTORY_RESET_REQUEST_ID || '').trim();
      let historyWasReset = false;
      if (resetRequestId) {
        if (typeof this.stateStore.resetHistoryOnce !== 'function') {
          throw new Error('A BTC history reset was requested, but the durable store does not support it.');
        }
        historyWasReset = await this.stateStore.resetHistoryOnce(
          resetRequestId,
          this.persistentStateSnapshot(),
        );
      }
      const savedState = await this.stateStore.loadState();
      if (savedState) {
        this.restorePersistentState(savedState);
      } else if (this.requirePersistedState) {
        throw new Error('The durable BTC paper ledger is missing; refusing to start a fresh account.');
      } else {
        await this.stateStore.saveState(this.persistentStateSnapshot());
      }
      this.storageHealthy = true;
      this.persistenceStatus = 'CONNECTED';
      if (savedState) {
        await this.stateStore.saveState(this.persistentStateSnapshot());
        this.lastStateSavedAt = this.now();
      }
      this.error = null;
      this.log('BOT_STARTED', savedState
        ? 'BTC 5-minute ask-band bot restored its paper history from PostgreSQL.'
        : 'BTC 5-minute ask-band paper bot started with a new durable ledger.');
      if (historyWasReset) {
        this.log('BOT_HISTORY_RESET_COMPLETED',
          'BTC paper positions, ledger history, and stored analytics were reset by request.',
          { requestId: resetRequestId });
      }
      void this.tick();
      this.interval = setInterval(() => void this.tick(), this.config.POLL_INTERVAL_MS);
      this.interval.unref?.();
      this.persistenceHeartbeat = setInterval(() => this.schedulePersistedState(true), 60_000);
      this.persistenceHeartbeat.unref?.();
    })().catch(error => {
      this.storageHealthy = false;
      this.persistenceStatus = 'ERROR';
      this.running = false;
      this.error = 'BTC paper-history storage is unavailable; trading is paused.';
      this.statusReason = this.error;
      this.log('STORAGE_ERROR', this.error, {
        errorType: error?.name || 'Error',
      });
    });
    return this.startupPromise;
  }

  stop() {
    this.running = false;
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    if (this.persistenceHeartbeat) clearInterval(this.persistenceHeartbeat);
    this.persistenceHeartbeat = null;
    if (this.persistenceTimer) clearTimeout(this.persistenceTimer);
    this.persistenceTimer = null;
    void this.flushPersistedState();
    this.closeMarketStream();
  }

  log(type, message, details = {}) {
    this.events.unshift({
      id: `event-${++this.eventSequence}`,
      at: this.now(),
      type,
      message,
      ...details,
    });
    this.events = this.events.slice(0, 150);
    const immediate = new Set([
      'BUY_FILLED',
      'BOT_HISTORY_RESET_COMPLETED',
      'PENDING_TRIGGER_CREATED',
      'PENDING_TRIGGER_EXPIRED',
      'PENDING_TRIGGER_SUPERSEDED',
      'OPPOSITE_SIGNAL_SELL',
      'OPPOSITE_SIGNAL_PARTIAL_SELL',
      'MARTINGALE_PIVOT_TRIGGERED',
      'TERMINAL_THRESHOLD_RECORDED',
      'TERMINAL_PRICE_SETTLEMENT',
      'POSITION_RESOLVED',
      'WINDOW_EXPIRED',
    ]).has(type);
    this.schedulePersistedState(immediate);
  }

  restorePersistentState(state) {
    if (state?.schemaVersion !== 1 || !Array.isArray(state.trades)
      || !Array.isArray(state.events) || !Number.isFinite(Number(state.cash))
      || !Number.isFinite(Number(state.startingCapital))
      || !Number.isFinite(Number(state.realizedPnl))) {
      throw new Error('The saved BTC paper ledger has an unsupported or invalid format.');
    }
    this.startingCapital = Number(state.startingCapital);
    this.cash = Number(state.cash);
    this.realizedPnl = Number(state.realizedPnl);
    this.trades = state.trades;
    this.events = state.events.slice(0, 150);
    this.windowStart = state.windowStart == null ? null : Number(state.windowStart);
    this.windowEnd = state.windowEnd == null ? null : Number(state.windowEnd);
    this.restoredMarketId = state.marketId == null ? null : String(state.marketId);
    this.sideState = {
      UP: { ...this.emptySideState(), ...(state.sideState?.UP || {}) },
      DOWN: { ...this.emptySideState(), ...(state.sideState?.DOWN || {}) },
    };
    const latestWindowTrade = this.trades
      .filter(trade => trade.windowStart === this.windowStart
        && (state.marketId == null || trade.marketId === String(state.marketId))
        && trade.status === 'OPEN'
        && !trade.parentTradeId
        && ['UP', 'DOWN'].includes(trade.side))
      .sort((a, b) => Number(b.openedAt || 0) - Number(a.openedAt || 0)
        || tradeSequenceFromId(b.id) - tradeSequenceFromId(a.id))[0];
    this.activeSide = ['UP', 'DOWN'].includes(state.activeSide)
      ? state.activeSide : latestWindowTrade?.side || null;
    this.lastBaseBuyAt = state.lastBaseBuyAt != null
      && Number.isFinite(Number(state.lastBaseBuyAt))
      ? Number(state.lastBaseBuyAt) : null;
    const savedReentryCount = Number(state.martingaleReentriesThisWindow);
    const ledgerReentryCount = this.trades.filter(trade =>
      trade.windowStart === this.windowStart
      && trade.entryMode === 'MARTINGALE_REENTRY'
      && !trade.parentTradeId).length;
    this.martingaleReentriesThisWindow = Math.max(
      ledgerReentryCount,
      Number.isInteger(savedReentryCount) && savedReentryCount >= 0 ? savedReentryCount : 0,
    );
    const savedPending = state.pendingTrigger;
    const allowedPendingModes = this.config.SELLS_ON_OPPOSITE_TRIGGER
      ? ['BASE_ENTRY', 'OPPOSITE_TRIGGER_BUY', 'OPPOSITE_SIGNAL_REVERSAL']
      : ['BASE_ENTRY', 'MARTINGALE_REENTRY'];
    this.pendingTrigger = savedPending
      && ['UP', 'DOWN'].includes(savedPending.side)
      && allowedPendingModes.includes(savedPending.mode)
      && Number(savedPending.windowStart) === this.windowStart
      ? {
        id: savedPending.id,
        side: savedPending.side,
        mode: savedPending.mode === 'BASE_ENTRY' ? 'BASE_ENTRY'
          : savedPending.mode === 'MARTINGALE_REENTRY' ? 'MARTINGALE_REENTRY'
            : 'OPPOSITE_SIGNAL_REVERSAL',
        triggerType: savedPending.triggerType,
        triggerAsk: Number.isFinite(Number(savedPending.triggerAsk))
          ? Number(savedPending.triggerAsk) : null,
        createdAt: Number(savedPending.createdAt) || 0,
        expiresAt: Number(savedPending.expiresAt) || 0,
        windowStart: Number(savedPending.windowStart),
        attempts: Math.max(0, Number(savedPending.attempts) || 0),
        requestedShares: Number(savedPending.requestedShares) > 0
          ? Number(savedPending.requestedShares) : this.config.SHARES_PER_BUY,
        sharesToSell: Math.max(0, Number(savedPending.sharesToSell) || 0),
        sharesSold: Math.max(0, Number(savedPending.sharesSold) || 0),
        sharesBought: Math.max(0, Number(savedPending.sharesBought) || 0),
        unmatchedShares: Math.max(0, Number(savedPending.unmatchedShares) || 0),
        rebuyTargetShares: Math.max(0, Number(savedPending.rebuyTargetShares) || 0),
        grossProceeds: Math.max(0, Number(savedPending.grossProceeds) || 0),
        saleFees: Math.max(0, Number(savedPending.saleFees) || 0),
        netProceeds: Math.max(0, Number(savedPending.netProceeds) || 0),
        lastBlockKey: null,
      } : null;
    const savedMartingalePivot = state.martingalePivot;
    this.martingaleReentryArmed = state.martingaleReentryArmed === true;
    this.martingalePivotedSides = {
      UP: state.martingalePivotedSides?.UP === true,
      DOWN: state.martingalePivotedSides?.DOWN === true,
    };
    this.martingalePivot = savedMartingalePivot
      && ['UP', 'DOWN'].includes(savedMartingalePivot.side)
      && Number(savedMartingalePivot.windowStart) === this.windowStart
      && (state.marketId == null
        || String(savedMartingalePivot.marketId) === String(state.marketId))
      ? {
        side: savedMartingalePivot.side,
        marketId: String(savedMartingalePivot.marketId),
        windowStart: Number(savedMartingalePivot.windowStart),
        triggeredAt: Number(savedMartingalePivot.triggeredAt) || 0,
        triggerBid: Number.isFinite(Number(savedMartingalePivot.triggerBid))
          ? Number(savedMartingalePivot.triggerBid) : null,
        sharesAtTrigger: Math.max(0, Number(savedMartingalePivot.sharesAtTrigger) || 0),
        nextBaseBuyShares: Math.max(
          this.config.SHARES_PER_BUY,
          Number(savedMartingalePivot.nextBaseBuyShares) || this.config.SHARES_PER_BUY,
        ),
      } : null;
    if (this.martingalePivot) {
      this.martingalePivotedSides[this.martingalePivot.side] = true;
      if (!this.config.SELLS_ON_OPPOSITE_TRIGGER
        && state.martingaleReentryArmed == null) {
        this.martingaleReentryArmed = true;
      }
    }
    if (this.martingaleReentriesThisWindow >= this.config.MAX_MARTINGALE_REENTRIES_PER_WINDOW) {
      this.martingaleReentryArmed = false;
      this.martingalePivot = null;
      if (this.pendingTrigger?.mode === 'MARTINGALE_REENTRY') this.pendingTrigger = null;
    } else if (this.pendingTrigger?.mode === 'MARTINGALE_REENTRY'
      && this.pendingTrigger.side !== this.martingaleReentryTargetSide()) {
      this.pendingTrigger = null;
    }
    const savedMartingaleShares = Number(state.martingaleNextShares);
    const savedRecoveryAdditions = Number(state.recoveryAdditions);
    this.recoveryAdditions = Number.isInteger(savedRecoveryAdditions)
      ? Math.max(0, Math.min(this.config.MAX_RECOVERY_ADDITIONS, savedRecoveryAdditions))
      : 0;
    const savedConsecutiveWins = Number(state.consecutiveWins);
    this.consecutiveWins = Number.isInteger(savedConsecutiveWins)
      ? Math.max(0, savedConsecutiveWins) : 0;
    this.syncRecoverySizing();
    this.entryTriggeredThisWindow = state.entryTriggeredThisWindow === true
      || Boolean(this.pendingTrigger)
      || this.trades.some(trade => trade.windowStart === this.windowStart);
    if (!Number.isFinite(savedMartingaleShares)) {
      this.martingaleNextShares = this.nextEntryShares;
    }
    const pendingSequence = Number(String(this.pendingTrigger?.id || '').match(/^trigger-(\d+)$/)?.[1]) || 0;
    this.triggerSequence = Math.max(0, Number(state.triggerSequence) || 0, pendingSequence);
    this.lastAskTrigger = {
      UP: state.lastAskTrigger?.UP ?? null,
      DOWN: state.lastAskTrigger?.DOWN ?? null,
    };
    this.quotes = Object.fromEntries(['UP', 'DOWN'].map(side => {
      const quote = state.quotes?.[side];
      if (!quote || typeof quote !== 'object') return [side, null];
      return [side, {
        ...quote,
        status: 'STALE',
        updatedAt: Number.isFinite(Number(quote.updatedAt)) ? Number(quote.updatedAt) : 0,
      }];
    }));
    this.terminalEvidence = state.terminalEvidence || this.emptyTerminalEvidence();
    this.terminalEvidenceMarketId = state.terminalEvidenceMarketId == null
      ? this.restoredMarketId : String(state.terminalEvidenceMarketId);
    this.terminalObservation = state.terminalObservation || null;
    this.tradeSequence = Math.max(
      Number(state.tradeSequence) || 0,
      ...this.trades.map(trade => {
        const match = String(trade.id || '').match(/^trade-(\d+)$/);
        return match ? Number(match[1]) : 0;
      }),
    );
    this.eventSequence = Math.max(
      Number(state.eventSequence) || 0,
      ...this.events.map(event => {
        const match = String(event.id || '').match(/^event-(\d+)$/);
        return match ? Number(match[1]) : 0;
      }),
    );
    this.books.clear();
    this.seenMarketEvents.clear();
    this.lastResolutionCheckAt = 0;
    this.statusReason = 'Restored the durable BTC paper ledger; reconnecting to the live market.';
  }

  syncRecoverySizing() {
    const baseShares = Math.max(0, Number(this.config.SHARES_PER_BUY) || 0);
    const stepShares = Math.max(0, Number(this.config.RECOVERY_STEP_SHARES) || 0);
    const maxAdditions = Math.max(0, Number(this.config.MAX_RECOVERY_ADDITIONS) || 0);
    this.recoveryAdditions = Math.max(0, Math.min(maxAdditions, Number(this.recoveryAdditions) || 0));
    this.nextEntryShares = round(baseShares + this.recoveryAdditions * stepShares, 8);
    this.martingaleNextShares = this.nextEntryShares;
    return this.nextEntryShares;
  }

  applyWindowRecoveryOutcome(windowStart, now = this.now()) {
    if (windowStart == null) return false;
    const trades = this.trades.filter(trade => trade.windowStart === windowStart);
    if (!trades.length || trades.some(trade => trade.recoveryProgressionApplied)
      || trades.some(trade => ['OPEN', 'AWAITING_RESOLUTION'].includes(trade.status))) {
      return false;
    }

    for (const trade of trades) trade.recoveryProgressionApplied = true;
    const netPnl = trades.reduce((sum, trade) => sum + (Number(trade.realizedPnl) || 0), 0);
    if (netPnl > EPSILON) {
      const additionsBeforeWin = this.recoveryAdditions;
      this.consecutiveWins += 1;
      const resetAfterWin = () => {
        this.recoveryAdditions = 0;
        this.consecutiveWins = 0;
      };
      if (additionsBeforeWin >= 7) {
        if (this.consecutiveWins >= this.config.RESET_AT_SEVEN_ADDITIONS_WINS) resetAfterWin();
      } else if (additionsBeforeWin === 4) {
        if (this.consecutiveWins >= this.config.RESET_AT_FOUR_ADDITIONS_WINS) resetAfterWin();
      } else {
        this.recoveryAdditions = Math.max(0, additionsBeforeWin - 1);
        if (this.recoveryAdditions === 4
          && this.consecutiveWins >= this.config.RESET_AT_FOUR_ADDITIONS_WINS) {
          resetAfterWin();
        }
      }
    } else {
      this.consecutiveWins = 0;
    }

    this.syncRecoverySizing();
    this.log(netPnl > EPSILON ? 'RECOVERY_WIN_RECORDED' : 'RECOVERY_LOSS_RECORDED',
      netPnl > EPSILON
        ? `Window win recorded; next entry size is ${this.nextEntryShares} shares.`
        : `Window loss recorded; recovery size remains ${this.nextEntryShares} shares.`,
      {
        windowStart,
        netPnl: round(netPnl),
        recoveryAdditions: this.recoveryAdditions,
        consecutiveWins: this.consecutiveWins,
        nextEntryShares: this.nextEntryShares,
        at: now,
      });
    return true;
  }

  advanceRecoveryAfterStopLoss(windowStart, stoppedTrades, now = this.now()) {
    const trades = this.trades.filter(trade => trade.windowStart === windowStart
      && trade.stopLossTriggeredAt != null);
    if (!trades.length || trades.some(trade => trade.recoveryProgressionApplied)) return false;
    for (const trade of trades) trade.recoveryProgressionApplied = true;
    const additionsBeforeStop = this.recoveryAdditions;
    this.recoveryAdditions = Math.min(
      this.config.MAX_RECOVERY_ADDITIONS,
      this.recoveryAdditions + 1,
    );
    this.consecutiveWins = 0;
    this.syncRecoverySizing();
    this.log('RECOVERY_ADDITION_ADDED',
      additionsBeforeStop < this.config.MAX_RECOVERY_ADDITIONS
        ? `Stop-loss completed; next window adds 50 shares, for ${this.nextEntryShares} total shares.`
        : `Stop-loss completed at the 10-addition cap; next entry remains ${this.nextEntryShares} shares.`,
      {
        windowStart,
        stoppedTradeIds: stoppedTrades.map(trade => trade.id),
        recoveryAdditions: this.recoveryAdditions,
        maxRecoveryAdditions: this.config.MAX_RECOVERY_ADDITIONS,
        nextEntryShares: this.nextEntryShares,
        at: now,
      });
    return true;
  }

  processStopLoss(now = this.now()) {
    if (!this.market || this.windowStart == null
      || (this.stateStore && !this.storageHealthy)) return false;
    let changed = false;
    for (const side of ['UP', 'DOWN']) {
      const trades = this.currentWindowOpenTrades(side);
      if (!trades.length) continue;
      const quote = this.quotes[side];
      const quoteIsFresh = this.quoteIsFresh(quote, now) && Number.isFinite(quote.bestBid);
      const alreadyTriggered = trades.some(trade => trade.stopLossTriggeredAt != null);
      if (!alreadyTriggered
        && (!quoteIsFresh || quote.bestBid > this.config.STOP_LOSS_BID + EPSILON)) continue;

      for (const trade of trades) {
        if (trade.stopLossTriggeredAt == null) {
          trade.stopLossTriggeredAt = now;
          trade.stopLossTriggerBid = quoteIsFresh ? quote.bestBid : null;
          trade.stopLossBookAtTrigger = this.bidBookAudit(side);
          changed = true;
        }
      }
      const requestedShares = round(
        trades.reduce((sum, trade) => sum + Number(trade.shares || 0), 0),
        8,
      );
      const preview = this.sweepBids(side, requestedShares, { consume: false });
      const state = this.sideState[side];
      if (!preview?.complete) {
        state.status = 'STOP_LOSS_WAITING_FOR_DEPTH';
        state.reason = `Bid reached $${this.config.STOP_LOSS_BID.toFixed(2)}; waiting for enough visible bids to sell all ${requestedShares} shares.`;
        const blockKey = `${state.status}|${requestedShares}`;
        if (trades.some(trade => trade.stopLossLastBlockKey !== blockKey)) {
          this.log('STOP_LOSS_WAITING_FOR_DEPTH', state.reason, {
            side,
            requestedShares,
            availableShares: round(preview?.shares || 0),
            stopLossBid: this.config.STOP_LOSS_BID,
            bidBookAtTrigger: trades[0]?.stopLossBookAtTrigger ?? null,
            bidBookAtRetry: this.bidBookAudit(side),
          });
          for (const trade of trades) trade.stopLossLastBlockKey = blockKey;
          changed = true;
        }
        continue;
      }

      const execution = this.sweepBids(side, requestedShares);
      if (!execution?.complete) continue;
      this.closePositionsOnOppositeSignal(trades, execution, now, side, 'STOP_LOSS');
      this.advanceRecoveryAfterStopLoss(this.windowStart, trades, now);
      state.status = 'STOP_LOSS_FILLED';
      state.reason = `Sold all ${requestedShares} ${side} shares after the $${this.config.STOP_LOSS_BID.toFixed(2)} stop-loss trigger.`;
      this.log('STOP_LOSS_FILLED', state.reason, {
        side,
        shares: requestedShares,
        triggerBid: trades[0]?.stopLossTriggerBid ?? quote.bestBid,
        averageExitPrice: round(execution.averagePrice),
        proceeds: round(execution.netProceeds),
        fees: round(execution.fees),
        fills: execution.fills,
        bidBookAtTrigger: trades[0]?.stopLossBookAtTrigger ?? null,
        bidBookAtFill: this.bidBookAudit(side),
      });
      changed = true;
    }
    if (changed) this.schedulePersistedState(true);
    return changed;
  }

  persistentStateSnapshot() {
    const state = {
      schemaVersion: 1,
      persistenceSource: 'runtime',
      strategyVersion: this.config.STRATEGY_VERSION,
      startingCapital: this.startingCapital,
      cash: this.cash,
      realizedPnl: this.realizedPnl,
      trades: this.trades,
      events: this.events,
      tradeSequence: this.tradeSequence,
      eventSequence: this.eventSequence,
      windowStart: this.windowStart,
      windowEnd: this.windowEnd,
      marketId: this.market?.id == null ? this.restoredMarketId : String(this.market.id),
      sideState: this.sideState,
      activeSide: this.activeSide,
      lastBaseBuyAt: this.lastBaseBuyAt,
      pendingTrigger: this.pendingTrigger,
      entryTriggeredThisWindow: this.entryTriggeredThisWindow,
      recoveryAdditions: this.recoveryAdditions,
      consecutiveWins: this.consecutiveWins,
      nextEntryShares: this.nextEntryShares,
      triggerSequence: this.triggerSequence,
      lastAskTrigger: this.lastAskTrigger,
      quotes: this.quotes,
      terminalEvidence: this.terminalEvidence,
      terminalEvidenceMarketId: this.terminalEvidenceMarketId,
      terminalObservation: this.terminalObservation,
    };
    return JSON.parse(JSON.stringify(state));
  }

  schedulePersistedState(immediate = false) {
    if (!this.stateStore || !this.storageHealthy) return;
    this.pendingPersistedState = this.persistentStateSnapshot();
    if (immediate) {
      if (this.persistenceTimer) clearTimeout(this.persistenceTimer);
      this.persistenceTimer = null;
      void this.flushPersistedState();
      return;
    }
    if (this.persistenceTimer) return;
    this.persistenceTimer = setTimeout(() => {
      this.persistenceTimer = null;
      void this.flushPersistedState();
    }, 500);
    this.persistenceTimer.unref?.();
  }

  async flushPersistedState() {
    if (!this.stateStore || !this.storageHealthy || this.persistenceWriteInProgress) return;
    this.persistenceWriteInProgress = true;
    try {
      while (this.pendingPersistedState && this.storageHealthy) {
        const state = this.pendingPersistedState;
        this.pendingPersistedState = null;
        await this.stateStore.saveState(state);
        this.lastStateSavedAt = this.now();
      }
    } catch (error) {
      this.storageHealthy = false;
      this.persistenceStatus = 'ERROR';
      this.error = 'BTC paper-history storage is unavailable; new buys are paused.';
      this.statusReason = this.error;
    } finally {
      this.persistenceWriteInProgress = false;
      if (this.pendingPersistedState && this.storageHealthy) {
        void this.flushPersistedState();
      }
    }
  }

  closeMarketStream() {
    this.streamGeneration += 1;
    if (this.marketStream) {
      try {
        this.marketStream.close();
      } catch {
        // Closing a stale socket must not interrupt the next window.
      }
    }
    this.marketStream = null;
  }

  resetWindow(start) {
    if (this.windowStart === start) return;
    const previousStart = this.windowStart;
    if (previousStart != null) this.processStopLoss(this.now());
    this.markOpenPositions(this.now());
    for (const trade of this.trades) {
      if (trade.status === 'OPEN' && trade.windowStart < start) {
        trade.status = 'AWAITING_RESOLUTION';
        trade.settlementStatus = 'AWAITING_SETTLEMENT';
        trade.awaitingResolutionAt = this.now();
      }
    }
    if (previousStart != null) {
      const moved = this.trades.filter(trade =>
        trade.windowStart === previousStart && trade.status === 'AWAITING_RESOLUTION').length;
      if (moved) {
        this.log('WINDOW_EXPIRED',
          `${moved} BTC position(s) moved to resolution after the 5-minute window ended.`,
          { windowStart: previousStart, positions: moved });
      }
    }
    this.closeMarketStream();
    this.windowStart = start;
    this.windowEnd = start + this.config.WINDOW_MS;
    this.market = null;
    this.quotes = { UP: null, DOWN: null };
    this.books.clear();
    this.sideState = { UP: this.emptySideState(), DOWN: this.emptySideState() };
    this.activeSide = null;
    this.lastBaseBuyAt = null;
    this.pendingTrigger = null;
    this.entryTriggeredThisWindow = false;
    this.syncRecoverySizing();
    this.martingaleReentryArmed = false;
    this.martingaleReentriesThisWindow = 0;
    this.martingalePivot = null;
    this.martingalePivotedSides = { UP: false, DOWN: false };
    this.lastAskTrigger = { UP: null, DOWN: null };
    this.seenMarketEvents.clear();
    this.terminalObservation = null;
    this.terminalEvidence = this.emptyTerminalEvidence();
    this.terminalEvidenceMarketId = null;
    this.restoredMarketId = null;
    this.websocket = {
      status: 'DISCONNECTED',
      connectedAt: null,
      lastMessageAt: null,
      reconnectCount: 0,
      error: null,
    };
    this.lastMarketRefreshAt = 0;
    this.statusReason = 'Looking up the current BTC 5-minute Polymarket market.';
  }

  async refreshMarket(now) {
    if (this.market?.start === this.windowStart
      && now - this.lastMarketRefreshAt < this.config.MARKET_REFRESH_MS) return;
    this.lastMarketRefreshAt = now;
    const market = await this.marketData.getBtcMarket(this.windowStart, this.config.WINDOW_MS);
    if (!market) {
      this.statusReason = 'Waiting for the current BTC 5-minute Polymarket market.';
      return;
    }
    if (market.start !== this.windowStart || market.end !== this.windowEnd
      || !market.tokens?.UP || !market.tokens?.DOWN) {
      throw new Error('BTC UP/DOWN outcomes do not match the current 5-minute window.');
    }

    const restoredSameMarket = !this.market && this.restoredMarketId != null
      && String(this.restoredMarketId) === String(market.id);
    const changed = !restoredSameMarket && (!this.market
      || String(this.market.id) !== String(market.id)
      || this.market.tokens.UP !== market.tokens.UP
      || this.market.tokens.DOWN !== market.tokens.DOWN);
    this.market = market;
    if (changed) {
      this.quotes = { UP: null, DOWN: null };
      this.books.clear();
      this.sideState = { UP: this.emptySideState(), DOWN: this.emptySideState() };
      this.activeSide = null;
      this.lastBaseBuyAt = null;
      this.pendingTrigger = null;
      this.martingalePivot = null;
      this.martingalePivotedSides = { UP: false, DOWN: false };
      this.lastAskTrigger = { UP: null, DOWN: null };
      this.terminalEvidence = this.emptyTerminalEvidence();
      this.terminalEvidenceMarketId = String(market.id);
      this.terminalObservation = null;
      this.startMarketStream(market);
      this.schedulePersistedState(true);
    } else if (restoredSameMarket) {
      this.restoredMarketId = null;
      this.terminalEvidenceMarketId = String(market.id);
      this.startMarketStream(market);
      this.schedulePersistedState(true);
    }
    this.statusReason = 'BTC market loaded; waiting for live UP/DOWN ask updates.';
    this.error = null;
  }

  startMarketStream(market) {
    this.closeMarketStream();
    const generation = this.streamGeneration;
    if (typeof this.marketData.connectMarketStream !== 'function') {
      throw new Error('Polymarket market WebSocket is unavailable.');
    }
    this.websocket = {
      status: 'CONNECTING',
      connectedAt: null,
      lastMessageAt: null,
      reconnectCount: 0,
      error: null,
    };
    this.marketStream = this.marketData.connectMarketStream(
      [market.tokens.UP, market.tokens.DOWN],
      {
        heartbeatMs: this.config.WS_HEARTBEAT_MS,
        reconnectMinMs: this.config.WS_RECONNECT_MIN_MS,
        reconnectMaxMs: this.config.WS_RECONNECT_MAX_MS,
        onStatus: update => {
          if (generation !== this.streamGeneration) return;
          this.websocket = { ...this.websocket, ...update };
          if (update.status === 'CONNECTED') {
            this.websocket.connectedAt = this.now();
            this.websocket.error = null;
            this.statusReason = 'Connected to Polymarket; waiting for BTC UP/DOWN order books.';
          } else if (update.status === 'DISCONNECTED' || update.status === 'ERROR') {
            this.websocket.error = update.error || null;
            this.statusReason = 'Polymarket WebSocket reconnecting; stale prices cannot trigger buys.';
          }
        },
        onMessage: event => {
          if (generation !== this.streamGeneration) return;
          try {
            this.handleMarketMessage(event);
          } catch (error) {
            this.websocket.error = error?.message || 'Could not process a Polymarket update.';
            this.log('WEBSOCKET_MESSAGE_ERROR', this.websocket.error);
          }
        },
      },
    );
  }

  sideForToken(tokenId) {
    if (!this.market) return null;
    const token = String(tokenId || '');
    if (token === String(this.market.tokens.UP)) return 'UP';
    if (token === String(this.market.tokens.DOWN)) return 'DOWN';
    return null;
  }

  rememberEvent(event) {
    const key = JSON.stringify(event);
    if (this.seenMarketEvents.has(key)) return false;
    this.seenMarketEvents.add(key);
    if (this.seenMarketEvents.size > 500) {
      this.seenMarketEvents.delete(this.seenMarketEvents.values().next().value);
    }
    return true;
  }

  handleMarketMessage(event) {
    if (Array.isArray(event)) {
      for (const item of event) this.handleMarketMessage(item);
      return;
    }
    if (!event || typeof event !== 'object') return;
    const type = event.event_type || event.eventType;
    if (!type || type === 'PONG') return;
    const now = this.now();
    this.websocket.lastMessageAt = now;
    this.websocket.error = null;
    if (type === 'book') {
      if (!this.rememberEvent(event)) return;
      this.handleBookSnapshot(event, now);
    } else if (type === 'price_change') {
      if (!this.rememberEvent(event)) return;
      this.handlePriceChanges(event, now);
    } else if (type === 'best_bid_ask') {
      this.handleBestBidAsk(event, now);
    }
    this.maybeSettleAtTerminalPrice(now);
    this.retryPendingTrigger(now);
    this.markOpenPositions(now);
  }

  handleBookSnapshot(event, now) {
    const tokenId = String(event.asset_id || event.assetId || '');
    const side = this.sideForToken(tokenId);
    if (!side) return;
    const previous = this.books.get(tokenId);
    const previousBestAsk = previous?.asks?.[0]?.price ?? this.quotes[side]?.bestAsk ?? null;
    const asks = reconcileLevels(previous?.asks, normalizeLevels(event.asks, 'asks'), {
      refreshVisibleDepth: this.config.ONE_TRIGGER_PER_WINDOW,
    });
    const bids = reconcileLevels(previous?.bids, normalizeLevels(event.bids, 'bids'), {
      refreshVisibleDepth: this.config.ONE_TRIGGER_PER_WINDOW,
    });
    const book = {
      asks,
      bids,
      updatedAt: now,
      sourceTimestamp: sourceTimestamp(event.timestamp),
    };
    this.books.set(tokenId, book);
    this.updateQuoteFromBook(side, tokenId, book, now, event.timestamp);
    const nextBestAsk = asks[0]?.price ?? null;
    if (bestAskPriceChanged(previousBestAsk, nextBestAsk)
      && this.handleAskTrigger(side, now, 'BEST_ASK_PRICE_CHANGE')) {
      this.recordAskTrigger(side, 'BOOK_UPDATE', event.timestamp);
    }
  }

  handlePriceChanges(event, now) {
    const changes = Array.isArray(event.price_changes)
      ? event.price_changes
      : Array.isArray(event.priceChanges) ? event.priceChanges : [];
    const byToken = new Map();
    for (const change of changes) {
      const tokenId = String(change.asset_id || change.assetId || '');
      const side = this.sideForToken(tokenId);
      if (!side) continue;
      if (!byToken.has(tokenId)) byToken.set(tokenId, { side, changes: [], askChanged: false });
      const group = byToken.get(tokenId);
      group.changes.push(change);
      const bookSide = String(change.side || '').toUpperCase();
      if (bookSide === 'SELL' || bookSide === 'ASK' || bookSide === 'ASKS') {
        group.askChanged = true;
      }
    }
    for (const [tokenId, group] of byToken) {
      const book = this.books.get(tokenId);
      if (!book) continue;
      const previousBestAsk = book.asks[0]?.price ?? null;
      for (const change of group.changes) this.applyLevelChange(book, change);
      const nextBestAsk = book.asks[0]?.price ?? null;
      book.updatedAt = now;
      book.sourceTimestamp = sourceTimestamp(event.timestamp);
      this.updateQuoteFromBook(group.side, tokenId, book, now, event.timestamp);
      if (group.askChanged && bestAskPriceChanged(previousBestAsk, nextBestAsk)) {
        if (this.isDuplicateAskTrigger(group.side, 'ASK_PRICE_UPDATE', event.timestamp)) {
          this.lastAskTrigger[group.side] = null;
          continue;
        }
        if (this.handleAskTrigger(group.side, now, 'ASK_PRICE_UPDATE')) {
          this.recordAskTrigger(group.side, 'ASK_PRICE_UPDATE', event.timestamp);
        }
      }
    }
  }

  askTriggerSignature(side, timestamp) {
    return {
      timestamp: sourceTimestamp(timestamp),
      bestAsk: this.quotes[side]?.bestAsk ?? null,
    };
  }

  recordAskTrigger(side, source, timestamp) {
    this.lastAskTrigger[side] = {
      source,
      ...this.askTriggerSignature(side, timestamp),
    };
  }

  isDuplicateAskTrigger(side, source, timestamp) {
    const previous = this.lastAskTrigger[side];
    if (!previous || previous.source === source) return false;
    const current = this.askTriggerSignature(side, timestamp);
    return current.timestamp != null
      && previous.timestamp === current.timestamp
      && current.bestAsk != null
      && previous.bestAsk != null
      && Math.abs(previous.bestAsk - current.bestAsk) < EPSILON;
  }

  applyLevelChange(book, change) {
    const price = numeric(change.price);
    const size = numeric(change.size);
    if (!(price > 0 && price < 1) || size == null) return;
    const side = String(change.side || '').toUpperCase();
    const levels = side === 'SELL' || side === 'ASK' || side === 'ASKS'
      ? book.asks
      : side === 'BUY' || side === 'BID' || side === 'BIDS' ? book.bids : null;
    if (!levels) return;
    const index = levels.findIndex(level => Math.abs(level.price - price) < EPSILON);
    if (size <= 0) {
      if (index >= 0) levels.splice(index, 1);
      return;
    }
    if (index >= 0) {
      const level = levels[index];
      level.availableSize = this.config.ONE_TRIGGER_PER_WINDOW
        ? size
        : Math.max(0, level.availableSize + size - level.size);
      level.size = size;
    } else {
      levels.push({ price, size, availableSize: size });
    }
    levels.sort((a, b) => side === 'SELL' || side === 'ASK' || side === 'ASKS'
      ? a.price - b.price : b.price - a.price);
  }

  handleBestBidAsk(event, now) {
    const tokenId = String(event.asset_id || event.assetId || '');
    const side = this.sideForToken(tokenId);
    if (!side) return;
    const previous = this.quotes[side] || {};
    const previousBestAsk = previous.bestAsk ?? null;
    const bestAsk = numeric(event.best_ask ?? event.bestAsk);
    const bestBid = numeric(event.best_bid ?? event.bestBid);
    this.quotes[side] = {
      ...previous,
      asset: 'BTC',
      side,
      tokenId,
      bestAsk: bestAsk ?? previous.bestAsk ?? null,
      askSize: previous.askSize ?? 0,
      bestBid: bestBid ?? previous.bestBid ?? null,
      bidSize: previous.bidSize ?? 0,
      midpoint: bestAsk != null && bestBid != null ? (bestAsk + bestBid) / 2 : previous.midpoint ?? null,
      updatedAt: now,
      sourceTimestamp: sourceTimestamp(event.timestamp),
      status: 'LIVE',
      error: null,
      eventType: 'BEST_BID_ASK',
    };
    this.recordTerminalEvidence(side, now);
    this.processStopLoss(now);
    const bestAskChanged = bestAsk != null
      && (previousBestAsk == null || Math.abs(bestAsk - previousBestAsk) >= EPSILON);
    if (bestAskChanged) {
      if (this.isDuplicateAskTrigger(side, 'BEST_BID_ASK', event.timestamp)) {
        this.lastAskTrigger[side] = null;
      } else if (this.handleAskTrigger(side, now, 'BEST_BID_ASK')) {
        this.recordAskTrigger(side, 'BEST_BID_ASK', event.timestamp);
      }
    }
  }

  updateQuoteFromBook(side, tokenId, book, now, timestamp) {
    const ask = book.asks[0] || null;
    const bid = book.bids[0] || null;
    this.quotes[side] = {
      asset: 'BTC',
      side,
      tokenId,
      bestAsk: ask?.price ?? null,
      askSize: ask?.size ?? 0,
      availableAskSize: ask?.availableSize ?? 0,
      bestBid: bid?.price ?? null,
      bidSize: bid?.size ?? 0,
      midpoint: ask && bid ? (ask.price + bid.price) / 2 : null,
      updatedAt: now,
      sourceTimestamp: sourceTimestamp(timestamp),
      status: 'LIVE',
      error: null,
      eventType: 'ORDER_BOOK',
    };
    this.recordTerminalEvidence(side, now);
    return this.processStopLoss(now);
  }

  processMartingalePivot(now = this.now()) {
    if (!this.market || this.windowStart == null || this.terminalObservation?.winner
      || (this.stateStore && !this.storageHealthy)) return false;
    if (this.martingaleReentriesThisWindow >= this.config.MAX_MARTINGALE_REENTRIES_PER_WINDOW) {
      return false;
    }
    if (this.martingaleReentryArmed) return false;

    const pivot = this.martingalePivot;
    if (pivot && (pivot.windowStart !== this.windowStart
      || pivot.marketId !== String(this.market.id)
      || this.currentWindowOpenTrades(pivot.side).length === 0)) {
      this.martingalePivot = null;
    }
    if (this.martingalePivot) return false;

    const side = this.activeSideForWindow();
    if (!['UP', 'DOWN'].includes(side)) return false;

    const quote = this.quotes[side];
    const shares = round(this.currentWindowOpenTrades(side)
      .reduce((sum, trade) => sum + trade.shares, 0), 8);
    if (shares <= EPSILON || this.martingalePivotedSides[side]
      || !this.quoteIsFresh(quote, now)
      || !Number.isFinite(quote.bestBid)
      || quote.bestBid > this.config.MARTINGALE_PIVOT_BID) return false;
    const nextBaseBuyShares = round(
      Math.max(this.martingaleNextShares, shares) * this.config.MARTINGALE_MULTIPLIER,
      8,
    );
    this.martingaleNextShares = nextBaseBuyShares;
    this.martingaleReentryArmed = true;
    this.martingalePivotedSides[side] = true;
    this.martingalePivot = {
      side,
      marketId: String(this.market.id),
      windowStart: this.windowStart,
      triggeredAt: now,
      triggerBid: quote.bestBid,
      sharesAtTrigger: shares,
      nextBaseBuyShares,
    };

    const state = this.sideState[side];
    state.status = 'MARTINGALE_PIVOT_TRIGGERED';
    const oppositeSide = side === 'UP' ? 'DOWN' : 'UP';
    state.reason = `Best bid reached the $${this.config.MARTINGALE_PIVOT_BID.toFixed(2)} martingale pivot; holding ${shares} ${side} shares and arming a ${nextBaseBuyShares}-share ${oppositeSide} buy. ${this.martingaleReentriesThisWindow} of ${this.config.MAX_MARTINGALE_REENTRIES_PER_WINDOW} additional martingale buys used this window.`;
    state.lastUpdateAt = now;
    this.log('MARTINGALE_PIVOT_TRIGGERED', state.reason, {
      side,
      triggerBid: quote.bestBid,
      threshold: this.config.MARTINGALE_PIVOT_BID,
      shares,
      multiplier: this.config.MARTINGALE_MULTIPLIER,
      nextBaseBuyShares,
      martingaleReentriesThisWindow: this.martingaleReentriesThisWindow,
      maxMartingaleReentriesPerWindow: this.config.MAX_MARTINGALE_REENTRIES_PER_WINDOW,
      soldShares: 0,
    });
    return true;
  }

  recordTerminalEvidence(side, now) {
    if (!this.market || this.windowStart == null || now >= this.windowEnd) return;
    const marketId = String(this.market.id);
    if (this.terminalEvidenceMarketId !== marketId) {
      this.terminalEvidence = this.emptyTerminalEvidence();
      this.terminalEvidenceMarketId = marketId;
      this.terminalObservation = null;
    }
    const quote = this.quotes[side];
    if (!this.quoteIsFresh(quote, now) || !Number.isFinite(quote.bestBid)) return;
    const evidence = this.terminalEvidence[side];
    if (quote.bestBid >= this.config.TERMINAL_WINNER_BID && evidence.winnerHitAt == null) {
      evidence.winnerHitAt = now;
      evidence.winnerBid = quote.bestBid;
      this.log('TERMINAL_THRESHOLD_RECORDED',
        `${side} reached the $0.99 winner threshold during this BTC window.`,
        { side, threshold: 'WINNER', bid: quote.bestBid, observedAt: now });
    }
    if (quote.bestBid < this.config.TERMINAL_LOSER_BID && evidence.loserHitAt == null) {
      evidence.loserHitAt = now;
      evidence.loserBid = quote.bestBid;
      this.log('TERMINAL_THRESHOLD_RECORDED',
        `${side} fell below the $0.01 loser threshold during this BTC window.`,
        { side, threshold: 'LOSER', bid: quote.bestBid, observedAt: now });
    }
  }

  quoteIsFresh(quote, now) {
    return quote?.status === 'LIVE'
      && Number.isFinite(quote.updatedAt)
      && now >= quote.updatedAt
      && now - quote.updatedAt <= this.config.MAX_QUOTE_AGE_MS;
  }

  sweepAsks(side, requestedShares, {
    consume = true,
    minPrice = this.config.MIN_ENTRY_ASK,
    maxPrice = this.config.MAX_ENTRY_ASK,
  } = {}) {
    const market = this.market;
    const quote = this.quotes[side];
    const tokenId = String(market?.tokens?.[side] || '');
    const book = this.books.get(tokenId);
    if (!book || !this.quoteIsFresh(quote, this.now())) return null;
    if (Math.abs((book.asks[0]?.price ?? NaN) - quote.bestAsk) >= EPSILON) return null;
    const parameters = feeParameters(market);
    let remaining = requestedShares;
    let grossCost = 0;
    let fees = 0;
    const fills = [];
    for (const level of book.asks) {
      if (remaining <= EPSILON || level.price > maxPrice) break;
      if (level.price < minPrice) continue;
      const shares = Math.min(remaining, Math.max(0, level.availableSize));
      if (shares <= EPSILON) continue;
      const cost = shares * level.price;
      const fee = takerFeeAt(level.price, shares, parameters);
      fills.push({ level, price: level.price, shares, cost, fee });
      grossCost += cost;
      fees += fee;
      remaining -= shares;
    }
    const complete = remaining <= EPSILON;
    if (complete && consume) {
      for (const fill of fills) fill.level.availableSize -= fill.shares;
    }
    return {
      tokenId,
      shares: requestedShares - remaining,
      remainingShares: Math.max(0, remaining),
      grossCost,
      fees,
      totalCost: grossCost + fees,
      averagePrice: grossCost / Math.max(EPSILON, requestedShares - remaining),
      fills: fills.map(({ level, ...fill }) => fill),
      complete,
    };
  }

  sweepBids(side, requestedShares, { consume = true } = {}) {
    const market = this.market;
    const quote = this.quotes[side];
    const tokenId = String(market?.tokens?.[side] || '');
    const book = this.books.get(tokenId);
    if (!book || !this.quoteIsFresh(quote, this.now())) return null;
    if (Math.abs((book.bids[0]?.price ?? NaN) - quote.bestBid) >= EPSILON) return null;
    const parameters = feeParameters(market);
    let remaining = requestedShares;
    let grossProceeds = 0;
    let fees = 0;
    const fills = [];
    for (const level of book.bids) {
      if (remaining <= EPSILON) break;
      const shares = Math.min(remaining, Math.max(0, level.availableSize));
      if (shares <= EPSILON) continue;
      const proceeds = shares * level.price;
      const fee = takerFeeAt(level.price, shares, parameters);
      fills.push({ level, price: level.price, shares, proceeds, fee });
      grossProceeds += proceeds;
      fees += fee;
      remaining -= shares;
    }
    const complete = remaining <= EPSILON;
    if (complete && consume) {
      for (const fill of fills) fill.level.availableSize -= fill.shares;
    }
    const sharesFilled = requestedShares - remaining;
    return {
      tokenId,
      shares: sharesFilled,
      remainingShares: Math.max(0, remaining),
      grossProceeds,
      fees,
      netProceeds: grossProceeds - fees,
      averagePrice: grossProceeds / Math.max(EPSILON, sharesFilled),
      fills: fills.map(({ level, ...fill }) => fill),
      complete,
    };
  }

  bidBookAudit(side, limit = 10) {
    const tokenId = String(this.market?.tokens?.[side] || '');
    const quote = this.quotes[side];
    const book = this.books.get(tokenId);
    const levels = book?.bids || [];
    return {
      side,
      tokenId,
      quoteBestBid: quote?.bestBid ?? null,
      quoteUpdatedAt: quote?.updatedAt ?? null,
      quoteSourceTimestamp: quote?.sourceTimestamp ?? null,
      bookBestBid: levels[0]?.price ?? null,
      bookUpdatedAt: book?.updatedAt ?? null,
      bookSourceTimestamp: book?.sourceTimestamp ?? null,
      displayedBidShares: round(levels.reduce((sum, level) => sum + (Number(level.size) || 0), 0)),
      availableBidShares: round(levels.reduce((sum, level) => sum + (Number(level.availableSize) || 0), 0)),
      topBidLevels: levels.slice(0, limit).map(level => ({
        price: level.price,
        displayedShares: level.size,
        availableShares: level.availableSize,
      })),
    };
  }

  currentWindowOpenTrades(side = null) {
    return this.trades.filter(trade => trade.status === 'OPEN'
      && trade.windowStart === this.windowStart
      && (!this.market?.id || trade.marketId === String(this.market.id))
      && (!side || trade.side === side));
  }

  activeSideForWindow() {
    if (['UP', 'DOWN'].includes(this.activeSide)) return this.activeSide;
    const latestTrade = this.currentWindowOpenTrades()
      .filter(trade => !trade.parentTradeId)
      .sort((a, b) => Number(b.openedAt || 0) - Number(a.openedAt || 0)
        || tradeSequenceFromId(b.id) - tradeSequenceFromId(a.id))[0];
    this.activeSide = latestTrade?.side || null;
    return this.activeSide;
  }

  martingaleReentryTargetSide() {
    if (!this.martingaleReentryArmed
      || this.martingaleReentriesThisWindow >= this.config.MAX_MARTINGALE_REENTRIES_PER_WINDOW
      || this.currentWindowOpenTrades().length === 0) return null;
    const latestPositionSide = this.activeSideForWindow();
    if (!['UP', 'DOWN'].includes(latestPositionSide)) return null;
    return latestPositionSide === 'UP' ? 'DOWN' : 'UP';
  }

  handleAskTrigger(side, now, triggerType) {
    const state = this.sideState[side];
    const quote = this.quotes[side];
    const openTrades = this.currentWindowOpenTrades();
    const activeSide = openTrades.length > 0 ? this.activeSideForWindow() : null;
    const martingaleTargetSide = this.martingaleReentryTargetSide();
    const isMartingaleReentry = !this.config.SELLS_ON_OPPOSITE_TRIGGER
      && side === martingaleTargetSide;
    state.lastUpdateAt = now;
    state.lastBestAsk = quote?.bestAsk ?? null;
    if (this.stateStore && !this.storageHealthy) {
      state.status = 'PAPER_HISTORY_STORAGE_ERROR';
      state.reason = 'Trading is paused until durable paper history storage is available.';
      return false;
    }
    if (this.terminalObservation?.winner) {
      state.status = 'WINDOW_ALREADY_SETTLED';
      state.reason = `The ${this.terminalObservation.winner} side already settled this window.`;
      return false;
    }

    if (this.pendingTrigger) {
      if (this.pendingTrigger.side === side) {
        if (this.pendingTrigger.mode === 'MARTINGALE_REENTRY' && !isMartingaleReentry) {
          return false;
        }
        state.status = 'PENDING_TRIGGER';
        state.reason = `Retrying the pending ${side} trigger until it fills or expires.`;
        return true;
      }
      const canReplaceBaseEntry = !this.config.ONE_TRIGGER_PER_WINDOW
        && this.pendingTrigger.mode === 'BASE_ENTRY'
        && this.activeSideForWindow() == null
        && this.currentWindowOpenTrades().length === 0;
      const canReplaceMartingaleEntry = this.pendingTrigger.mode === 'MARTINGALE_REENTRY'
        && isMartingaleReentry;
      if (!canReplaceBaseEntry && !canReplaceMartingaleEntry) {
        if (this.config.ONE_TRIGGER_PER_WINDOW && this.entryTriggeredThisWindow) {
          state.status = 'ONE_TRIGGER_PER_WINDOW';
          state.reason = 'The window already used its single entry trigger.';
        }
        return false;
      }
      if (!this.quoteIsFresh(quote, now) || !Number.isFinite(quote?.bestAsk)
        || quote.bestAsk < this.config.MIN_ENTRY_ASK
        || quote.bestAsk > this.config.MAX_ENTRY_ASK) return false;
      const superseded = this.pendingTrigger;
      this.pendingTrigger = null;
      this.sideState[superseded.side].status = 'PENDING_TRIGGER_SUPERSEDED';
      this.sideState[superseded.side].reason = `Pending ${superseded.side} entry was replaced by a newer ${side} trigger.`;
      this.log('PENDING_TRIGGER_SUPERSEDED', this.sideState[superseded.side].reason, {
        triggerId: superseded.id,
        side: superseded.side,
        replacedBySide: side,
      });
    }
    if (!this.quoteIsFresh(quote, now) || !Number.isFinite(quote.bestAsk)) {
      state.status = 'WAITING_FOR_FRESH_ASK';
      state.reason = 'Waiting for a fresh Polymarket best ask.';
      return false;
    }
    if (quote.bestAsk < this.config.MIN_ENTRY_ASK) {
      state.status = 'BELOW_PRICE_BAND';
      state.reason = `Best ask ${quote.bestAsk.toFixed(3)} is below $${this.config.MIN_ENTRY_ASK.toFixed(2)}.`;
      return false;
    }
    if (quote.bestAsk > this.config.MAX_ENTRY_ASK) {
      state.status = 'ABOVE_PRICE_BAND';
      state.reason = `Best ask ${quote.bestAsk.toFixed(3)} is above $${this.config.MAX_ENTRY_ASK.toFixed(2)}.`;
      return false;
    }

    if (this.config.ONE_TRIGGER_PER_WINDOW && this.entryTriggeredThisWindow) {
      state.status = 'ONE_TRIGGER_PER_WINDOW';
      state.reason = 'The window already used its single entry trigger.';
      return true;
    }

    if (!this.config.SELLS_ON_OPPOSITE_TRIGGER && openTrades.length > 0) {
      if (this.martingaleReentriesThisWindow >= this.config.MAX_MARTINGALE_REENTRIES_PER_WINDOW) {
        state.status = 'MARTINGALE_CAP_REACHED';
        state.reason = `The ${this.config.MAX_MARTINGALE_REENTRIES_PER_WINDOW} additional martingale buys allowed this window have been used; holding shares until settlement or the next window.`;
        return true;
      }
      if (this.martingaleReentryArmed && !isMartingaleReentry) {
        state.status = 'WAITING_FOR_OPPOSITE_MARTINGALE_TRIGGER';
        state.reason = `The latest position is ${activeSide}; only the opposite ${martingaleTargetSide} ask can trigger this martingale buy.`;
        return true;
      }
      if (!isMartingaleReentry) {
        state.status = 'POSITION_LOCKED';
        state.reason = `Holding ${activeSide} shares with no sell orders; waiting for its $0.50 pivot, then an opposite-side trigger.`;
        return true;
      }
    }
    if (this.config.SELLS_ON_OPPOSITE_TRIGGER && activeSide === side) {
      state.status = 'POSITION_LOCKED';
      state.reason = `Holding ${side}; waiting for an opposite-side trigger before buying again.`;
      return true;
    }

    const isOppositeTrigger = this.config.SELLS_ON_OPPOSITE_TRIGGER
      && activeSide != null && activeSide !== side;
    const outgoingShares = isOppositeTrigger
      ? this.currentWindowOpenTrades(activeSide)
        .reduce((sum, trade) => sum + trade.shares, 0)
      : 0;
    const requestedShares = outgoingShares > EPSILON
      ? round(outgoingShares * this.config.OPPOSITE_TRIGGER_SIZE_MULTIPLIER, 8)
      : this.nextEntryShares;
    state.qualifyingUpdates += 1;
    this.entryTriggeredThisWindow = true;
    this.pendingTrigger = {
      id: `trigger-${++this.triggerSequence}`,
      side,
      mode: isOppositeTrigger ? 'OPPOSITE_SIGNAL_REVERSAL'
        : isMartingaleReentry ? 'MARTINGALE_REENTRY' : 'BASE_ENTRY',
      triggerType,
      triggerAsk: quote.bestAsk,
      createdAt: now,
      expiresAt: now + this.config.PENDING_TRIGGER_TTL_MS,
      windowStart: this.windowStart,
      attempts: 0,
      requestedShares,
      sharesToSell: outgoingShares,
      sharesSold: 0,
      sharesBought: 0,
      unmatchedShares: 0,
      rebuyTargetShares: requestedShares,
      grossProceeds: 0,
      saleFees: 0,
      netProceeds: 0,
      lastBlockKey: null,
    };
    state.status = 'PENDING_TRIGGER';
    state.reason = isOppositeTrigger
      ? `Opposite ${side} trigger queued to sell ${round(outgoingShares)} outgoing shares and buy ${round(requestedShares)} (${this.config.OPPOSITE_TRIGGER_SIZE_MULTIPLIER}x).`
      : isMartingaleReentry
        ? `Martingale re-entry armed: queue ${round(requestedShares)} ${side} shares from the band; either side may trigger this buy.`
      : `One ${round(requestedShares)}-share ${side} entry queued for this window.`;
    this.log('PENDING_TRIGGER_CREATED', state.reason, {
      triggerId: this.pendingTrigger.id,
      side,
      mode: this.pendingTrigger.mode,
      requestedShares: this.pendingTrigger.requestedShares,
      triggerAsk: quote.bestAsk,
      expiresAt: this.pendingTrigger.expiresAt,
      triggerType,
    });
    return true;
  }

  setPendingWait(pending, status, reason, eventType = 'PENDING_TRIGGER_WAITING', details = {}) {
    const state = this.sideState[pending.side];
    state.status = status;
    state.reason = reason;
    state.lastUpdateAt = this.now();
    const blockKey = `${eventType}|${status}|${reason}`;
    if (pending.lastBlockKey !== blockKey) {
      this.log(eventType, reason, {
        triggerId: pending.id,
        side: pending.side,
        mode: pending.mode,
        ...details,
      });
    }
    pending.lastBlockKey = blockKey;
    this.schedulePersistedState();
    return false;
  }

  expirePendingTrigger(now, reason) {
    const pending = this.pendingTrigger;
    if (!pending) return false;
    this.pendingTrigger = null;
    if (this.currentWindowOpenTrades().length === 0) this.activeSide = null;
    const state = this.sideState[pending.side];
    state.status = 'PENDING_TRIGGER_EXPIRED';
    state.reason = reason;
    state.lastUpdateAt = now;
    this.log('PENDING_TRIGGER_EXPIRED', reason, {
      triggerId: pending.id,
      side: pending.side,
      mode: pending.mode,
      attempts: pending.attempts,
      ageMs: Math.max(0, now - pending.createdAt),
    });
    this.schedulePersistedState(true);
    return true;
  }

  retryPendingTrigger(now = this.now()) {
    const pending = this.pendingTrigger;
    if (!pending) return false;
    if (pending.windowStart !== this.windowStart || now >= this.windowEnd
      || this.terminalObservation?.winner) {
      return this.expirePendingTrigger(now, 'The BTC window ended or settled before the pending trigger completed.');
    }
    if (now >= pending.expiresAt) {
      return this.expirePendingTrigger(now, 'The pending trigger expired after its two-second retry window.');
    }

    const side = pending.side;
    const state = this.sideState[side];
    const quote = this.quotes[side];
    if (pending.mode === 'MARTINGALE_REENTRY'
      && pending.side !== this.martingaleReentryTargetSide()) {
      this.pendingTrigger = null;
      state.status = this.martingaleReentriesThisWindow
        >= this.config.MAX_MARTINGALE_REENTRIES_PER_WINDOW
        ? 'MARTINGALE_CAP_REACHED' : 'WAITING_FOR_OPPOSITE_MARTINGALE_TRIGGER';
      state.reason = 'The pending martingale entry no longer matches the opposite side of the latest position.';
      this.schedulePersistedState(true);
      return false;
    }
    if (pending.mode === 'BASE_ENTRY' && this.activeSideForWindow() === side) {
      this.pendingTrigger = null;
      state.status = 'POSITION_LOCKED';
      state.reason = `Holding ${side}; the active-side lock prevents a duplicate buy.`;
      this.schedulePersistedState(true);
      return false;
    }
    if (this.stateStore && !this.storageHealthy) {
      return this.setPendingWait(
        pending,
        'PAPER_HISTORY_STORAGE_ERROR',
        'Trading is paused until durable paper history storage is available.',
      );
    }
    if (!this.quoteIsFresh(quote, now) || !Number.isFinite(quote.bestAsk)) {
      return this.setPendingWait(
        pending,
        'WAITING_FOR_FRESH_ASK',
        'Waiting for a fresh Polymarket best ask.',
      );
    }
    if (quote.bestAsk > this.config.PENDING_RETRY_MAX_ASK) {
      return this.setPendingWait(
        pending,
        'WAITING_FOR_RETRY_PRICE',
        `Best ask ${quote.bestAsk.toFixed(3)} exceeds the market's $${this.config.PENDING_RETRY_MAX_ASK.toFixed(2)} maximum.`,
      );
    }

    const firstAttempt = pending.attempts === 0;
    const minPrice = firstAttempt
      ? this.config.MIN_ENTRY_ASK : this.config.PENDING_RETRY_MIN_ASK;
    const maxPrice = this.config.PENDING_RETRY_MAX_ASK;
    pending.attempts += 1;

    if (pending.mode === 'BASE_ENTRY') {
      if (this.lastBaseBuyAt != null
        && now - this.lastBaseBuyAt < this.config.SAME_SIDE_COOLDOWN_MS) {
        return this.setPendingWait(
          pending,
          'SAME_SIDE_COOLDOWN',
          'Waiting for the one-second same-side duplicate guard to clear.',
        );
      }
    }

    if (pending.mode === 'OPPOSITE_SIGNAL_REVERSAL') {
      if (!this.config.SELLS_ON_OPPOSITE_TRIGGER) {
        this.pendingTrigger = null;
        state.status = 'SELLS_DISABLED';
        state.reason = 'Opposite-side signal ignored; sell orders are disabled.';
        this.log('OPPOSITE_TRIGGER_IGNORED', state.reason, {
          triggerId: pending.id,
          side,
          mode: pending.mode,
        });
        this.schedulePersistedState(true);
        return false;
      }
      const filled = this.tryReverse(pending, now, minPrice, maxPrice);
      if (filled) {
        this.pendingTrigger = null;
        this.schedulePersistedState(true);
      }
      return filled;
    }

    const filled = this.tryBuy(
      side,
      now,
      pending.triggerType,
      pending.requestedShares || this.config.SHARES_PER_BUY,
      pending.mode === 'MARTINGALE_REENTRY' ? 'MARTINGALE_REENTRY' : null,
      {
        minPrice,
        maxPrice,
        triggerAsk: pending.triggerAsk,
        triggerId: pending.id,
      },
    );
    if (filled) {
      this.pendingTrigger = null;
      this.schedulePersistedState(true);
      return true;
    }
    return this.setPendingWait(
      pending,
      state.status,
      state.reason,
      state.status === 'INSUFFICIENT_CAPITAL'
        ? 'ENTRY_BLOCKED_CAPITAL'
        : 'ENTRY_WAITING_FOR_DEPTH',
      { triggerType: pending.triggerType, bestAsk: quote.bestAsk },
    );
  }

  tryReverse(pending, now, minPrice, maxPrice) {
    if (!this.config.SELLS_ON_OPPOSITE_TRIGGER) return false;
    const side = pending.side;
    const outgoingSide = side === 'UP' ? 'DOWN' : 'UP';
    const state = this.sideState[side];
    const quote = this.quotes[side];
    state.lastUpdateAt = now;
    state.lastBestAsk = quote?.bestAsk ?? null;

    const targetShares = round(
      Number(pending.rebuyTargetShares)
        || Number(pending.requestedShares)
        || this.config.SHARES_PER_BUY,
      8,
    );
    if (pending.sharesSold > EPSILON
      && pending.sharesBought + EPSILON >= targetShares) {
      return this.completeScaledPendingFlip(pending, side, outgoingSide, now);
    }

    if (pending.unmatchedShares > EPSILON) {
      const catchUpShares = round(pending.unmatchedShares, 8);
      const previousSharesBought = pending.sharesBought;
      pending.sharesBought = round(previousSharesBought + catchUpShares, 8);
      pending.unmatchedShares = 0;
      const bought = this.tryBuy(
        side,
        now,
        pending.triggerType,
        catchUpShares,
        'OPPOSITE_SIGNAL_REVERSAL',
        {
          minPrice,
          maxPrice,
          triggerAsk: pending.triggerAsk,
          triggerId: pending.id,
        },
      );
      if (!bought) {
        pending.sharesBought = previousSharesBought;
        pending.unmatchedShares = catchUpShares;
        return this.setPendingWait(
          pending,
          state.status,
          state.reason,
          'REVERSAL_BUY_WAITING_FOR_DEPTH',
          { outgoingSide, sharesSold: pending.sharesSold, sharesToBuy: catchUpShares },
        );
      }
      return this.completeScaledPendingFlip(pending, side, outgoingSide, now);
    }

    const outgoingTrades = this.currentWindowOpenTrades(outgoingSide);
    const sharesToSell = round(
      outgoingTrades.reduce((sum, trade) => sum + trade.shares, 0),
      8,
    );
    if (sharesToSell <= EPSILON) {
      pending.mode = 'BASE_ENTRY';
      const requestedShares = Number(pending.requestedShares) > 0
        ? Number(pending.requestedShares) : this.martingaleNextShares;
      pending.requestedShares = requestedShares;
      const bought = this.tryBuy(
        side,
        now,
        pending.triggerType,
        requestedShares,
        null,
        {
          minPrice,
          maxPrice,
          triggerAsk: pending.triggerAsk,
          triggerId: pending.id,
        },
      );
      if (bought) {
        this.pendingTrigger = null;
        this.schedulePersistedState(true);
        return true;
      }
      return this.setPendingWait(
        pending,
        state.status,
        state.reason,
        'ENTRY_WAITING_FOR_DEPTH',
        { triggerType: pending.triggerType, bestAsk: quote?.bestAsk },
      );
    }

    const requestedShares = round(
      sharesToSell * this.config.OPPOSITE_TRIGGER_SIZE_MULTIPLIER,
      8,
    );
    pending.sharesToSell = sharesToSell;
    pending.requestedShares = requestedShares;
    pending.rebuyTargetShares = requestedShares;

    const sellPreview = this.sweepBids(outgoingSide, sharesToSell, { consume: false });
    if (!sellPreview?.complete) {
      return this.setPendingWait(
        pending,
        'WAITING_FOR_FULL_SELL_DEPTH',
        `Waiting for visible bids to sell all ${sharesToSell} ${outgoingSide} shares; no partial sale was placed.`,
        'REVERSAL_WAITING_FOR_SELL_DEPTH',
        { outgoingSide, sharesToSell, triggerType: pending.triggerType },
      );
    }
    const buyPreview = this.sweepAsks(side, requestedShares, {
      consume: false,
      minPrice,
      maxPrice,
    });
    if (!buyPreview?.complete) {
      return this.setPendingWait(
        pending,
        'WAITING_FOR_FULL_BUY_DEPTH',
        `Waiting for all ${requestedShares} ${side} shares before selling ${outgoingSide}; no partial order will be placed.`,
        'REVERSAL_WAITING_FOR_BUY_DEPTH',
        { outgoingSide, sharesToSell, requestedShares, triggerType: pending.triggerType },
      );
    }
    if (this.cash + sellPreview.netProceeds + EPSILON < buyPreview.totalCost) {
      return this.setPendingWait(
        pending,
        'INSUFFICIENT_CAPITAL',
        `The ${requestedShares}-share ${side} buy needs $${buyPreview.totalCost.toFixed(2)} after the sale; only $${(this.cash + sellPreview.netProceeds).toFixed(2)} would be available.`,
        'REVERSAL_BLOCKED_CAPITAL',
        {
          outgoingSide,
          sharesToSell,
          requestedShares,
          requiredCash: round(buyPreview.totalCost),
          availableAfterSale: round(this.cash + sellPreview.netProceeds),
          triggerType: pending.triggerType,
        },
      );
    }

    const sellExecution = this.sweepBids(outgoingSide, sharesToSell);
    if (!sellExecution?.complete) {
      return this.setPendingWait(
        pending,
        'WAITING_FOR_FULL_SELL_DEPTH',
        `Visible ${outgoingSide} bids changed before the full sale completed.`,
        'REVERSAL_WAITING_FOR_SELL_DEPTH',
        { outgoingSide, sharesToSell, triggerType: pending.triggerType },
      );
    }

    this.closePositionsOnOppositeSignal(outgoingTrades, sellExecution, now, side);
    pending.sharesSold = round(pending.sharesSold + sellExecution.shares, 8);
    pending.grossProceeds = round(pending.grossProceeds + sellExecution.grossProceeds, 8);
    pending.saleFees = round(pending.saleFees + sellExecution.fees, 8);
    pending.netProceeds = round(pending.netProceeds + sellExecution.netProceeds, 8);
    pending.unmatchedShares = requestedShares;
    const previousSharesBought = pending.sharesBought;
    pending.sharesBought = round(previousSharesBought + requestedShares, 8);
    pending.unmatchedShares = 0;
    const bought = this.tryBuy(
      side,
      now,
      pending.triggerType,
      requestedShares,
      'OPPOSITE_SIGNAL_REVERSAL',
      {
        minPrice,
        maxPrice,
        triggerAsk: pending.triggerAsk,
        triggerId: pending.id,
      },
    );
    if (!bought) {
      pending.sharesBought = previousSharesBought;
      pending.unmatchedShares = requestedShares;
      return this.setPendingWait(
        pending,
        state.status,
        state.reason,
        'REVERSAL_BUY_WAITING_FOR_DEPTH',
        { outgoingSide, sharesSold: round(pending.sharesSold), sharesToBuy: requestedShares },
      );
    }
    return this.completeScaledPendingFlip(pending, side, outgoingSide, now);
  }

  completeScaledPendingFlip(pending, side, outgoingSide, now) {
    this.pendingTrigger = null;
    this.activeSide = side;
    const state = this.sideState[side];
    state.status = 'BUY_FILLED';
    state.reason = `Sold ${round(pending.sharesSold)} ${outgoingSide} shares and bought ${round(pending.sharesBought)} ${side} shares (${this.config.OPPOSITE_TRIGGER_SIZE_MULTIPLIER}x).`;
    state.lastUpdateAt = now;
    this.log('OPPOSITE_SIGNAL_SELL', state.reason, {
      triggerId: pending.id,
      side,
      outgoingSide,
      sharesSold: round(pending.sharesSold),
      sharesBought: round(pending.sharesBought),
      multiplier: this.config.OPPOSITE_TRIGGER_SIZE_MULTIPLIER,
      averageSellPrice: pending.sharesSold > EPSILON
        ? round(pending.grossProceeds / pending.sharesSold)
        : null,
      grossProceeds: round(pending.grossProceeds),
      fees: round(pending.saleFees),
      netProceeds: round(pending.netProceeds),
      triggerType: pending.triggerType,
    });
    this.schedulePersistedState(true);
    return true;
  }

  tryReverseLegacyDisabled(pending, now, minPrice, maxPrice) {
    return false;
    const side = pending.side;
    const oppositeSide = side === 'UP' ? 'DOWN' : 'UP';
    const state = this.sideState[side];
    const quote = this.quotes[side];
    state.lastUpdateAt = now;
    state.lastBestAsk = quote?.bestAsk ?? null;
    if (pending.unmatchedShares > EPSILON) {
      const catchUpShares = pending.unmatchedShares;
      const caughtUp = this.tryBuy(
        side,
        now,
        pending.triggerType,
        catchUpShares,
        'OPPOSITE_SIGNAL_REVERSAL',
        {
          minPrice,
          maxPrice,
          triggerAsk: pending.triggerAsk,
          triggerId: pending.id,
        },
      );
      if (!caughtUp) {
        return this.setPendingWait(
          pending,
          'REVERSAL_BUY_FAILED',
          `Retrying the ${round(catchUpShares)} shares already sold before selling more ${oppositeSide} shares.`,
          'REVERSAL_WAITING_FOR_DEPTH',
          { oppositeSide, unmatchedShares: round(catchUpShares), triggerType: pending.triggerType },
        );
      }
      pending.sharesBought += catchUpShares;
      pending.unmatchedShares = 0;
      pending.lastBlockKey = null;
      this.activeSide = side;
      const remainingShares = this.currentWindowOpenTrades(oppositeSide)
        .reduce((sum, trade) => sum + trade.shares, 0);
      if (remainingShares <= EPSILON) {
          return this.completePendingFlip(pending, side, oppositeSide, now, minPrice, maxPrice);
      }
      state.status = 'PARTIAL_REVERSAL_WAITING_FOR_DEPTH';
      state.reason = `Bought the ${round(catchUpShares)} previously sold shares; ${round(remainingShares)} ${oppositeSide} shares remain.`;
      this.schedulePersistedState(true);
      return true;
    }
    const oppositeTrades = this.currentWindowOpenTrades(oppositeSide);
    const sharesToReverse = oppositeTrades.reduce((sum, trade) => sum + trade.shares, 0);
    if (sharesToReverse <= EPSILON) {
      if (this.currentWindowOpenTrades(side).length > 0) {
        return this.completePendingFlip(pending, side, oppositeSide, now, minPrice, maxPrice);
      }
      return this.expirePendingTrigger(now, `No open ${oppositeSide} shares remain to sell; the pending flip was not bought.`);
    }

    const sellPreview = this.sweepBids(oppositeSide, sharesToReverse, { consume: false });
    const availableSellShares = sellPreview?.shares || 0;
    if (availableSellShares <= EPSILON) {
      return this.setPendingWait(
        pending,
        'WAITING_FOR_REVERSAL_DEPTH',
        `Waiting for visible ${oppositeSide} bids to sell ${round(sharesToReverse)} remaining shares.`,
        'REVERSAL_WAITING_FOR_DEPTH',
        { oppositeSide, sharesToReverse: round(sharesToReverse), triggerType: pending.triggerType },
      );
    }

    const buyPreview = this.sweepAsks(side, availableSellShares, {
      consume: false, minPrice, maxPrice,
    });
    const matchedShares = Math.min(availableSellShares, buyPreview?.shares || 0);
    if (matchedShares <= EPSILON) {
      return this.setPendingWait(
        pending,
        'WAITING_FOR_REVERSAL_DEPTH',
        `Waiting for ${side} ask depth up to $${maxPrice.toFixed(2)} to match the available ${oppositeSide} sale.`,
        'REVERSAL_WAITING_FOR_DEPTH',
        { oppositeSide, availableSellShares: round(availableSellShares), triggerType: pending.triggerType },
      );
    }

    const matchedSellPreview = this.sweepBids(oppositeSide, matchedShares, { consume: false });
    const matchedBuyPreview = this.sweepAsks(side, matchedShares, {
      consume: false, minPrice, maxPrice,
    });
    if (!matchedSellPreview?.complete || !matchedBuyPreview?.complete) {
      return this.setPendingWait(
        pending,
        'WAITING_FOR_REVERSAL_DEPTH',
        `Waiting for matched ${oppositeSide} sell and ${side} buy depth.`,
        'REVERSAL_WAITING_FOR_DEPTH',
        { oppositeSide, matchedShares: round(matchedShares), triggerType: pending.triggerType },
      );
    }
    if (this.cash + matchedSellPreview.netProceeds + EPSILON < matchedBuyPreview.totalCost) {
      const reason = `Reversal needs $${matchedBuyPreview.totalCost.toFixed(2)} after the matched sale; only $${(this.cash + matchedSellPreview.netProceeds).toFixed(2)} would be available.`;
      return this.setPendingWait(
        pending,
        'INSUFFICIENT_CAPITAL',
        reason,
        'REVERSAL_BLOCKED_CAPITAL',
        {
          oppositeSide,
          shares: round(matchedShares),
          requiredCash: round(matchedBuyPreview.totalCost),
          availableAfterSale: round(this.cash + matchedSellPreview.netProceeds),
          triggerType: pending.triggerType,
        },
      );
    }

    const sellExecution = this.sweepBids(oppositeSide, matchedShares);
    if (!sellExecution?.complete) {
      return this.setPendingWait(
        pending,
        'WAITING_FOR_REVERSAL_DEPTH',
        `Visible ${oppositeSide} bid depth changed before the matched sale.`,
        'REVERSAL_WAITING_FOR_DEPTH',
        { oppositeSide, matchedShares: round(matchedShares), triggerType: pending.triggerType },
      );
    }
    const closeResult = this.closePositionsOnOppositeSignal(
      oppositeTrades, sellExecution, now, side,
    );
    pending.sharesSold += sellExecution.shares;
    pending.unmatchedShares = round(pending.unmatchedShares + sellExecution.shares, 8);
    pending.grossProceeds = round(pending.grossProceeds + sellExecution.grossProceeds, 8);
    pending.saleFees = round(pending.saleFees + sellExecution.fees, 8);
    pending.netProceeds = round(pending.netProceeds + sellExecution.netProceeds, 8);
    const bought = this.tryBuy(
      side,
      now,
      pending.triggerType,
      sellExecution.shares,
      'OPPOSITE_SIGNAL_REVERSAL',
      {
        minPrice,
        maxPrice,
        triggerAsk: pending.triggerAsk,
        triggerId: pending.id,
      },
    );
    if (!bought) {
      return this.setPendingWait(
        pending,
        'REVERSAL_BUY_FAILED',
        'Shares were sold, but the matching buy did not complete; retry those shares before selling more.',
        'REVERSAL_WAITING_FOR_DEPTH',
        { oppositeSide, sharesSold: round(sellExecution.shares), unmatchedShares: round(pending.unmatchedShares), triggerType: pending.triggerType },
      );
    }

    pending.sharesBought += sellExecution.shares;
    pending.unmatchedShares = Math.max(0, round(pending.unmatchedShares - sellExecution.shares, 8));
    pending.lastBlockKey = null;
    this.activeSide = side;
    if (closeResult.remainingShares <= EPSILON) {
      return this.completePendingFlip(pending, side, oppositeSide, now, minPrice, maxPrice);
    }

    state.status = 'PARTIAL_REVERSAL_WAITING_FOR_DEPTH';
    state.reason = `Sold and rebought ${round(sellExecution.shares)} shares; ${round(closeResult.remainingShares)} ${oppositeSide} shares remain for this flip.`;
    this.log('OPPOSITE_SIGNAL_PARTIAL_SELL', state.reason, {
      triggerId: pending.id,
      side,
      oppositeSide,
      shares: round(sellExecution.shares),
      totalSharesSold: round(pending.sharesSold),
      remainingShares: round(closeResult.remainingShares),
      triggerType: pending.triggerType,
    });
    this.schedulePersistedState(true);
    return true;
  }

  completePendingFlip(
    pending,
    side,
    oppositeSide,
    now,
    minPrice = this.config.MIN_ENTRY_ASK,
    maxPrice = this.config.MAX_ENTRY_ASK,
  ) {
    const targetShares = Math.max(
      pending.sharesSold,
      Number(pending.rebuyTargetShares) || pending.sharesSold,
    );
    const remainingRebuyShares = Math.max(
      0,
      round(targetShares - pending.sharesBought, 8),
    );
    if (remainingRebuyShares > EPSILON) {
      const bought = this.tryBuy(
        side,
        now,
        pending.triggerType,
        remainingRebuyShares,
        'OPPOSITE_SIGNAL_REVERSAL',
        {
          minPrice,
          maxPrice,
          triggerAsk: pending.triggerAsk,
          triggerId: pending.id,
        },
      );
      if (!bought) {
        return this.setPendingWait(
          pending,
          'WAITING_FOR_ESCALATED_REBUY',
          `The ${oppositeSide} position is closed; waiting to complete the ${round(targetShares)}-share ${side} rebuy.`,
          'REVERSAL_REBUY_WAITING',
          {
            targetShares: round(targetShares),
            sharesBought: round(pending.sharesBought),
            remainingRebuyShares: round(remainingRebuyShares),
          },
        );
      }
      pending.sharesBought = round(pending.sharesBought + remainingRebuyShares, 8);
    }

    this.pendingTrigger = null;
    this.consecutiveFlipCount += 1;
    const state = this.sideState[side];
    state.status = 'BUY_FILLED';
    state.reason = `Completed flip ${this.consecutiveFlipCount}: sold ${round(pending.sharesSold)} ${oppositeSide} shares and rebought ${round(pending.sharesBought)} ${side} shares.`;
    state.lastUpdateAt = now;
    this.log('OPPOSITE_SIGNAL_SELL',
      `Completed flip ${this.consecutiveFlipCount}: sold ${round(pending.sharesSold)} ${oppositeSide} shares and bought ${round(pending.sharesBought)} ${side} shares.`,
      {
        triggerId: pending.id,
        side,
        oppositeSide,
        sharesSold: round(pending.sharesSold),
        sharesBought: round(pending.sharesBought),
        rebuyTargetShares: round(targetShares),
        consecutiveFlipCount: this.consecutiveFlipCount,
        averagePrice: round(pending.grossProceeds / Math.max(EPSILON, pending.sharesSold)),
        grossProceeds: pending.grossProceeds,
        fees: pending.saleFees,
        netProceeds: pending.netProceeds,
        triggerType: pending.triggerType,
      });
    this.schedulePersistedState(true);
    return true;
  }

  closePositionsOnOppositeSignal(trades, execution, now, newSide, exitReason = 'OPPOSITE_SIGNAL') {
    if (!this.config.SELLS_ON_OPPOSITE_TRIGGER && exitReason !== 'STOP_LOSS') {
      return {
        soldShares: 0,
        remainingShares: trades.reduce((sum, trade) => sum + trade.shares, 0),
      };
    }
    const totalShares = execution.shares;
    this.cash = round(this.cash + execution.netProceeds, 8);
    let totalRealized = 0;
    let remainingSaleShares = totalShares;
    for (const trade of trades) {
      if (remainingSaleShares <= EPSILON) break;
      const originalShares = trade.shares;
      const soldShares = Math.min(originalShares, remainingSaleShares);
      if (soldShares <= EPSILON) continue;
      const tradeRatio = soldShares / originalShares;
      const soldGrossCost = round(trade.grossCost * tradeRatio, 8);
      const soldEntryFees = round(trade.fees * tradeRatio, 8);
      const soldTotalCost = round(trade.totalCost * tradeRatio, 8);
      const { closedFills, remainingFills } = splitFillLevels(trade.fills, soldShares);
      const saleRatio = soldShares / totalShares;
      const grossProceeds = round(execution.grossProceeds * saleRatio, 8);
      const exitFees = round(execution.fees * saleRatio, 8);
      const netProceeds = round(grossProceeds - exitFees, 8);
      const closedTrade = soldShares + EPSILON >= originalShares ? trade : {
        ...trade,
        id: `trade-${++this.tradeSequence}`,
        shares: soldShares,
        grossCost: soldGrossCost,
        fees: soldEntryFees,
        totalCost: soldTotalCost,
        fills: closedFills,
        parentTradeId: trade.id,
      };
      if (closedTrade !== trade) {
        trade.shares = round(originalShares - soldShares, 8);
        trade.grossCost = round(trade.grossCost - soldGrossCost, 8);
        trade.fees = round(trade.fees - soldEntryFees, 8);
        trade.totalCost = round(trade.totalCost - soldTotalCost, 8);
        trade.fills = remainingFills;
        trade.markPrice = null;
        trade.markValue = null;
        trade.unrealizedPnl = null;
        this.trades.push(closedTrade);
      }
      closedTrade.status = 'CLOSED';
      closedTrade.settlementStatus = 'CLOSED';
      closedTrade.closedAt = now;
      closedTrade.exitSide = exitReason === 'STOP_LOSS' ? null : newSide;
      closedTrade.exitReason = exitReason;
      closedTrade.exitPrice = execution.averagePrice;
      closedTrade.exitGrossProceeds = grossProceeds;
      closedTrade.exitFees = exitFees;
      closedTrade.proceeds = netProceeds;
      closedTrade.realizedPnl = round(netProceeds - closedTrade.totalCost, 8);
      closedTrade.finalOutcome = `${exitReason}_EXIT`;
      closedTrade.settlementSource = exitReason;
      closedTrade.outcome = 'EXIT';
      closedTrade.exitFills = scaleExecutionFills(execution.fills, saleRatio);
      if (closedTrade === trade && Array.isArray(trade.fills)) trade.fills = closedFills;
      totalRealized += closedTrade.realizedPnl;
      remainingSaleShares -= soldShares;
    }
    this.realizedPnl = round(this.realizedPnl + totalRealized, 8);
    if (this.martingalePivot?.side === trades[0]?.side) {
      this.martingalePivot = null;
    }
    const remainingShares = this.currentWindowOpenTrades(trades[0]?.side)
      .reduce((sum, trade) => sum + trade.shares, 0);
    return { soldShares: totalShares - Math.max(0, remainingSaleShares), remainingShares };
  }

  tryBuy(side, now, triggerType, requestedShares = this.config.SHARES_PER_BUY, entryMode = null, options = {}) {
    const {
      minPrice = this.config.MIN_ENTRY_ASK,
      maxPrice = this.config.PENDING_RETRY_MAX_ASK,
      triggerAsk = this.quotes[side]?.bestAsk ?? null,
      triggerId = null,
    } = options;
    const quote = this.quotes[side];
    const state = this.sideState[side];
    state.lastUpdateAt = now;
    state.lastBestAsk = quote?.bestAsk ?? null;
    if (entryMode === 'MARTINGALE_REENTRY'
      && (this.martingaleReentriesThisWindow >= this.config.MAX_MARTINGALE_REENTRIES_PER_WINDOW
        || this.martingaleReentryTargetSide() !== side)) {
      state.status = this.martingaleReentriesThisWindow
        >= this.config.MAX_MARTINGALE_REENTRIES_PER_WINDOW
        ? 'MARTINGALE_CAP_REACHED' : 'WAITING_FOR_OPPOSITE_MARTINGALE_TRIGGER';
      state.reason = 'Martingale buys are limited to two per window and must be opposite the latest position.';
      return false;
    }
    if (this.stateStore && !this.storageHealthy) {
      state.status = 'PAPER_HISTORY_STORAGE_ERROR';
      state.reason = 'Trading is paused until durable paper history storage is available.';
      return false;
    }
    if (!this.quoteIsFresh(quote, now) || !Number.isFinite(quote.bestAsk)) {
      state.status = 'WAITING_FOR_FRESH_ASK';
      state.reason = 'Waiting for a fresh Polymarket best ask.';
      return false;
    }
    if (quote.bestAsk < minPrice) {
      state.status = 'BELOW_PRICE_BAND';
      state.reason = `Best ask ${quote.bestAsk.toFixed(3)} is below $${minPrice.toFixed(2)}.`;
      return false;
    }
    if (quote.bestAsk > maxPrice) {
      state.status = 'ABOVE_PRICE_BAND';
      state.reason = `Best ask ${quote.bestAsk.toFixed(3)} is above $${maxPrice.toFixed(2)}.`;
      return false;
    }

    const preview = this.sweepAsks(side, requestedShares, {
      consume: false,
      minPrice,
      maxPrice,
    });
    if (!preview || !preview.complete) {
      state.status = 'WAITING_FOR_FULL_DEPTH';
      state.reason = `Waiting for enough visible asks to fill all ${requestedShares} shares; no partial buy was placed.`;
      return false;
    }
    if (preview.totalCost > this.cash + EPSILON) {
      state.status = 'INSUFFICIENT_CAPITAL';
      state.reason = `Needs $${preview.totalCost.toFixed(2)} including fees; $${this.cash.toFixed(2)} is available.`;
      this.log('ENTRY_BLOCKED_CAPITAL', `${side} buy skipped because paper cash is insufficient.`, {
        side, requiredCash: round(preview.totalCost), availableCash: round(this.cash), triggerType,
      });
      return false;
    }
    const execution = this.sweepAsks(side, requestedShares, { minPrice, maxPrice });
    if (!execution?.complete) {
      state.status = 'WAITING_FOR_FULL_DEPTH';
      state.reason = `Visible asks changed before the full ${requestedShares}-share sweep completed.`;
      return false;
    }

    this.cash = round(this.cash - execution.totalCost, 8);
    this.activeSide = side;
    if (entryMode !== 'OPPOSITE_SIGNAL_REVERSAL') this.lastBaseBuyAt = now;
    const trade = {
      id: `trade-${++this.tradeSequence}`,
      asset: 'BTC',
      side,
      marketId: String(this.market.id),
      marketSlug: this.market.slug,
      marketTitle: this.market.title,
      tokenId: execution.tokenId,
      windowStart: this.windowStart,
      windowEnd: this.windowEnd,
      shares: requestedShares,
      entryPrice: execution.averagePrice,
      triggerAsk,
      bestAskAtFill: quote.bestAsk,
      triggerType,
      triggerId,
      entryMode,
      grossCost: execution.grossCost,
      fees: execution.fees,
      totalCost: execution.totalCost,
      fills: execution.fills,
      openedAt: now,
      status: 'OPEN',
      settlementStatus: 'OPEN',
      markPrice: null,
      markValue: null,
      unrealizedPnl: null,
      realizedPnl: null,
      outcome: null,
    };
    this.trades.push(trade);
    this.entryTriggeredThisWindow = true;
    if (entryMode === 'MARTINGALE_REENTRY') {
      this.martingaleReentriesThisWindow += 1;
      this.martingaleReentryArmed = false;
      this.martingalePivot = null;
      this.martingalePivotedSides[side] = false;
    }
    state.status = 'BUY_FILLED';
    const entryDetail = entryMode === 'MARTINGALE_REENTRY'
      ? '; martingale re-entry, no shares sold'
      : entryMode ? '; outgoing shares sold on the opposite trigger' : '';
    state.reason = `Bought ${trade.shares} ${side} shares at ${trade.entryPrice.toFixed(3)} average${entryDetail}.`;
    state.buys += 1;
    state.sharesBought += trade.shares;
    this.log('BUY_FILLED',
      `${side} buy filled: ${trade.shares} shares at ${trade.entryPrice.toFixed(3)} average${entryMode === 'MARTINGALE_REENTRY' ? ' after the martingale pivot; no shares were sold' : entryMode ? ' after selling the outgoing position' : ''}.`,
      {
        tradeId: trade.id,
        triggerId,
        side,
        shares: trade.shares,
        triggerAsk,
        bestAsk: quote.bestAsk,
        averagePrice: round(trade.entryPrice),
        totalCost: round(trade.totalCost),
        fees: round(trade.fees),
        triggerType,
      });
    this.markOpenPositions(now);
    return true;
  }

  maybeSettleAtTerminalPrice(now) {
    if (!this.market || this.windowStart == null || this.terminalObservation?.winner
      || now < this.windowStart + this.config.TERMINAL_CHECK_SECONDS * 1000
      || now >= this.windowEnd) return;
    const evidence = this.terminalEvidence;
    const upIsWinner = evidence.UP.winnerHitAt != null
      && evidence.DOWN.loserHitAt != null;
    const downIsWinner = evidence.DOWN.winnerHitAt != null
      && evidence.UP.loserHitAt != null;
    const winner = upIsWinner === downIsWinner ? null : upIsWinner ? 'UP' : 'DOWN';
    const evidenceSignature = JSON.stringify(evidence);
    if (this.terminalObservation?.evidenceSignature === evidenceSignature) return;
    const observed = {
      at: now,
      UP: this.quotes.UP?.bestBid ?? null,
      DOWN: this.quotes.DOWN?.bestBid ?? null,
      winner,
      ambiguous: upIsWinner && downIsWinner,
      evidence: JSON.parse(evidenceSignature),
      evidenceSignature,
    };
    this.terminalObservation = observed;

    if (!observed.winner) {
      this.log(observed.ambiguous ? 'TERMINAL_PRICE_AMBIGUOUS' : 'TERMINAL_PRICE_UNCONFIRMED',
        observed.ambiguous
          ? 'Both directions reached terminal thresholds during this window; positions will wait for official resolution.'
          : 'No paired terminal thresholds have been recorded by the 297-second check; positions will wait for official resolution unless both are observed before window end.',
        { at: now, ambiguous: observed.ambiguous, evidence: observed.evidence });
      return;
    }

    const currentTrades = this.trades.filter(trade =>
      trade.status === 'OPEN' && trade.marketId === String(this.market.id));
    for (const trade of currentTrades) {
      const payout = trade.side === observed.winner ? 1 : 0;
      const proceeds = trade.shares * payout;
      trade.status = 'SETTLED';
      trade.settlementStatus = 'SETTLED';
      trade.finalOutcome = 'TERMINAL_PRICE_297S';
      trade.settlementSource = 'TERMINAL_PRICE_297S';
      trade.resolutionPayout = payout;
      trade.proceeds = proceeds;
      trade.realizedPnl = proceeds - trade.totalCost;
      trade.settledAt = now;
      trade.outcome = payout === 1 ? 'WIN' : 'LOSS';
      this.cash = round(this.cash + proceeds, 8);
      this.realizedPnl += trade.realizedPnl;
      this.log('TERMINAL_PRICE_SETTLEMENT',
        `BTC ${trade.side} counted as ${payout ? '$1' : '$0'} per share from terminal prices recorded this window.`,
        {
          tradeId: trade.id, winner: observed.winner, payout,
          upWinnerBid: observed.evidence.UP.winnerBid,
          upLoserBid: observed.evidence.UP.loserBid,
          downWinnerBid: observed.evidence.DOWN.winnerBid,
          downLoserBid: observed.evidence.DOWN.loserBid,
          realizedPnl: round(trade.realizedPnl),
        });
    }
    if (currentTrades.length) this.applyWindowRecoveryOutcome(this.windowStart, now);
    this.schedulePersistedState(true);
  }

  markOpenPositions(now) {
    for (const trade of this.trades) {
      if (trade.status !== 'OPEN') continue;
      const quote = trade.windowStart === this.windowStart ? this.quotes[trade.side] : null;
      if (!this.quoteIsFresh(quote, now) || !Number.isFinite(quote.bestBid)) {
        trade.markPrice = null;
        trade.markValue = null;
        trade.unrealizedPnl = null;
        continue;
      }
      trade.markPrice = quote.bestBid;
      trade.markValue = trade.shares * quote.bestBid;
      trade.unrealizedPnl = trade.markValue - trade.totalCost;
      trade.markAt = now;
    }
  }

  async resolveDue(now = this.now(), { force = false } = {}) {
    const pending = this.trades.filter(trade => trade.status === 'AWAITING_RESOLUTION');
    const marketIds = [...new Set(pending.map(trade => trade.marketId))];
    const due = marketIds.filter(marketId => !this.resolutionInFlight.has(marketId)
      && (force || now - (this.resolutionLastAttemptAt.get(marketId) || 0) >= this.config.RESOLUTION_POLL_MS));
    await Promise.all(due.map(async marketId => {
      this.resolutionInFlight.add(marketId);
      this.resolutionLastAttemptAt.set(marketId, now);
      try {
        const market = await this.marketData.getMarket(marketId);
        const settlementWindowStart = this.trades.find(trade =>
          trade.marketId === marketId)?.windowStart;
        let settledCount = 0;
        for (const trade of this.trades) {
          if (trade.status !== 'AWAITING_RESOLUTION' || trade.marketId !== marketId) continue;
          const payout = resolvedPayout(market, trade);
          trade.settlementLastCheckedAt = now;
          if (payout == null) {
            trade.settlementStatus = 'AWAITING_SETTLEMENT';
            trade.settlementError = 'The original Polymarket market is not confirmed resolved yet.';
            continue;
          }
          const proceeds = trade.shares * payout;
          trade.status = 'SETTLED';
          trade.settlementStatus = 'SETTLED';
          trade.settlementError = null;
          trade.finalOutcome = 'MARKET_RESOLUTION';
          trade.resolutionPayout = payout;
          trade.proceeds = proceeds;
          trade.realizedPnl = proceeds - trade.totalCost;
          trade.settledAt = now;
          trade.outcome = payout === 1 ? 'WIN' : 'LOSS';
          this.cash = round(this.cash + proceeds, 8);
          this.realizedPnl += trade.realizedPnl;
          settledCount += 1;
          this.log('POSITION_RESOLVED',
            `BTC ${trade.side} settled from its exact original market: ${trade.outcome.toLowerCase()}.`,
            { tradeId: trade.id, marketId, payout, realizedPnl: round(trade.realizedPnl) });
        }
        if (settledCount > 0) {
          this.applyWindowRecoveryOutcome(settlementWindowStart, now);
          this.schedulePersistedState(true);
        }
      } catch (error) {
        for (const trade of this.trades) {
          if (trade.status === 'AWAITING_RESOLUTION' && trade.marketId === marketId) {
            trade.settlementStatus = 'AWAITING_SETTLEMENT';
            trade.settlementError = error?.message || 'Resolution check failed.';
            trade.settlementLastCheckedAt = now;
          }
        }
      } finally {
        this.resolutionInFlight.delete(marketId);
      }
    }));
  }

  maybeResolve(now) {
    if (now - this.lastResolutionCheckAt < this.config.RESOLUTION_POLL_MS) return;
    this.lastResolutionCheckAt = now;
    void this.resolveDue(now);
  }

  async tick() {
    if (this.tickInProgress) return this.snapshot();
    this.tickInProgress = true;
    const now = this.now();
    try {
      const currentStart = Math.floor(now / this.config.WINDOW_MS) * this.config.WINDOW_MS;
      this.resetWindow(currentStart);
      await this.refreshMarket(now);
      this.processStopLoss(now);
      this.maybeSettleAtTerminalPrice(now);
      this.retryPendingTrigger(now);
      this.markOpenPositions(now);
      this.maybeResolve(now);
      if (!this.error) {
        this.statusReason = this.market
          ? `BTC 5-minute market active; WebSocket ${this.websocket.status.toLowerCase()}.`
          : this.statusReason;
      }
      return this.snapshot();
    } catch (error) {
      this.error = error?.message || 'BTC price-band scan failed.';
      this.statusReason = 'Market scan paused; retrying automatically.';
      this.log('SCAN_ERROR', this.error);
      return this.snapshot();
    } finally {
      this.tickInProgress = false;
    }
  }

  inventoryBoxSnapshot(trades, selector) {
    return groupInventory(trades, selector);
  }

  quoteSnapshot(side, now) {
    const quote = this.quotes[side];
    if (!quote) {
      return { side, status: 'WAITING', bestAsk: null, bestBid: null, updatedAt: null, ageMs: null };
    }
    const ageMs = Math.max(0, now - quote.updatedAt);
    return {
      ...quote,
      status: ageMs <= this.config.MAX_QUOTE_AGE_MS ? 'LIVE' : 'STALE',
      ageMs,
    };
  }

  snapshot() {
    const now = this.now();
    this.markOpenPositions(now);
    const open = this.trades.filter(trade => trade.status === 'OPEN');
    const pending = this.trades.filter(trade => trade.status === 'AWAITING_RESOLUTION');
    const settled = this.trades.filter(trade => trade.status === 'SETTLED');
    const marked = this.trades.filter(trade =>
      ['OPEN', 'AWAITING_RESOLUTION'].includes(trade.status) && trade.markValue != null);
    const markedValue = marked.reduce((sum, trade) => sum + trade.markValue, 0);
    const unrealizedPnl = marked.reduce((sum, trade) => sum + trade.unrealizedPnl, 0);
    const account = {
      startingCapital: this.startingCapital,
      cash: round(this.cash, 2),
      openCost: round(open.reduce((sum, trade) => sum + trade.totalCost, 0), 2),
      realizedPnl: round(this.realizedPnl, 2),
      unrealizedPnl: round(unrealizedPnl, 2),
      markedValue: round(markedValue, 2),
      equity: round(this.cash + markedValue, 2),
      openPositions: open.length,
      pendingResolutionPositions: pending.length,
      settledPositions: settled.length,
      closedPositions: this.trades.filter(trade => trade.status === 'CLOSED').length,
      wins: settled.filter(trade => trade.outcome === 'WIN').length,
      losses: settled.filter(trade => trade.outcome === 'LOSS').length,
      takerFees: round(this.trades.reduce((sum, trade) => sum + trade.fees + (trade.exitFees || 0), 0), 2),
      unmarkedPositions: open.length + pending.length - marked.length,
    };
    const currentWindowTrades = this.trades.filter(trade =>
      trade.status === 'OPEN' && trade.windowStart === this.windowStart);
    const pendingTrades = this.trades.filter(trade => trade.status === 'AWAITING_RESOLUTION');
    const windowSeconds = this.windowEnd == null ? null : Math.max(0, (this.windowEnd - now) / 1000);
    return {
      mode: 'PAPER ONLY',
      running: this.running,
      now,
      lastUpdateAt: now,
      status: this.persistenceStatus === 'LOADING'
        ? 'STARTING'
        : this.error ? 'WARNING' : this.running ? 'RUNNING' : 'STOPPED',
      statusReason: this.statusReason,
      error: this.error,
      persistence: {
        status: this.persistenceStatus,
        lastSavedAt: this.lastStateSavedAt,
      },
      strategy: {
        version: this.config.STRATEGY_VERSION,
        timeframe: '5m',
        assets: ['BTC'],
        startingCapital: this.startingCapital,
        sharesPerBuy: this.config.SHARES_PER_BUY,
        oppositeTriggerSizeMultiplier: this.config.SELLS_ON_OPPOSITE_TRIGGER
          ? this.config.OPPOSITE_TRIGGER_SIZE_MULTIPLIER : null,
        oneTriggerPerWindow: this.config.ONE_TRIGGER_PER_WINDOW,
        entryTriggeredThisWindow: this.entryTriggeredThisWindow,
        stopLossBid: this.config.STOP_LOSS_BID,
        recoveryStepShares: this.config.RECOVERY_STEP_SHARES,
        recoveryAdditions: this.recoveryAdditions,
        maxRecoveryAdditions: this.config.MAX_RECOVERY_ADDITIONS,
        consecutiveWins: this.consecutiveWins,
        nextEntryShares: this.nextEntryShares,
        resetAtFourAdditionsWins: this.config.RESET_AT_FOUR_ADDITIONS_WINS,
        resetAtSevenAdditionsWins: this.config.RESET_AT_SEVEN_ADDITIONS_WINS,
        allOrNothingBuys: true,
        allOrNothingSells: true,
        sameSideCooldownMs: this.config.SAME_SIDE_COOLDOWN_MS,
        activeSide: this.activeSideForWindow(),
        oneBaseBuyPerActiveSide: this.config.SELLS_ON_OPPOSITE_TRIGGER,
        sellsOnOppositeTrigger: this.config.SELLS_ON_OPPOSITE_TRIGGER,
        pendingTriggerTtlMs: this.config.PENDING_TRIGGER_TTL_MS,
        pendingRetryMaxAsk: this.config.PENDING_RETRY_MAX_ASK,
        minEntryAsk: this.config.MIN_ENTRY_ASK,
        maxEntryAsk: this.config.MAX_ENTRY_ASK,
        trigger: `Buy at most once per 5-minute window when a fresh best ask is in the inclusive $${this.config.MIN_ENTRY_ASK.toFixed(2)}-$${this.config.MAX_ENTRY_ASK.toFixed(2)} band; next order size is ${this.nextEntryShares} shares.`,
        orderType: 'PAPER ALL-OR-NOTHING TAKER SWEEP',
        marketSweepMaxPrice: 1,
        intraWindowSales: true,
        stopLossRule: `When the held side's best bid reaches or falls below $${this.config.STOP_LOSS_BID.toFixed(2)}, sell all shares using the latest visible bids; this is a market-style sweep with no price floor.`,
        recoveryRule: `Each stop-loss adds ${this.config.RECOVERY_STEP_SHARES} shares for the next window, up to ${this.config.MAX_RECOVERY_ADDITIONS} additions. At four additions, hold size until two consecutive wins reset to base; at seven or more, hold until three wins. At other levels, each win removes one addition.`,
        reversalRule: 'An opposite-side ask does not sell or replace the window’s one entry. Unsold shares remain until terminal-price or official market resolution.',
        terminalCheckSeconds: this.config.TERMINAL_CHECK_SECONDS,
        terminalThresholds: {
          winnerBestBidAtLeast: this.config.TERMINAL_WINNER_BID,
          loserBestBidBelow: this.config.TERMINAL_LOSER_BID,
        },
        settlement: 'At 297 seconds or later, use any recorded in-window $0.99+ winner bid and opposing below-$0.01 loser bid; if both directions qualify or neither qualifies, use exact original-market resolution.',
        resolutionPollMs: this.config.RESOLUTION_POLL_MS,
        priceSource: 'Polymarket CLOB market WebSocket',
      },
      window: {
        start: this.windowStart,
        end: this.windowEnd,
        secondsRemaining: windowSeconds,
        terminalObservation: this.terminalObservation,
        slug: this.market?.slug || (this.windowStart == null ? null : `btc-updown-5m-${Math.floor(this.windowStart / 1000)}`),
      },
      market: this.market ? {
        id: this.market.id,
        slug: this.market.slug,
        title: this.market.title,
        start: this.market.start,
        end: this.market.end,
      } : null,
      quotes: {
        UP: this.quoteSnapshot('UP', now),
        DOWN: this.quoteSnapshot('DOWN', now),
      },
      websocket: {
        ...this.websocket,
        lastMessageAgeMs: this.websocket.lastMessageAt == null
          ? null : Math.max(0, now - this.websocket.lastMessageAt),
      },
      sideState: this.sideState,
      pendingTrigger: this.pendingTrigger ? {
        id: this.pendingTrigger.id,
        side: this.pendingTrigger.side,
        mode: this.pendingTrigger.mode,
        createdAt: this.pendingTrigger.createdAt,
        expiresAt: this.pendingTrigger.expiresAt,
        remainingMs: Math.max(0, this.pendingTrigger.expiresAt - now),
        attempts: this.pendingTrigger.attempts,
        requestedShares: this.pendingTrigger.requestedShares,
      } : null,
      stopLoss: (() => {
        const triggeredTrade = currentWindowTrades.find(trade => trade.stopLossTriggeredAt != null);
        return triggeredTrade ? {
          thresholdBid: this.config.STOP_LOSS_BID,
          triggeredAt: triggeredTrade.stopLossTriggeredAt,
          triggerBid: triggeredTrade.stopLossTriggerBid,
          waitingForDepth: triggeredTrade.status === 'OPEN',
        } : null;
      })(),
      account,
      inventory: {
        currentWindow: this.inventoryBoxSnapshot(this.trades,
          trade => trade.status === 'OPEN' && trade.windowStart === this.windowStart),
        awaitingResolution: this.inventoryBoxSnapshot(this.trades,
          trade => trade.status === 'AWAITING_RESOLUTION'),
      },
      trades: this.trades.slice().sort((a, b) => b.openedAt - a.openedAt).slice(0, 200),
      events: this.events.slice(0, 80),
    };
  }
}

module.exports = {
  BtcPriceBandBot,
  normalizeLevels,
  groupInventory,
};
