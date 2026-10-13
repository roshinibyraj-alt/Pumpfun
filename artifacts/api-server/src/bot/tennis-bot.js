"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

const API_TENNIS = "https://api.api-tennis.com/tennis/";
const GAMMA = "https://gamma-api.polymarket.com";
const CLOB = "https://clob.polymarket.com";
const POLL_MS = 5000;
const DISCOVERY_CACHE_MS = 30000;
const FAVORITE_ASK_THRESHOLD = 0.7;
const NEUTRAL_ASK_MIN = 0.37;
const NEUTRAL_ASK_MAX = 0.66;
const STAKE_USD = 500;
const STARTING_CAPITAL = 10000;
const MAX_LOGS = 200;
const SERVE_POINT_STRATEGY_VERSION = "serve-point-accumulator-v1";
const SERVE_POINT_SHARES = 10;
const BOOK_404_BASE_COOLDOWN_MS = 60_000;
const BOOK_404_MAX_COOLDOWN_MS = 15 * 60_000;
const BREAKBACK_STRATEGY_VERSION = "breakback-staged-flat-v2";
const BASE_TRANCHE_SHARES = 250;

function entryGameAllowed(playerGames, opponentGames) {
  return (playerGames <= 4 && opponentGames <= 3) ||
    (playerGames <= 3 && opponentGames <= 4);
}

function parseUrl(value, host) {
  try {
    const url = new URL(String(value));
    const standardHost = url.hostname === host || url.hostname.endsWith(`.${host}`);
    if (url.protocol !== "https:" || !standardHost) return null;
    return url;
  } catch {
    return null;
  }
}

function slugFromPolymarket(url) {
  const parts = url.pathname.split("/").filter(Boolean);
  return parts.at(-1) || null;
}

function normalizeName(value) {
  return String(value || "").toLowerCase().replace(/[^a-z]/g, "");
}

function nameMatches(left, right) {
  const aParts = String(left || "").trim().split(/\s+/).filter(Boolean);
  const bParts = String(right || "").trim().split(/\s+/).filter(Boolean);
  const a = normalizeName(left);
  const b = normalizeName(right);
  const aSurname = normalizeName(aParts.at(-1));
  const bSurname = normalizeName(bParts.at(-1));
  const initialsMatch = !aParts.length || !bParts.length ||
    normalizeName(aParts[0])[0] === normalizeName(bParts[0])[0];
  return Boolean(a && b && (a === b || a.includes(b) || b.includes(a) ||
    (aSurname && aSurname === bSurname && initialsMatch)));
}

function findLiveMatch(matches, playerOne, playerTwo) {
  return matches.find((match) =>
    (nameMatches(match.event_first_player, playerOne) && nameMatches(match.event_second_player, playerTwo)) ||
    (nameMatches(match.event_second_player, playerOne) && nameMatches(match.event_first_player, playerTwo))
  ) || null;
}

function mayTradeSet(setNumber, firstSetLost) {
  return setNumber === 1 || (setNumber === 2 && firstSetLost) || setNumber === 3;
}

function listValue(value) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value || "[]"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function matchScore(event) {
  const match = String(event?.event_game_result || "").match(/(\d+)\s*[-:]\s*(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2])];
}

function tennisScoreSnapshot(match, selectedIsFirst, currentSet) {
  const sets = (Array.isArray(match?.scores) ? match.scores : []).map((score) => ({
    set: Number(score.score_set),
    playerGames: Number(score[selectedIsFirst ? "score_first" : "score_second"] || 0),
    opponentGames: Number(score[selectedIsFirst ? "score_second" : "score_first"] || 0),
  })).filter((score) => Number.isInteger(score.set) && score.set > 0);
  const isComplete = ({ playerGames, opponentGames }) => {
    const high = Math.max(playerGames, opponentGames);
    const low = Math.min(playerGames, opponentGames);
    return (high >= 6 && high - low >= 2) || (high === 7 && low === 6);
  };
  const completedSets = sets.filter((score) => score.set < currentSet || isComplete(score));
  const current = sets.find((score) => score.set === currentSet) || null;
  return {
    setsWon: {
      player: completedSets.filter((score) => score.playerGames > score.opponentGames).length,
      opponent: completedSets.filter((score) => score.opponentGames > score.playerGames).length,
    },
    currentSetGames: current
      ? { player: current.playerGames, opponent: current.opponentGames }
      : null,
    perSet: sets.map(({ set, playerGames, opponentGames }) => ({ set, playerGames, opponentGames })),
  };
}

function matchIsComplete(match) {
  return /finished|complete|ended|retired|walkover|cancelled|abandoned/i.test(String(match?.event_status || ""));
}

function hasZeroThirty(event, selectedIsFirst) {
  const score = matchScore(event);
  if (!score) return false;
  const selectedScore = score[selectedIsFirst ? 0 : 1];
  const opponentScore = score[selectedIsFirst ? 1 : 0];
  return selectedScore === 0 && opponentScore === 30;
}

function marketWinnerTokens(event, selectedPlayer) {
  for (const market of event?.markets || []) {
    const eventTitle = String(event.title || event.question || "").trim().toLowerCase();
    const question = String(market.question || "").trim().toLowerCase();
    if (!eventTitle || question !== eventTitle) continue;
    const outcomes = listValue(market.outcomes);
    const ids = listValue(market.clobTokenIds);
    if (outcomes.length !== 2 || ids.length !== 2) continue;
    const labels = outcomes.map(String);
    if (!labels.some((label) => nameMatches(label, selectedPlayer))) continue;
    if (labels.some((label) => /^(yes|no|completed|cancelled|draw)$/i.test(label.trim()))) continue;
    return { market, outcomes: labels, ids: ids.map(String) };
  }
  return null;
}

function marketForPlayers(event, playerOne, playerTwo) {
  if (!event || event.active === false || event.closed === true || event.closed === "true") return null;
  const eventTitle = String(event.title || event.question || "").trim().toLowerCase();
  if (!eventTitle) return null;
  for (const market of event.markets || []) {
    const question = String(market.question || "").trim().toLowerCase();
    if (question !== eventTitle || market.active === false || market.closed === true || market.closed === "true") continue;
    const outcomes = listValue(market.outcomes).map(String);
    const ids = listValue(market.clobTokenIds).map(String);
    if (outcomes.length !== 2 || ids.length !== 2) continue;
    if (outcomes.some((label) => /^(yes|no|completed|cancelled|draw)$/i.test(label.trim()))) continue;
    const oneIndex = outcomes.findIndex((label) => nameMatches(label, playerOne));
    const twoIndex = outcomes.findIndex((label) => nameMatches(label, playerTwo));
    if (oneIndex < 0 || twoIndex < 0 || oneIndex === twoIndex) continue;
    return { market, outcomes, ids };
  }
  return null;
}

function chooseFavorite(books, threshold = FAVORITE_ASK_THRESHOLD) {
  const eligible = books
    .map((book, index) => ({ ...book, index }))
    .filter((book) => book.bestAsk && Number(book.bestAsk.price) > threshold && Number(book.bestAsk.size) > 0)
    .sort((a, b) => Number(b.bestAsk.price) - Number(a.bestAsk.price));
  return eligible[0] || null;
}

function classifyFirstScan(books) {
  const favorite = chooseFavorite(books);
  if (favorite) return { selectionMode: "automatic_favorite", index: favorite.index, ask: favorite.bestAsk.price };
  const neutral = books
    .map((book, index) => ({ ...book, index }))
    .find((book) => book.bestAsk &&
      Number(book.bestAsk.price) >= NEUTRAL_ASK_MIN &&
      Number(book.bestAsk.price) <= NEUTRAL_ASK_MAX &&
      Number(book.bestAsk.size) > 0);
  return neutral
    ? { selectionMode: "automatic_any_break", index: neutral.index, ask: neutral.bestAsk.price }
    : null;
}

function marketDefaults({ slug, event, polyUrl, mapped, player, favoriteAsk, selectionMode = "automatic_favorite" }) {
  const selectedIndex = mapped.outcomes.findIndex((outcome) => nameMatches(outcome, player));
  return {
    id: `${slug}:${Date.now()}`,
    slug,
    title: event.title || event.question || slug,
    polymarketUrl: polyUrl,
    player,
    outcomes: mapped.outcomes,
    tokenIds: mapped.ids,
    opponent: mapped.outcomes[selectedIndex === 0 ? 1 : 0],
    tokenId: mapped.ids[selectedIndex],
    baseTokenId: mapped.ids[selectedIndex],
    marketId: String(mapped.market.id || ""),
    status: "armed",
    selectionMode,
    strategyVersion: SERVE_POINT_STRATEGY_VERSION,
    favoriteAskAtArm: favoriteAsk == null ? null : Number(favoriteAsk),
    scoreStatus: "live",
    currentScore: null,
    currentServer: null,
    position: null,
    positions: {},
    entries: 0,
    setBankrolls: { 1: STAKE_USD, 2: STAKE_USD, 3: STAKE_USD },
    firstSetPosition: null,
    firstSetClosed: false,
    lastGameCounts: {},
    lastObservedGames: {},
    breakCycle: null,
    compoundBudget: null,
    createdAt: Date.now(),
    error: null,
  };
}

class TennisPaperBot {
  constructor(options = {}) {
    this.fetch = options.fetch || globalThis.fetch;
    this.file = options.file || process.env.TENNIS_STATE_PATH ||
      path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH || process.cwd(), "data", "tennis-state.json");
    this.apiKey = options.apiKey ?? process.env.API_TENNIS_KEY ?? "";
    this.state = {
      app: "Polymarket Tennis Paper Bot",
      mode: "PAPER",
      running: false,
      updatedAt: Date.now(),
      feed: { status: this.apiKey ? "connecting" : "missing_key", liveMatches: 0, lastUpdate: null, error: null },
      discovery: { status: this.apiKey ? "waiting" : "missing_key", lastScanAt: null, candidates: 0, autoArmed: 0, lastMessage: null },
      bankroll: { startingCapital: STARTING_CAPITAL, availableCapital: STARTING_CAPITAL },
      markets: [],
      trades: [],
      events: [],
    };
    this.timer = null;
    this.busy = false;
    this.discoveryCursor = 0;
    this.book404Backoff = new Map();
  }

  log(message, level = "info") {
    this.state.events.unshift({ at: Date.now(), level, message });
    this.state.events = this.state.events.slice(0, MAX_LOGS);
    console.info(`[tennis-paper] ${message}`);
  }

  migrateServePointMarket(market) {
    for (const [key, position] of Object.entries(market.positions || {})) {
      position.player ||= market.activePlayer || market.player;
      position.tokenId ||= market.tokenId || market.tokenIds?.[0] || null;
      position.kind = "accumulated";
      position.entryPrice = Number(position.shares) > 0
        ? Number(position.stake || 0) / Number(position.shares)
        : Number(position.entryPrice || 0);
      market.positions[key] = position;
    }
    market.strategyVersion = SERVE_POINT_STRATEGY_VERSION;
    market.selectionMode = "automatic_serve_points";
    market.activePlayer = null;
    market.breakCycle = null;
    market.activeServeGame = null;
    market.lastObservedGames = {};
  }

  snapshot() {
    const snapshot = JSON.parse(JSON.stringify(this.state));
    snapshot.bankroll = this.capitalSummary();
    snapshot.markets = snapshot.markets.map((market) => ({
      ...market,
      accounting: this.marketAccounting(market),
    }));
    return snapshot;
  }

  capitalSummary() {
    const realizedPnl = this.state.trades.reduce((total, trade) =>
      total + Number(trade.realizedPnl ?? (trade.status === "closed" ? trade.pnl : 0) ?? 0), 0);
    let allocatedCapital = 0;
    let positionValue = 0;
    let unrealizedPnl = 0;
    for (const market of this.state.markets) {
      for (const position of Object.values(market.positions || {})) {
        const mark = Number(position.bestBid?.price ?? market.booksByToken?.[position.tokenId]?.bestBid?.price ?? market.bestBid?.price ?? position.entryPrice);
        const marketValue = position.shares * mark;
        allocatedCapital += Number(position.stake || 0);
        positionValue += marketValue;
        unrealizedPnl += marketValue - Number(position.stake || 0);
      }
    }
    const availableCapital = Number(this.state.bankroll?.availableCapital ?? STARTING_CAPITAL);
    const currentCapital = availableCapital + positionValue;
    return {
      startingCapital: STARTING_CAPITAL,
      availableCapital,
      allocatedCapital,
      positionValue,
      realizedPnl,
      unrealizedPnl,
      totalPnl: currentCapital - STARTING_CAPITAL,
      currentCapital,
    };
  }

  marketAccounting(market) {
    const trades = this.state.trades.filter((trade) => trade.marketId === market.id);
    const realizedPnl = trades.reduce((total, trade) =>
      total + Number(trade.realizedPnl ?? (trade.status === "closed" ? trade.pnl : 0) ?? 0), 0);
    let allocatedCapital = 0;
    let positionValue = 0;
    let unrealizedPnl = 0;
    for (const position of Object.values(market.positions || {})) {
      const mark = Number(position.bestBid?.price ?? market.booksByToken?.[position.tokenId]?.bestBid?.price ?? market.bestBid?.price ?? position.entryPrice);
      const value = position.shares * mark;
      allocatedCapital += Number(position.stake || 0);
      positionValue += value;
      unrealizedPnl += value - Number(position.stake || 0);
    }
    return {
      allocatedCapital,
      positionValue,
      realizedPnl,
      unrealizedPnl,
      totalPnl: realizedPnl + unrealizedPnl,
      openPositions: Object.keys(market.positions || {}).length,
      trades,
    };
  }

  async persist() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(this.state), "utf8");
  }

  async start() {
    if (this.timer) return;
    try {
      const saved = JSON.parse(await fs.readFile(this.file, "utf8"));
      if (saved?.app === this.state.app) this.state = { ...this.state, ...saved };
    } catch {}
    for (const market of this.state.markets || []) {
      if (market.strategyVersion !== SERVE_POINT_STRATEGY_VERSION) this.migrateServePointMarket(market);
    }
    if (!Number.isFinite(Number(this.state.bankroll?.availableCapital))) {
      const realized = this.state.trades.reduce((total, trade) =>
        total + Number(trade.realizedPnl ?? (trade.status === "closed" ? trade.pnl : 0) ?? 0), 0);
      const openStake = this.state.markets.reduce((total, market) =>
        total + Object.values(market.positions || {}).reduce((sum, position) => sum + Number(position.stake || 0), 0), 0);
      this.state.bankroll = {
        startingCapital: STARTING_CAPITAL,
        availableCapital: Math.max(0, STARTING_CAPITAL + realized - openStake),
      };
    } else {
      this.state.bankroll = {
        startingCapital: STARTING_CAPITAL,
        availableCapital: Math.max(0, Number(this.state.bankroll.availableCapital)),
      };
    }
    this.state.running = true;
    this.log(this.apiKey ? "Tennis score polling started in paper-only mode." : "Set API_TENNIS_KEY to enable score polling.", this.apiKey ? "info" : "warn");
    this.timer = setInterval(() => void this.tick(), POLL_MS);
    void this.tick();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.state.running = false;
    void this.persist();
  }

  async addMarket(input) {
    const polyUrl = parseUrl(input.polymarketUrl, "polymarket.com");
    const player = String(input.player || "").trim();
    if (!polyUrl || !player) throw new Error("Enter a valid Polymarket URL and choose the player.");
    if (input.confirmPolymarket !== true) throw new Error("Confirm the Polymarket match before arming the paper strategy.");
    const slug = slugFromPolymarket(polyUrl);
    if (!slug) throw new Error("Could not read a Polymarket market slug from that URL.");
    if (this.state.markets.some((item) => item.slug === slug)) throw new Error("That market is already on the dashboard.");
    const response = await this.fetch(`${GAMMA}/events?slug=${encodeURIComponent(slug)}`);
    if (!response.ok) throw new Error(`Polymarket lookup failed (HTTP ${response.status}).`);
    const events = await response.json();
    const event = events?.[0];
    const mapped = marketWinnerTokens(event, player);
    if (!event || !mapped) throw new Error("Could not identify a two-outcome Polymarket winner market.");
    const matchingOutcome = mapped.outcomes.findIndex((outcome) => nameMatches(outcome, player));
    if (matchingOutcome < 0) throw new Error("Selected player does not match either Polymarket outcome.");
    const item = {
      ...marketDefaults({ slug, event, polyUrl: polyUrl.href, mapped, player, favoriteAsk: null }),
      status: "armed",
      scoreStatus: "waiting",
      selectionMode: "manual_confirmation",
      favoriteAskAtArm: null,
    };
    this.state.markets.unshift(item);
    this.log(`Armed ${item.title} for ${player}; PAPER ONLY.`);
    await this.persist();
    return item;
  }

  async previewMarket(input) {
    const polyUrl = parseUrl(input.polymarketUrl, "polymarket.com");
    if (!polyUrl) throw new Error("Enter a valid Polymarket URL.");
    const slug = slugFromPolymarket(polyUrl);
    if (!slug) throw new Error("Could not read a Polymarket market slug from that URL.");
    const response = await this.fetch(`${GAMMA}/events?slug=${encodeURIComponent(slug)}`);
    if (!response.ok) throw new Error(`Polymarket lookup failed (HTTP ${response.status}).`);
    const events = await response.json();
    const event = events?.[0];
    if (!event) throw new Error("Polymarket did not return that market.");
    const candidate = (event.markets || []).map((market) => {
      if (String(market.question || "").trim().toLowerCase() !== String(event.title || event.question || "").trim().toLowerCase()) return null;
      const outcomes = listValue(market.outcomes);
      const ids = listValue(market.clobTokenIds);
      return outcomes.length === 2 && ids.length === 2 &&
        !outcomes.some((label) => /^(yes|no|completed|cancelled|draw)$/i.test(String(label).trim()))
        ? { market, outcomes: outcomes.map(String), ids: ids.map(String) } : null;
    }).find(Boolean);
    if (!candidate) throw new Error("No two-player match-winner market found; refusing unsafe outcome mapping.");
    const scoreFeed = await this.previewScoreFeed(candidate.outcomes);
    const clobBooks = await Promise.all(candidate.ids.map(async (tokenId, index) => {
      try {
        const bookResponse = await this.fetch(`${CLOB}/book?token_id=${encodeURIComponent(tokenId)}`, { signal: AbortSignal.timeout(5000) });
        if (!bookResponse.ok) return { player: candidate.outcomes[index], status: `http_${bookResponse.status}`, bestBid: null, bestAsk: null };
        const book = await bookResponse.json();
        const bestBid = (book.bids || []).map((level) => ({ price: Number(level.price), size: Number(level.size) }))
          .filter((level) => level.price > 0 && level.size > 0).sort((a, b) => b.price - a.price)[0] || null;
        const bestAsk = (book.asks || []).map((level) => ({ price: Number(level.price), size: Number(level.size) }))
          .filter((level) => level.price > 0 && level.size > 0).sort((a, b) => a.price - b.price)[0] || null;
        return { player: candidate.outcomes[index], status: "loaded", bestBid, bestAsk };
      } catch {
        return { player: candidate.outcomes[index], status: "unavailable", bestBid: null, bestAsk: null };
      }
    }));
    return {
      title: event.title || event.question || slug,
      players: candidate.outcomes,
      slug,
      marketId: String(candidate.market.id || ""),
      scoreFeed,
      clobBooks,
    };
  }

  async previewScoreFeed(players) {
    if (!this.apiKey) return { status: "missing_key", message: "API_TENNIS_KEY is not configured." };
    try {
      const matches = await this.fetchLiveMatches();
      this.state.feed = { status: "connected", liveMatches: matches.length, lastUpdate: Date.now(), error: null };
      const match = findLiveMatch(matches, players[0], players[1]);
      if (!match) return { status: "not_live", message: "No matching event in the current API-Tennis live feed." };
      return {
        status: "live_match_found",
        players: [match.event_first_player, match.event_second_player],
        score: match.event_game_result || null,
        server: match.event_serve || null,
        eventStatus: match.event_status || null,
        scores: Array.isArray(match.scores) ? match.scores : [],
      };
    } catch (error) {
      const message = String(error?.message || error).slice(0, 160);
      this.state.feed = { ...this.state.feed, status: "error", error: message };
      return { status: "error", message };
    }
  }

  async fetchLiveMatches() {
    if (!this.apiKey) throw new Error("API_TENNIS_KEY is not configured.");
    const url = new URL(API_TENNIS);
    url.searchParams.set("method", "get_livescore");
    url.searchParams.set("APIkey", this.apiKey);
    const response = await this.fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`API-Tennis HTTP ${response.status}`);
    const payload = await response.json();
    if (payload.success !== 1) throw new Error(payload.error || "API-Tennis rejected the request.");
    return Array.isArray(payload.result) ? payload.result : [];
  }

  async searchPolymarketEvent(playerOne, playerTwo) {
    const key = [normalizeName(playerOne), normalizeName(playerTwo)].sort().join(":");
    const cached = this.discoveryCache?.get(key);
    if (cached && Date.now() - cached.at < DISCOVERY_CACHE_MS) return cached.event;
    const surname = (name) => String(name || "").trim().split(/\s+/).filter(Boolean).at(-1) || "";
    const query = `${surname(playerOne)} ${surname(playerTwo)}`.trim();
    const url = new URL(`${GAMMA}/public-search`);
    url.searchParams.set("q", query);
    url.searchParams.set("events_status", "active");
    url.searchParams.set("limit_per_type", "10");
    const response = await this.fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`Polymarket event search HTTP ${response.status}`);
    const payload = await response.json();
    const event = (payload.events || []).find((candidate) => marketForPlayers(candidate, playerOne, playerTwo)) || null;
    this.discoveryCache ||= new Map();
    this.discoveryCache.set(key, { at: Date.now(), event });
    return event;
  }

  async readBook(tokenId) {
    const previousFailure = this.book404Backoff.get(tokenId);
    if (previousFailure && Date.now() < previousFailure.retryAt) {
      const deferred = new Error("Polymarket order book HTTP 404; retry deferred.");
      deferred.code = "CLOB_BOOK_RETRY_DEFERRED";
      deferred.retryAt = previousFailure.retryAt;
      throw deferred;
    }
    const response = await this.fetch(`${CLOB}/book?token_id=${encodeURIComponent(tokenId)}`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) {
      const error = new Error(`Polymarket order book HTTP ${response.status}`);
      if (response.status === 404) {
        const failures = (previousFailure?.failures || 0) + 1;
        const cooldown = Math.min(BOOK_404_MAX_COOLDOWN_MS,
          BOOK_404_BASE_COOLDOWN_MS * 2 ** Math.min(failures - 1, 8));
        const retryAt = Date.now() + cooldown;
        this.book404Backoff.set(tokenId, { failures, retryAt });
        error.code = "CLOB_BOOK_NOT_FOUND";
        error.retryAt = retryAt;
      }
      throw error;
    }
    this.book404Backoff.delete(tokenId);
    const book = await response.json();
    const levels = (items, descending) => (items || [])
      .map((level) => ({ price: Number(level.price), size: Number(level.size) }))
      .filter((level) => level.price > 0 && level.size > 0)
      .sort((a, b) => descending ? b.price - a.price : a.price - b.price);
    const bidDepth = levels(book.bids, true);
    const askDepth = levels(book.asks, false);
    return { bestBid: bidDepth[0] || null, bestAsk: askDepth[0] || null, bidDepth, askDepth };
  }

  async readBooks(tokenIds) {
    const coolingToken = tokenIds.find((tokenId) =>
      Number(this.book404Backoff.get(tokenId)?.retryAt || 0) > Date.now());
    if (coolingToken) {
      const deferred = new Error("Polymarket order book HTTP 404; retry deferred.");
      deferred.code = "CLOB_BOOK_RETRY_DEFERRED";
      deferred.retryAt = this.book404Backoff.get(coolingToken).retryAt;
      throw deferred;
    }
    return Promise.all(tokenIds.map((tokenId) => this.readBook(tokenId)));
  }

  noteBookUnavailable(market, error) {
    if (!["CLOB_BOOK_NOT_FOUND", "CLOB_BOOK_RETRY_DEFERRED"].includes(error?.code)) return false;
    market.bookStatus = "unavailable";
    market.bookError = error.message;
    market.bookRetryAt = error.retryAt || null;
    if (error.code === "CLOB_BOOK_NOT_FOUND") {
      this.log(`${market.title}: ${error.message}; pausing this market's entries and retrying after backoff.`, "error");
    }
    return true;
  }

  clearBookUnavailable(market) {
    delete market.bookStatus;
    delete market.bookError;
    delete market.bookRetryAt;
  }

  async discoverLiveMarkets(matches) {
    this.state.discovery = {
      status: "scanning",
      lastScanAt: Date.now(),
      candidates: matches.length,
      autoArmed: 0,
      lastMessage: null,
    };
    if (!matches.length) {
      this.state.discovery.status = "no_live_matches";
      this.state.discovery.lastMessage = "No live API-Tennis matches to match against Polymarket.";
      return;
    }
    const scanCount = Math.min(20, matches.length);
    const startIndex = this.discoveryCursor % matches.length;
    const scanBatch = [...matches.slice(startIndex), ...matches.slice(0, startIndex)].slice(0, scanCount);
    this.discoveryCursor = (startIndex + scanCount) % matches.length;
    for (const live of scanBatch) {
      const first = String(live.event_first_player || "").trim();
      const second = String(live.event_second_player || "").trim();
      if (!first || !second) continue;
      const existing = this.state.markets.find((market) =>
        (nameMatches(market.player, first) && nameMatches(market.opponent, second)) ||
        (nameMatches(market.player, second) && nameMatches(market.opponent, first)));
      if (existing) {
        if (existing.strategyVersion !== SERVE_POINT_STRATEGY_VERSION) {
          this.migrateServePointMarket(existing);
          this.log(`${existing.title}: switched to serve-point accumulation while live.`);
        }
        continue;
      }
      try {
        const event = await this.searchPolymarketEvent(first, second);
        const mapped = marketForPlayers(event, first, second);
        if (!event || !mapped) continue;
        const slug = String(event.slug || "");
        if (!slug || this.state.markets.some((market) => market.slug === slug)) continue;
        const player = mapped.outcomes[0];
        const item = marketDefaults({
          slug,
          event,
          polyUrl: `https://polymarket.com/event/${slug}`,
          mapped,
          player,
          favoriteAsk: null,
          selectionMode: "automatic_serve_points",
        });
        item.currentServer = live.event_serve || null;
        item.currentScore = live.event_game_result || null;
        item.feedEventKey = String(live.event_key || "");
        this.state.markets.unshift(item);
        this.state.discovery.autoArmed += 1;
        this.log(`Auto-added live match ${item.title}; both players can trigger serve-point paper entries (paper only).`);
      } catch (error) {
        this.state.discovery.lastMessage = String(error?.message || error).slice(0, 160);
      }
    }
    this.state.discovery.status = this.state.discovery.autoArmed ? "matches_armed" : "scanned";
    if (!this.state.discovery.lastMessage) {
      this.state.discovery.lastMessage = this.state.discovery.autoArmed
        ? `${this.state.discovery.autoArmed} live match(es) automatically armed.`
        : "Scanning live matches at any score; both players are eligible whenever they serve.";
    }
  }

  async removeMarket(id) {
    const market = this.state.markets.find((item) => item.id === id);
    if (market && Object.keys(market.positions || {}).length) {
      throw new Error("This match still has an open paper position. Wait for it to close before removing it.");
    }
    this.state.markets = this.state.markets.filter((item) => item.id !== id);
    await this.persist();
  }

  async tick() {
    if (this.busy || !this.apiKey || !this.state.running) return;
    this.busy = true;
    try {
      const matches = await this.fetchLiveMatches();
      this.state.feed = { status: "connected", liveMatches: matches.length, lastUpdate: Date.now(), error: null };
      await this.discoverLiveMarkets(matches);
      await Promise.all(this.state.markets.map(async (market) => {
        try {
          await this.processMarket(market, matches);
        } catch (error) {
          market.error = String(error?.message || error).slice(0, 200);
          this.log(`${market.title}: ${market.error}`, "error");
        }
      }));
      this.state.markets = this.state.markets.filter((market) =>
        !(market.completedAt && !Object.keys(market.positions || {}).length));
      this.state.updatedAt = Date.now();
      await this.persist();
    } catch (error) {
      this.state.feed = { ...this.state.feed, status: "error", error: String(error?.message || error).slice(0, 200) };
      this.log(`Score-feed error: ${this.state.feed.error}`, "error");
    } finally {
      this.busy = false;
    }
  }

  async processMarket(market, matches) {
    const basePlayer = market.player;
    const baseOpponent = market.opponent;
    const match = matches.find((item) => {
      return (nameMatches(item.event_first_player, basePlayer) && nameMatches(item.event_second_player, baseOpponent)) ||
        (nameMatches(item.event_second_player, basePlayer) && nameMatches(item.event_first_player, baseOpponent));
    });
    if (!match) {
      market.scoreStatus = market.currentScore ? "not_live_checking_settlement" : "not_live_or_unmatched";
      if (Object.keys(market.positions || {}).length) {
        const tokenIds = [...new Set(Object.values(market.positions).map((position) => position.tokenId).filter(Boolean))];
        try {
          const books = await this.readBooks(tokenIds);
          market.booksByToken = Object.fromEntries(tokenIds.map((tokenId, index) => [tokenId, books[index]]));
          for (const position of Object.values(market.positions)) {
            position.bestBid = market.booksByToken[position.tokenId]?.bestBid || null;
          }
          market.bestBid = books[0]?.bestBid || null;
          market.bidDepth = books[0]?.bidDepth || [];
          market.lastBookAt = Date.now();
          this.clearBookUnavailable(market);
        } catch (error) {
          if (!this.noteBookUnavailable(market, error)) throw error;
        }
      }
      await this.checkOfficialSettlement(market);
      return;
    }
    const selectedPlayer = market.activePlayer || basePlayer;
    const selectedOpponent = nameMatches(selectedPlayer, basePlayer) ? baseOpponent : basePlayer;
    const selectedIsFirst = nameMatches(match.event_first_player, selectedPlayer);
    market.scoreStatus = "live";
    const pointScore = matchScore(match);
    market.currentPointScore = pointScore ? {
      player: pointScore[selectedIsFirst ? 0 : 1],
      opponent: pointScore[selectedIsFirst ? 1 : 0],
    } : null;
    market.currentScore = pointScore
      ? `${pointScore[selectedIsFirst ? 0 : 1]}–${pointScore[selectedIsFirst ? 1 : 0]}`
      : null;
    if (matchIsComplete(match)) market.completedAt = Date.now();
    market.currentServer = match.event_serve || null;
    market.feedEventKey = String(match.event_key || "");
    const setNumber = Math.max(1, Number(String(match.event_status || "").match(/set\s*(\d+)/i)?.[1] || 1));
    market.currentSet = setNumber;
    const scoreSnapshot = tennisScoreSnapshot(match, selectedIsFirst, setNumber);
    market.setsWon = scoreSnapshot.setsWon;
    market.currentSetGames = scoreSnapshot.currentSetGames;
    market.perSetScore = scoreSnapshot.perSet;
    const setScore = Array.isArray(match.scores) ? match.scores.find((item) => Number(item.score_set) === setNumber) : null;
    const selectedGames = Number(setScore?.[selectedIsFirst ? "score_first" : "score_second"] || 0);
    const opponentGames = Number(setScore?.[selectedIsFirst ? "score_second" : "score_first"] || 0);
    const tokenIds = market.tokenIds?.length ? market.tokenIds : [market.tokenId];
    let books;
    try {
      books = await this.readBooks(tokenIds);
    } catch (error) {
      if (!this.noteBookUnavailable(market, error)) throw error;
      await this.checkOfficialSettlement(market);
      return;
    }
    this.clearBookUnavailable(market);
    market.booksByToken = Object.fromEntries(tokenIds.map((tokenId, index) => [tokenId, books[index]]));
    const selectedBook = market.booksByToken[market.tokenId] || books[0];
    market.bestAsk = selectedBook?.bestAsk || null;
    market.bestBid = selectedBook?.bestBid || null;
    market.bidDepth = selectedBook?.bidDepth || [];
    market.lastBookAt = Date.now();
    const ask = selectedBook?.bestAsk || null;
    const bid = selectedBook?.bestBid || null;
    const firstScanBooks = books;
    for (const position of Object.values(market.positions || {})) {
      const positionBook = market.booksByToken[position.tokenId];
      if (positionBook) position.bestBid = positionBook.bestBid;
    }
    if (matchIsComplete(match)) {
      await this.checkOfficialSettlement(market);
      return;
    }
    market.lastScoreAt = Date.now();
    if (market.strategyVersion === SERVE_POINT_STRATEGY_VERSION) {
      await this.processServePointMarket(market, match, selectedIsFirst, setNumber,
        selectedGames, opponentGames, pointScore);
      return;
    }
    market.lastObservedGames ||= {};
    const currentObservation = {
      playerGames: selectedGames,
      opponentGames,
      serverSelected: match.event_serve === (selectedIsFirst ? "First Player" : "Second Player"),
    };
    const previous = market.lastObservedGames[setNumber];
    market.position = market.positions?.[market.breakCycle?.entrySet] || null;
    if (market.breakCycle?.exitTriggeredAt) {
      const pending = market.breakCycle;
      this.trySweepExit(market, market.positions?.[pending.entrySet], pending.entrySet,
        pending.pendingExitReason, pending.pendingExitShares);
      market.lastObservedGames[setNumber] = currentObservation;
      if (!market.breakCycle || pending.exitTriggeredAt) {
        if (!market.activePlayer && market.selectionMode === "automatic_any_break" &&
            !nameMatches(selectedPlayer, basePlayer)) {
          market.currentPointScore = market.currentPointScore
            ? { player: market.currentPointScore.opponent, opponent: market.currentPointScore.player }
            : null;
          market.currentScore = market.currentPointScore
            ? `${market.currentPointScore.player}–${market.currentPointScore.opponent}`
            : null;
          market.setsWon = market.setsWon
            ? { player: market.setsWon.opponent, opponent: market.setsWon.player }
            : null;
          market.currentSetGames = market.currentSetGames
            ? { player: market.currentSetGames.opponent, opponent: market.currentSetGames.player }
            : null;
          market.perSetScore = (market.perSetScore || []).map((score) => ({
            ...score, playerGames: score.opponentGames, opponentGames: score.playerGames,
          }));
          market.lastObservedGames[setNumber] = {
            playerGames: opponentGames,
            opponentGames: selectedGames,
            serverSelected: !currentObservation.serverSelected,
          };
        }
      }
      return;
    }
    if (!previous || market.strategyVersion !== BREAKBACK_STRATEGY_VERSION ||
        !["automatic_favorite", "automatic_any_break"].includes(market.selectionMode)) {
      market.lastObservedGames[setNumber] = currentObservation;
      return;
    }

    const gamesAdvanced = selectedGames + opponentGames - previous.playerGames - previous.opponentGames;
    const selectedWonGame = selectedGames > previous.playerGames && opponentGames === previous.opponentGames;
    const opponentWonGame = opponentGames > previous.opponentGames && selectedGames === previous.playerGames;
    const gameAdvanced = gamesAdvanced === 1 && (selectedWonGame || opponentWonGame);

    const cycle = market.breakCycle;
    let swapObservation = false;
    if (gameAdvanced && cycle?.stage === "await_player_breakback" && setNumber <= cycle.entrySet + 1 &&
        !previous.serverSelected && selectedWonGame) {
      const position = market.positions?.[cycle.entrySet];
      if (position && bid) {
        cycle.exitTriggeredAt = Date.now();
        cycle.pendingExitShares = position.shares / 2;
        cycle.pendingExitAction = "half";
        cycle.pendingExitReason = `the broken player broke back in set ${setNumber}`;
        this.trySweepExit(market, position, cycle.entrySet, `the broken player broke back in set ${setNumber}`, cycle.pendingExitShares);
      }
    } else if (gameAdvanced && cycle?.stage === "await_position_hold" &&
        setNumber <= cycle.entrySet + 1 && previous.serverSelected && selectedWonGame) {
      const position = market.positions?.[cycle.entrySet];
      if (position && bid) {
        cycle.exitTriggeredAt = Date.now();
        cycle.pendingExitShares = position.shares;
        cycle.pendingExitAction = "remaining";
        cycle.pendingExitReason = `the position player held serve in set ${setNumber}`;
        this.trySweepExit(market, position, cycle.entrySet, cycle.pendingExitReason, cycle.pendingExitShares);
      }
    } else if (gameAdvanced && !cycle && entryGameAllowed(selectedGames, opponentGames)) {
      const anyBreakMode = market.selectionMode === "automatic_any_break";
      const playerWasBroken = anyBreakMode
        ? (previous.serverSelected && opponentWonGame) || (!previous.serverSelected && selectedWonGame)
        : previous.serverSelected && opponentWonGame;
      if (playerWasBroken) {
        const brokenPlayer = anyBreakMode && !previous.serverSelected ? selectedOpponent : selectedPlayer;
        const brokenIndex = (market.outcomes || []).findIndex((name) => nameMatches(name, brokenPlayer));
        const brokenBook = anyBreakMode && brokenIndex >= 0 ? firstScanBooks?.[brokenIndex] : null;
        const entryAsk = brokenBook?.bestAsk || ask;
        if (anyBreakMode && brokenIndex >= 0) {
          market.activePlayer = brokenPlayer;
          market.tokenId = market.tokenIds?.[brokenIndex] || market.tokenId;
          swapObservation = !nameMatches(brokenPlayer, selectedPlayer);
          if (swapObservation) {
            market.currentPointScore = market.currentPointScore
              ? { player: market.currentPointScore.opponent, opponent: market.currentPointScore.player }
              : null;
            market.currentScore = market.currentPointScore
              ? `${market.currentPointScore.player}–${market.currentPointScore.opponent}`
              : null;
            market.setsWon = market.setsWon
              ? { player: market.setsWon.opponent, opponent: market.setsWon.player }
              : null;
            market.currentSetGames = market.currentSetGames
              ? { player: market.currentSetGames.opponent, opponent: market.currentSetGames.player }
              : null;
            market.perSetScore = (market.perSetScore || []).map((score) => ({
              ...score, playerGames: score.opponentGames, opponentGames: score.playerGames,
            }));
          }
        }
        const nextCycle = { entrySet: setNumber, stage: "await_opponent_hold", trancheShares: null };
        market.breakCycle = nextCycle;
        if (this.openBreakTranche(market, entryAsk, nextCycle)) {
          if (brokenBook) {
            market.bestAsk = entryAsk;
            market.bestBid = brokenBook.bestBid;
            market.bidDepth = brokenBook.bestBid ? [brokenBook.bestBid] : [];
          }
          this.log(`${market.title}: ${brokenPlayer} was broken at ${swapObservation ? opponentGames : selectedGames}–${swapObservation ? selectedGames : opponentGames}; bought the first 250-share paper tranche.`);
        } else {
          market.breakCycle = null;
          if (anyBreakMode) {
            market.activePlayer = null;
            market.tokenId = market.baseTokenId || market.tokenIds?.[0] || market.tokenId;
          }
        }
      }
    } else if (gameAdvanced && cycle && cycle.stage === "await_opponent_hold" &&
        !previous.serverSelected && opponentWonGame &&
        setNumber <= cycle.entrySet + 1 && entryGameAllowed(selectedGames, opponentGames)) {
      if (this.openBreakTranche(market, ask, cycle)) {
        cycle.stage = "await_player_breakback";
        this.log(`${market.title}: opponent held serve; added the second paper tranche.`);
      }
    }
    market.lastObservedGames[setNumber] = swapObservation ? {
      playerGames: opponentGames,
      opponentGames: selectedGames,
      serverSelected: !currentObservation.serverSelected,
    } : currentObservation;
    market.position = market.positions?.[market.breakCycle?.entrySet] || null;
  }

  async processServePointMarket(market, match, selectedIsFirst, setNumber,
    selectedGames, opponentGames, pointScore) {
    const serverIsFirst = match.event_serve === "First Player";
    const serverIsSecond = match.event_serve === "Second Player";
    if (!serverIsFirst && !serverIsSecond) {
      market.strategyStatus = "Waiting for API-Tennis server state";
      return;
    }
    const server = serverIsFirst ? match.event_first_player : match.event_second_player;
    const player = nameMatches(server, market.player) ? market.player : market.opponent;
    const tokenIndex = (market.outcomes || []).findIndex((name) => nameMatches(name, player));
    const tokenId = market.tokenIds?.[tokenIndex] || market.tokenId;
    const book = market.booksByToken?.[tokenId];
    const serverPoints = pointScore?.[serverIsFirst ? 0 : 1];
    const returnPoints = pointScore?.[serverIsFirst ? 1 : 0];
    const gameKey = `${setNumber}:${selectedGames}:${opponentGames}:${normalizeName(server)}`;
    let active = market.activeServeGame;
    if (active && active.key !== gameKey) {
      let serverWon = false;
      if (active.setNumber === setNumber) {
        const serverGamesNow = active.serverIsFirst ? selectedGames : opponentGames;
        const serverGamesAtStart = active.serverIsFirst ? active.startSelectedGames : active.startOpponentGames;
        serverWon = serverGamesNow > serverGamesAtStart;
      }
      if (active.position?.shares > 0) {
        if (!serverWon || !this.tryServeGameExit(market, active.position)) {
          this.moveServeGameToAccumulator(market, active);
        }
      }
      active = null;
    }
    if (!active) {
      active = market.activeServeGame = {
        key: gameKey,
        setNumber,
        server,
        serverIsFirst: nameMatches(server, market.player),
        startSelectedGames: selectedGames,
        startOpponentGames: opponentGames,
        position: null,
        boughtAt15: false,
        boughtAt30: false,
      };
    }
    if (active.server !== server) return;
    if (serverPoints === 0 && returnPoints === 15 && !active.boughtAt15) {
      active.boughtAt15 = true;
      this.openServePointShares(market, active, tokenId, book, "0-15");
    } else if (serverPoints === 0 && returnPoints === 30 && !active.boughtAt30) {
      active.boughtAt30 = true;
      this.openServePointShares(market, active, tokenId, book, "0-30");
    }
    for (const [key, position] of Object.entries(market.positions || {})) {
      if (position.kind === "serve_game") continue;
      const positionBook = market.booksByToken?.[position.tokenId];
      const bid = positionBook?.bestBid?.price;
      if (Number.isFinite(bid) && bid >= Number(position.entryPrice) + 0.10) {
        this.tryAccumulatedExit(market, key, position, positionBook);
      }
    }
    market.position = active.position || Object.values(market.positions || {})[0] || null;
    market.strategyStatus = `${server} serving · buys at 0-15 and 0-30`;
  }

  openServePointShares(market, active, tokenId, book, stage) {
    if (!book?.askDepth?.length) {
      this.log(`${market.title}: skipped ${active.server} ${stage} entry; no ask depth is available.`);
      return false;
    }
    let remaining = SERVE_POINT_SHARES;
    let stake = 0;
    for (const level of book.askDepth) {
      const shares = Math.min(remaining, Number(level.size));
      stake += shares * Number(level.price);
      remaining -= shares;
      if (remaining <= 1e-8) break;
    }
    if (remaining > 1e-8) {
      this.log(`${market.title}: skipped ${active.server} ${stage} entry; insufficient visible ask depth for 10 shares.`);
      return false;
    }
    const available = Number(this.state.bankroll?.availableCapital ?? STARTING_CAPITAL);
    if (available < stake) {
      this.log(`${market.title}: skipped ${active.server} ${stage} entry; insufficient demo capital.`);
      return false;
    }
    const entryPrice = stake / SERVE_POINT_SHARES;
    const key = `serve:${active.key}`;
    const position = active.position || {
      kind: "serve_game", player: active.server, tokenId, setNumber: active.setNumber,
      shares: 0, stake: 0, tranches: [], openedAt: Date.now(), bestBid: book.bestBid,
    };
    const tradeId = `${market.id}:serve:${active.key}:${stage}:${Date.now()}`;
    const trade = {
      id: tradeId, marketId: market.id, market: market.title, player: active.server,
      side: active.server, stage, entryPrice, shares: SERVE_POINT_SHARES,
      stake, openedAt: Date.now(), status: "open", pnl: 0, realizedPnl: 0,
      remainingShares: SERVE_POINT_SHARES, setNumber: active.setNumber,
    };
    position.tranches.push({ tradeId, entryPrice, shares: SERVE_POINT_SHARES, stake });
    position.shares += SERVE_POINT_SHARES;
    position.stake += stake;
    position.entryPrice = position.stake / position.shares;
    position.tokenId = tokenId;
    active.position = position;
    market.positions ||= {};
    market.positions[key] = position;
    market.entries = Number(market.entries || 0) + 1;
    this.state.bankroll.availableCapital = available - stake;
    this.state.trades.unshift(trade);
    this.log(`${market.title}: bought ${SERVE_POINT_SHARES} ${active.server} shares at ${stage}, average $${entryPrice.toFixed(3)} for $${stake.toFixed(2)}.`);
    return true;
  }

  tryServeGameExit(market, position) {
    const book = market.booksByToken?.[position.tokenId];
    if (!this.sellPositionFromBook(market, position, book, "serve game won")) return false;
    delete market.positions[`serve:${market.activeServeGame?.key}`];
    if (market.activeServeGame) market.activeServeGame.position = null;
    return true;
  }

  tryAccumulatedExit(market, key, position, book) {
    if (!this.sellPositionFromBook(market, position, book, "accumulated position reached +$0.10")) return false;
    delete market.positions[key];
    return true;
  }

  sellPositionFromBook(market, position, book, reason) {
    if (!position || !book?.bidDepth?.length) return false;
    let remaining = Number(position.shares);
    let proceeds = 0;
    for (const level of book.bidDepth) {
      if (remaining <= 1e-8) break;
      const sold = Math.min(remaining, Number(level.size));
      proceeds += sold * Number(level.price);
      remaining -= sold;
    }
    if (remaining > 1e-8) return false;
    const shares = Number(position.shares);
    const exitPrice = proceeds / shares;
    const pnl = this.realizePositionShares(market, position, shares, exitPrice, reason);
    this.log(`${market.title}: sold ${shares.toFixed(2)} ${position.player} shares at $${exitPrice.toFixed(3)} VWAP; realized P&L $${pnl.toFixed(2)} (${reason}).`);
    return true;
  }

  moveServeGameToAccumulator(market, active) {
    const source = active.position;
    const sourceKey = `serve:${active.key}`;
    if (!source) return;
    const key = `accumulated:${normalizeName(source.player)}`;
    const target = market.positions[key] || {
      kind: "accumulated", player: source.player, tokenId: source.tokenId,
      shares: 0, stake: 0, tranches: [], openedAt: source.openedAt,
    };
    target.shares += source.shares;
    target.stake += source.stake;
    target.entryPrice = target.stake / target.shares;
    target.tranches.push(...source.tranches);
    market.positions[key] = target;
    delete market.positions[sourceKey];
    this.log(`${market.title}: ${source.player}'s ${source.shares.toFixed(2)} shares moved to their accumulated bucket at $${target.entryPrice.toFixed(3)} average.`);
  }

  trySweepExit(market, position, setNumber, reason = "break-back exit", requestedShares = position?.shares) {
    if (!position || !market.bidDepth?.length) return false;
    const bestBid = market.bidDepth[0].price;
    const minPrice = Math.max(0.01, bestBid - 0.99);
    const sellShares = Math.min(Number(position.shares), Number(requestedShares));
    let remaining = sellShares;
    let proceeds = 0;
    for (const level of market.bidDepth) {
      if (level.price < minPrice || remaining <= 1e-8) break;
      const filled = Math.min(remaining, Number(level.size));
      proceeds += filled * level.price;
      remaining -= filled;
    }
    if (remaining > 1e-8) {
      market.exitStatus = `Waiting for enough bid depth to sweep ${remaining.toFixed(2)} remaining shares (0.99 slippage limit).`;
      return false;
    }
    const vwap = proceeds / sellShares;
    const pnl = this.realizePositionShares(market, position, sellShares, vwap, reason);
    market.exitStatus = null;
    const cycle = market.breakCycle;
    if (position.shares <= 1e-8) {
      delete market.positions[setNumber];
      market.breakCycle = null;
      market.position = null;
      if (market.selectionMode === "automatic_any_break") {
        market.activePlayer = null;
        market.tokenId = market.baseTokenId || market.tokenIds?.[0] || market.tokenId;
      }
    } else if (cycle?.pendingExitAction === "half") {
      cycle.stage = "await_position_hold";
      cycle.exitTriggeredAt = null;
      cycle.pendingExitShares = null;
      cycle.pendingExitAction = null;
    }
    this.log(`${market.title}: sold ${sellShares.toFixed(2)} shares at $${vwap.toFixed(3)} VWAP; realized P&L $${pnl.toFixed(2)}.`);
    return true;
  }

  realizePositionShares(market, position, shares, exitPrice, reason) {
    let remaining = shares, costBasis = 0;
    position.tranches ||= [{ tradeId: position.tradeId, shares: position.shares, stake: position.stake }];
    for (const tranche of position.tranches) {
      if (remaining <= 1e-8) break;
      const sold = Math.min(remaining, Number(tranche.shares));
      if (sold <= 0) continue;
      const basis = Number(tranche.stake) * sold / Number(tranche.shares);
      tranche.shares -= sold;
      tranche.stake -= basis;
      remaining -= sold;
      costBasis += basis;
      const trade = this.state.trades.find((item) => item.id === tranche.tradeId);
      if (trade) {
        trade.realizedPnl = Number(trade.realizedPnl || 0) + sold * exitPrice - basis;
        trade.pnl = trade.realizedPnl;
        trade.remainingShares = tranche.shares;
        trade.exitPrice = exitPrice;
        trade.exitHistory ||= [];
        trade.exitHistory.push({ at: Date.now(), shares: sold, price: exitPrice, reason });
        if (tranche.shares <= 1e-8) {
          trade.status = "closed";
          trade.closedAt = Date.now();
        }
      }
    }
    if (remaining > 1e-8 && !position.tranches.length) {
      costBasis = Number(position.stake) * shares / Number(position.shares);
    }
    const proceeds = shares * exitPrice;
    position.shares -= shares;
    position.stake -= costBasis;
    position.entryPrice = position.shares > 1e-8 ? position.stake / position.shares : 0;
    this.state.bankroll.availableCapital = Number(this.state.bankroll?.availableCapital ?? STARTING_CAPITAL) + proceeds;
    return proceeds - costBasis;
  }

  openBreakTranche(market, ask, cycle) {
    if (!ask || ask.price <= 0 || ask.price >= 1 || ask.size <= 0) {
      market.error = "No executable ask depth for break-back paper entry.";
      return false;
    }
    if (cycle.trancheShares == null) {
      cycle.trancheShares = BASE_TRANCHE_SHARES;
    }
    const availableCapital = Number(this.state.bankroll?.availableCapital ?? STARTING_CAPITAL);
    const shares = Math.min(cycle.trancheShares, ask.size, availableCapital / ask.price);
    if (shares <= 0) {
      market.error = "Insufficient demo capital or ask depth for break-back paper entry.";
      return false;
    }
    const stake = shares * ask.price;
    const position = market.positions?.[cycle.entrySet] || {
      openedAt: Date.now(),
      entryPrice: 0,
      shares: 0,
      stake: 0,
      setNumber: cycle.entrySet,
      tradeIds: [],
      tranches: [],
    };
    const tradeId = `${market.id}:breakback:${cycle.entrySet}:${position.tranches.length + 1}:${Date.now()}`;
    const trade = {
      id: tradeId,
      marketId: market.id,
      market: market.title,
      player: market.activePlayer || market.player,
      side: market.activePlayer || market.player,
      entryPrice: ask.price,
      shares,
      stake,
      openedAt: Date.now(),
      status: "open",
      pnl: 0,
      realizedPnl: 0,
      remainingShares: shares,
      setNumber: cycle.entrySet,
    };
    position.tranches.push({ tradeId, entryPrice: ask.price, shares, stake });
    position.tradeIds.push(tradeId);
    position.shares += shares;
    position.stake += stake;
    position.entryPrice = position.stake / position.shares;
    market.positions ||= {};
    market.positions[cycle.entrySet] = position;
    market.position = position;
    this.state.bankroll.availableCapital = Math.max(0, availableCapital - stake);
    market.entries = Number(market.entries || 0) + 1;
    this.state.trades.unshift(trade);
    return true;
  }

  openPaperPosition(market, ask, setNumber, selectedGames) {
    if (!ask || ask.price >= 1 || ask.size <= 0) {
      market.error = "No executable ask depth for paper entry.";
      return;
    }
    const availableCapital = Number(this.state.bankroll?.availableCapital ?? STARTING_CAPITAL);
    const stakeBudget = Math.min(STAKE_USD, availableCapital);
    const shares = Math.min(stakeBudget / ask.price, ask.size);
    if (shares <= 0) return;
    const position = { openedAt: Date.now(), entryPrice: ask.price, shares, stake: shares * ask.price, entryScore: market.currentScore, setNumber, entryGames: selectedGames, tradeId: `${market.id}:${market.entries + 1}` };
    market.positions ||= {};
    market.positions[setNumber] = position;
    market.position = position;
    this.state.bankroll.availableCapital = Math.max(0, availableCapital - position.stake);
    market.entries += 1;
    if (setNumber === 1 && !market.firstSetPosition) market.firstSetPosition = { ...position };
    this.state.trades.unshift({ id: position.tradeId, marketId: market.id, market: market.title, player: market.player, side: market.player, entryPrice: ask.price, shares, stake: position.stake, openedAt: Date.now(), status: "open", pnl: 0, setNumber });
    this.log(`${market.title}: set ${setNumber} paper buy ${shares.toFixed(2)} shares at $${ask.price.toFixed(3)} for $${position.stake.toFixed(2)}.`);
  }

  shouldExitAfterBothEvents(market, match, selectedIsFirst, setNumber) {
    const serverIsSelected = match.event_serve === (selectedIsFirst ? "First Player" : "Second Player");
    const both = matchScore(match);
    const oppIsZeroThirty = !!both && both[selectedIsFirst ? 0 : 1] === 30 && both[selectedIsFirst ? 1 : 0] === 0;
    const score = Array.isArray(match.scores) ? match.scores : [];
    const currentSetScore = score.find((set) => Number(set.score_set) === setNumber);
    const games = Number(currentSetScore?.[selectedIsFirst ? "score_first" : "score_second"] || 0);
    const position = market.positions?.[setNumber];
    const wonGameSinceEntry = position && games > Number(position.entryGames || 0);
    if (!serverIsSelected && wonGameSinceEntry && oppIsZeroThirty) return true;
    market.lastGameCounts ||= {};
    market.lastGameCounts[setNumber] = games;
    return false;
  }

  closePaperPosition(market, bid, reason, setNumber = market.currentSet || 1) {
    const position = market.positions?.[setNumber] || market.position;
    if (!position || !bid) return;
    this.finalizePosition(market, position, bid.price, reason, setNumber);
  }

  finalizePosition(market, position, exitPrice, reason, setNumber) {
    const proceeds = position.shares * exitPrice;
    const pnl = proceeds - position.stake;
    this.state.bankroll.availableCapital = Number(this.state.bankroll?.availableCapital ?? STARTING_CAPITAL) + proceeds;
    const tranches = position.tranches?.length ? position.tranches : [{
      tradeId: position.tradeId,
      shares: position.shares,
      stake: position.stake,
    }];
    for (const tranche of tranches) {
      const trancheProceeds = Number(tranche.shares) * exitPrice;
      const trade = this.state.trades.find((item) => item.id === tranche.tradeId);
      if (trade) Object.assign(trade, {
        status: "closed",
        closedAt: Date.now(),
        exitPrice,
        pnl: Number(trade.realizedPnl || 0) + trancheProceeds - Number(tranche.stake),
        realizedPnl: Number(trade.realizedPnl || 0) + trancheProceeds - Number(tranche.stake),
        remainingShares: 0,
        exitReason: reason,
      });
    }
    market.positions ||= {};
    delete market.positions[setNumber];
    market.position = Object.values(market.positions || {})[0] || null;
    this.log(`${market.title}: paper exit at $${exitPrice.toFixed(3)}, P&L $${pnl.toFixed(2)}.`);
    return proceeds;
  }

  async checkOfficialSettlement(market) {
    if (Date.now() - Number(market.lastOfficialCheckAt || 0) < 30000) return;
    market.lastOfficialCheckAt = Date.now();
    try {
      const response = await this.fetch(`${GAMMA}/events?slug=${encodeURIComponent(market.slug)}`, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) return;
      const event = (await response.json())?.[0];
      const resolvedMarket = (event?.markets || []).find((item) => String(item.id) === market.marketId);
      if (!resolvedMarket || !(resolvedMarket.closed === true || resolvedMarket.closed === "true")) return;
      market.completedAt ||= Date.now();
      if (!Object.keys(market.positions || {}).length) return;
      const outcomes = listValue(resolvedMarket.outcomes).map(String);
      const prices = listValue(resolvedMarket.outcomePrices).map(Number);
      for (const [key, position] of Object.entries(market.positions)) {
        const chosen = outcomes.findIndex((outcome) => nameMatches(outcome, position.player || market.player));
        if (chosen < 0 || !Number.isFinite(prices[chosen])) continue;
        const payout = prices[chosen] >= 0.99 ? 1 : prices[chosen] <= 0.01 ? 0 : null;
        if (payout === null) continue;
        this.finalizePosition(market, position, payout, "official Polymarket outcome", key);
      }
      market.scoreStatus = "officially_resolved";
    } catch (error) {
      market.error = `Settlement check failed: ${String(error?.message || error).slice(0, 120)}`;
    }
  }
}

module.exports = { TennisPaperBot, matchScore, hasZeroThirty, nameMatches, findLiveMatch, mayTradeSet, parseUrl, marketForPlayers, chooseFavorite, classifyFirstScan, tennisScoreSnapshot, entryGameAllowed, matchIsComplete };
