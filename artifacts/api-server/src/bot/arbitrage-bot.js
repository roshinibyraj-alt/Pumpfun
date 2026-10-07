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
  getPolymarketResolvedOutcome,
  getPredictResolvedOutcome,
  getExplicitMarketWindow,
  mapPredictUpDownOutcomes,
  normalizeLevels,
  toTimestampMs,
  updateTradeWithOfficialVenueSettlement,
  windowForTime,
  windowsMatch,
} = require("./arbitrage-engine.js");

const POLY_GAMMA = "https://gamma-api.polymarket.com";
const POLY_CLOB = "https://clob.polymarket.com";
const PREDICT_API = "https://api.predict.fun";
const COINBASE_API = "https://api.exchange.coinbase.com";
const POLL_MS = 500;
const DEFAULT_PAPER_BASE_LATENCY_MS = 500;
const MAX_BOOK_SKEW_MS = 1000;
const MAX_EXECUTION_WAIT_MS = 3000;
const RETRY_AFTER_MISSED_MS = 1000;
const PREDICT_MARKET_CACHE_MS = 60_000;
const POLYMARKET_MARKET_CACHE_MS = 60_000;
const SETTLEMENT_RETRY_MS = 15_000;
const MAX_SETTLEMENT_WINDOWS_PER_TICK = 1;
const HEARTBEAT_INTERVAL_MS = 30_000;
const SETTLEMENT_MODEL = "independent-venue-v1";
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

function venueKey(value) {
  const normalized = String(value ?? "").toLowerCase();
  if (normalized.includes("poly")) return "polymarket";
  if (normalized.includes("predict")) return "predict";
  return null;
}

function toShortLevels(levels, side = "asks") {
  return normalizeLevels(levels, side).slice(0, 20);
}

function blankQuote(status = "missing", error = null) {
  return {
    status,
    error,
    observedAt: null,
    receivedAt: null,
    ageMs: null,
    requestLatencyMs: null,
    bids: [],
    asks: [],
    bestBid: null,
    bestAsk: null,
    bidDepth: 0,
    askDepth: 0,
  };
}

function quoteFromBook(
  book,
  observedAt,
  receivedAt = Date.now(),
  timestampKind = "received",
  requestStartedAt = receivedAt,
) {
  const bids = toShortLevels(book?.bids, "bids");
  const asks = toShortLevels(book?.asks, "asks");
  return {
    status: "ok",
    error: null,
    observedAt,
    receivedAt,
    timestampKind,
    ageMs: Math.max(0, receivedAt - observedAt),
    requestLatencyMs: Math.max(0, receivedAt - requestStartedAt),
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
    this.stdoutLogger =
      options.stdoutLogger ||
      ((line) => {
        console.info(line);
      });
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
    this.pollMs = this._readBoundedMs(
      options.pollMs ?? process.env.ARB_POLL_MS,
      POLL_MS,
      POLL_MS,
      5000,
    );
    this.paperBaseLatencyMs = this._readBoundedMs(
      options.paperBaseLatencyMs ?? process.env.ARB_PAPER_BASE_LATENCY_MS,
      DEFAULT_PAPER_BASE_LATENCY_MS,
      100,
      5000,
    );
    this.rateLimitBackoffMs = 0;
    this.rateLimitedUntil = 0;
    this.lastCycleMs = 0;
    this.lastHeartbeatAt = 0;
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
    this.polymarketCache = {
      fetchedAt: 0,
      windowSlug: null,
      candidate: null,
      event: null,
    };
    this.pendingPaperPairs = new Map();
    this.retryAfterByKey = new Map();
    this.settlementRetryAtByWindow = new Map();
    this.predictSettlementIdBySlug = new Map();
    this.state = {
      app: "BTC Cross-Venue Arb Demo",
      mode: "PAPER",
      running: false,
      now: Date.now(),
      pollMs: this.pollMs,
      polling: {
        targetIntervalMs: this.pollMs,
        lastCycleMs: 0,
        rateLimitBackoffMs: 0,
      },
      config: {
        startingPaperCapitalUsd: this.startingCapitalUsd,
        maxCashPerLegUsd: this.maxCashPerLegUsd,
        maxCashPerOpportunityUsd: this.maxCashPerLegUsd * 2,
        minNetEdgePerShare: this.minNetEdgePerShare,
        safetyMarginPerShare: this.safetyMarginPerShare,
        maxBookAgeMs: this.maxBookAgeMs,
        maxBookSkewMs: MAX_BOOK_SKEW_MS,
        paperBaseLatencyMs: this.paperBaseLatencyMs,
        executionModel: "delayed_marketable_pair_recheck",
        equalShares: true,
        pairPayoutPerShare: 1,
        onePaperPairPerDirectionPerWindow: true,
      },
      window: null,
      benchmark: {
        source: "Coinbase Exchange BTC-USD",
        use: "diagnostic/provisional reference only; never used for official venue settlement or final P&L",
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
  }

  _readSafetyMargin() {
    const configured = finiteNumber(process.env.ARB_SAFETY_MARGIN_PER_SHARE);
    if (configured === null || configured < 0 || configured >= 0.5) {
      return DEFAULT_SAFETY_MARGIN_PER_SHARE;
    }
    return configured;
  }

  _readBoundedMs(value, fallback, minimum, maximum) {
    const configured = finiteNumber(value);
    if (configured === null) return fallback;
    return Math.max(minimum, Math.min(maximum, Math.round(configured)));
  }

  async _load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const text = await fs.readFile(this.stateFile, "utf8");
      const stored = JSON.parse(text);
      let migratedTrades = 0;
      let priorBenchmarkPnl = 0;
      if (Array.isArray(stored.paperTrades)) {
        this.state.paperTrades = stored.paperTrades.slice(-MAX_TRADES);
        for (const trade of this.state.paperTrades) {
          if (
            trade.finalized === true &&
            trade.settlementMethod !== "official_venue_markets"
          ) {
            priorBenchmarkPnl += finiteNumber(trade.realizedPnl) ?? 0;
            trade.priorBenchmarkSettlement ??= {
              outcome: trade.finalOutcome ?? null,
              payout: finiteNumber(trade.finalPayout),
              pnl: finiteNumber(trade.realizedPnl),
              label: trade.settlementLabel ?? "legacy_shared_benchmark",
            };
            trade.finalized = false;
            trade.status =
              Number(trade.closeMs) <= Date.now()
                ? "awaiting_official_venue_settlement"
                : "open_provisional";
            trade.finalOutcome = null;
            trade.finalPayout = null;
            trade.realizedPnl = null;
            trade.finalizedAt = null;
            trade.provisionalOutcome = null;
            trade.provisionalPayout = null;
            trade.provisionalPnl = null;
            trade.settlementLabel = "OFFICIAL_VENUE_SETTLEMENT_PENDING";
            migratedTrades += 1;
          } else if (
            trade.finalized !== true &&
            Number(trade.closeMs) <= Date.now()
          ) {
            trade.status = "awaiting_official_venue_settlement";
            trade.provisionalOutcome = null;
            trade.provisionalPayout = null;
            trade.provisionalPnl = null;
            trade.settlementLabel = "OFFICIAL_VENUE_SETTLEMENT_PENDING";
          } else if (trade.finalized !== true) {
            trade.provisionalOutcome = null;
            trade.provisionalPayout = null;
            trade.provisionalPnl = null;
          }
        }
      }
      const storedStartingCapital = finiteNumber(stored.startingCapitalUsd);
      if (storedStartingCapital !== null && storedStartingCapital >= 0) {
        this.startingCapitalUsd = storedStartingCapital;
      }
      this.realizedPnlTotal = this.state.paperTrades
        .filter(
          (trade) =>
            trade.finalized === true &&
            trade.settlementMethod === "official_venue_markets",
        )
        .reduce((sum, trade) => sum + (finiteNumber(trade.realizedPnl) ?? 0), 0);
      this.state.config.startingPaperCapitalUsd = this.startingCapitalUsd;
      if (Array.isArray(stored.events)) this.state.events = stored.events.slice(-MAX_LOGS);
      if (Array.isArray(stored.firedKeys)) this.firedKeys = new Set(stored.firedKeys);
      const needsSettlementMigration =
        Number(stored.version || 0) < 3 ||
        stored.settlementModel !== SETTLEMENT_MODEL ||
        migratedTrades > 0;
      if (migratedTrades > 0) {
        this._log(
          "OFFICIAL_SETTLEMENT_MIGRATION",
          "Legacy shared-benchmark results were moved back to pending; closed pairs will be reconciled against both exact venue markets.",
          {
            migratedTrades,
            priorBenchmarkPnl,
          },
        );
      }
      if (needsSettlementMigration) {
        await this._persist();
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
        version: 3,
        settlementModel: SETTLEMENT_MODEL,
        startingCapitalUsd: this.startingCapitalUsd,
        realizedPnlTotal: this.realizedPnlTotal,
        paperTrades: this.state.paperTrades.slice(-MAX_TRADES),
        events: this.state.events.slice(-MAX_LOGS),
        firedKeys: [...this.firedKeys].slice(-500),
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
    const entry = {
      ts: Date.now(),
      event,
      note,
      ...extra,
    };
    this.state.events.unshift(entry);
    this.state.events = this.state.events.slice(0, MAX_LOGS);
    const level = /ERROR|FAILED/.test(event)
      ? "error"
      : /WAITING|BACKOFF/.test(event)
        ? "warn"
        : "info";
    const safeNote = String(note || "").replace(
      /(x-api-key|authorization|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi,
      "$1=[redacted]",
    );
    try {
      this.stdoutLogger(
        JSON.stringify({
          timestamp: new Date(entry.ts).toISOString(),
          level,
          component: "btc-cross-venue-paper",
          mode: "PAPER",
          ...entry,
          note: safeNote,
        }),
      );
    } catch {
      // Logging must not interrupt the paper scan.
    }
  }

  _maybeLogHeartbeat(nowMs) {
    if (Number(nowMs) - this.lastHeartbeatAt < HEARTBEAT_INTERVAL_MS) return;
    this.lastHeartbeatAt = Number(nowMs);
    const summarizeVenue = (venue) => ({
      status: venue?.status || "missing",
      up: {
        status: venue?.up?.status || "missing",
        bestBid: venue?.up?.bestBid?.price ?? null,
        bestAsk: venue?.up?.bestAsk?.price ?? null,
        ageMs: venue?.up?.ageMs ?? null,
      },
      down: {
        status: venue?.down?.status || "missing",
        bestBid: venue?.down?.bestBid?.price ?? null,
        bestAsk: venue?.down?.bestAsk?.price ?? null,
        ageMs: venue?.down?.ageMs ?? null,
      },
    });
    this._log("BOT_HEARTBEAT", "Paper scanner is polling read-only market data.", {
      mode: "PAPER",
      windowSlug: this.state.window?.slug ?? null,
      secondsRemaining: this.state.window?.secondsRemaining ?? null,
      targetIntervalMs: this.pollMs,
      lastCycleMs: this.lastCycleMs,
      venues: {
        polymarket: summarizeVenue(this.state.venues?.polymarket),
        predict: summarizeVenue(this.state.venues?.predict),
      },
      opportunities: (this.state.opportunities || []).map((item) => ({
        direction: item.direction,
        status: item.status,
        eligible: item.eligible,
        netEdgePerShare: item.netEdgePerShare ?? null,
      })),
      paperPairs: this.state.paperTrades.length,
      pendingOfficialSettlements: this.state.paperTrades.filter(
        (trade) => !trade.finalized && Number(trade.closeMs) <= Number(nowMs),
      ).length,
    });
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
      const cycleStartedAt = Date.now();
      try {
        await this._tick();
      } catch (error) {
        this.state.lastError = serializeError(error);
        this._log("SCAN_ERROR", this.state.lastError);
        await this._persist();
      }
      if (!this.running) break;
      const elapsedMs = Date.now() - cycleStartedAt;
      const intervalWaitMs = Math.max(0, this.pollMs - elapsedMs);
      const rateLimitWaitMs = Math.max(0, this.rateLimitedUntil - Date.now());
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(intervalWaitMs, rateLimitWaitMs)),
      );
    }
  }

  async _tick() {
    const tickStartedAt = Date.now();
    const currentWindow = windowForTime(tickStartedAt);
    const slug = `btc-updown-5m-${Math.floor(currentWindow.openMs / 1000)}`;
    const activeWindow = this.state.window;
    if (!activeWindow || activeWindow.openMs !== currentWindow.openMs) {
      this._log("WINDOW_CHANGED", `Scanning the 5-minute UTC slot ${new Date(currentWindow.openMs).toISOString()}.`);
    }
    this.state.window = {
      slug,
      openMs: currentWindow.openMs,
      closeMs: currentWindow.closeMs,
      secondsRemaining: Math.max(0, (currentWindow.closeMs - tickStartedAt) / 1000),
      timezone: "UTC",
    };

    const [polyResult, initialPredictResult, currentBenchmark] = await Promise.all([
      this._fetchPolymarket(currentWindow, slug),
      this._fetchPredict(currentWindow, null, tickStartedAt),
      this._fetchBenchmark(currentWindow, tickStartedAt),
    ]);
    let predictResult = initialPredictResult;
    const polymarketConditionId = String(polyResult.market?.conditionId || "").toLowerCase();
    if (
      predictResult.market?.matchStatus !== "matched" &&
      polymarketConditionId &&
      this.predictCache.markets.some((market) =>
        (Array.isArray(market?.polymarketConditionIds)
          ? market.polymarketConditionIds
          : [])
          .map((id) => String(id).toLowerCase())
          .includes(polymarketConditionId),
      )
    ) {
      predictResult = await this._fetchPredict(
        currentWindow,
        polyResult.market.conditionId,
        Date.now(),
      );
    }
    this.state.venues.polymarket = polyResult;
    this.state.venues.predict = predictResult;
    this.state.benchmark = currentBenchmark || {
      source: "Coinbase Exchange BTC-USD",
      use: "diagnostic/provisional reference only; never used for official venue settlement or final P&L",
      status: "unavailable",
    };

    const evaluationAt = Date.now();
    const evaluated = this._evaluate(
      currentWindow,
      polyResult,
      predictResult,
      evaluationAt,
    );
    this._processPendingPaperPairs(
      currentWindow,
      evaluated,
      currentBenchmark,
      evaluationAt,
    );
    this._schedulePaperPairs(currentWindow, evaluated, evaluationAt);
    this.state.opportunities = this._decoratePendingOpportunities(
      this._evaluate(currentWindow, polyResult, predictResult, evaluationAt),
    );

    for (const trade of this.state.paperTrades) {
      if (
        trade.finalized ||
        Number(trade.openMs) !== Number(currentWindow.openMs) ||
        Number(trade.closeMs) <= evaluationAt
      ) {
        continue;
      }
      const updated = updateTradeWithOfficialVenueSettlement(
        trade,
        currentBenchmark,
        null,
        evaluationAt,
      );
      Object.assign(trade, updated);
    }
    const settlementResults = await this._processOfficialSettlements(evaluationAt);
    const rateLimitText = [
      polyResult.error,
      polyResult.up?.error,
      polyResult.down?.error,
      predictResult.error,
      JSON.stringify(predictResult.discovery || {}),
      predictResult.up?.error,
      predictResult.down?.error,
      currentBenchmark?.error,
      ...settlementResults.map((item) => item.error),
    ]
      .filter(Boolean)
      .join(" ");
    if (/\b429\b|too many requests|rate.?limit/i.test(rateLimitText)) {
      this.rateLimitBackoffMs = Math.min(
        this.rateLimitBackoffMs ? this.rateLimitBackoffMs * 2 : 2000,
        30_000,
      );
      this.rateLimitedUntil = Date.now() + this.rateLimitBackoffMs;
      this._log(
        "API_RATE_LIMIT_BACKOFF",
        `Read-only data endpoint rate limited the scanner; pausing requests for ${this.rateLimitBackoffMs} ms.`,
      );
    } else {
      this.rateLimitBackoffMs = 0;
      this.rateLimitedUntil = 0;
    }
    this.lastCycleMs = Date.now() - tickStartedAt;
    this.state.polling = {
      targetIntervalMs: this.pollMs,
      lastCycleMs: this.lastCycleMs,
      rateLimitBackoffMs: this.rateLimitBackoffMs,
      rateLimitedUntil: this.rateLimitedUntil || null,
    };
    this._recalculateStats();
    this.state.lastError = null;
    this._maybeLogHeartbeat(Date.now());
    await this._persist();
  }

  _schedulePaperPairs(window, opportunities, nowMs) {
    for (const opportunity of opportunities) {
      const key = `${window.openMs}:${opportunity.direction}`;
      if (
        !opportunity.eligible ||
        this.firedKeys.has(key) ||
        this.pendingPaperPairs.has(key) ||
        Number(this.retryAfterByKey.get(key) || 0) > nowMs
      ) {
        continue;
      }
      const arrivalAtByVenue = {};
      for (const leg of opportunity.legs || []) {
        const feedLatencyMs = Math.max(0, finiteNumber(leg.requestLatencyMs) ?? 0);
        arrivalAtByVenue[leg.venue] =
          nowMs + this.paperBaseLatencyMs + feedLatencyMs;
      }
      const simulatedArrivalAt = Math.max(...Object.values(arrivalAtByVenue));
      this.pendingPaperPairs.set(key, {
        key,
        direction: opportunity.direction,
        windowOpenMs: Number(window.openMs),
        closeMs: Number(window.closeMs),
        detectedAt: nowMs,
        arrivalAtByVenue,
        simulatedArrivalAt,
        expiresAt: simulatedArrivalAt + MAX_EXECUTION_WAIT_MS,
        signalPairCostPerShare: opportunity.pairCostPerShare,
        signalNetEdgePerShare: opportunity.netEdgePerShare,
        signalShares: opportunity.shares,
      });
      this._log(
        "PAPER_PAIR_QUEUED",
        `${opportunity.direction} met the signal threshold; rechecking prices, depth, and fees after ${simulatedArrivalAt - nowMs} ms of modeled arrival latency.`,
        {
          direction: opportunity.direction,
          simulatedArrivalAt,
          signalNetEdgePerShare: opportunity.netEdgePerShare,
        },
      );
    }
  }

  _processPendingPaperPairs(window, opportunities, benchmark, nowMs) {
    const byDirection = new Map(
      opportunities.map((opportunity) => [opportunity.direction, opportunity]),
    );
    for (const [key, pending] of this.pendingPaperPairs) {
      if (
        pending.windowOpenMs !== Number(window.openMs) ||
        nowMs >= Number(pending.closeMs)
      ) {
        this.pendingPaperPairs.delete(key);
        this._log(
          "PAPER_PAIR_MISSED",
          `${pending.direction} was not simulated because its five-minute window ended before the delayed execution check.`,
          { direction: pending.direction, reason: "window_closed_before_arrival" },
        );
        continue;
      }
      const opportunity = byDirection.get(pending.direction);
      if (nowMs < pending.simulatedArrivalAt) continue;
      const snapshotsReady =
        opportunity?.legs?.length === 2 &&
        opportunity.legs.every(
          (leg) =>
            finiteNumber(leg.quoteReceivedAt) !== null &&
            finiteNumber(leg.quoteReceivedAt) >=
              Number(pending.arrivalAtByVenue[leg.venue] || pending.simulatedArrivalAt),
        );
      if (!snapshotsReady) {
        if (nowMs <= pending.expiresAt) continue;
        this.pendingPaperPairs.delete(key);
        this.retryAfterByKey.set(key, nowMs + RETRY_AFTER_MISSED_MS);
        this._log(
          "PAPER_PAIR_MISSED",
          `${pending.direction} had no fresh venue snapshots after the modeled arrival time; no paper fill was recorded.`,
          { direction: pending.direction, reason: "no_post_latency_snapshot" },
        );
        continue;
      }
      if (opportunity?.eligible) {
        const simulatedLatencyMs = Math.max(0, nowMs - pending.detectedAt);
        const trade = this._createPaperTrade(opportunity, window, benchmark, {
          detectedAt: pending.detectedAt,
          executedAt: nowMs,
          simulatedLatencyMs,
          signalPairCostPerShare: pending.signalPairCostPerShare,
          signalNetEdgePerShare: pending.signalNetEdgePerShare,
          signalShares: pending.signalShares,
        });
        this.state.paperTrades.unshift(trade);
        this.state.paperTrades = this.state.paperTrades.slice(0, MAX_TRADES);
        this.firedKeys.add(key);
        this.pendingPaperPairs.delete(key);
        this.retryAfterByKey.delete(key);
        this._log(
          "PAPER_PAIR_OPENED",
          `${opportunity.direction} simulated at ${opportunity.shares.toFixed(2)} equal shares after ${simulatedLatencyMs} ms; current depth and fees were rechecked and no orders were sent.`,
          {
            tradeId: trade.id,
            direction: trade.direction,
            simulatedLatencyMs,
            executionPriceDriftPerShare: trade.executionPriceDriftPerShare,
          },
        );
        continue;
      }
      const transient =
        opportunity?.status === "blocked" &&
        /book|stale|missing|unavailable|snapshot|not safely matched/i.test(
          String(opportunity.reason || ""),
        );
      if (transient && nowMs <= pending.expiresAt) continue;
      this.pendingPaperPairs.delete(key);
      this.retryAfterByKey.set(key, nowMs + RETRY_AFTER_MISSED_MS);
      this._log(
        "PAPER_PAIR_MISSED",
        `${pending.direction} signal disappeared during modeled latency; no fill was recorded. ${opportunity?.reason || "Current books no longer support the signal."}`,
        {
          direction: pending.direction,
          reason: opportunity?.reason || "signal_disappeared",
          signalNetEdgePerShare: pending.signalNetEdgePerShare,
          arrivalNetEdgePerShare: opportunity?.netEdgePerShare ?? null,
        },
      );
    }
    for (const [key, retryAt] of this.retryAfterByKey) {
      if (retryAt <= nowMs) this.retryAfterByKey.delete(key);
    }
  }

  _decoratePendingOpportunities(opportunities) {
    return opportunities.map((opportunity) => {
      const key = `${this.state.window?.openMs}:${opportunity.direction}`;
      const pending = this.pendingPaperPairs.get(key);
      if (!pending) return opportunity;
      return {
        ...opportunity,
        status: "pending_execution",
        eligible: false,
        pendingExecution: true,
        simulatedArrivalAt: pending.simulatedArrivalAt,
        reason:
          "Signal found; waiting for delayed venue snapshots, then rechecking the $0.10 edge, fees, and visible depth.",
      };
    });
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
      maxBookSkewMs: MAX_BOOK_SKEW_MS,
    };
    const candidates = [
      {
        direction: "POLY_UP + PREDICT_DOWN",
        legs: [
          {
            venue: "Polymarket",
            side: "UP",
            marketId: poly.market?.id,
            marketSlug: poly.market?.slug,
            conditionId: poly.market?.conditionId,
            marketTitle: poly.market?.title,
            feeModel: "polymarket",
            book: poly.up,
            marketMatched: polyMatched,
            matchReason: poly.market?.matchReason,
          },
          {
            venue: "Predict.fun",
            side: "DOWN",
            marketId: predict.market?.id,
            marketSlug: predict.market?.slug,
            conditionId: predict.market?.conditionId,
            marketTitle: predict.market?.title,
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
            marketId: predict.market?.id,
            marketSlug: predict.market?.slug,
            conditionId: predict.market?.conditionId,
            marketTitle: predict.market?.title,
            feeModel: "predict",
            book: predict.up,
            marketMatched: predictMatched,
            matchReason: predict.market?.matchReason,
          },
          {
            venue: "Polymarket",
            side: "DOWN",
            marketId: poly.market?.id,
            marketSlug: poly.market?.slug,
            conditionId: poly.market?.conditionId,
            marketTitle: poly.market?.title,
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

  _createPaperTrade(opportunity, window, benchmark, execution = {}) {
    const legs = opportunity.legs.map((leg) => ({
      venue: leg.venue,
      side: leg.side,
      marketId: leg.marketId ?? null,
      marketSlug: leg.marketSlug ?? null,
      conditionId: leg.conditionId ?? null,
      marketTitle: leg.marketTitle ?? null,
      shares: leg.shares,
      quoteObservedAt: leg.quoteObservedAt,
      quoteReceivedAt: leg.quoteReceivedAt,
      quoteAgeMs: leg.quoteAgeMs,
      requestLatencyMs: leg.requestLatencyMs,
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
      openedAt: execution.executedAt ?? Date.now(),
      signalDetectedAt: execution.detectedAt ?? null,
      simulatedLatencyMs: execution.simulatedLatencyMs ?? null,
      executionModel: "marketable_depth_after_latency",
      signalPairCostPerShare: execution.signalPairCostPerShare ?? null,
      signalNetEdgePerShare: execution.signalNetEdgePerShare ?? null,
      signalShares: execution.signalShares ?? null,
      executionPriceDriftPerShare:
        finiteNumber(execution.signalPairCostPerShare) === null
          ? null
          : opportunity.pairCostPerShare - Number(execution.signalPairCostPerShare),
      arrivalSnapshotSkewMs: opportunity.snapshotSkewMs ?? null,
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
      settlementLabel: "OFFICIAL_VENUE_SETTLEMENT_PENDING",
      settlementMethod: null,
      venueSettlements: null,
      legSettlements: null,
      provisionalOutcome: null,
      provisionalPayout: null,
      provisionalPnl: null,
      finalized: false,
      mode: "PAPER",
    };
  }

  async _processOfficialSettlements(nowMs) {
    const groups = new Map();
    for (const trade of this.state.paperTrades) {
      if (trade.finalized || Number(trade.closeMs) > Number(nowMs)) continue;
      const key = Number(trade.openMs);
      if (!groups.has(key)) {
        groups.set(key, {
          window: { openMs: key, closeMs: Number(trade.closeMs) },
          trades: [],
        });
      }
      groups.get(key).trades.push(trade);
    }
    const dueGroups = [...groups.entries()]
      .filter(
        ([openMs]) => Number(this.settlementRetryAtByWindow.get(openMs) || 0) <= nowMs,
      )
      .sort((left, right) => left[0] - right[0])
      .slice(0, MAX_SETTLEMENT_WINDOWS_PER_TICK);
    const results = [];
    for (const [openMs, group] of dueGroups) {
      this.settlementRetryAtByWindow.set(openMs, nowMs + SETTLEMENT_RETRY_MS);
      const [polymarket, predict] = await Promise.all([
        this._fetchOfficialPolymarketOutcome(group.window, group.trades),
        this._fetchOfficialPredictOutcome(group.window, group.trades),
      ]);
      for (const venueResult of [polymarket, predict]) {
        if (venueResult.error) results.push({ error: venueResult.error });
      }
      for (const trade of group.trades) {
        const updated = updateTradeWithOfficialVenueSettlement(
          trade,
          null,
          { polymarket, predict },
          nowMs,
        );
        Object.assign(trade, updated);
        if (updated.finalized) {
          this.realizedPnlTotal += finiteNumber(updated.realizedPnl) ?? 0;
          this._log(
            "PAPER_PAIR_FINALIZED",
            `Venue-specific results finalized the pair: ${updated.finalOutcome}.`,
            {
              tradeId: trade.id,
              finalOutcome: updated.finalOutcome,
              finalPayout: updated.finalPayout,
              realizedPnl: updated.realizedPnl,
            },
          );
        } else {
          const shouldLog =
            !trade.lastSettlementLogAt ||
            Number(nowMs) - Number(trade.lastSettlementLogAt) >= 60_000;
          if (shouldLog) {
            trade.lastSettlementLogAt = Number(nowMs);
            this._log(
              "OFFICIAL_SETTLEMENT_WAITING",
              "At least one exact venue market has not published a confirmed final outcome; the pair remains pending and is excluded from realized P&L.",
              {
                tradeId: trade.id,
                polymarketStatus: polymarket.status,
                predictStatus: predict.status,
              },
            );
          }
        }
      }
      if (group.trades.every((trade) => trade.finalized)) {
        this.settlementRetryAtByWindow.delete(openMs);
      }
    }
    for (const openMs of this.settlementRetryAtByWindow.keys()) {
      if (!groups.has(openMs)) this.settlementRetryAtByWindow.delete(openMs);
    }
    return results;
  }

  async _fetchOfficialPolymarketOutcome(window, trades) {
    const slug = predictFiveMinuteSlug(window);
    const result = {
      status: "pending",
      outcome: null,
      marketSlug: slug,
      source: "Polymarket Gamma resolved market",
    };
    try {
      const response = await fetchJson(
        this.fetch,
        `${POLY_GAMMA}/events?slug=${encodeURIComponent(slug)}`,
      );
      const events = Array.isArray(response) ? response : response?.data || [];
      const event = events.find((item) => item.slug === slug);
      if (!event) {
        return { ...result, reason: "No exact Polymarket event was returned for this slot." };
      }
      const candidate = safePolymarketMarket(event, window);
      if (!candidate) {
        return {
          ...result,
          status: "unavailable",
          reason: "The closed Polymarket event did not contain one exact binary UP/DOWN market for this window.",
        };
      }
      const storedPolyLeg = trades
        .flatMap((trade) => trade.legs || [])
        .find((leg) => venueKey(leg.venue) === "polymarket");
      const expectedConditionId = String(storedPolyLeg?.conditionId || "").toLowerCase();
      const actualConditionId = String(candidate.market?.conditionId || "").toLowerCase();
      if (
        expectedConditionId &&
        actualConditionId &&
        expectedConditionId !== actualConditionId
      ) {
        return {
          ...result,
          status: "unavailable",
          reason: "Polymarket returned a different condition ID than the one stored at paper entry.",
        };
      }
      const outcome = getPolymarketResolvedOutcome(candidate.market);
      if (!outcome) {
        return {
          ...result,
          reason: "Polymarket has not published a confirmed 1/0 result for both UP and DOWN.",
        };
      }
      return {
        ...result,
        status: "resolved",
        outcome,
        marketId: candidate.market.id == null ? null : String(candidate.market.id),
        conditionId: candidate.market.conditionId ?? null,
        source: "Polymarket Gamma closed market outcome prices",
        resolvedAt:
          toTimestampMs(candidate.market.resolvedAt) ??
          toTimestampMs(candidate.market.closedTime) ??
          null,
      };
    } catch (error) {
      return { ...result, status: "error", reason: serializeError(error), error: serializeError(error) };
    }
  }

  async _fetchOfficialPredictOutcome(window, trades) {
    const slug = predictFiveMinuteSlug(window);
    const result = {
      status: "pending",
      outcome: null,
      marketSlug: slug,
      source: "Predict.fun resolved market outcome",
    };
    if (!this.predictApiKey) {
      return {
        ...result,
        status: "unavailable",
        reason: "PREDICT_API_KEY is not configured on the server.",
      };
    }
    try {
      const storedPredictLeg = trades
        .flatMap((trade) => trade.legs || [])
        .find((leg) => venueKey(leg.venue) === "predict");
      const storedSlug = String(storedPredictLeg?.marketSlug || slug);
      if (storedSlug !== slug) {
        return {
          ...result,
          status: "unavailable",
          reason: "The stored Predict.fun market slug does not match this five-minute window.",
        };
      }
      let marketId = String(storedPredictLeg?.marketId || "");
      if (!marketId) marketId = this.predictSettlementIdBySlug.get(slug) || "";
      let market;
      if (marketId) {
        const response = await fetchJson(
          this.fetch,
          `${PREDICT_API}/v1/markets/${encodeURIComponent(marketId)}`,
          { headers: { "x-api-key": this.predictApiKey } },
        );
        market = extractPredictMarkets(response).find(
          (candidate) => String(candidate.id) === marketId,
        );
      } else {
        const resolved = await this._fetchPredictMarketBySlug(window);
        market = resolved?.market;
        marketId = String(resolved?.marketId || market?.id || "");
        if (marketId) this.predictSettlementIdBySlug.set(slug, marketId);
      }
      if (!market) {
        return {
          ...result,
          status: "unavailable",
          reason: "Predict.fun did not return details for the exact market ID.",
        };
      }
      const actualSlug = String(market.slug || storedSlug);
      if (actualSlug !== slug) {
        return {
          ...result,
          status: "unavailable",
          reason: "Predict.fun market details do not match this exact five-minute slug.",
        };
      }
      const expectedConditionId = String(storedPredictLeg?.conditionId || "").toLowerCase();
      const actualConditionId = String(market.conditionId || "").toLowerCase();
      if (
        expectedConditionId &&
        actualConditionId &&
        expectedConditionId !== actualConditionId
      ) {
        return {
          ...result,
          status: "unavailable",
          reason: "Predict.fun returned a different condition ID than the one stored at paper entry.",
        };
      }
      const explicitWindow = getExplicitMarketWindow({
        ...market,
        slug: actualSlug,
      });
      if (!windowsMatch(explicitWindow, window)) {
        return {
          ...result,
          status: "unavailable",
          reason: "Predict.fun market boundaries do not match the stored UTC five-minute window.",
        };
      }
      const outcome = getPredictResolvedOutcome(market);
      if (!outcome) {
        return {
          ...result,
          reason:
            String(market.status || "").toUpperCase() === "RESOLVED"
              ? "Predict.fun's result is not an unambiguous binary UP/DOWN resolution."
              : "Predict.fun has not marked the exact market RESOLVED.",
        };
      }
      return {
        ...result,
        status: "resolved",
        outcome,
        marketId: marketId || String(market.id || ""),
        conditionId: market.conditionId ?? null,
        source: "Predict.fun market status, resolution and outcome records",
        resolvedAt: toTimestampMs(market.resolution?.createdAt) ?? null,
      };
    } catch (error) {
      return { ...result, status: "error", reason: serializeError(error), error: serializeError(error) };
    }
  }

  async _fetchPolymarket(window, slug) {
    const base = emptyVenue("Polymarket", "loading");
    try {
      const cacheAgeMs = Date.now() - Number(this.polymarketCache.fetchedAt || 0);
      const hasCachedMarket =
        this.polymarketCache.windowSlug === slug &&
        this.polymarketCache.candidate &&
        cacheAgeMs < POLYMARKET_MARKET_CACHE_MS;
      const hasShortNegativeCache =
        this.polymarketCache.windowSlug === slug &&
        !this.polymarketCache.candidate &&
        cacheAgeMs < 1000;
      let event = hasCachedMarket || hasShortNegativeCache
        ? this.polymarketCache.event
        : null;
      let candidate = hasCachedMarket ? this.polymarketCache.candidate : null;
      if (!hasCachedMarket && !hasShortNegativeCache) {
        const events = await fetchJson(
          this.fetch,
          `${POLY_GAMMA}/events?slug=${encodeURIComponent(slug)}`,
        );
        const eventList = Array.isArray(events) ? events : events?.data || [];
        event = eventList.find((item) => item.slug === slug) || eventList[0];
        candidate = event ? safePolymarketMarket(event, window) : null;
        this.polymarketCache = {
          fetchedAt: Date.now(),
          windowSlug: slug,
          candidate,
          event,
        };
      }
      if (!event) {
        base.status = "missing_market";
        base.market.matchReason = "No Polymarket event was returned for the exact 5-minute UTC slot.";
        return base;
      }
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
            const requestStartedAt = Date.now();
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
                requestStartedAt,
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
    const cacheTtlMs = this.predictCache.discovery?.exactMarketFound
      ? PREDICT_MARKET_CACHE_MS
      : Math.min(PREDICT_MARKET_CACHE_MS, 5000);
    if (
      this.predictCache.windowSlug === expectedSlug &&
      now - this.predictCache.fetchedAt < cacheTtlMs
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
          String(market?.slug ?? "") === expectedSlug &&
          mapPredictUpDownOutcomes(market).safe
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
      const requestStartedAt = Date.now();
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
        base.up = quoteFromBook(
          book,
          observedAt,
          receivedAt,
          timestampKind,
          requestStartedAt,
        );
        base.down = blankQuote(
          "unavailable",
          "Cannot derive the complementary DOWN quote without valid market precision.",
        );
      } else {
        const mapped = complementYesBook(book, decimalPrecision);
        base.market = marketMeta;
        base.up = quoteFromBook(
          mapped.yes,
          observedAt,
          receivedAt,
          timestampKind,
          requestStartedAt,
        );
        base.down = quoteFromBook(
          mapped.no,
          observedAt,
          receivedAt,
          timestampKind,
          requestStartedAt,
        );
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
      use: "diagnostic/provisional reference only; never used for official venue settlement or final P&L",
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
      settlementRule:
        "Diagnostic only: UP if the BTC-USD candle close is at least its open; otherwise DOWN. This never finalizes a paper pair.",
      warning:
        "Display-only diagnostic. It is not either venue's official outcome or actual token payout, and it is never used for final P&L.",
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
        result.status = "reference_final";
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
