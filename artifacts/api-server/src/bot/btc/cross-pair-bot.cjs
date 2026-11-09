'use strict';

const config = require('./cross-pair-config.cjs');
const marketDataDefault = require('./wick-market-data.js');
const { feeParameters, takerFeeAt } = require('./paper-trading.js');
const { resolvedPayout } = require('./position-exits.js');

const EPSILON = 1e-8;

function numeric(value) {
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

function makeTierStates() {
  return Object.fromEntries(config.TIERS.map(tier => [tier.id, {
    id: tier.id,
    label: tier.label,
    status: 'ARMED',
    qualifiedAt: null,
    filledAt: null,
    lastCombinedAsk: null,
    attempts: 0,
    sharesPerLeg: config.SHARES_PER_LEG,
    reason: 'Waiting for the combined ask threshold.',
  }]));
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
  const result = {
    BTC: { UP: emptyInventoryBox(), DOWN: emptyInventoryBox() },
    ETH: { UP: emptyInventoryBox(), DOWN: emptyInventoryBox() },
  };
  for (const trade of trades) {
    if (!selector(trade)) continue;
    const box = result[trade.asset]?.[trade.side];
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
  for (const asset of ['BTC', 'ETH']) {
    for (const side of ['UP', 'DOWN']) {
      const box = result[asset][side];
      box.shares = round(box.shares) || 0;
      box.grossCost = round(box.grossCost) || 0;
      box.fees = round(box.fees) || 0;
      box.totalCost = round(box.totalCost) || 0;
      box.averageEntryPrice = box.shares > 0 ? round(box.grossCost / box.shares) : null;
      box.markValue = box.markValue == null ? null : round(box.markValue);
      box.unrealizedPnl = box.unrealizedPnl == null ? null : round(box.unrealizedPnl);
    }
  }
  return result;
}

class CrossPairBot {
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
    this.statusReason = 'Starting the 15-minute BTC/ETH cross-pair scanner.';
    this.windowStart = null;
    this.windowEnd = null;
    this.markets = { BTC: null, ETH: null };
    this.quotes = {
      BTC: { UP: null, DOWN: null },
      ETH: { UP: null, DOWN: null },
    };
    this.books = new Map();
    this.consumedAskDepth = new Map();
    this.pairTiers = {};
    this.lastMarketRefreshAt = 0;
    this.lastResolutionCheckAt = 0;
    this.resolutionLastAttemptAt = new Map();
    this.resolutionInFlight = new Set();
    this.interval = null;
    this.tickInProgress = false;
    this.tradeSequence = 0;
    this.eventSequence = 0;
  }

  start() {
    if (this.running) return;
    this.running = true;
    void this.tick();
    this.interval = setInterval(() => void this.tick(), this.config.POLL_INTERVAL_MS);
    this.interval.unref?.();
  }

  stop() {
    this.running = false;
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
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
  }

  resetWindow(start) {
    if (this.windowStart === start) return;
    const previousStart = this.windowStart;
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
        this.log('WINDOW_EXPIRED', `${moved} position(s) moved to resolution after the 15-minute window ended.`, {
          windowStart: previousStart,
          positions: moved,
        });
      }
    }
    this.windowStart = start;
    this.windowEnd = start + this.config.WINDOW_MS;
    this.markets = { BTC: null, ETH: null };
    this.quotes = { BTC: { UP: null, DOWN: null }, ETH: { UP: null, DOWN: null } };
    this.books.clear();
    this.consumedAskDepth.clear();
    this.pairTiers = Object.fromEntries(this.config.PAIRS.map(pair => [pair.id, makeTierStates()]));
    this.lastMarketRefreshAt = 0;
    this.statusReason = 'Looking up the aligned BTC and ETH 15-minute markets.';
  }

  async refreshMarkets(now) {
    if (this.markets.BTC && this.markets.ETH
      && now - this.lastMarketRefreshAt < this.config.MARKET_REFRESH_MS) return;
    this.lastMarketRefreshAt = now;
    const [btc, eth] = await Promise.all([
      this.marketData.getBtcMarket(this.windowStart, this.config.WINDOW_MS),
      this.marketData.getEthMarket(this.windowStart, this.config.WINDOW_MS),
    ]);
    if (!btc || !eth) {
      this.statusReason = 'Waiting for aligned 15-minute BTC and ETH markets from Polymarket.';
      return;
    }
    if (btc.start !== this.windowStart || eth.start !== this.windowStart
      || btc.end !== eth.end || String(btc.id) === String(eth.id)) {
      throw new Error('BTC and ETH markets do not match the same 15-minute window.');
    }
    for (const asset of ['BTC', 'ETH']) {
      const previous = this.markets[asset];
      const next = asset === 'BTC' ? btc : eth;
      if (previous && (previous.tokens.UP !== next.tokens.UP || previous.tokens.DOWN !== next.tokens.DOWN)) {
        this.quotes[asset] = { UP: null, DOWN: null };
      }
    }
    this.markets = { BTC: btc, ETH: eth };
    this.statusReason = 'Markets aligned; scanning both cross-pair combined asks.';
    this.error = null;
  }

  async refreshBooks(now) {
    const jobs = [];
    for (const asset of ['BTC', 'ETH']) {
      const market = this.markets[asset];
      if (!market) continue;
      for (const side of ['UP', 'DOWN']) {
        const tokenId = market.tokens[side];
        if (!tokenId) continue;
        jobs.push((async () => {
          const book = await this.marketData.getBook(tokenId);
          const asks = normalizeLevels(book?.asks, 'asks');
          const bids = normalizeLevels(book?.bids, 'bids');
          const quote = {
            asset,
            side,
            tokenId: String(tokenId),
            bestAsk: asks[0]?.price ?? null,
            askSize: asks[0]?.size ?? 0,
            bestBid: bids[0]?.price ?? null,
            bidSize: bids[0]?.size ?? 0,
            midpoint: asks[0] && bids[0] ? (asks[0].price + bids[0].price) / 2 : null,
            updatedAt: now,
            error: null,
          };
          this.books.set(String(tokenId), { asks, bids, updatedAt: now });
          this.quotes[asset][side] = quote;
        })());
      }
    }
    const results = await Promise.allSettled(jobs);
    const failures = results.filter(result => result.status === 'rejected');
    if (failures.length) {
      this.error = `${failures.length} order-book request(s) failed; stale quotes will not trigger entries.`;
    } else {
      this.error = null;
    }
  }

  quoteIsFresh(quote, now) {
    return Number.isFinite(quote?.updatedAt)
      && now >= quote.updatedAt
      && now - quote.updatedAt <= this.config.MAX_QUOTE_AGE_MS;
  }

  pairQuote(pair, now) {
    const asks = pair.legs.map(leg => {
      const quote = this.quotes[leg.asset]?.[leg.side];
      return this.quoteIsFresh(quote, now) ? quote.bestAsk : null;
    });
    if (asks.some(price => !Number.isFinite(price))) return null;
    return { legAsks: asks, combinedAsk: asks[0] + asks[1] };
  }

  availableAskSize(tokenId, level) {
    const key = `${tokenId}:${level.price.toFixed(6)}`;
    const consumed = this.consumedAskDepth.get(key) || 0;
    return Math.max(0, level.size - consumed);
  }

  sweepAsks(asset, side, requestedShares, market) {
    const tokenId = String(market.tokens[side]);
    const book = this.books.get(tokenId);
    if (!book || !this.quoteIsFresh({ updatedAt: book.updatedAt }, this.now())) return null;
    const parameters = feeParameters(market);
    let remaining = requestedShares;
    let grossCost = 0;
    let fees = 0;
    const fills = [];
    for (const level of book.asks) {
      if (remaining <= EPSILON) break;
      if (level.price > this.config.MAX_ENTRY_PRICE) break;
      const available = this.availableAskSize(tokenId, level);
      const shares = Math.min(remaining, available);
      if (shares <= EPSILON) continue;
      const cost = shares * level.price;
      const fee = takerFeeAt(level.price, shares, parameters);
      fills.push({ price: level.price, shares, cost, fee });
      grossCost += cost;
      fees += fee;
      remaining -= shares;
    }
    return {
      asset,
      side,
      tokenId,
      shares: requestedShares - remaining,
      remainingShares: Math.max(0, remaining),
      grossCost,
      fees,
      totalCost: grossCost + fees,
      averagePrice: grossCost / Math.max(EPSILON, requestedShares - remaining),
      fills,
      complete: remaining <= EPSILON,
    };
  }

  commitDepth(execution) {
    for (const fill of execution.fills) {
      const key = `${execution.tokenId}:${fill.price.toFixed(6)}`;
      this.consumedAskDepth.set(key, (this.consumedAskDepth.get(key) || 0) + fill.shares);
    }
  }

  tierQualifies(tier, combinedAsk) {
    return tier.strict ? combinedAsk < tier.threshold : combinedAsk <= tier.threshold;
  }

  processEntries(now) {
    for (const pair of this.config.PAIRS) {
      const pairQuote = this.pairQuote(pair, now);
      const states = this.pairTiers[pair.id];
      if (!states) continue;
      for (const tier of this.config.TIERS) {
        const state = states[tier.id];
        if (state.status === 'FILLED') continue;
        if (!pairQuote) {
          state.status = 'WAITING_FOR_QUOTES';
          state.reason = 'Waiting for fresh asks on both pair legs.';
          state.lastCombinedAsk = null;
          continue;
        }
        const { combinedAsk } = pairQuote;
        state.lastCombinedAsk = round(combinedAsk);
        if (!this.tierQualifies(tier, combinedAsk)) {
          state.status = 'ARMED';
          state.reason = `Combined ask ${combinedAsk.toFixed(3)} is above this tier.`;
          continue;
        }
        if (state.qualifiedAt == null) state.qualifiedAt = now;
        state.attempts += 1;
        const executions = pair.legs.map(leg =>
          this.sweepAsks(leg.asset, leg.side, this.config.SHARES_PER_LEG, this.markets[leg.asset]));
        if (executions.some(execution => !execution || !execution.complete)) {
          state.status = 'WAITING_FOR_FULL_DEPTH';
          state.reason = 'Threshold reached, but both legs do not have enough visible ask depth for a complete paired fill.';
          continue;
        }
        const totalCost = executions.reduce((sum, execution) => sum + execution.totalCost, 0);
        if (totalCost > this.cash + EPSILON) {
          state.status = 'INSUFFICIENT_CAPITAL';
          state.reason = `Needs ${totalCost.toFixed(2)} including taker fees; only ${this.cash.toFixed(2)} is available.`;
          continue;
        }
        for (const execution of executions) this.commitDepth(execution);
        this.cash = round(this.cash - totalCost, 8);
        for (const execution of executions) {
          const market = this.markets[execution.asset];
          const trade = {
            id: `trade-${++this.tradeSequence}`,
            pairId: pair.id,
            pairLabel: pair.label,
            tierId: tier.id,
            tierLabel: tier.label,
            asset: execution.asset,
            side: execution.side,
            marketId: String(market.id),
            marketSlug: market.slug,
            marketTitle: market.title,
            tokenId: String(execution.tokenId),
            windowStart: this.windowStart,
            windowEnd: this.windowEnd,
            shares: this.config.SHARES_PER_LEG,
            entryPrice: execution.averagePrice,
            grossCost: execution.grossCost,
            fees: execution.fees,
            totalCost: execution.totalCost,
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
        }
        state.status = 'FILLED';
        state.filledAt = now;
        state.reason = `Complete ${this.config.SHARES_PER_LEG}-share fills confirmed for both legs.`;
        const combinedFillCost = executions.reduce((sum, execution) => sum + execution.grossCost, 0);
        this.log('PAIR_ENTRY_FILLED',
          `${pair.label} filled ${this.config.SHARES_PER_LEG} shares per leg at the ${tier.id} combined-ask tier.`,
          {
            pairId: pair.id,
            tierId: tier.id,
            combinedAsk,
            combinedFillCost: round(combinedFillCost),
            fees: round(executions.reduce((sum, execution) => sum + execution.fees, 0)),
            sharesPerLeg: this.config.SHARES_PER_LEG,
          });
      }
    }
  }

  markOpenPositions(now) {
    for (const trade of this.trades) {
      if (trade.status !== 'OPEN') continue;
      const quote = this.quotes[trade.asset]?.[trade.side];
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
          this.log('POSITION_RESOLVED',
            `${trade.asset} ${trade.side} settled from its exact original market: ${payout === 1 ? 'won' : 'lost'}.`,
            { tradeId: trade.id, marketId, payout, realizedPnl: round(trade.realizedPnl) });
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
      await this.refreshMarkets(now);
      await this.refreshBooks(now);
      const aligned = this.markets.BTC?.start === this.windowStart
        && this.markets.ETH?.start === this.windowStart;
      if (aligned) {
        this.processEntries(now);
        this.statusReason = 'Scanning BTC UP + ETH DOWN and ETH UP + BTC DOWN.';
      }
      this.markOpenPositions(now);
      this.maybeResolve(now);
      return this.snapshot();
    } catch (error) {
      this.error = error?.message || 'Cross-pair strategy tick failed.';
      this.statusReason = 'Strategy paused for this scan; retrying automatically.';
      this.log('SCAN_ERROR', this.error);
      return this.snapshot();
    } finally {
      this.tickInProgress = false;
    }
  }

  inventoryBoxSnapshot(trades, selector) {
    return groupInventory(trades, selector);
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
      wins: settled.filter(trade => trade.outcome === 'WIN').length,
      losses: settled.filter(trade => trade.outcome === 'LOSS').length,
      takerFees: round(this.trades.reduce((sum, trade) => sum + trade.fees, 0), 2),
      unmarkedPositions: open.length + pending.length - marked.length,
    };
    const currentWindowTrades = this.trades.filter(trade =>
      trade.status === 'OPEN' && trade.windowStart === this.windowStart);
    const pendingTrades = this.trades.filter(trade => trade.status === 'AWAITING_RESOLUTION');
    const pairStates = this.config.PAIRS.map(pair => {
      const quote = this.pairQuote(pair, now);
      const tiers = this.pairTiers[pair.id] || {};
      return {
        id: pair.id,
        label: pair.label,
        combinedAsk: quote ? round(quote.combinedAsk, 4) : null,
        legAsks: quote ? quote.legAsks.map(value => round(value, 4)) : null,
        tiers: this.config.TIERS.map(tier => ({
          ...tiers[tier.id],
          threshold: tier.threshold,
          strict: tier.strict,
        })),
      };
    });
    const windowSeconds = this.windowEnd == null ? null : Math.max(0, (this.windowEnd - now) / 1000);
    return {
      mode: 'PAPER ONLY',
      running: this.running,
      now,
      lastUpdateAt: now,
      status: this.error ? 'WARNING' : this.running ? 'RUNNING' : 'STOPPED',
      statusReason: this.statusReason,
      error: this.error,
      strategy: {
        version: this.config.STRATEGY_VERSION,
        timeframe: '15m',
        assets: ['BTC', 'ETH'],
        startingCapital: this.startingCapital,
        sharesPerTriggerPerLeg: this.config.SHARES_PER_LEG,
        maxEntryPricePerLeg: this.config.MAX_ENTRY_PRICE,
        orderType: 'TAKER MARKET SWEEP',
        intraWindowSales: false,
        settlement: 'Exact original market resolution only',
        resolutionPollMs: this.config.RESOLUTION_POLL_MS,
        tiers: this.config.TIERS,
      },
      window: {
        start: this.windowStart,
        end: this.windowEnd,
        secondsRemaining: windowSeconds,
        slug: this.markets.BTC?.slug || (this.windowStart == null ? null : `btc-eth-15m-${Math.floor(this.windowStart / 1000)}`),
      },
      markets: {
        BTC: this.marketSnapshot('BTC'),
        ETH: this.marketSnapshot('ETH'),
      },
      quotes: this.quotes,
      pairs: pairStates,
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

  marketSnapshot(asset) {
    const market = this.markets[asset];
    return market ? {
      id: market.id,
      slug: market.slug,
      title: market.title,
      start: market.start,
      end: market.end,
    } : null;
  }
}

module.exports = {
  CrossPairBot,
  normalizeLevels,
  groupInventory,
};
