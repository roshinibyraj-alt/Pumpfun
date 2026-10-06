"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const {
  DEFAULT_MAX_BOOK_AGE_MS,
  DEFAULT_MAX_CASH_PER_LEG_USD,
  DEFAULT_MIN_NET_EDGE_PER_SHARE,
  DEFAULT_SAFETY_MARGIN_PER_SHARE,
  calculatePaperCapital,
  complementYesBook,
  evaluatePair,
  evaluatePredictMarketMatch,
  finiteNumber,
  getExplicitMarketWindow,
  normalizeLevels,
  toTimestampMs,
  updateTradeWithBenchmark,
  windowForTime,
  windowsMatch,
} = require("./arbitrage-engine.js");

const POLY_GAMMA = "https://gamma-api.polymarket.com";
const POLY_CLOB = "https://clob.polymarket.com";
const PREDICT_API = "https://api.predict.fun";
const COINBASE_API = "https://api.exchange.coinbase.com";
const POLL_MS = 2000;
const PREDICT_MARKET_CACHE_MS = 15000;
const MAX_LOGS = 150;
const MAX_TRADES = 250;
const DEFAULT_STARTING_PAPER_CAPITAL_USD = 10_000;

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function extractPredictMarkets(response) {
  const markets = [];
  const seenObjects = new WeakSet();
  const visit = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== "object" || seenObjects.has(value)) return;
    seenObjects.add(value);
    if (
      value.id !== undefined &&
      value.id !== null &&
      (value.variantData ||
        value.marketVariant ||
        value.outcomes !== undefined)
    ) {
      markets.push(value);
    }
    for (const key of ["data", "categories", "markets", "results", "items"]) {
      if (value[key] !== undefined) visit(value[key]);
    }
  };
  visit(response);
  return markets;
}

function predictFiveMinuteSlug(window) {
  return `btc-updown-5m-${Math.floor(Number(window.openMs) / 1000)}`;
}

function marketIdFromCanonicalPage(html, expectedSlug) {
  for (const tagMatch of String(html).matchAll(/<meta\b[^>]*>/gi)) {
    const tag = tagMatch[0];
    const property = tag.match(/\bproperty=["']([^"']+)["']/i)?.[1];
    if (String(property).toLowerCase() !== "og:image") continue;
    const content = tag.match(/\bcontent=["']([^"']+)["']/i)?.[1];
    if (!content) return null;
    try {
      const imageUrl = new URL(content.replaceAll("&amp;", "&"), "https://predict.fun");
      if (
        imageUrl.origin !== "https://predict.fun" ||
        imageUrl.pathname !== "/api/generate/image/market.png" ||
        imageUrl.searchParams.get("categoryId") !== expectedSlug
      ) {
        return null;
      }
      const marketId = imageUrl.searchParams.get("marketId");
      return /^\d+$/.test(String(marketId || "")) ? String(marketId) : null;
    } catch {
      return null;
    }
  }
  return null;
}

function outcomeText(value) {
  return String(value?.name ?? value?.title ?? value?.label ?? value ?? "")
    .trim()
    .toUpperCase();
}

function toShortLevels(levels) {
  return normalizeLevels(levels).slice(0, 20);
}

function blankQuote(status = "missing", error = null) {
  return {
    status,
    error,
    observedAt: null,
    ageMs: null,
    bids: [],
    asks: [],
    bestBid: null,
    bestAsk: null,
    bidDepth: 0,
    askDepth: 0,
  };
}

function quoteFromBook(book, observedAt, nowMs = Date.now(), timestampKind = "received") {
  const bids = toShortLevels(book?.bids);
  const asks = toShortLevels(book?.asks);
  return {
    status: "ok",
    error: null,
    observedAt,
    timestampKind,
    ageMs: Math.max(0, nowMs - observedAt),
    bids,
    asks,
    bestBid: bids[0] || null,
    bestAsk: asks[0] || null,
    bidDepth: bids.reduce((sum, level) => sum + level.size, 0),
    askDepth: asks.reduce((sum, level) => sum + level.size, 0),
  };
}

function emptyVenue(name, status = "waiting", error = null) {
  return {
    name,
    status,
    error,
    market: {
      id: null,
      title: null,
      question: null,
      slug: null,
      conditionId: null,
      startMs: null,
      closeMs: null,
      outcomes: [],
      matchStatus: "unmatched",
      matchMethod: null,
      matchReason: "No market has been matched yet.",
    },
    marketCandidates: [],
    candidateCount: 0,
    up: blankQuote(),
    down: blankQuote(),
    observedAt: null,
  };
}

async function fetchJson(fetchImpl, url, options = {}) {
  const response = await fetchImpl(url, {
    method: "GET",
    headers: options.headers || {},
    signal: AbortSignal.timeout(options.timeoutMs || 5000),
  });
  const bodyText = await response.text();
  let body;
  try {
    body = bodyText ? JSON.parse(bodyText) : null;
  } catch {
    throw new Error(`Invalid JSON response from ${new URL(url).host}.`);
  }
  if (!response.ok) {
    const detail =
      body?.message || body?.error || body?.msg || `HTTP ${response.status}`;
    throw new Error(`${new URL(url).host}: ${detail}`);
  }
  return body;
}

function polyWindowFrom(event, market) {
  const openMs = toTimestampMs(
    event?.startTime ??
      event?.eventStartTime ??
      market?.eventStartTime ??
      market?.startTime,
  );
  const closeMs = toTimestampMs(
    event?.endDate ?? event?.endTime ?? market?.endDate ?? market?.endTime,
  );
  return openMs !== null && closeMs !== null ? { openMs, closeMs } : null;
}

function safePolymarketMarket(event, expectedWindow) {
  const markets = Array.isArray(event?.markets) ? event.markets : [];
  const candidates = markets
    .map((market) => {
      const outcomes = parseJsonArray(market.outcomes);
      const tokenIds = parseJsonArray(market.clobTokenIds);
      const labels = outcomes.map(outcomeText);
      const hasUpAndDown =
        labels.length === 2 &&
        labels.includes("UP") &&
        labels.includes("DOWN") &&
        tokenIds.length === 2;
      if (!hasUpAndDown) return null;
      const tokens = {};
      labels.forEach((label, index) => {
        tokens[label] = String(tokenIds[index] || "");
      });
      if (!tokens.UP || !tokens.DOWN) return null;
      const window = polyWindowFrom(event, market);
      return { market, outcomes, tokens, window };
    })
    .filter(Boolean);
  const exact = candidates.filter(
    (candidate) => candidate.window && windowsMatch(candidate.window, expectedWindow),
  );
  return exact.length === 1 ? exact[0] : null;
}

function marketMetadata(market) {
  const variantData = market?.variantData || {};
  const explicitWindow = getExplicitMarketWindow(market);
  return {
    id: market?.id == null ? null : String(market.id),
    title: market?.title ?? null,
    question: market?.question ?? null,
    slug: market?.slug ?? null,
    conditionId: market?.conditionId ?? null,
    outcomes: parseJsonArray(market?.outcomes).map(outcomeText),
    description: market?.description ?? null,
    resolutionSource: market?.resolutionSource ?? null,
    marketVariant: market?.marketVariant ?? variantData.type ?? null,
    tradingStatus: market?.tradingStatus ?? market?.status ?? null,
    variantData: {
      type: variantData.type ?? null,
      priceFeedProvider: variantData.priceFeedProvider ?? null,
      priceFeedSymbol: variantData.priceFeedSymbol ?? null,
    },
    startMs: explicitWindow?.openMs ?? null,
    closeMs: explicitWindow?.closeMs ?? null,
    externalSettlement: variantData.priceFeedProvider
      ? `${variantData.priceFeedProvider} ${variantData.priceFeedSymbol || ""}`.trim()
      : null,
  };
}

function serializeError(error) {
  if (error?.name === "TimeoutError" || error?.name === "AbortError") {
    return "Market data request timed out.";
  }
  return String(error?.message || error || "Unknown market-data error").slice(0, 240);
}

class ArbitrageBot {
  constructor(options = {}) {
    this.fetch = options.fetch || globalThis.fetch;
    this.stateFile =
      options.stateFile ||
      process.env.ARB_STATE_PATH ||
      path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH || process.cwd(), "data", "arb-state.json");
    this.predictApiKey = options.predictApiKey ?? process.env.PREDICT_API_KEY ?? "";
    this.maxBookAgeMs = DEFAULT_MAX_BOOK_AGE_MS;
    this.maxCashPerLegUsd = DEFAULT_MAX_CASH_PER_LEG_USD;
    this.startingCapitalUsd =
      finiteNumber(options.startingCapitalUsd) ?? DEFAULT_STARTING_PAPER_CAPITAL_USD;
    this.realizedPnlTotal = 0;
    this.minNetEdgePerShare = DEFAULT_MIN_NET_EDGE_PER_SHARE;
    this.safetyMarginPerShare = this._readSafetyMargin();
    this.running = false;
    this.loopPromise = null;
    this.loaded = false;
    this.savePromise = Promise.resolve();
    this.predictCache = {
      fetchedAt: 0,
      windowSlug: null,
      markets: [],
      error: null,
    };
    this.state = {
      app: "BTC Cross-Venue Arb Demo",
      mode: "PAPER",
      running: false,
      now: Date.now(),
      pollMs: POLL_MS,
      config: {
        startingPaperCapitalUsd: this.startingCapitalUsd,
        maxCashPerLegUsd: this.maxCashPerLegUsd,
        maxCashPerOpportunityUsd: this.maxCashPerLegUsd * 2,
        minNetEdgePerShare: this.minNetEdgePerShare,
        safetyMarginPerShare: this.safetyMarginPerShare,
        maxBookAgeMs: this.maxBookAgeMs,
        equalShares: true,
        pairPayoutPerShare: 1,
        onePaperPairPerDirectionPerWindow: true,
      },
      window: null,
      benchmark: {
        source: "Coinbase Exchange BTC-USD",
        use: "paper settlement only; never used by the arbitrage scanner",
        status: "waiting",
      },
      venues: {
        polymarket: emptyVenue("Polymarket"),
        predict: emptyVenue(
          "Predict.fun",
          this.predictApiKey ? "waiting" : "needs_api_key",
          this.predictApiKey ? null : "PREDICT_API_KEY is not configured on the server.",
        ),
      },
      opportunities: [],
      paperTrades: [],
      stats: {
        pairCount: 0,
        settledCount: 0,
        wins: 0,
        losses: 0,
        realizedPnl: 0,
        provisionalPnl: 0,
        capitalCommitted: 0,
        startingCapitalUsd: this.startingCapitalUsd,
        cashBalanceUsd: this.startingCapitalUsd,
        availableCapitalUsd: this.startingCapitalUsd,
        paperEquityUsd: this.startingCapitalUsd,
        feesPaid: 0,
      },
      events: [],
    };
    this.firedKeys = new Set();
    this.finalBenchmarks = new Map();
  }

  _readSafetyMargin() {
    const configured = finiteNumber(process.env.ARB_SAFETY_MARGIN_PER_SHARE);
    if (configured === null || configured < 0 || configured >= 0.5) {
      return DEFAULT_SAFETY_MARGIN_PER_SHARE;
    }
    return configured;
  }

  async _load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const text = await fs.readFile(this.stateFile, "utf8");
      const stored = JSON.parse(text);
      if (Array.isArray(stored.paperTrades)) {
        this.state.paperTrades = stored.paperTrades.slice(-MAX_TRADES);
      }
      const storedStartingCapital = finiteNumber(stored.startingCapitalUsd);
      if (storedStartingCapital !== null && storedStartingCapital >= 0) {
        this.startingCapitalUsd = storedStartingCapital;
      }
      const storedRealizedPnl = finiteNumber(stored.realizedPnlTotal);
      this.realizedPnlTotal =
        storedRealizedPnl ??
        this.state.paperTrades
          .filter((trade) => trade.finalized)
          .reduce((sum, trade) => sum + (finiteNumber(trade.realizedPnl) ?? 0), 0);
      this.state.config.startingPaperCapitalUsd = this.startingCapitalUsd;
      if (Array.isArray(stored.events)) this.state.events = stored.events.slice(-MAX_LOGS);
      if (Array.isArray(stored.firedKeys)) this.firedKeys = new Set(stored.firedKeys);
      if (Array.isArray(stored.finalBenchmarks)) {
        this.finalBenchmarks = new Map(stored.finalBenchmarks);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        this._log("PERSISTENCE_LOAD_ERROR", serializeError(error));
      }
    }
    this._recalculateStats();
  }

  async _persist() {
    const data = JSON.stringify(
      {
        version: 2,
        startingCapitalUsd: this.startingCapitalUsd,
        realizedPnlTotal: this.realizedPnlTotal,
        paperTrades: this.state.paperTrades.slice(-MAX_TRADES),
        events: this.state.events.slice(-MAX_LOGS),
        firedKeys: [...this.firedKeys].slice(-500),
        finalBenchmarks: [...this.finalBenchmarks.entries()].slice(-50),
      },
      null,
      2,
    );
    this.savePromise = this.savePromise
      .catch(() => {})
      .then(async () => {
        await fs.mkdir(path.dirname(this.stateFile), { recursive: true });
        const tempFile = `${this.stateFile}.tmp`;
        await fs.writeFile(tempFile, data, { mode: 0o600 });
        await fs.rename(tempFile, this.stateFile);
      })
      .catch((error) => {
        this._log("PERSISTENCE_SAVE_ERROR", serializeError(error));
      });
    return this.savePromise;
  }

  _log(event, note, extra = {}) {
    this.state.events.unshift({
      ts: Date.now(),
      event,
      note,
      ...extra,
    });
    this.state.events = this.state.events.slice(0, MAX_LOGS);
  }

  _recalculateStats() {
    const trades = this.state.paperTrades;
    const settled = trades.filter((trade) => trade.finalized);
    const open = trades.filter((trade) => !trade.finalized);
    const capital = calculatePaperCapital({
      startingCapitalUsd: this.startingCapitalUsd,
      realizedPnlUsd: this.realizedPnlTotal,
      trades,
    });
    this.state.stats = {
      pairCount: trades.length,
      settledCount: settled.length,
      wins: settled.filter((trade) => Number(trade.realizedPnl) > 0).length,
      losses: settled.filter((trade) => Number(trade.realizedPnl) < 0).length,
      realizedPnl: capital.realizedPnlUsd,
      provisionalPnl: capital.provisionalPnlUsd,
      capitalCommitted: capital.capitalCommittedUsd,
      startingCapitalUsd: capital.startingCapitalUsd,
      cashBalanceUsd: capital.cashBalanceUsd,
      availableCapitalUsd: capital.availableCapitalUsd,
      paperEquityUsd: capital.paperEquityUsd,
      feesPaid: trades.reduce((sum, trade) => sum + Number(trade.fees || 0), 0),
    };
  }

  _availablePaperCapital() {
    return calculatePaperCapital({
      startingCapitalUsd: this.startingCapitalUsd,
      realizedPnlUsd: this.realizedPnlTotal,
      trades: this.state.paperTrades,
    }).availableCapitalUsd;
  }

  async start() {
    if (this.running) return;
    await this._load();
    this.running = true;
    this.state.running = true;
    this._log("BOT_STARTED", "Paper scanner started. No orders can be placed by this bot.");
    this.loopPromise = this._runLoop();
  }

  stop() {
    this.running = false;
    this.state.running = false;
    this._log("BOT_STOPPED", "Paper scanner stopped. No market orders were sent.");
    void this._persist();
  }

  snapshot() {
    this.state.now = Date.now();
    this.state.running = this.running;
    if (this.state.window) {
      this.state.window.secondsRemaining = Math.max(
        0,
        (Number(this.state.window.closeMs) - this.state.now) / 1000,
      );
    }
    return JSON.parse(JSON.stringify(this.state));
  }

  async _runLoop() {
    while (this.running) {
      try {
        await this._tick();
      } catch (error) {
        this.state.lastError = serializeError(error);
        this._log("SCAN_ERROR", this.state.lastError);
        await this._persist();
      }
      if (!this.running) break;
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  }

  async _tick() {
    const nowMs = Date.now();
    const currentWindow = windowForTime(nowMs);
    const slug = `btc-updown-5m-${Math.floor(currentWindow.openMs / 1000)}`;
    const activeWindow = this.state.window;
    if (!activeWindow || activeWindow.openMs !== currentWindow.openMs) {
      this._log("WINDOW_CHANGED", `Scanning the 5-minute UTC slot ${new Date(currentWindow.openMs).toISOString()}.`);
    }
    this.state.window = {
      slug,
      openMs: currentWindow.openMs,
      closeMs: currentWindow.closeMs,
      secondsRemaining: Math.max(0, (currentWindow.closeMs - nowMs) / 1000),
      timezone: "UTC",
    };

    const pendingWindows = this.state.paperTrades
      .filter((trade) => !trade.finalized && Number(trade.closeMs) <= nowMs)
      .map((trade) => ({ openMs: Number(trade.openMs), closeMs: Number(trade.closeMs) }));
    const uniqueWindows = new Map(
      [[currentWindow.openMs, currentWindow], ...pendingWindows.map((w) => [w.openMs, w])],
    );
    const benchmarkWindows = [...uniqueWindows.values()];
    const [polyResult, benchmarkResults] = await Promise.all([
      this._fetchPolymarket(currentWindow, slug),
      Promise.all(benchmarkWindows.map((window) => this._fetchBenchmark(window, nowMs))),
    ]);
    this.state.venues.polymarket = polyResult;
    const currentBenchmark = benchmarkResults.find(
      (item) => Number(item.openMs) === Number(currentWindow.openMs),
    );
    this.state.benchmark = currentBenchmark || {
      source: "Coinbase Exchange BTC-USD",
      use: "paper settlement only; never used by the arbitrage scanner",
      status: "unavailable",
    };
    for (const benchmark of benchmarkResults) {
      if (benchmark.finalized) this.finalBenchmarks.set(benchmark.openMs, benchmark);
    }

    const predictResult = await this._fetchPredict(
      currentWindow,
      polyResult.market?.conditionId,
      nowMs,
    );
    this.state.venues.predict = predictResult;

    this.state.opportunities = this._evaluate(currentWindow, polyResult, predictResult, nowMs);
    for (const opportunity of this.state.opportunities) {
      const key = `${currentWindow.openMs}:${opportunity.direction}`;
      if (!opportunity.eligible || this.firedKeys.has(key)) continue;
      const trade = this._createPaperTrade(opportunity, currentWindow, currentBenchmark);
      this.state.paperTrades.unshift(trade);
      this.state.paperTrades = this.state.paperTrades.slice(0, MAX_TRADES);
      this.firedKeys.add(key);
      this._log(
        "PAPER_PAIR_OPENED",
        `${opportunity.direction} simulated at ${opportunity.shares.toFixed(2)} equal shares; no orders sent.`,
        { tradeId: trade.id, direction: opportunity.direction },
      );
    }

    const benchmarkByWindow = new Map(benchmarkResults.map((item) => [item.openMs, item]));
    for (const trade of this.state.paperTrades) {
      if (trade.finalized) continue;
      const benchmark =
        benchmarkByWindow.get(Number(trade.openMs)) ||
        this.finalBenchmarks.get(Number(trade.openMs));
      if (!benchmark) continue;
      const updated = updateTradeWithBenchmark(trade, benchmark, nowMs);
      if (!trade.finalized && updated.finalized) {
        this.realizedPnlTotal += finiteNumber(updated.realizedPnl) ?? 0;
        this._log(
          "PAPER_PAIR_FINALIZED",
          `Finalized on the shared internal BTC/USD benchmark: ${updated.finalOutcome}; this is not official venue settlement.`,
          { tradeId: trade.id, finalOutcome: updated.finalOutcome },
        );
      }
      Object.assign(trade, updated);
    }
    this._recalculateStats();
    this.state.lastError = null;
    await this._persist();
  }

  _evaluate(currentWindow, poly, predict, nowMs) {
    const polyMatched = poly.market?.matchStatus === "matched";
    const predictMatched = predict.market?.matchStatus === "matched";
    let remainingCapital = Math.max(0, this._availablePaperCapital());
    const common = {
      nowMs,
      minNetEdgePerShare: this.minNetEdgePerShare,
      safetyMarginPerShare: this.safetyMarginPerShare,
      maxBookAgeMs: this.maxBookAgeMs,
    };
    const candidates = [
      {
        direction: "POLY_UP + PREDICT_DOWN",
        legs: [
          {
            venue: "Polymarket",
            side: "UP",
            feeModel: "polymarket",
            book: poly.up,
            marketMatched: polyMatched,
            matchReason: poly.market?.matchReason,
          },
          {
            venue: "Predict.fun",
            side: "DOWN",
            feeModel: "predict",
            book: predict.down,
            marketMatched: predictMatched,
            matchReason: predict.market?.matchReason,
          },
        ],
      },
      {
        direction: "PREDICT_UP + POLY_DOWN",
        legs: [
          {
            venue: "Predict.fun",
            side: "UP",
            feeModel: "predict",
            book: predict.up,
            marketMatched: predictMatched,
            matchReason: predict.market?.matchReason,
          },
          {
            venue: "Polymarket",
            side: "DOWN",
            feeModel: "polymarket",
            book: poly.down,
            marketMatched: polyMatched,
            matchReason: poly.market?.matchReason,
          },
        ],
      },
    ];
    return candidates.map((candidate) => {
      const firedKey = `${currentWindow.openMs}:${candidate.direction}`;
      const alreadyFiredThisWindow = this.firedKeys.has(firedKey);
      const perLegCashLimit = Math.min(this.maxCashPerLegUsd, remainingCapital / 2);
      const evaluated = evaluatePair({
        ...common,
        maxCashPerLegUsd: perLegCashLimit,
        ...candidate,
      });
      const result = {
        ...evaluated,
        direction: candidate.direction,
        alreadyFiredThisWindow,
        eligible: evaluated.eligible && !alreadyFiredThisWindow,
        thresholdStatus: evaluated.eligible ? "threshold_met" : evaluated.status,
      };
      if (result.eligible) {
        remainingCapital = Math.max(0, remainingCapital - evaluated.pairCash);
      }
      return result;
    });
  }

  _createPaperTrade(opportunity, window, benchmark) {
    const legs = opportunity.legs.map((leg) => ({
      venue: leg.venue,
      side: leg.side,
      shares: leg.shares,
      averagePrice: leg.averagePrice,
      bestAsk: leg.bestAsk,
      worstFillPrice: leg.worstFillPrice,
      notional: leg.notional,
      fees: leg.fees,
      cash: leg.cash,
      depthSlippagePerShare: leg.depthSlippagePerShare,
      levelsUsed: leg.levelsUsed,
      feeModel: leg.feeModel,
    }));
    return {
      id: `paper-${window.openMs}-${opportunity.direction.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}`,
      openedAt: Date.now(),
      openMs: window.openMs,
      closeMs: window.closeMs,
      direction: opportunity.direction,
      shares: opportunity.shares,
      legs,
      pairCash: opportunity.pairCash,
      pairCostPerShare: opportunity.pairCostPerShare,
      fees: legs.reduce((sum, leg) => sum + leg.fees, 0),
      grossEdgePerShare: opportunity.grossEdgePerShare,
      netEdgePerShare: opportunity.netEdgePerShare,
      safetyMarginPerShare: opportunity.safetyMarginPerShare,
      status: "open_provisional",
      benchmarkSource: benchmark?.source || "Coinbase Exchange BTC-USD",
      provisionalOutcome: null,
      provisionalPayout: null,
      provisionalPnl: null,
      finalized: false,
      mode: "PAPER",
    };
  }

  async _fetchPolymarket(window, slug) {
    const base = emptyVenue("Polymarket", "loading");
    try {
      const events = await fetchJson(
        this.fetch,
        `${POLY_GAMMA}/events?slug=${encodeURIComponent(slug)}`,
      );
      const eventList = Array.isArray(events) ? events : events?.data || [];
      const event = eventList.find((item) => item.slug === slug) || eventList[0];
      if (!event) {
        base.status = "missing_market";
        base.market.matchReason = "No Polymarket event was returned for the exact 5-minute UTC slot.";
        return base;
      }
      const candidate = safePolymarketMarket(event, window);
      if (!candidate) {
        base.status = "unmatched";
        base.market = {
          ...base.market,
          ...marketMetadata(event.markets?.[0]),
          title: event.title || event.markets?.[0]?.question || null,
          slug: event.slug || slug,
          matchReason:
            "Polymarket did not return exactly one two-outcome UP/DOWN market with matching 5-minute boundaries and token IDs.",
        };
        return base;
      }
      const { market, tokens, window: marketWindow, outcomes } = candidate;
      const matched = windowsMatch(marketWindow, window);
      const metadata = {
        ...marketMetadata(market),
        title: event.title || market.question || market.title || null,
        slug: event.slug || slug,
        conditionId: market.conditionId || null,
        startMs: marketWindow?.openMs ?? null,
        closeMs: marketWindow?.closeMs ?? null,
        outcomes: outcomes.map(outcomeText),
        matchStatus: matched ? "matched" : "unmatched",
        matchMethod: "exact_slug_and_window",
        matchReason: matched
          ? "Exact UTC 5-minute slug and event boundaries matched."
          : "Market window boundaries do not equal the requested 5-minute UTC slot.",
      };
      const books = await Promise.all(
        ["UP", "DOWN"].map(async (side) => {
          try {
            const book = await fetchJson(
              this.fetch,
              `${POLY_CLOB}/book?token_id=${encodeURIComponent(tokens[side])}`,
            );
            const receivedAt = Date.now();
            const sourceTimestamp = toTimestampMs(book?.timestamp);
            const observedAt = sourceTimestamp ?? receivedAt;
            return [
              side,
              quoteFromBook(
                book,
                observedAt,
                receivedAt,
                sourceTimestamp === null ? "received" : "source",
              ),
            ];
          } catch (error) {
            return [side, blankQuote("error", serializeError(error))];
          }
        }),
      );
      const quoteMap = Object.fromEntries(books);
      base.status = "connected";
      base.error = null;
      base.market = metadata;
      base.up = quoteMap.UP;
      base.down = quoteMap.DOWN;
      base.observedAt = Date.now();
      return base;
    } catch (error) {
      base.status = "error";
      base.error = serializeError(error);
      base.market.matchReason = `Polymarket market data request failed: ${base.error}`;
      base.up = blankQuote("error", base.error);
      base.down = blankQuote("error", base.error);
      return base;
    }
  }

  async _fetchPredictMarkets(window) {
    const now = Date.now();
    const expectedSlug = predictFiveMinuteSlug(window);
    if (
      this.predictCache.windowSlug === expectedSlug &&
      now - this.predictCache.fetchedAt < PREDICT_MARKET_CACHE_MS
    ) {
      return this.predictCache;
    }
    const markets = [];
    let after = null;
    let listError = null;
    let searchError = null;
    let pageError = null;
    const headers = { "x-api-key": this.predictApiKey };
    let exactSearchCount = 0;
    let openListCount = 0;
    let titleSearchCount = 0;
    let canonicalPageMarketId = null;
    let discoverySource = null;
    const hasExpectedSlug = () =>
      markets.some((market) => {
        const variant = String(
          market?.variantData?.type ?? market?.marketVariant ?? "",
        ).toUpperCase();
        return (
          variant === "CRYPTO_UP_DOWN" &&
          String(market?.slug ?? "") === expectedSlug
        );
      });

    const search = async (query, kind) => {
      try {
        const params = new URLSearchParams({
          query,
          includeResolved: "false",
          limit: "100",
        });
        const response = await fetchJson(
          this.fetch,
          `${PREDICT_API}/v1/search?${params.toString()}`,
          { headers },
        );
        const found = extractPredictMarkets(response);
        markets.push(...found);
        if (kind === "exact") exactSearchCount = found.length;
        if (kind === "title") titleSearchCount = found.length;
        if (hasExpectedSlug()) discoverySource = `${kind}_search`;
      } catch (err) {
        searchError = serializeError(err);
      }
    };

    // Predict's general market list may omit short-window markets, so query
    // the current canonical slug before falling back to broad discovery.
    await search(expectedSlug, "exact");
    if (!hasExpectedSlug()) {
      try {
        for (let page = 0; page < 3; page += 1) {
          const params = new URLSearchParams({
            first: "100",
            status: "OPEN",
            marketVariant: "CRYPTO_UP_DOWN",
          });
          if (after) params.set("after", after);
          const response = await fetchJson(
            this.fetch,
            `${PREDICT_API}/v1/markets?${params.toString()}`,
            { headers },
          );
          const data = extractPredictMarkets(response);
          openListCount += data.length;
          markets.push(...data);
          after = response?.cursor || response?.data?.cursor || null;
          if (hasExpectedSlug()) discoverySource = "open_market_list";
          if (!after || data.length === 0) break;
        }
      } catch (err) {
        listError = serializeError(err);
      }
    }
    if (!hasExpectedSlug()) {
      await search("Bitcoin Up or Down", "title");
    }
    if (!hasExpectedSlug()) {
      try {
        const resolved = await this._fetchPredictMarketBySlug(window);
        if (resolved?.market) {
          markets.push(resolved.market);
          canonicalPageMarketId = resolved.marketId;
          discoverySource = "canonical_page_market_id";
        }
      } catch (err) {
        pageError = serializeError(err);
      }
    }

    const deduped = [
      ...new Map(
        markets.map((market, index) => [
          String(market?.id ?? market?.slug ?? `unknown-${index}`),
          market,
        ]),
      ).values(),
    ];
    const errors = [
      listError && `Market list: ${listError}`,
      searchError && `Predict search: ${searchError}`,
      pageError && `Canonical market lookup: ${pageError}`,
    ].filter(Boolean);
    const error = deduped.length === 0 && errors.length ? errors.join("; ") : null;
    const discovery = {
      expectedSlug,
      exactMarketFound: hasExpectedSlug(),
      source: discoverySource,
      exactSearchResults: exactSearchCount,
      openMarketListResults: openListCount,
      titleSearchResults: titleSearchCount,
      canonicalPageMarketId,
      canonicalPageError: pageError,
      searchError,
      marketListError: listError,
    };
    this.predictCache = {
      fetchedAt: now,
      windowSlug: expectedSlug,
      markets: deduped,
      error,
      discovery,
    };
    return this.predictCache;
  }

  async _fetchPredictMarketBySlug(window) {
    const slug = predictFiveMinuteSlug(window);
    const pageResponse = await this.fetch(
      `https://predict.fun/market/${encodeURIComponent(slug)}`,
      {
        method: "GET",
        headers: { accept: "text/html" },
        signal: AbortSignal.timeout(5000),
      },
    );
    const pageHtml = await pageResponse.text();
    if (!pageResponse.ok) {
      throw new Error(`predict.fun market page: HTTP ${pageResponse.status}`);
    }
    const marketId = marketIdFromCanonicalPage(pageHtml, slug);
    if (!marketId) {
      throw new Error("Canonical page did not identify this exact 5-minute market.");
    }

    const response = await fetchJson(
      this.fetch,
      `${PREDICT_API}/v1/markets/${encodeURIComponent(marketId)}`,
      { headers: { "x-api-key": this.predictApiKey } },
    );
    const market = extractPredictMarkets(response).find(
      (candidate) => String(candidate.id) === marketId,
    );
    if (!market) {
      throw new Error(`Predict market details were not returned for market ${marketId}.`);
    }
    if (market.slug && String(market.slug) !== slug) {
      throw new Error("Predict market details did not match the requested 5-minute slug.");
    }
    return { market: market.slug ? market : { ...market, slug }, marketId };
  }

  async _fetchPredict(window, polymarketConditionId, nowMs) {
    const base = emptyVenue(
      "Predict.fun",
      this.predictApiKey ? "loading" : "needs_api_key",
      this.predictApiKey ? null : "Add PREDICT_API_KEY to Railway's server-side variables.",
    );
    if (!this.predictApiKey) {
      base.market.matchReason = "Predict.fun data is unavailable until PREDICT_API_KEY is set server-side.";
      return base;
    }
    const cache = await this._fetchPredictMarkets(window);
    base.discovery = cache.discovery || null;
    if (cache.error) {
      base.status = "error";
      base.error = cache.error;
      base.market.matchReason = `Predict.fun market discovery failed: ${cache.error}`;
      base.up = blankQuote("error", cache.error);
      base.down = blankQuote("error", cache.error);
      return base;
    }
    const cryptoMarkets = cache.markets.filter((market) => {
      const variant = String(
        market?.variantData?.type ?? market?.marketVariant ?? "",
      ).toUpperCase();
      return variant === "CRYPTO_UP_DOWN";
    });
    const evaluated = cryptoMarkets.map((market) => ({
      market,
      match: evaluatePredictMarketMatch(market, window, polymarketConditionId),
    }));
    const matches = evaluated.filter((item) => item.match.matched);
    base.candidateCount = evaluated.length;
    base.marketCandidates = evaluated.slice(0, 12).map(({ market, match }) => ({
      id: market?.id == null ? null : String(market.id),
      title: market?.title || market?.question || null,
      slug: market?.slug ?? null,
      conditionId: market?.conditionId ?? null,
      tradingStatus: market?.tradingStatus ?? market?.status ?? null,
      startMs: match.explicitWindow?.openMs ?? null,
      closeMs: match.explicitWindow?.closeMs ?? null,
      outcomes: parseJsonArray(market?.outcomes).map(outcomeText),
      matchStatus: match.matched ? "matched" : "unmatched",
      matchReason: match.reason,
    }));
    if (matches.length > 1) {
      const reason =
        "More than one Predict market matched this slot; scanner is disabled to avoid ambiguity.";
      base.status = "ambiguous";
      base.market.matchReason = reason;
      return base;
    }

    const exactMatch = matches.length === 1;
    const displayCandidates = evaluated
      .filter((item) => item.match.outcomeMapping?.safe)
      .sort((left, right) => {
        const displayRank = (item) => {
          const titleAndSlug = `${item.market?.title || item.market?.question || ""} ${item.market?.slug || ""}`;
          const explicitWindow = item.match.explicitWindow;
          const fiveMinuteWindow =
            explicitWindow &&
            Number(explicitWindow.closeMs) - Number(explicitWindow.openMs) ===
              5 * 60 * 1000;
          const fiveMinuteLabel =
            /(?:\b5\s*(?:m|min(?:ute)?s?)\b|\bfive[-\s]+minutes?\b)/i.test(
              titleAndSlug,
            );
          return [
            fiveMinuteWindow || fiveMinuteLabel ? 0 : 1,
            explicitWindow
              ? Math.abs(Number(explicitWindow.openMs) - Number(window.openMs))
              : Number.MAX_SAFE_INTEGER,
          ];
        };
        const leftRank = displayRank(left);
        const rightRank = displayRank(right);
        return leftRank[0] - rightRank[0] || leftRank[1] - rightRank[1];
      });
    const fiveMinuteCandidates = displayCandidates.filter((item) => {
      const titleAndSlug = `${item.market?.title || item.market?.question || ""} ${item.market?.slug || ""}`;
      const explicitWindow = item.match.explicitWindow;
      return Boolean(
        /^btc-updown-5m-\d+$/.test(String(item.market?.slug ?? "")) ||
          (explicitWindow &&
            Number(explicitWindow.closeMs) - Number(explicitWindow.openMs) ===
              5 * 60 * 1000) ||
          /(?:\b5\s*(?:m|min(?:ute)?s?)\b|\bfive[-\s]+minutes?\b)/i.test(
            titleAndSlug,
          ),
      );
    });
    const selected = exactMatch ? matches[0] : fiveMinuteCandidates[0];
    if (!selected) {
      const reason =
        "No Predict BTC 5-minute market was found for this slot; unrelated daily markets are hidden.";
      base.status = "missing_market";
      base.market.matchReason = reason;
      return base;
    }

    const { market, match } = selected;
    if (!match.outcomeMapping?.safe) {
      base.status = "unmatched";
      base.market = {
        ...base.market,
        ...marketMetadata(market),
        title: market.title || market.question || null,
        outcomes: parseJsonArray(market.outcomes).map(outcomeText),
        matchStatus: "unmatched",
        matchReason: match.reason,
      };
      return base;
    }
    const marketWindow = exactMatch ? match.explicitWindow || window : match.explicitWindow;
    const unmatchedReason =
      match.reason ||
      "Predict market is not safely matched to this Polymarket 5-minute window.";
    const marketMeta = {
      ...marketMetadata(market),
      title: market.title || market.question || null,
      conditionId: market.conditionId || null,
      startMs: marketWindow?.openMs ?? null,
      closeMs: marketWindow?.closeMs ?? null,
      outcomes: parseJsonArray(market.outcomes).map(outcomeText),
      matchStatus: exactMatch ? "matched" : "unmatched",
      matchMethod: exactMatch ? match.matchMethod : null,
      matchReason: exactMatch
        ? match.reason
        : `Live quotes are shown for this Predict market only. It is not matched to the current Polymarket 5-minute window, so no pair can fire. ${unmatchedReason}`,
      externalSettlement: market.variantData?.priceFeedProvider
        ? `${market.variantData.priceFeedProvider} ${market.variantData.priceFeedSymbol || ""}`.trim()
        : null,
    };
    const decimalPrecision = Number(market.decimalPrecision);
    const precisionInvalid =
      !Number.isInteger(decimalPrecision) ||
      decimalPrecision < 1 ||
      decimalPrecision > 8;
    try {
      const response = await fetchJson(
        this.fetch,
        `${PREDICT_API}/v1/markets/${encodeURIComponent(market.id)}/orderbook`,
        { headers: { "x-api-key": this.predictApiKey } },
      );
      const book = response?.data || response;
      const receivedAt = Date.now();
      const sourceTimestamp = toTimestampMs(book?.updateTimestampMs);
      const observedAt = sourceTimestamp ?? receivedAt;
      base.status = exactMatch && !precisionInvalid ? "connected" : "unmatched";
      base.error = null;
      const timestampKind = sourceTimestamp === null ? "received" : "source";
      if (precisionInvalid) {
        base.market = {
          ...marketMeta,
          matchStatus: "unmatched",
          matchReason:
            "Predict price precision is missing or invalid. UP's raw quote is shown; DOWN cannot be safely derived, and the scanner remains blocked.",
        };
        base.up = quoteFromBook(book, observedAt, receivedAt, timestampKind);
        base.down = blankQuote(
          "unavailable",
          "Cannot derive the complementary DOWN quote without valid market precision.",
        );
      } else {
        const mapped = complementYesBook(book, decimalPrecision);
        base.market = marketMeta;
        base.up = quoteFromBook(mapped.yes, observedAt, receivedAt, timestampKind);
        base.down = quoteFromBook(mapped.no, observedAt, receivedAt, timestampKind);
      }
      base.observedAt = receivedAt;
      if (Number(nowMs) - observedAt > this.maxBookAgeMs) {
        for (const quote of [base.up, base.down]) {
          if (quote.status !== "ok") continue;
          quote.status = "stale";
          quote.error = "Predict.fun order book timestamp is stale.";
        }
      }
      return base;
    } catch (error) {
      base.status = "error";
      base.error = serializeError(error);
      base.market = {
        ...marketMeta,
        matchStatus: exactMatch ? "matched" : "unmatched",
        matchReason: `${exactMatch ? "Market matched" : "Could not load a separate Predict quote"}. Order-book request failed: ${base.error}`,
      };
      base.up = blankQuote("error", base.error);
      base.down = blankQuote("error", base.error);
      return base;
    }
  }

  async _fetchBenchmark(window, nowMs) {
    const start = new Date(window.openMs).toISOString();
    const end = new Date(window.closeMs).toISOString();
    const params = new URLSearchParams({
      granularity: "300",
      start,
      end,
    });
    const result = {
      source: "Coinbase Exchange BTC-USD",
      use: "paper settlement only; never used by the arbitrage scanner",
      status: "unavailable",
      openMs: window.openMs,
      closeMs: window.closeMs,
      observedAt: null,
      openPrice: null,
      currentPrice: null,
      currentOutcome: null,
      finalClosePrice: null,
      finalOutcome: null,
      finalized: false,
      finalizedAt: null,
      settlementRule: "UP if final BTC-USD candle close is greater than or equal to its open; otherwise DOWN.",
      warning:
        "Internal paper benchmark only. It is not Polymarket/Chainlink or Predict.fun/Pyth settlement and not an actual token payout.",
    };
    try {
      const [ticker, candles] = await Promise.all([
        fetchJson(this.fetch, `${COINBASE_API}/products/BTC-USD/ticker`, {
          headers: { "User-Agent": "BTC-Cross-Venue-Arb-Demo/1.0" },
        }),
        fetchJson(
          this.fetch,
          `${COINBASE_API}/products/BTC-USD/candles?${params.toString()}`,
          { headers: { "User-Agent": "BTC-Cross-Venue-Arb-Demo/1.0" } },
        ),
      ]);
      const rows = Array.isArray(candles) ? candles : [];
      const row = rows.find(
        (entry) => Array.isArray(entry) && Number(entry[0]) * 1000 === Number(window.openMs),
      );
      const currentPrice = finiteNumber(ticker?.price);
      const openPrice = row ? finiteNumber(row[3]) : null;
      const finalClosePrice = row ? finiteNumber(row[4]) : null;
      result.openPrice = openPrice;
      result.currentPrice = currentPrice;
      result.finalClosePrice = Number(nowMs) >= Number(window.closeMs) ? finalClosePrice : null;
      result.observedAt = toTimestampMs(ticker?.time) ?? Date.now();
      result.status =
        openPrice !== null && currentPrice !== null ? "provisional" : "incomplete";
      if (openPrice !== null && currentPrice !== null) {
        result.currentOutcome = currentPrice >= openPrice ? "UP" : "DOWN";
      }
      if (
        Number(nowMs) >= Number(window.closeMs) &&
        openPrice !== null &&
        finalClosePrice !== null
      ) {
        result.status = "final";
        result.finalized = true;
        result.finalizedAt = Math.max(Date.now(), Number(window.closeMs));
        result.finalOutcome = finalClosePrice >= openPrice ? "UP" : "DOWN";
      }
      if (openPrice === null) {
        result.error = "Coinbase did not return the exact 5-minute candle for this UTC window.";
      }
      return result;
    } catch (error) {
      result.error = serializeError(error);
      return result;
    }
  }
}

module.exports = ArbitrageBot;
