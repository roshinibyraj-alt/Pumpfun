"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

const API_TENNIS = "https://api.api-tennis.com/tennis/";
const GAMMA = "https://gamma-api.polymarket.com";
const CLOB = "https://clob.polymarket.com";
const POLL_MS = 5000;
const STAKE_USD = 500;
const MAX_LOGS = 200;

function parseUrl(value, host) {
  try {
    const url = new URL(String(value));
    const standardHost = url.hostname === host || url.hostname.endsWith(`.${host}`);
    const bet365Australia = host === "bet365.com" &&
      (url.hostname === "bet365.com.au" || url.hostname.endsWith(".bet365.com.au"));
    if (url.protocol !== "https:" || (!standardHost && !bet365Australia)) return null;
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
      markets: [],
      trades: [],
      events: [],
    };
    this.timer = null;
    this.busy = false;
  }

  log(message, level = "info") {
    this.state.events.unshift({ at: Date.now(), level, message });
    this.state.events = this.state.events.slice(0, MAX_LOGS);
    console.info(`[tennis-paper] ${message}`);
  }

  snapshot() {
    return JSON.parse(JSON.stringify(this.state));
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
    const bet365Url = parseUrl(input.bet365Url, "bet365.com");
    const player = String(input.player || "").trim();
    if (!polyUrl || !bet365Url || !player) throw new Error("Enter valid Polymarket and Bet365 URLs and choose the player.");
    if (input.confirmPolymarket !== true || input.confirmBet365 !== true) throw new Error("Confirm both market links before arming the paper strategy.");
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
      id: `${slug}:${Date.now()}`,
      slug,
      title: event.title || event.question || slug,
      polymarketUrl: polyUrl.href,
      bet365Url: bet365Url.href,
      player,
      outcomes: mapped.outcomes,
      opponent: mapped.outcomes[matchingOutcome === 0 ? 1 : 0],
      tokenId: mapped.ids[matchingOutcome],
      marketId: String(mapped.market.id || ""),
      status: "armed",
      scoreStatus: "waiting",
      currentScore: null,
      currentServer: null,
      position: null,
      positions: {},
      entries: 0,
      setBankrolls: { 1: STAKE_USD, 2: STAKE_USD },
      firstSetPosition: null,
      firstSetClosed: false,
      lastGameCounts: {},
      createdAt: Date.now(),
      error: null,
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
        ? { market, outcomes: outcomes.map(String) } : null;
    }).find(Boolean);
    if (!candidate) throw new Error("No two-player match-winner market found; refusing unsafe outcome mapping.");
    return { title: event.title || event.question || slug, players: candidate.outcomes, slug };
  }

  async removeMarket(id) {
    this.state.markets = this.state.markets.filter((item) => item.id !== id);
    await this.persist();
  }

  async tick() {
    if (this.busy || !this.apiKey || !this.state.running) return;
    this.busy = true;
    try {
      const url = new URL(API_TENNIS);
      url.searchParams.set("method", "get_livescore");
      url.searchParams.set("APIkey", this.apiKey);
      const response = await this.fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error(`API-Tennis HTTP ${response.status}`);
      const payload = await response.json();
      if (payload.success !== 1) throw new Error(payload.error || "API-Tennis rejected the request.");
      const matches = Array.isArray(payload.result) ? payload.result : [];
      this.state.feed = { status: "connected", liveMatches: matches.length, lastUpdate: Date.now(), error: null };
      await Promise.all(this.state.markets.map(async (market) => {
        try {
          await this.processMarket(market, matches);
        } catch (error) {
          market.error = String(error?.message || error).slice(0, 200);
          this.log(`${market.title}: ${market.error}`, "error");
        }
      }));
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
    const match = matches.find((item) => {
      return (nameMatches(item.event_first_player, market.player) && nameMatches(item.event_second_player, market.opponent)) ||
        (nameMatches(item.event_second_player, market.player) && nameMatches(item.event_first_player, market.opponent));
    });
    if (!match) {
      market.scoreStatus = market.currentScore ? "not_live_checking_settlement" : "not_live_or_unmatched";
      await this.checkOfficialSettlement(market);
      return;
    }
    const selectedIsFirst = nameMatches(match.event_first_player, market.player);
    market.scoreStatus = "live";
    market.currentScore = match.event_game_result || null;
    market.currentServer = match.event_serve || null;
    market.feedEventKey = String(match.event_key || "");
    const setNumber = Math.max(1, Number(String(match.event_status || "").match(/set\s*(\d+)/i)?.[1] || 1));
    market.currentSet = setNumber;
    const serverMatches = match.event_serve === (selectedIsFirst ? "First Player" : "Second Player");
    const setScore = Array.isArray(match.scores) ? match.scores.find((item) => Number(item.score_set) === setNumber) : null;
    const selectedGames = Number(setScore?.[selectedIsFirst ? "score_first" : "score_second"] || 0);
    const opponentGames = Number(setScore?.[selectedIsFirst ? "score_second" : "score_first"] || 0);
    const firstSet = Array.isArray(match.scores) ? match.scores.find((item) => Number(item.score_set) === 1) : null;
    const firstSetSelected = Number(firstSet?.[selectedIsFirst ? "score_first" : "score_second"] || 0);
    const firstSetOpponent = Number(firstSet?.[selectedIsFirst ? "score_second" : "score_first"] || 0);
    const firstSetLost = setNumber >= 2 && firstSetOpponent > firstSetSelected;
    const canTradeSet = setNumber === 1 || (setNumber === 2 && firstSetLost);
    const entryTrigger = canTradeSet && selectedGames === opponentGames &&
      serverMatches && hasZeroThirty(match, selectedIsFirst);
    const bookResponse = await this.fetch(`${CLOB}/book?token_id=${encodeURIComponent(market.tokenId)}`, { signal: AbortSignal.timeout(5000) });
    if (!bookResponse.ok) throw new Error(`Polymarket order book HTTP ${bookResponse.status}`);
    const book = await bookResponse.json();
    const ask = (book.asks || []).map((level) => ({ price: Number(level.price), size: Number(level.size) }))
      .filter((level) => level.price > 0 && level.size > 0).sort((a, b) => a.price - b.price)[0];
    const bid = (book.bids || []).map((level) => ({ price: Number(level.price), size: Number(level.size) }))
      .filter((level) => level.price > 0 && level.size > 0).sort((a, b) => b.price - a.price)[0];
    market.bestAsk = ask || null;
    market.bestBid = bid || null;
    market.lastScoreAt = Date.now();
    const activePosition = market.positions?.[setNumber] || null;
    if (entryTrigger && !activePosition) this.openPaperPosition(market, ask, setNumber, selectedGames);
    if (activePosition && this.shouldExitAfterBothEvents(market, match, selectedIsFirst, setNumber)) {
      this.closePaperPosition(market, bid, "serve-game-win + opponent 0-30", setNumber);
    }
    const firstPosition = market.positions?.[1];
    if (setNumber >= 2 && firstPosition && selectedGames === opponentGames &&
        bid && bid.price >= firstPosition.entryPrice + 0.15) {
      this.closePaperPosition(market, bid, "second-set comeback; first-set position +$0.15", 1);
      market.firstSetClosed = true;
    }
    market.position = market.positions?.[setNumber] || market.positions?.[1] || null;
  }

  openPaperPosition(market, ask, setNumber, selectedGames) {
    if (!ask || ask.price >= 1 || ask.size <= 0) {
      market.error = "No executable ask depth for paper entry.";
      return;
    }
    const bankroll = Number(market.setBankrolls?.[setNumber] || STAKE_USD);
    const shares = Math.min(bankroll / ask.price, ask.size);
    if (shares <= 0) return;
    const position = { openedAt: Date.now(), entryPrice: ask.price, shares, stake: shares * ask.price, entryScore: market.currentScore, setNumber, entryGames: selectedGames, tradeId: `${market.id}:${market.entries + 1}` };
    market.positions ||= {};
    market.positions[setNumber] = position;
    market.position = position;
    market.setBankrolls[setNumber] = Math.max(0, bankroll - position.stake);
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
    const trade = this.state.trades.find((item) => item.id === position.tradeId);
    if (trade) Object.assign(trade, { status: "closed", closedAt: Date.now(), exitPrice, pnl, exitReason: reason });
    market.positions ||= {};
    delete market.positions[setNumber];
    market.setBankrolls[setNumber] = Math.max(0, market.setBankrolls[setNumber] || 0) + proceeds;
    market.position = market.positions?.[market.currentSet] || market.positions?.[1] || null;
    this.log(`${market.title}: paper exit at $${exitPrice.toFixed(3)}, P&L $${pnl.toFixed(2)}.`);
  }

  async checkOfficialSettlement(market) {
    if (!Object.keys(market.positions || {}).length || Date.now() - Number(market.lastOfficialCheckAt || 0) < 30000) return;
    market.lastOfficialCheckAt = Date.now();
    try {
      const response = await this.fetch(`${GAMMA}/events?slug=${encodeURIComponent(market.slug)}`, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) return;
      const event = (await response.json())?.[0];
      const resolvedMarket = (event?.markets || []).find((item) => String(item.id) === market.marketId);
      if (!resolvedMarket || !(resolvedMarket.closed === true || resolvedMarket.closed === "true")) return;
      const outcomes = listValue(resolvedMarket.outcomes).map(String);
      const prices = listValue(resolvedMarket.outcomePrices).map(Number);
      const chosen = outcomes.findIndex((outcome) => nameMatches(outcome, market.player));
      if (chosen < 0 || !Number.isFinite(prices[chosen])) return;
      const payout = prices[chosen] >= 0.99 ? 1 : prices[chosen] <= 0.01 ? 0 : null;
      if (payout === null) return;
      for (const [setKey, position] of Object.entries(market.positions)) {
        const setNumber = Number(setKey);
        this.finalizePosition(market, position, payout, "official Polymarket outcome", setNumber);
      }
      market.scoreStatus = "officially_resolved";
    } catch (error) {
      market.error = `Settlement check failed: ${String(error?.message || error).slice(0, 120)}`;
    }
  }
}

module.exports = { TennisPaperBot, matchScore, hasZeroThirty, nameMatches, parseUrl };
