'use strict';

const { BtcMispricingBot, DEFAULT_CONFIG } = require('./mispricing-bot.cjs');
const { feeParameters, takerFeeAt } = require('./paper-trading.js');

const EPSILON = 1e-8;
const MAX_TAKER_BUY_PRICE = 0.99;
const MIN_TAKER_SELL_PRICE = 0.01;
const AUTHENTICATION_HALT_REASON = 'Polymarket authentication failed; live orders are disabled.';
const SUBMISSION_UNCERTAIN_HALT_REASON = 'Order submission outcome is uncertain; automatic retries are blocked.';
const ORDER_RECONCILIATION_HALT_REASON = 'An existing order could not be reconciled; new orders are blocked.';
const ORDER_ID_MISSING_HALT_REASON = 'A saved submission has no exchange order ID; it must be reconciled manually.';
const RESTORED_ORDER_ID_MISSING_HALT_REASON = 'A saved order has no exchange order ID; automatic resubmission is blocked.';
const CANDLE_STREAK_MEAN_REVERSION_THRESHOLD = 3;
const RECOVERABLE_ORDER_HALT_REASONS = new Set([
  SUBMISSION_UNCERTAIN_HALT_REASON,
  ORDER_RECONCILIATION_HALT_REASON,
  ORDER_ID_MISSING_HALT_REASON,
  RESTORED_ORDER_ID_MISSING_HALT_REASON,
]);
const TERMINAL_ORDER_STATUSES = new Set([
  'MATCHED', 'FILLED', 'CANCELLED', 'CANCELED', 'REJECTED', 'EXPIRED', 'UNFILLED',
]);

function round(value, digits = 8) {
  if (!Number.isFinite(Number(value))) return null;
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

function matchedShares(order) {
  const value = order?.sizeMatched
    ?? order?.size_matched
    ?? order?.matchedSize
    ?? order?.matched_size
    ?? order?.matchedShares
    ?? order?.matched_shares;
  const shares = Number(value);
  return Number.isFinite(shares) && shares > 0 ? shares : 0;
}

function orderStatus(order) {
  const status = String(order?.status || order?.state || 'UNKNOWN').toUpperCase();
  if (status === 'CANCELED') return 'CANCELLED';
  return status;
}

function timestampMillis(value) {
  if (value == null || value === '') return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function orderErrorClass(value) {
  const message = String(value || '').toLowerCase();
  if (!message) return 'NONE';
  if (/\b429\b|rate.?limit|too many requests/.test(message)) return 'RATE_LIMITED';
  if (/\b404\b|not found|unknown order/.test(message)) return 'ORDER_NOT_FOUND';
  if (/\b401\b|\b403\b|unauthori[sz]ed|forbidden/.test(message)) return 'AUTH_ERROR';
  if (/timeout|timed out|econn|network|fetch failed/.test(message)) return 'NETWORK_ERROR';
  if (/cancel|canceled|cancelled/.test(message)) return 'CANCEL_UNCONFIRMED';
  return 'OTHER';
}

function isTerminalOrder(order) {
  return TERMINAL_ORDER_STATUSES.has(orderStatus(order))
    || matchedShares(order) >= Number(order?.shares || Infinity) - EPSILON;
}

function isActiveOrder(order) {
  return !isTerminalOrder(order)
    && !['REJECTED', 'SUBMISSION_UNCERTAIN', 'CANCEL_UNCERTAIN', 'RECONCILIATION_REQUIRED']
      .includes(orderStatus(order));
}

function isAssumedFailedSellOrder(order) {
  return order?.action === 'SELL_FLIP'
    && order.assumedFailedByPolicy === true
    && !order.id
    && ['SUBMITTING', 'SUBMISSION_UNCERTAIN'].includes(orderStatus(order));
}

function isFailedSellFlipOrder(order) {
  return order?.action === 'SELL_FLIP'
    && matchedShares(order) <= EPSILON
    && (
      ['REJECTED', 'UNFILLED'].includes(orderStatus(order))
      || isAssumedFailedSellOrder(order)
    );
}

function errorText(error) {
  return String(error?.message || error || 'Unknown order error').slice(0, 240);
}

function safeErrorName(error) {
  const name = String(error?.name || '');
  return /^(?:Error|[A-Z][A-Za-z]{0,31}(?:Error|Exception))$/.test(name) ? name : null;
}

function safeErrorCode(error) {
  const code = String(error?.code || error?.cause?.code || '');
  return /^(?:ERR_[A-Z0-9_]{1,60}|E(?:CONN[A-Z]+|HOSTUNREACH|AI_AGAIN|ADDRINUSE|ADDRNOTAVAIL|PIPE|TIMEDOUT)|INVALID_ARGUMENT|BAD_DATA|NETWORK_ERROR|SERVER_ERROR|UNKNOWN_ERROR)$/.test(code)
    ? code : null;
}

function getCandleSignalPriority(candles) {
  const closedCandles = (Array.isArray(candles) ? candles : [])
    .filter(candle => candle?.closed !== false
      && Number.isFinite(Number(candle?.open))
      && Number.isFinite(Number(candle?.close))
      && Number(candle.open) > 0
      && Number(candle.close) > 0)
    .slice(-CANDLE_STREAK_MEAN_REVERSION_THRESHOLD);
  const latest = closedCandles.at(-1);
  if (!latest) {
    return {
      side: null,
      color: 'UNKNOWN',
      streak: 0,
      meanReversion: false,
      reason: 'Closed candle data is unavailable; the strongest qualifying edge will be selected.',
    };
  }

  const color = Number(latest.close) > Number(latest.open)
    ? 'GREEN'
    : Number(latest.close) < Number(latest.open) ? 'RED' : 'DOJI';
  if (color === 'DOJI') {
    return {
      side: null,
      color,
      streak: 0,
      meanReversion: false,
      reason: 'The latest closed candle is a doji; the strongest qualifying edge will be selected.',
    };
  }

  let streak = 0;
  for (let index = closedCandles.length - 1; index >= 0; index -= 1) {
    const candle = closedCandles[index];
    const candleColor = Number(candle.close) > Number(candle.open)
      ? 'GREEN'
      : Number(candle.close) < Number(candle.open) ? 'RED' : 'DOJI';
    if (candleColor !== color) break;
    streak += 1;
  }
  const meanReversion = streak >= CANDLE_STREAK_MEAN_REVERSION_THRESHOLD;
  const trendSide = color === 'GREEN' ? 'UP' : 'DOWN';
  const side = meanReversion
    ? (trendSide === 'UP' ? 'DOWN' : 'UP')
    : trendSide;
  const streakLabel = meanReversion
    ? `${CANDLE_STREAK_MEAN_REVERSION_THRESHOLD}+`
    : String(streak);
  return {
    side,
    color,
    streak: Math.min(streak, CANDLE_STREAK_MEAN_REVERSION_THRESHOLD),
    meanReversion,
    reason: meanReversion
      ? `${side} is prioritized first after ${streakLabel} consecutive ${color.toLowerCase()} candles (mean reversion).`
      : `${side} is prioritized first after the latest ${color.toLowerCase()} candle.`,
  };
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

class LiveBtcMispricingBot extends BtcMispricingBot {
  constructor(options = {}) {
    const config = {
      ...DEFAULT_CONFIG,
      STRATEGY_VERSION: 'btc-live-mispricing-candle-streak-priority-v1',
      BASE_SHARES: 10,
      LOSS_SIZE_STEP_SHARES: 2,
      WIN_SIZE_REDUCTION_SHARES: 3,
      ...(options.config || {}),
    };
    super({ ...options, config });
    this.trader = options.trader || null;
    this.tradingEnabled = options.tradingEnabled === true;
    this.orderTimeoutMs = Math.max(500, Number(options.orderTimeoutMs) || 1_500);
    this.orderPollMs = Math.max(100, Number(options.orderPollMs) || 300);
    this.processStartedAt = this.now();
    this.accountRefreshMs = Math.max(5_000, Number(options.accountRefreshMs) || 15_000);
    this.accountRefreshTimer = null;
    this.liveAccount = {
      authenticated: false,
      accountReady: false,
      status: 'STARTING',
      collateral: null,
      positionValue: null,
      equity: null,
      positions: [],
      orders: [],
      transactions: [],
      asOf: null,
      orderSnapshotStatus: 'UNKNOWN',
      ordersSnapshotAt: null,
      orderSnapshotError: null,
      balanceStatus: 'LOADING',
      positionsStatus: 'LOADING',
      positionsHttpStatus: null,
      positionsRetryAfterMs: null,
      activityStatus: 'LOADING',
      error: null,
      errorName: null,
      errorCode: null,
    };
    this.liveOrders = [];
    this.activeLiveOrderId = null;
    this.pendingFlip = null;
    this.lastHaltRecoverySignature = null;
    this.liveHalted = false;
    this.liveHaltReason = null;
    this.historyResetRequestId = '';
    this.evaluatePromise = null;
    this.priceFeed.onUpdate = () => { void this.tick(); };
  }

  restoreState(state) {
    super.restoreState(state);
    this.historyResetRequestId = String(state.historyResetRequestId || '');
    this.liveOrders = Array.isArray(state.liveOrders) ? state.liveOrders : [];
    // Ignore legacy flip state so an old pending flip cannot submit a new order.
    this.pendingFlip = null;
    this.liveHalted = state.liveHalted === true;
    this.liveHaltReason = state.liveHaltReason || null;
    for (const order of this.liveOrders) {
      if (order.action === 'SELL_FLIP'
        && !order.id
        && ['SUBMITTING', 'SUBMISSION_UNCERTAIN'].includes(orderStatus(order))) {
        order.assumedFailedByPolicy = true;
        order.assumptionPolicy = 'ASSUME_UNFILLED_AND_CONTINUE';
        order.assumedFailedAt ||= this.now();
      }
    }
    const uncertain = this.liveOrders.find(order =>
      ['SUBMITTING', 'SUBMISSION_UNCERTAIN', 'CANCEL_UNCERTAIN', 'RECONCILIATION_REQUIRED']
        .includes(orderStatus(order))
        && !order.id
        && !isAssumedFailedSellOrder(order));
    if (uncertain) {
      this.liveHalted = true;
      this.liveHaltReason = RESTORED_ORDER_ID_MISSING_HALT_REASON;
    } else if (this.liveHalted
      && [
        SUBMISSION_UNCERTAIN_HALT_REASON,
        ORDER_ID_MISSING_HALT_REASON,
        RESTORED_ORDER_ID_MISSING_HALT_REASON,
      ].includes(this.liveHaltReason)
      && !this.liveOrders.some(order => !isAssumedFailedSellOrder(order)
        && (
          ['SUBMITTING', 'SUBMISSION_UNCERTAIN', 'CANCEL_UNCERTAIN', 'RECONCILIATION_REQUIRED']
            .includes(orderStatus(order))
          || !order.processed
          || !isTerminalOrder(order)
        ))
      && !this.pendingFlip) {
      this.liveHalted = false;
      this.liveHaltReason = null;
      if (this.status === 'ERROR') {
        this.status = 'RUNNING';
        this.statusReason = 'Resumed after an uncertain flip sell was treated as unfilled by policy.';
      }
    }
  }

  persistentStateSnapshot() {
    return {
      ...super.persistentStateSnapshot(),
      liveOrders: this.liveOrders,
      pendingFlip: this.pendingFlip,
      liveHalted: this.liveHalted,
      liveHaltReason: this.liveHaltReason,
      historyResetRequestId: this.historyResetRequestId || null,
    };
  }

  async start() {
    if (this.running) return this.snapshot();
    await this.applyHistoryResetRequest();
    this.processStartedAt = this.now();
    await super.start();
    if (this.trader) {
      let authenticated = false;
      try {
        await this.trader.authenticate();
        authenticated = true;
        this.liveAccount.authenticated = true;
        this.liveAccount.accountReady = true;
        this.liveAccount.status = 'READY';
        this.liveAccount.error = null;
        this.liveAccount.errorName = null;
        this.liveAccount.errorCode = null;
        await this.refreshAccountSnapshot();
        await this.reconcileLiveOrders();
        await this.clearResolvedAuthHalt();
        await this.clearResolvedSubmissionHalt();
      } catch (error) {
        this.liveAccount.error = errorText(error);
        this.liveAccount.errorName = safeErrorName(error);
        this.liveAccount.errorCode = safeErrorCode(error);
        if (!authenticated) {
          this.liveAccount.authenticated = false;
          this.liveAccount.accountReady = false;
          this.liveAccount.status = 'AUTH_ERROR';
          if (this.tradingEnabled) this.haltLiveTrading(AUTHENTICATION_HALT_REASON);
        } else {
          this.liveAccount.authenticated = true;
          this.liveAccount.accountReady = true;
          this.liveAccount.status = 'READY';
          this.liveAccount.orderSnapshotStatus = 'STALE';
          this.liveAccount.orderSnapshotError = this.liveAccount.error;
          if (this.tradingEnabled) {
            this.haltLiveTrading('An existing order could not be reconciled; new orders are blocked.');
          }
        }
      }
    } else {
      this.liveAccount.status = 'UNAVAILABLE';
      this.liveAccount.error = 'Polymarket account adapter is not configured.';
      if (this.tradingEnabled) {
        this.haltLiveTrading('Polymarket account adapter is not configured.');
      }
    }
    this.scheduleAccountRefresh();
    await this.tick();
    return this.snapshot();
  }

  async applyHistoryResetRequest() {
    const requestId = String(
      process.env.BTC_LIVE_MISPRICING_HISTORY_RESET_REQUEST_ID || '',
    ).trim();
    if (!requestId) return false;
    if (!this.stateStore || typeof this.stateStore.resetHistoryOnce !== 'function') {
      throw new Error('A live history reset was requested, but the durable live store cannot reset history.');
    }
    const reset = await this.stateStore.resetHistoryOnce(requestId);
    this.historyResetRequestId = requestId;
    if (reset) console.log('BTC live mispricing local history reset completed.');
    return reset;
  }

  async stop() {
    if (this.accountRefreshTimer) clearTimeout(this.accountRefreshTimer);
    this.accountRefreshTimer = null;
    await super.stop();
  }

  scheduleAccountRefresh() {
    if (!this.running || !this.trader) return;
    if (this.accountRefreshTimer) clearTimeout(this.accountRefreshTimer);
    this.accountRefreshTimer = setTimeout(async () => {
      try {
        const refreshed = await this.refreshAccountSnapshot();
        if (refreshed && this.liveHalted) {
          await this.reconcileLiveOrders();
          await this.clearResolvedSubmissionHalt();
        }
      } catch (error) {
        this.error = errorText(error);
      } finally {
        this.scheduleAccountRefresh();
      }
    }, this.accountRefreshMs);
    this.accountRefreshTimer.unref?.();
  }

  async refreshAccountSnapshot() {
    if (!this.trader || !this.liveAccount.authenticated) return false;
    try {
      const account = typeof this.trader.getTradingSnapshot === 'function'
        ? await this.trader.getTradingSnapshot()
        : await this.trader.getEquitySnapshot();
      this.liveAccount = {
        ...this.liveAccount,
        ...account,
        authenticated: true,
        accountReady: true,
        status: 'READY',
        orderSnapshotStatus: account.orderSnapshotStatus || 'READY',
        orderSnapshotError: null,
        error: null,
        errorName: null,
        errorCode: null,
      };
      if (typeof this.trader.refreshDisplaySnapshot === 'function') {
        void this.trader.refreshDisplaySnapshot().then(display => {
          const previousPositionsStatus = this.liveAccount.positionsStatus;
          const previousPositionsHttpStatus = this.liveAccount.positionsHttpStatus;
          this.liveAccount = {
            ...this.liveAccount,
            ...display,
            authenticated: true,
            accountReady: true,
            status: 'READY',
          };
          if (
            previousPositionsStatus !== this.liveAccount.positionsStatus
            || previousPositionsHttpStatus !== this.liveAccount.positionsHttpStatus
          ) {
            const diagnostic = `status=${this.liveAccount.positionsStatus || 'UNKNOWN'} `
              + `httpStatus=${this.liveAccount.positionsHttpStatus ?? 'NONE'} `
              + `retryAfterMs=${this.liveAccount.positionsRetryAfterMs ?? 'NONE'}`;
            this.log(
              'ACCOUNT_POSITIONS_SNAPSHOT',
              diagnostic,
            );
            console.log(`Polymarket positions snapshot ${diagnostic}`);
          }
        }).catch(error => {
          this.liveAccount.positionsStatus = error?.rateLimited
            ? 'RATE_LIMITED'
            : error?.cooldown
              ? 'COOLDOWN'
              : 'STALE';
          this.liveAccount.positionsError = errorText(error);
        });
      }
      return true;
    } catch (error) {
      this.liveAccount.authenticated = true;
      this.liveAccount.accountReady = true;
      this.liveAccount.status = 'READY';
      this.liveAccount.orderSnapshotStatus = 'STALE';
      this.liveAccount.orderSnapshotError = errorText(error);
      this.liveAccount.error = errorText(error);
      this.liveAccount.errorName = safeErrorName(error);
      this.liveAccount.errorCode = safeErrorCode(error);
      return false;
    }
  }

  haltLiveTrading(reason) {
    this.liveHalted = true;
    this.liveHaltReason = String(reason || 'Live trading is halted.');
    this.status = 'ERROR';
    this.statusReason = this.liveHaltReason;
    this.log('LIVE_TRADING_HALTED', this.liveHaltReason);
    this.schedulePersist(true);
  }

  async clearResolvedAuthHalt() {
    if (
      !this.liveHalted
      || this.liveHaltReason !== AUTHENTICATION_HALT_REASON
      || !this.liveAccount.accountReady
      || !this.stateStore
      || !this.storageHealthy
    ) {
      return false;
    }
    this.liveHalted = false;
    this.liveHaltReason = null;
    return this.persist();
  }

  submissionHaltRecoveryDiagnostics() {
    const blockers = [];
    const maxSnapshotAgeMs = Math.max(60_000, this.accountRefreshMs * 3);
    const snapshotAt = timestampMillis(this.liveAccount.ordersSnapshotAt);
    const snapshotAgeMs = Number.isFinite(snapshotAt) ? this.now() - snapshotAt : Number.NaN;

    if (!RECOVERABLE_ORDER_HALT_REASONS.has(this.liveHaltReason)) {
      blockers.push('HALT_REASON_NOT_RECOVERABLE');
    }
    if (!this.liveAccount.accountReady) blockers.push('ACCOUNT_NOT_READY');
    if (String(this.liveAccount.status || '').toUpperCase() !== 'READY') {
      blockers.push('ACCOUNT_STATUS_NOT_READY');
    }
    if (this.liveAccount.orderSnapshotStatus !== 'READY') {
      blockers.push('ORDER_SNAPSHOT_NOT_READY');
    } else if (!Number.isFinite(snapshotAt)) {
      blockers.push('ORDER_SNAPSHOT_TIMESTAMP_MISSING');
    } else if (snapshotAgeMs < 0) {
      blockers.push('ORDER_SNAPSHOT_FROM_FUTURE');
    } else if (snapshotAgeMs > maxSnapshotAgeMs) {
      blockers.push('ORDER_SNAPSHOT_STALE');
    }
    if (!Array.isArray(this.liveAccount.orders)) {
      blockers.push('EXCHANGE_ORDERS_UNAVAILABLE');
    } else if (this.liveAccount.orders.length > 0) {
      blockers.push('EXCHANGE_OPEN_ORDERS_PRESENT');
    }
    if (this.pendingFlip) blockers.push('PENDING_FLIP_PRESENT');
    if (this.activeLiveOrderId) blockers.push('ACTIVE_ORDER_PRESENT');
    if (!this.stateStore || !this.storageHealthy) {
      blockers.push('PERSISTENCE_UNAVAILABLE');
    }

    const localOrders = Array.isArray(this.liveOrders) ? this.liveOrders : [];
    const unresolvedOrders = localOrders.filter(order => {
      if (isAssumedFailedSellOrder(order)) return false;
      const status = orderStatus(order);
      const terminal = isTerminalOrder({
        ...order,
        shares: order.shares,
        matchedShares: order.matchedShares,
      });
      const confirmedFillMissingDetails = ['MATCHED', 'FILLED'].includes(status)
        && (!order.id || Number(order.matchedShares) <= EPSILON);
      return ['SUBMITTING', 'SUBMISSION_UNCERTAIN', 'CANCEL_UNCERTAIN', 'RECONCILIATION_REQUIRED']
        .includes(status)
        || !order.processed
        || !terminal
        || confirmedFillMissingDetails;
    });
    const unresolvedStatusCounts = {};
    const orderClosureStatusCounts = {};
    const unresolvedErrorClassCounts = {};
    for (const order of unresolvedOrders) {
      const status = String(orderStatus(order) || 'UNKNOWN')
        .replace(/[^A-Z0-9_]/g, '_')
        .slice(0, 40);
      unresolvedStatusCounts[status] = (unresolvedStatusCounts[status] || 0) + 1;
      const closureStatus = this.orderClosureStatus(order);
      orderClosureStatusCounts[closureStatus] = (orderClosureStatusCounts[closureStatus] || 0) + 1;
      const errorClass = orderErrorClass(order.error);
      unresolvedErrorClassCounts[errorClass] = (unresolvedErrorClassCounts[errorClass] || 0) + 1;
    }
    const missingOrderIdCount = unresolvedOrders.filter(order => !order.id).length;
    if (unresolvedOrders.length > 0) blockers.push('LOCAL_ORDERS_UNRESOLVED');
    if (missingOrderIdCount > 0) blockers.push('LOCAL_ORDER_ID_MISSING');

    return {
      canClear: this.liveHalted && blockers.length === 0,
      blockers,
      unresolvedOrderCount: unresolvedOrders.length,
      missingOrderIdCount,
      unresolvedStatusCounts,
      orderClosureStatusCounts,
      unresolvedErrorClassCounts,
      localOrderCount: localOrders.length,
      assumedFailedSellCount: localOrders.filter(isAssumedFailedSellOrder).length,
      exchangeOpenOrderCount: Array.isArray(this.liveAccount.orders)
        ? this.liveAccount.orders.length
        : null,
      orderSnapshotAgeMs: Number.isFinite(snapshotAgeMs) ? snapshotAgeMs : null,
    };
  }

  async clearResolvedSubmissionHalt() {
    if (!this.liveHalted) return false;
    const diagnostics = this.submissionHaltRecoveryDiagnostics();
    if (!diagnostics.canClear) {
      const statusSummary = Object.entries(diagnostics.unresolvedStatusCounts)
        .map(([status, count]) => `${status}:${count}`)
        .join(',') || 'NONE';
      const closureSummary = Object.entries(diagnostics.orderClosureStatusCounts)
        .map(([status, count]) => `${status}:${count}`)
        .join(',') || 'NONE';
      const errorSummary = Object.entries(diagnostics.unresolvedErrorClassCounts)
        .map(([status, count]) => `${status}:${count}`)
        .join(',') || 'NONE';
      const signature = [
        diagnostics.blockers.join(',') || 'UNKNOWN',
        statusSummary,
        closureSummary,
        errorSummary,
      ].join('|');
      if (signature !== this.lastHaltRecoverySignature) {
        this.lastHaltRecoverySignature = signature;
        const message = `blockers=${diagnostics.blockers.join(',') || 'UNKNOWN'} `
          + `localOrders=${diagnostics.localOrderCount} `
          + `unresolvedOrders=${diagnostics.unresolvedOrderCount} `
          + `missingOrderIds=${diagnostics.missingOrderIdCount} `
          + `statuses=${statusSummary} `
          + `snapshotClosure=${closureSummary} `
          + `orderErrors=${errorSummary}`;
        this.log('LIVE_HALT_RECOVERY_BLOCKED', message);
        console.warn(`Live halt recovery blocked ${message}`);
      }
      return false;
    }
    this.lastHaltRecoverySignature = null;
    this.liveHalted = false;
    this.liveHaltReason = null;
    return this.persist();
  }

  async tick() {
    if (this.tickInProgress) return this.snapshot();
    this.tickInProgress = true;
    const now = this.now();
    try {
      const currentStart = Math.floor(now / this.config.WINDOW_MS) * this.config.WINDOW_MS;
      if (this.windowStart !== currentStart) {
        await this.cancelOrdersFromPreviousWindow(currentStart);
        await this.resetWindow(currentStart);
        if (this.pendingFlip && this.pendingFlip.windowStart !== currentStart) {
          this.pendingFlip = null;
          this.schedulePersist(true);
        }
      }
      if (!this.market) await this.loadMarket(currentStart);
      await this.reconcileLiveOrders();
      await this.clearResolvedSubmissionHalt();
      if (this.market) await this.evaluate(now);
      this.updateOpenMarks(now);
      await this.resolveDue(now);
      if (this.market) {
        this.status = this.storageHealthy ? 'RUNNING' : 'ERROR';
        this.statusReason = this.liveHalted
          ? this.liveHaltReason
          : this.tradingEnabled
            ? 'BTC 5-minute signal bot is active; exchange-confirmed fills only.'
            : 'Read-only monitoring; live order submission is disabled.';
      }
      return this.snapshot();
    } catch (error) {
      this.error = errorText(error);
      this.status = 'ERROR';
      this.statusReason = 'The live bot paused after an evaluation or exchange error.';
      return this.snapshot();
    } finally {
      this.tickInProgress = false;
    }
  }

  async evaluate(now = this.now()) {
    if (this.evaluatePromise) return this.evaluatePromise;
    this.evaluatePromise = this.evaluateLive(now)
      .finally(() => { this.evaluatePromise = null; });
    return this.evaluatePromise;
  }

  async evaluateLive(now) {
    if (!this.market || this.windowStart == null || !this.storageHealthy) return false;
    const model = this.modelSnapshot(now);
    this.model = model;
    if (!model.ready) {
      this.resetFlipConfirmation();
      this.currentSignal = { side: null, reason: model.reason, edgePerShare: null };
      return false;
    }
    const openTrade = this.currentOpenTrade();
    if (openTrade) {
      this.currentSignal = {
        side: openTrade.side,
        reason: this.liveHalted
          ? this.liveHaltReason
          : 'Holding this position to market resolution; in-window sells and opposite-side re-entries are disabled.',
        edgePerShare: null,
      };
      return false;
    }
    if (this.entryTriggeredThisWindow || now >= this.windowEnd) return false;
    if (this.windowStart < this.processStartedAt) {
      this.currentSignal = {
        side: null,
        reason: 'Waiting for a new 5-minute window; this service will not enter mid-window after startup.',
        edgePerShare: null,
      };
      return false;
    }
    const shares = this.nextEntryShares;
    const candlePriority = getCandleSignalPriority(this.priceFeed.snapshot?.()?.candles);
    const candidates = ['UP', 'DOWN'].map(side => {
      if (!this.sideQuoteIsFresh(side, now)) return null;
      const preview = this.sweep(side, 'asks', shares);
      if (!preview?.complete) return null;
      const probability = side === 'UP' ? model.probabilityUp : model.probabilityDown;
      const expectedProfit = probability * shares - preview.totalCost;
      return { side, preview, edgePerShare: expectedProfit / shares };
    }).filter(candidate => candidate
      && candidate.edgePerShare >= this.config.MIN_NET_EDGE_PER_SHARE);
    if (!candidates.length) {
      this.currentSignal = {
        side: null,
        reason: `${candlePriority.reason} No side clears the minimum net edge after visible ask-depth and fee estimates.`,
        edgePerShare: null,
      };
      return false;
    }
    candidates.sort((left, right) => {
      const leftPriority = left.side === candlePriority.side ? 0 : 1;
      const rightPriority = right.side === candlePriority.side ? 0 : 1;
      return leftPriority - rightPriority || right.edgePerShare - left.edgePerShare;
    });
    const selected = candidates[0];
    const selectionReason = candlePriority.side
      ? selected.side === candlePriority.side
        ? candlePriority.reason
        : `Priority ${candlePriority.side} did not qualify; selecting the strongest qualifying ${selected.side} signal.`
      : candlePriority.reason;
    this.currentSignal = {
      side: selected.side,
      reason: this.tradingEnabled
        ? `${selectionReason} Signal qualifies; submitting an immediate FAK taker buy capped at $${MAX_TAKER_BUY_PRICE.toFixed(2)}.`
        : `${selectionReason} Signal qualifies, but live order submission is disabled.`,
      edgePerShare: selected.edgePerShare,
    };
    if (!this.tradingEnabled || !this.liveAccount.accountReady || this.liveHalted) return false;
    this.entryTriggeredThisWindow = true;
    const order = await this.submitSweepOrder({
      action: 'BUY_ENTRY',
      side: selected.side,
      shares,
      preview: selected.preview,
      model,
      edgePerShare: selected.edgePerShare,
      entryReason: 'MODEL_EDGE',
      windowStart: this.windowStart,
      windowEnd: this.windowEnd,
    });
    this.currentSignal = {
      side: selected.side,
      reason: order?.matchedShares > 0
        ? `${selectionReason} Bought ${round(order.matchedShares, 2)} ${selected.side} shares from exchange-confirmed fills.`
        : order?.status === 'REJECTED'
          ? `${selectionReason} The exchange rejected the ${selected.side} entry; no fill was recorded.`
          : `${selectionReason} No shares filled for the ${selected.side} signal; the order was canceled or requires review.`,
      edgePerShare: selected.edgePerShare,
    };
    this.schedulePersist(true);
    return Boolean(order?.matchedShares > 0);
  }

  async evaluateLiveFlip(openTrade) {
    this.currentSignal = {
      side: openTrade?.side || null,
      reason: 'Holding this position to market resolution; in-window sells and opposite-side re-entries are disabled.',
      edgePerShare: null,
    };
    return false;

    const opposite = openTrade.side === 'UP' ? 'DOWN' : 'UP';
    if (this.flipAttemptsWindowStart !== this.windowStart) {
      this.flipAttemptsWindowStart = this.windowStart;
      this.flipAttemptsThisWindow = 0;
    }
    const legacySellAttempt = this.liveOrders.some(order =>
      order.action === 'SELL_FLIP'
      && !order.flipPairId
      && Number(order.windowStart) === Number(this.windowStart));
    if (legacySellAttempt) {
      this.flipAttemptsThisWindow = Math.max(1, this.flipAttemptsThisWindow);
      this.resetFlipConfirmation();
      this.currentSignal = {
        side: opposite,
        reason: 'A prior sell attempt exists for this window; holding the existing position instead of duplicating the sell.',
        edgePerShare: null,
      };
      this.schedulePersist(true);
      return false;
    }
    if (!this.tradingEnabled || !this.liveAccount.accountReady || this.liveHalted
      || Math.max(this.flipsThisWindow, this.flipAttemptsThisWindow)
        >= this.config.MAX_FLIPS_PER_WINDOW
      || now >= this.windowEnd
      || !this.sideQuoteIsFresh(openTrade.side, now)
      || !this.sideQuoteIsFresh(opposite, now)) {
      this.resetFlipConfirmation();
      return false;
    }

    const estimatedSellShares = Math.floor(
      (this.currentWindowFilledExposure(openTrade.side, openTrade) + 1e-9) * 100,
    ) / 100;
    if (estimatedSellShares <= EPSILON) {
      this.resetFlipConfirmation();
      this.currentSignal = {
        side: opposite,
        reason: `No confirmed current-window ${openTrade.side} shares are available to flip.`,
        edgePerShare: null,
      };
      return false;
    }
    const estimatedBuyPreview = this.sweep(opposite, 'asks', estimatedSellShares);
    const probability = opposite === 'UP' ? model.probabilityUp : model.probabilityDown;
    const estimatedEdgePerShare = estimatedBuyPreview?.complete
      ? (probability * estimatedSellShares - estimatedBuyPreview.totalCost) / estimatedSellShares
      : null;
    if (!estimatedBuyPreview?.complete || estimatedEdgePerShare == null
      || estimatedEdgePerShare < this.config.MIN_FLIP_NET_EDGE_PER_SHARE) {
      this.resetFlipConfirmation();
      this.currentSignal = {
        side: opposite,
        reason: !estimatedBuyPreview?.complete
          ? `Holding: visible asks do not cover the estimated ${estimatedSellShares} opposite shares.`
          : `Holding: opposite edge is below the $${this.config.MIN_FLIP_NET_EDGE_PER_SHARE.toFixed(2)} flip threshold.`,
        edgePerShare: estimatedEdgePerShare,
      };
      return false;
    }
    const confirmation = this.recordFlipConfirmation(opposite, model, now);
    if (!confirmation.confirmed) {
      this.currentSignal = {
        side: opposite,
        reason: `Waiting for ${opposite} confirmation (${confirmation.count}/${this.config.FLIP_CONFIRMATION_UPDATES} fresh ticks).`,
        edgePerShare: estimatedEdgePerShare,
      };
      return false;
    }
    this.resetFlipConfirmation();
    const tokenId = String(this.market.tokens?.[openTrade.side] || '');
    if (!tokenId
      || String(openTrade.marketId || '') !== String(this.market.id)
      || Number(openTrade.windowStart) !== Number(this.windowStart)
      || (openTrade.tokenId && String(openTrade.tokenId) !== tokenId)) {
      this.currentSignal = {
        side: opposite,
        reason: 'The open position does not match this window’s market and outcome token; no sell was submitted.',
        edgePerShare: estimatedEdgePerShare,
      };
      return false;
    }
    const confirmedExposure = this.currentWindowFilledExposure(
      openTrade.side,
      openTrade,
    );
    if (!tokenId || confirmedExposure <= EPSILON) {
      this.currentSignal = {
        side: opposite,
        reason: `No confirmed current-window ${openTrade.side} fills were found for this market token; checking again on the next signal.`,
        edgePerShare: estimatedEdgePerShare,
      };
      return false;
    }

    let balance;
    try {
      if (typeof this.trader?.getSellableShares !== 'function') {
        throw new Error('Current-token balance refresh is unavailable.');
      }
      balance = await this.trader.getSellableShares(tokenId);
    } catch (error) {
      this.currentSignal = {
        side: opposite,
        reason: `Could not refresh the ${openTrade.side} token balance; will retry on the next signal.`,
        edgePerShare: estimatedEdgePerShare,
      };
      this.log('LIVE_FLIP_BALANCE_REFRESH_FAILED', errorText(error), {
        marketId: String(this.market.id),
        tokenId,
        windowStart: this.windowStart,
      });
      return false;
    }
    const sellShares = Math.floor(
      (Math.min(confirmedExposure, Number(balance?.shares) || 0) + 1e-9) * 100,
    ) / 100;
    if (sellShares <= EPSILON) {
      this.currentSignal = {
        side: opposite,
        reason: `No sellable ${openTrade.side} shares are available for the current market token yet; will recheck on the next signal.`,
        edgePerShare: estimatedEdgePerShare,
      };
      return false;
    }

    const buyPreview = this.sweep(opposite, 'asks', sellShares);
    const edgePerShare = buyPreview?.complete
      ? (probability * sellShares - buyPreview.totalCost) / sellShares
      : null;
    if (!buyPreview?.complete || edgePerShare == null
      || edgePerShare < this.config.MIN_FLIP_NET_EDGE_PER_SHARE) {
      this.currentSignal = {
        side: opposite,
        reason: !buyPreview?.complete
          ? `Holding: visible asks do not cover all ${sellShares} opposite shares.`
          : `Holding: opposite edge is below the $${this.config.MIN_FLIP_NET_EDGE_PER_SHARE.toFixed(2)} flip threshold.`,
        edgePerShare,
      };
      return false;
    }
    const salePreview = this.sweep(openTrade.side, 'bids', sellShares);

    const flipPairId = `flip-pair-${this.windowStart}-${this.liveOrders.length + 1}`;
    this.pendingFlip = {
      phase: 'PAIR',
      pairId: flipPairId,
      tradeId: openTrade.id,
      fromSide: openTrade.side,
      toSide: opposite,
      targetShares: sellShares,
      sellShares,
      buyShares: sellShares,
      windowStart: this.windowStart,
      windowEnd: this.windowEnd,
      startedAt: now,
    };
    this.flipAttemptsWindowStart = this.windowStart;
    this.flipAttemptsThisWindow += 1;

    const sellOrder = this.createSweepOrder({
      action: 'SELL_FLIP',
      side: openTrade.side,
      shares: sellShares,
      preview: salePreview,
      model,
      edgePerShare,
      tradeId: openTrade.id,
      windowStart: this.windowStart,
      windowEnd: this.windowEnd,
      flipPairId,
    });
    const buyOrder = this.createSweepOrder({
      action: 'BUY_FLIP',
      side: opposite,
      shares: sellShares,
      preview: buyPreview,
      model,
      edgePerShare,
      entryReason: 'OPPOSITE_MODEL_FLIP',
      windowStart: this.windowStart,
      windowEnd: this.windowEnd,
      flipPairId,
    });
    if (!sellOrder || !buyOrder) {
      const createdIds = new Set([sellOrder?.localId, buyOrder?.localId].filter(Boolean));
      this.liveOrders = this.liveOrders.filter(order => !createdIds.has(order.localId));
      this.flipAttemptsThisWindow = Math.max(0, this.flipAttemptsThisWindow - 1);
      this.pendingFlip = null;
      await this.persist();
      return false;
    }

    const activePairLock = `active-${flipPairId}`;
    this.activeLiveOrderId = activePairLock;
    await this.persist();
    let submittedSell;
    let submittedBuy;
    try {
      [submittedSell, submittedBuy] = await Promise.all([
        this.submitPreparedSweepOrder(sellOrder, model),
        this.submitPreparedSweepOrder(buyOrder, model),
      ]);
      if (submittedSell?.matchedShares > EPSILON
        && submittedBuy?.matchedShares > EPSILON) {
        this.flipsThisWindow += 1;
      }
    } finally {
      if (this.pendingFlip?.pairId === flipPairId) this.pendingFlip = null;
      if (this.activeLiveOrderId === activePairLock) this.activeLiveOrderId = null;
      await this.persist();
    }

    this.log('LIVE_FLIP_PAIR_SUBMITTED',
      `Submitted independent ${sellShares}-share sell and buy orders for the ${openTrade.side}-to-${opposite} flip.`,
      {
        flipPairId,
        fromSide: openTrade.side,
        toSide: opposite,
        requestedShares: sellShares,
        sellMatchedShares: submittedSell?.matchedShares || 0,
        buyMatchedShares: submittedBuy?.matchedShares || 0,
        sellStatus: submittedSell?.status || 'NOT_SUBMITTED',
        buyStatus: submittedBuy?.status || 'NOT_SUBMITTED',
      });
    this.currentSignal = {
      side: opposite,
      reason: `Paired orders requested ${sellShares} shares each; sell ${submittedSell?.status || 'NOT_SUBMITTED'}, buy ${submittedBuy?.status || 'NOT_SUBMITTED'}.`,
      edgePerShare,
    };
    this.schedulePersist(true);
    return Boolean(submittedBuy?.matchedShares > 0);
  }

  currentWindowFilledExposure(side, openTrade = null) {
    const tokenId = String(this.market?.tokens?.[side] || '');
    const matchingOrders = this.liveOrders.filter(order =>
      String(order.marketId || '') === String(this.market?.id || '')
      && Number(order.windowStart) === Number(this.windowStart)
      && String(order.tokenId || '') === tokenId
      && order.id);
    if (matchingOrders.length === 0) {
      return Math.max(0, Number(openTrade?.shares) || 0);
    }
    const bought = matchingOrders
      .filter(order => ['BUY_ENTRY', 'BUY_FLIP'].includes(order.action))
      .reduce((total, order) => total + matchedShares(order), 0);
    const sold = matchingOrders
      .filter(order => order.action === 'SELL_FLIP')
      .reduce((total, order) => total + matchedShares(order), 0);
    return Math.max(0, bought - sold);
  }

  async resumePendingFlip() {
    this.pendingFlip = null;
    return false;
  }

  async submitSweepOrder({
    action, side, shares, preview, model, edgePerShare, entryReason, tradeId,
    windowStart, windowEnd, flipPairId,
  }) {
    if (action === 'SELL_FLIP' || action === 'BUY_FLIP') {
      this.log('LIVE_FLIP_DISABLED', 'In-window flip orders are disabled; positions are held to resolution.', {
        action,
        side,
        windowStart,
      });
      return null;
    }
    if (!this.tradingEnabled || !this.liveAccount.accountReady || this.liveHalted) return null;
    if (this.activeLiveOrderId) return null;
    const order = this.createSweepOrder({
      action,
      side,
      shares,
      preview,
      edgePerShare,
      entryReason,
      tradeId,
      windowStart,
      windowEnd,
      flipPairId,
    });
    if (!order) return null;
    this.activeLiveOrderId = order.localId;
    try {
      await this.persist();
      return await this.submitPreparedSweepOrder(order, model);
    } finally {
      if (this.activeLiveOrderId === order.localId) this.activeLiveOrderId = null;
    }
  }

  createSweepOrder({
    action, side, shares, preview, edgePerShare, entryReason, tradeId,
    windowStart, windowEnd, flipPairId,
  }) {
    const lastFill = preview?.fills?.[preview.fills.length - 1];
    const isSell = action.startsWith('SELL');
    const priceLimit = isSell ? MIN_TAKER_SELL_PRICE : MAX_TAKER_BUY_PRICE;
    const accountingPriceEstimate = Number(lastFill?.price) || priceLimit;
    const tokenId = String(this.market?.tokens?.[side] || '');
    if (!Number.isFinite(accountingPriceEstimate) || accountingPriceEstimate <= 0
      || !Number.isFinite(priceLimit) || priceLimit <= 0 || priceLimit > 1
      || !Number.isFinite(Number(shares)) || Number(shares) <= 0
      || !tokenId) {
      this.haltLiveTrading('A candidate order had an invalid size or limit price.');
      return null;
    }
    const localId = `live-${Date.now()}-${this.liveOrders.length + 1}`;
    const order = {
      localId,
      id: null,
      action,
      side,
      tokenId,
      marketId: String(this.market.id),
      marketSlug: this.market.slug,
      windowStart,
      windowEnd,
      shares: Number(shares),
      matchedShares: 0,
      orderType: 'FAK',
      limitPrice: priceLimit,
      priceLimitType: isSell ? 'MINIMUM' : 'MAXIMUM',
      accountingPriceEstimate,
      averagePriceEstimate: Number(preview?.averagePrice) || accountingPriceEstimate,
      edgePerShare,
      tradeId: tradeId || null,
      entryReason: entryReason || null,
      status: 'SUBMITTING',
      processed: false,
      submittedAt: this.now(),
      updatedAt: this.now(),
      error: null,
      flipPairId: flipPairId || null,
    };
    this.liveOrders.push(order);
    return order;
  }

  async submitPreparedSweepOrder(order, model) {
    if (order?.action === 'SELL_FLIP' || order?.action === 'BUY_FLIP') return null;
    const isSell = order.action.startsWith('SELL');
    try {
      const response = await this.trader.placeTakerOrder(
        order.tokenId,
        isSell ? 'SELL' : 'BUY',
        order.limitPrice,
        order.shares,
      );
      order.id = response.id;
      order.status = orderStatus(response);
      order.updatedAt = this.now();
      await this.persist();
      await this.pollAndFinalizeOrder(order);
      await this.processFinalOrder(order, model);
      return order;
    } catch (error) {
      order.error = errorText(error);
      order.updatedAt = this.now();
      if (error?.submissionUncertain !== false) {
        order.status = 'SUBMISSION_UNCERTAIN';
        if (order.action === 'SELL_FLIP' && !order.id) {
          order.assumedFailedByPolicy = true;
          order.assumptionPolicy = 'ASSUME_UNFILLED_AND_CONTINUE';
          order.assumedFailedAt = this.now();
          if (!order.flipPairId) this.pendingFlip = null;
          this.log(
            'LIVE_SELL_FLIP_UNCERTAIN_ASSUMED_FAILED',
            'No-ID flip sell is treated as unfilled for accounting; the paired opposite buy is submitted independently.',
            { localOrderId: order.localId, tradeId: order.tradeId, windowStart: order.windowStart },
          );
        } else {
          this.haltLiveTrading('Order submission outcome is uncertain; automatic retries are blocked.');
        }
      } else {
        order.status = 'REJECTED';
        if (order.action === 'SELL_FLIP') {
          order.processed = true;
          order.processedMatchedShares = 0;
          if (!order.flipPairId) this.pendingFlip = null;
        }
      }
      await this.persist();
      return order;
    }
  }

  async pollAndFinalizeOrder(order) {
    const deadline = this.now() + this.orderTimeoutMs;
    let latest = null;
    while (this.now() < deadline) {
      latest = await this.trader.fetchOrder(order.id);
      this.applyExchangeOrder(order, latest);
      if (order.matchedShares > 0 || isTerminalOrder({
        ...latest, shares: order.shares, matchedShares: order.matchedShares,
      })) break;
      await wait(this.orderPollMs);
    }
    const stillOpen = !isTerminalOrder({
      status: order.status, shares: order.shares, matchedShares: order.matchedShares,
    });
    if (stillOpen) {
      try {
        await this.cancelAndReconcileOrder(order);
      } catch (error) {
        order.status = 'CANCEL_UNCERTAIN';
        order.error = errorText(error);
        order.updatedAt = this.now();
        this.haltLiveTrading('Order cancellation was not confirmed; automatic order submission is blocked.');
        await this.persist();
        throw error;
      }
    } else if (order.matchedShares > 0
      && order.matchedShares < order.shares - EPSILON
      && !TERMINAL_ORDER_STATUSES.has(order.status)) {
      try {
        await this.cancelAndReconcileOrder(order);
      } catch (error) {
        order.status = 'CANCEL_UNCERTAIN';
        order.error = errorText(error);
        this.haltLiveTrading('A partially filled order remainder could not be confirmed canceled.');
        await this.persist();
        throw error;
      }
    }
    order.updatedAt = this.now();
    await this.persist();
  }

  applyExchangeOrder(order, exchangeOrder) {
    order.matchedShares = Math.max(order.matchedShares, matchedShares(exchangeOrder));
    order.status = orderStatus(exchangeOrder);
    order.updatedAt = this.now();
    order.exchangeStatus = order.status;
  }

  applyConfirmedCancellation(order, exchangeOrder) {
    this.applyExchangeOrder(order, exchangeOrder);
    if (order.processed) {
      const alreadyAccounted = Number(order.processedMatchedShares);
      if (!Number.isFinite(alreadyAccounted)
        || Math.abs(alreadyAccounted - Number(order.matchedShares || 0)) > EPSILON) {
        order.status = 'RECONCILIATION_REQUIRED';
        order.error = 'Matched quantity changed after fill processing.';
        return false;
      }
    }
    if (!isTerminalOrder({
      ...exchangeOrder,
      shares: order.shares,
      matchedShares: order.matchedShares,
    })) {
      order.status = 'CANCELLED';
      order.cancelConfirmedAt = this.now();
    }
    return true;
  }

  hasFreshExchangeOrderSnapshot(afterTimestamp = 0) {
    const snapshotAt = timestampMillis(this.liveAccount.ordersSnapshotAt);
    const age = this.now() - snapshotAt;
    const minSnapshotAt = timestampMillis(afterTimestamp) ?? 0;
    return this.liveAccount.accountReady
      && String(this.liveAccount.status || '').toUpperCase() === 'READY'
      && this.liveAccount.orderSnapshotStatus === 'READY'
      && Number.isFinite(snapshotAt)
      && age >= 0
      && age <= Math.max(60_000, this.accountRefreshMs * 3)
      && snapshotAt >= minSnapshotAt
      && Array.isArray(this.liveAccount.orders);
  }

  ledgerMatchedSharesForProcessedOrder(order) {
    const linkedTrade = this.trades.find(trade =>
      trade.id === order.tradeId && trade.orderId === order.id)
      || this.trades.find(trade => trade.orderId === order.id);
    if (!linkedTrade) return null;

    if (order.action === 'BUY_ENTRY' || order.action === 'BUY_FLIP') {
      if (!Array.isArray(linkedTrade.fills) || linkedTrade.fills.length === 0) return null;
      return linkedTrade.fills.reduce(
        (total, fill) => total + Math.max(0, Number(fill?.shares) || 0),
        0,
      );
    }

    if (order.action === 'SELL_FLIP') {
      const partialExitShares = Array.isArray(linkedTrade.partialExits)
        ? linkedTrade.partialExits
          .filter(exit => exit.orderId === order.id)
          .reduce((total, exit) => total + Math.max(0, Number(exit.shares) || 0), 0)
        : 0;
      if (partialExitShares > 0) return partialExitShares;
      if (linkedTrade.exitOrderId === order.id && Array.isArray(linkedTrade.exitFills)) {
        return linkedTrade.exitFills.reduce(
          (total, fill) => total + Math.max(0, Number(fill?.shares) || 0),
          0,
        );
      }
    }
    return null;
  }

  orderClosureStatus(order) {
    if (!order.id) return 'MISSING_ORDER_ID';
    if (!this.hasFreshExchangeOrderSnapshot(order.submittedAt)) {
      return 'FRESH_SNAPSHOT_NOT_AFTER_ORDER';
    }
    const orderId = String(order.id);
    const stillOpen = this.liveAccount.orders.some(exchangeOrder =>
      String(exchangeOrder?.id || exchangeOrder?.orderId || '') === orderId);
    if (stillOpen) return 'ORDER_PRESENT_IN_EXCHANGE';
    if (order.processed) {
      const alreadyAccounted = Number(order.processedMatchedShares);
      const matched = Math.max(0, Number(order.matchedShares) || 0);
      if (Number.isFinite(alreadyAccounted) && Math.abs(alreadyAccounted - matched) <= EPSILON) {
        // The stored processed quantity is sufficient evidence.
      } else {
        const ledgerMatched = this.ledgerMatchedSharesForProcessedOrder(order);
        if (!Number.isFinite(ledgerMatched) || Math.abs(ledgerMatched - matched) > EPSILON) {
          return 'PROCESSED_FILL_MISMATCH';
        }
        return 'PROCESSED_FILL_LEDGER_MATCH';
      }
    }
    const requested = Number(order.shares);
    if (!Number.isFinite(requested) || requested <= 0) return 'INVALID_REQUESTED_SHARES';
    return 'CLOSEABLE_FROM_FRESH_SNAPSHOT';
  }

  markOrderClosedFromFreshSnapshot(order) {
    const closureStatus = this.orderClosureStatus(order);
    if (![
      'CLOSEABLE_FROM_FRESH_SNAPSHOT',
      'PROCESSED_FILL_LEDGER_MATCH',
    ].includes(closureStatus)) return false;

    const matched = Math.max(0, Number(order.matchedShares) || 0);
    if (closureStatus === 'PROCESSED_FILL_LEDGER_MATCH') {
      order.processedMatchedShares = matched;
    }
    const requested = Number(order.shares);
    order.status = matched >= requested - EPSILON
      ? 'MATCHED'
      : matched > EPSILON
        ? 'CANCELLED'
        : 'UNFILLED';
    order.closedByOpenOrdersSnapshotAt = this.now();
    order.closeEvidence = 'absent-from-fresh-authenticated-open-orders';
    return true;
  }

  async cancelAndReconcileOrder(order) {
    try {
      await this.trader.cancelOrder(order.id);
      const finalOrder = await this.trader.fetchOrder(order.id);
      if (!this.applyConfirmedCancellation(order, finalOrder)) {
        throw new Error('Matched quantity changed after fill processing.');
      }
      return true;
    } catch (cancelError) {
      const refreshed = await this.refreshAccountSnapshot();
      if (!refreshed) throw cancelError;
      const finalOrder = await this.trader.fetchOrder(order.id);
      this.applyExchangeOrder(order, finalOrder);
      if (this.markOrderClosedFromFreshSnapshot(order)) return true;
      throw cancelError;
    }
  }

  async processFinalOrder(order, model = this.model) {
    if (order.processed) return;
    const filled = Math.min(order.shares, order.matchedShares);
    if (filled <= EPSILON) {
      if (['MATCHED', 'FILLED'].includes(order.status)) {
        order.status = 'RECONCILIATION_REQUIRED';
        order.processed = false;
        order.error = 'The exchange reports a fill but returned no matched share quantity.';
        this.haltLiveTrading('An exchange fill is missing its matched quantity; orders are blocked for reconciliation.');
        await this.persist();
        return;
      }
      order.processed = true;
      order.processedMatchedShares = 0;
      if (order.action === 'SELL_FLIP' && !order.flipPairId) this.pendingFlip = null;
      order.status = order.status === 'REJECTED' ? 'REJECTED' : 'UNFILLED';
      order.updatedAt = this.now();
      this.log('LIVE_ORDER_UNFILLED', `${order.action} order finished with no confirmed shares.`, {
        localOrderId: order.localId,
        orderId: order.id,
        side: order.side,
      });
      await this.persist();
      return;
    }
    const execution = this.executionFromOrder(order, filled);
    if (order.action === 'BUY_ENTRY' || order.action === 'BUY_FLIP') {
      const entryModel = model?.ready ? model : this.modelSnapshot(this.now());
      const trade = this.buyPosition(
        order.side,
        execution,
        entryModel,
        this.now(),
        order.entryReason || (order.action === 'BUY_FLIP' ? 'PROFITABLE_MODEL_FLIP' : 'MODEL_EDGE'),
        order.edgePerShare,
      );
      trade.orderId = order.id;
      trade.localOrderId = order.localId;
      trade.fillPriceBasis = 'conservative-order-book-estimate';
      order.tradeId = trade.id;
      order.processed = true;
      order.processedMatchedShares = filled;
      if (order.action === 'BUY_FLIP') {
        if (!order.flipPairId) {
          this.flipsThisWindow += 1;
          this.pendingFlip = null;
        }
      }
      this.log('LIVE_FILL_CONFIRMED', `Exchange confirmed ${round(filled, 2)} ${order.side} shares.`, {
        tradeId: trade.id,
        orderId: order.id,
        orderAction: order.action,
        shares: round(filled, 4),
        priceLimit: order.limitPrice,
        conservativeCost: round(execution.totalCost, 4),
      });
    } else if (order.action === 'SELL_FLIP') {
      const trade = this.trades.find(item => item.id === order.tradeId);
      if (!trade || trade.status !== 'OPEN') {
        this.haltLiveTrading('A confirmed sell could not be matched to an open bot position.');
        order.processed = true;
        await this.persist();
        return;
      }
      const fullyClosed = filled >= trade.shares - EPSILON;
      if (fullyClosed) {
        this.closeLivePosition(
          trade,
          execution,
          this.now(),
          order.flipPairId ? 'OPPOSITE_MODEL_FLIP' : 'PROFITABLE_MODEL_FLIP',
          order.side,
        );
        trade.exitOrderId = order.id;
        trade.fillPriceBasis = 'conservative-limit-price';
        if (!order.flipPairId) this.flipsThisWindow += 1;
        if (!order.flipPairId && trade.realizedPnl > EPSILON && this.pendingFlip) {
          this.pendingFlip.phase = 'BUY';
          this.pendingFlip.targetShares = this.nextEntryShares;
          this.pendingFlip.sellOrderId = order.id;
        } else if (!order.flipPairId) {
          this.pendingFlip = null;
        }
      } else {
        this.closePositionPartially(trade, execution, order);
        if (!order.flipPairId) this.pendingFlip = null;
      }
      order.processed = true;
      order.processedMatchedShares = filled;
    }
    order.status = order.status || 'RECONCILED';
    order.updatedAt = this.now();
    await this.persist();
  }

  executionFromOrder(order, shares) {
    const accountingPrice = Number(order.accountingPriceEstimate) || order.limitPrice;
    const gross = shares * accountingPrice;
    const fees = takerFeeAt(accountingPrice, shares, feeParameters(this.market));
    const netProceeds = gross - fees;
    const totalCost = gross + fees;
    return {
      side: order.side,
      bookSide: order.action.startsWith('SELL') ? 'bids' : 'asks',
      requestedShares: order.shares,
      shares,
      remainingShares: Math.max(0, order.shares - shares),
      gross,
      fees,
      totalCost,
      netProceeds,
      averagePrice: accountingPrice,
      complete: shares >= order.shares - EPSILON,
      fills: [{
        price: accountingPrice,
        shares,
        gross,
        fee: fees,
        estimate: 'conservative order-book price at signal time; account activity shows actual execution prices',
      }],
    };
  }

  closePositionPartially(trade, execution, order) {
    const previousShares = Number(trade.shares);
    const sold = Math.min(previousShares, execution.shares);
    const ratio = previousShares > 0 ? sold / previousShares : 0;
    const costBasis = Number(trade.totalCost) * ratio;
    const proceeds = execution.netProceeds;
    const realized = proceeds - costBasis;
    trade.accumulatedRealizedPnl = round(
      (Number(trade.accumulatedRealizedPnl) || 0) + realized,
      8,
    );
    trade.accumulatedNetProceeds = round(
      (Number(trade.accumulatedNetProceeds) || 0) + proceeds,
      8,
    );
    trade.shares = round(previousShares - sold, 8);
    trade.totalCost = round(Number(trade.totalCost) - costBasis, 8);
    trade.grossCost = round(Number(trade.grossCost) * (1 - ratio), 8);
    trade.fees = round(Number(trade.fees) * (1 - ratio), 8);
    trade.partialExits ||= [];
    trade.partialExits.push({
      at: this.now(),
      orderId: order.id,
      shares: sold,
      proceeds,
      costBasis,
      realizedPnl: realized,
      limitPrice: order.limitPrice,
    });
    this.cash = round(this.cash + proceeds, 8);
    this.realizedPnl = round(this.realizedPnl + realized, 8);
    this.log('LIVE_PARTIAL_EXIT', `Exchange confirmed a partial sale of ${round(sold, 2)} shares; ${round(trade.shares, 2)} remain open.`, {
      tradeId: trade.id,
      orderId: order.id,
      sharesSold: round(sold, 4),
      sharesRemaining: round(trade.shares, 4),
      conservativeRealizedPnl: round(realized, 4),
    });
  }

  closeLivePosition(trade, execution, now, reason, nextSide = null) {
    this.cash = round(this.cash + execution.netProceeds, 8);
    const finalFillPnl = execution.netProceeds - trade.totalCost;
    const totalRealizedPnl = (Number(trade.accumulatedRealizedPnl) || 0) + finalFillPnl;
    trade.status = 'CLOSED';
    trade.settlementStatus = 'CLOSED';
    trade.closedAt = now;
    trade.exitReason = reason;
    trade.exitSide = nextSide;
    trade.exitPrice = execution.averagePrice;
    trade.exitGrossProceeds = execution.gross;
    trade.exitFees = execution.fees;
    trade.proceeds = round(
      (Number(trade.accumulatedNetProceeds) || 0) + execution.netProceeds,
      8,
    );
    trade.realizedPnl = round(totalRealizedPnl, 8);
    trade.outcome = 'EXIT';
    trade.exitFills = execution.fills;
    this.realizedPnl = round(this.realizedPnl + finalFillPnl, 8);
    if (totalRealizedPnl > EPSILON) {
      this.applySizingAdjustment(
        trade,
        'WIN',
        now,
        'Profitable intra-window close',
        'PROFITABLE_INTRAWINDOW_CLOSE',
      );
    }
    return trade;
  }

  async reconcileLiveOrders() {
    if (!this.trader || !this.liveAccount.authenticated) return;
    for (const order of this.liveOrders) {
      if (!order.id) {
        if (isAssumedFailedSellOrder(order)) continue;
        if (['SUBMITTING', 'SUBMISSION_UNCERTAIN'].includes(order.status)) {
          this.haltLiveTrading('A saved submission has no exchange order ID; it must be reconciled manually.');
          return;
        }
        continue;
      }
      if (order.processed && isTerminalOrder(order)) continue;
      try {
        if (order.processed && this.markOrderClosedFromFreshSnapshot(order)) {
          await this.persist();
          continue;
        }
        const latest = await this.trader.fetchOrder(order.id);
        this.applyExchangeOrder(order, latest);
        if (!isTerminalOrder({
          ...latest, shares: order.shares, matchedShares: order.matchedShares,
        })) {
          if (!this.markOrderClosedFromFreshSnapshot(order)) {
            await this.cancelAndReconcileOrder(order);
          }
        }
        await this.processFinalOrder(order);
        await this.persist();
      } catch (error) {
        order.error = errorText(error);
        order.status = 'RECONCILIATION_REQUIRED';
        this.haltLiveTrading(ORDER_RECONCILIATION_HALT_REASON);
        await this.persist();
        return;
      }
    }
  }

  async cancelOrdersFromPreviousWindow(nextWindowStart) {
    if (!this.trader || !this.liveAccount.authenticated) return;
    for (const order of this.liveOrders) {
      if (order.windowStart >= nextWindowStart || !order.id
        || !isActiveOrder(order)) continue;
      try {
        await this.cancelAndReconcileOrder(order);
        await this.processFinalOrder(order);
      } catch (error) {
        order.error = errorText(error);
        order.status = 'CANCEL_UNCERTAIN';
        this.haltLiveTrading('An expired window order could not be confirmed canceled.');
      }
    }
    await this.persist();
  }

  async persist() {
    if (!this.stateStore || !this.storageHealthy) return false;
    const snapshot = this.persistentStateSnapshot();
    this.persistInFlight = this.persistInFlight
      .catch(() => {})
      .then(() => this.stateStore.saveState(snapshot));
    try {
      await this.persistInFlight;
      this.persistenceStatus = 'CONNECTED';
      return true;
    } catch (error) {
      this.storageHealthy = false;
      this.persistenceStatus = 'ERROR';
      this.error = errorText(error);
      this.liveHalted = true;
      this.liveHaltReason = 'The live ledger could not be saved; new orders are blocked.';
      this.status = 'ERROR';
      this.statusReason = this.liveHaltReason;
      return false;
    }
  }

  snapshot() {
    const base = super.snapshot();
    const strategy = { ...(base.strategy || {}) };
    const candlePriority = getCandleSignalPriority(base.binance?.candles);
    delete strategy.minimumFlipNetEdgePerShare;
    delete strategy.flipConfirmationUpdates;
    delete strategy.flipConfirmationIntervalMs;
    const status = this.liveHalted
      ? 'HALTED'
      : !this.tradingEnabled
        ? 'READ_ONLY'
        : !this.liveAccount.accountReady
          ? 'ACCOUNT_UNAVAILABLE'
          : base.status;
    return {
      ...base,
      mode: 'REAL TRADING',
      status,
      statusReason: this.liveHaltReason || base.statusReason,
      tradingEnabled: this.tradingEnabled,
      liveHalted: this.liveHalted,
      liveHaltReason: this.liveHaltReason,
      haltRecovery: this.liveHalted ? this.submissionHaltRecoveryDiagnostics() : null,
      strategy: {
        ...strategy,
        name: 'BTC 5-minute Binance mispricing',
        entryOrderType: 'FAK taker sweep',
        intraWindowExitPolicy: 'Hold to market resolution; no in-window sells',
        maxBuyPrice: MAX_TAKER_BUY_PRICE,
        baseShares: this.config.BASE_SHARES,
        lossIncreaseShares: this.config.LOSS_SIZE_STEP_SHARES,
        winReductionShares: this.config.WIN_SIZE_REDUCTION_SHARES,
        minimumShares: this.config.BASE_SHARES,
        volatilityCandles: this.config.VOLATILITY_CANDLES,
        minEntryEdge: this.config.MIN_NET_EDGE_PER_SHARE,
        firstSignalPriority: candlePriority.side,
        firstSignalPriorityReason: candlePriority.reason,
        previousCandleColor: candlePriority.color,
        sameColorStreak: candlePriority.streak,
        meanReversionPriority: candlePriority.meanReversion,
      },
      account: {
        ...this.liveAccount,
        botRealizedPnlEstimate: base.account?.realizedPnl ?? null,
        botUnrealizedPnlEstimate: base.account?.unrealizedPnl ?? null,
        wins: base.account?.wins ?? 0,
        losses: base.account?.losses ?? 0,
        settledPositions: base.account?.settledPositions ?? 0,
        botTradeCount: base.account?.tradeCount ?? 0,
        sizingShares: this.nextEntryShares,
      },
      liveOrders: this.liveOrders.slice(-100).reverse(),
      pendingFlip: this.pendingFlip,
      note: 'Account balances and transactions are from Polymarket. Bot trade costs use conservative limit-price estimates; transaction rows show actual account activity.',
    };
  }
}

module.exports = {
  LiveBtcMispricingBot,
  getCandleSignalPriority,
  matchedShares,
  orderStatus,
  isTerminalOrder,
};
