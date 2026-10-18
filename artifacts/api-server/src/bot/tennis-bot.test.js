"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { stableMoveSignal } = require("./tennis-bot.js");

test("stable price movement confirms a greater-than-15-cent four-minute decline with a sustained trend", () => {
  const baseline = { at: 0, price: 0.60 };
  const values = [0.58, 0.54, 0.55, 0.44];
  const samples = values.flatMap((price, minute) =>
    Array.from({ length: 30 }, (_, i) => ({ at: minute * 60_000 + i * 2_000, price })));
  assert.ok(stableMoveSignal(samples, baseline, 240_000, "DOWN"));
  assert.equal(stableMoveSignal(samples, baseline, 239_999, "DOWN"), null);
  const exactValues = [0.56, 0.52, 0.49, 0.45];
  const exactThreshold = exactValues.flatMap((price, minute) =>
    Array.from({ length: 30 }, (_, i) => ({ at: minute * 60_000 + i * 2_000, price })));
  assert.equal(stableMoveSignal(exactThreshold, baseline, 240_000, "DOWN"), null);
});

test("stable-price tennis strategy opens one flat 500-share entry and exits on a confirmed rebound", async () => {
  const { TennisPaperBot } = require("./tennis-bot.js");
  const bot = new TennisPaperBot({ file: "/tmp/tennis-stable-move-test.json", fetch: async () => ({ ok: true, json: async () => ({}) }) });
  const market = {
    id: "stable-move", slug: "stable-move", title: "A vs B", outcomes: ["A", "B"],
    tokenIds: ["a", "b"], tokenId: null, positions: {}, entries: 0,
    strategyVersion: "stable-price-move-v1",
  };
  bot.state.markets = [market];
  bot.state.bankroll.availableCapital = 10000;
  const base = Date.now() - 240500;
  const makeSamples = (values) => values.flatMap((price, minute) =>
    Array.from({ length: 30 }, (_, i) => ({ at: base + minute * 60_000 + i * 2_000, price })));
  let books = [
    { bestBid: { price: 0.41, size: 500 }, bestAsk: { price: 0.43, size: 500 }, askDepth: [{ price: 0.43, size: 500 }], bidDepth: [{ price: 0.41, size: 500 }] },
    { bestBid: { price: 0.30, size: 500 }, bestAsk: { price: 0.31, size: 500 }, askDepth: [{ price: 0.31, size: 500 }], bidDepth: [{ price: 0.30, size: 500 }] },
  ];
  bot.readBooks = async () => books;
  market.priceMoveStates = {
    a: { baseline: { at: base, price: 0.60 }, samples: makeSamples([0.58, 0.54, 0.49, 0.42]) },
  };
  await bot.processMarket(market, [{ slug: market.slug, live: true }]);
  assert.equal(market.positions.ladder.shares, 500);
  assert.equal(market.positions.ladder.player, "A");
  assert.equal(bot.state.trades.length, 1);
  assert.equal(bot.state.trades[0].shares, 500);

  const exitBase = Date.now() - 240500;
  market.priceMoveStates.a = {
    baseline: { at: exitBase, price: 0.42 },
    samples: [0.46, 0.50, 0.55, 0.60].flatMap((price, minute) =>
      Array.from({ length: 30 }, (_, i) => ({ at: exitBase + minute * 60_000 + i * 2_000, price }))),
  };
  books = [
    { bestBid: { price: 0.60, size: 500 }, bestAsk: { price: 0.61, size: 500 }, askDepth: [{ price: 0.61, size: 500 }], bidDepth: [{ price: 0.60, size: 500 }] },
    books[1],
  ];
  await bot.processMarket(market, [{ slug: market.slug, live: true }]);
  assert.equal(market.positions.ladder, undefined);
  assert.equal(bot.state.trades[0].status, "closed");
  assert.ok(bot.state.trades[0].pnl > 0);
});
const { TennisPaperBot, hasZeroThirty, matchScore, nameMatches, findLiveMatch, countTrackedLiveMatches, countActiveMarkets, countMarketsWithOpenPositions, scorePollInterval, mayTradeSet, parseUrl, marketForPlayers, chooseFavorite, classifyFirstScan, tennisScoreSnapshot, entryGameAllowed, matchIsComplete } = require("./tennis-bot.js");

test("reads the current point score and recognizes selected player at 0-30", () => {
  const event = { event_game_result: "0 - 30" };
  assert.deepEqual(matchScore(event), [0, 30]);
  assert.equal(hasZeroThirty(event, true), true);
  assert.equal(hasZeroThirty(event, false), false);
});

test("does not trigger on malformed or different point scores", () => {
  assert.equal(matchScore({ event_game_result: "deuce" }), null);
  assert.equal(hasZeroThirty({ event_game_result: "15 - 30" }, true), false);
  assert.equal(hasZeroThirty({ event_game_result: "0 - 30" }, false), false);
});

test("orients set tally and current games around the selected player", () => {
  const score = tennisScoreSnapshot({
    scores: [
      { score_set: "1", score_first: "6", score_second: "4" },
      { score_set: "2", score_first: "2", score_second: "3" },
    ],
  }, false, 2);
  assert.deepEqual(score, {
    setsWon: { player: 0, opponent: 1 },
    currentSetGames: { player: 3, opponent: 2 },
    perSet: [
      { set: 1, playerGames: 4, opponentGames: 6 },
      { set: 2, playerGames: 3, opponentGames: 2 },
    ],
  });
});

test("matches API-Tennis abbreviated player names to market outcome names", () => {
  assert.equal(nameMatches("L. Draxl", "Liam Draxl"), true);
  assert.equal(nameMatches("O. Jasika", "Omar Jasika"), true);
  assert.equal(nameMatches("L. Draxl", "O. Jasika"), false);
});

test("matches API-Tennis live events against both Polymarket participants", () => {
  const event = { event_first_player: "J. Grabher", event_second_player: "Deborah Chiesa" };
  assert.equal(findLiveMatch([event], "Julia Grabher", "Deborah Chiesa"), event);
  assert.equal(findLiveMatch([event], "Deborah Chiesa", "Julia Grabher"), event);
  assert.equal(findLiveMatch([event], "Julia Grabher", "Other Player"), null);
});

test.skip("legacy API-Tennis adaptive polling is replaced by Polymarket polling", async () => {
  const delays = [];
  const liveEvent = { event_first_player: "Julia Grabher", event_second_player: "Deborah Chiesa" };
  const bot = new TennisPaperBot({
    apiKey: "test-key",
    file: "/tmp/tennis-adaptive-poll-test.json",
    setTimeout: (_callback, delay) => {
      delays.push(delay);
      return delays.length;
    },
    clearTimeout: () => {},
  });
  bot.state.running = true;
  bot.schedulerActive = true;
  bot.fetchLiveMatches = async () => [];
  bot.discoverLiveMarkets = async () => {};
  await bot.tick();
  assert.equal(bot.state.feed.pollIntervalMs, 60_000);
  assert.equal(delays.at(-1), 60_000);

  bot.state.markets = [{ player: "Julia Grabher", opponent: "Deborah Chiesa", positions: {} }];
  bot.fetchLiveMatches = async () => [liveEvent];
  await bot.tick();
  assert.equal(countTrackedLiveMatches(bot.state.markets, [liveEvent]), 1);
  assert.equal(scorePollInterval(bot.activeTrackedMatches), 2_000);
  assert.equal(bot.state.feed.pollIntervalMs, 2_000);
  assert.equal(delays.at(-1), 2_000);
  bot.stop();
});

test("allows 20 active matches before blocking another manual match", async () => {
  const bot = new TennisPaperBot({
    file: "/tmp/tennis-twenty-match-limit-test.json",
    fetch: async () => { throw new Error("manual add must be blocked before lookup"); },
  });
  bot.state.markets = Array.from({ length: 20 }, (_, index) => ({
    id: `active-${index}`, player: `Player ${index}`, opponent: `Opponent ${index}`,
    positions: { ladder: { shares: 500 } },
  }));
  assert.equal(countActiveMarkets(bot.state.markets), 20);
  assert.equal(bot.snapshot().limits.maxActiveMatches, 20);
  assert.equal(bot.snapshot().limits.activeMatches, 20);
  await assert.rejects(
    bot.addMarket({ polymarketUrl: "https://polymarket.com/event/twenty-first-match", player: "Player 21", confirmPolymarket: true }),
    /maximum of 20 active matches/,
  );
});

test("collapsed settled results do not block 20 active matches", () => {
  const active = Array.from({ length: 20 }, () => ({ positions: {} }));
  const settled = { completedAt: Date.now(), positions: {} };
  const pending = { completedAt: Date.now(), positions: { 1: { shares: 10 } } };
  assert.equal(countActiveMarkets([settled, ...active]), 20);
  assert.equal(countActiveMarkets([settled, pending, ...active.slice(0, 19)]), 20);
});

test("snapshot avoids exposing undefined labels", () => {
  const bot = new TennisPaperBot({ file: "/tmp/tennis-undefined-label-test.json" });
  bot.state.markets = [{
    id: "missing-labels", slug: "fallback-market", title: "undefined",
    player: "undefined", opponent: "null", currentServer: "undefined", positions: {},
  }];
  const market = bot.snapshot().markets[0];
  assert.equal(market.title, "fallback-market");
  assert.equal(market.player, null);
  assert.equal(market.opponent, null);
  assert.equal(market.currentServer, null);
});

test("marks a position from its own outcome book, not the selected player's quote", () => {
  const bot = new TennisPaperBot({ file: "/tmp/tennis-own-outcome-mark-test.json" });
  const market = {
    id: "kicker-match",
    bestBid: { price: 0.999 },
    booksByToken: {
      "mena-token": { bestBid: null, bestAsk: { price: 0.001 } },
    },
    positions: {
      mena: { tokenId: "mena-token", shares: 20, stake: 3.4, entryPrice: 0.17 },
    },
  };
  bot.state.markets = [market];
  const accounting = bot.marketAccounting(market);
  assert.equal(accounting.positionValue, 0.02);
  assert.ok(Math.abs(accounting.unrealizedPnl - (-3.38)) < 1e-9);
});

test("does not open a 21st match position and resumes when a slot frees", () => {
  const bot = new TennisPaperBot({ file: "/tmp/tennis-position-cap-test.json" });
  const occupied = Array.from({ length: 20 }, (_, index) => ({
    id: `occupied-${index}`, entries: 0, positions: { 1: { shares: 10 } },
  }));
  const candidate = { id: "candidate", title: "Candidate", entries: 0, positions: {} };
  bot.state.markets = [...occupied, candidate];
  assert.equal(countMarketsWithOpenPositions(bot.state.markets), 20);
  bot.openPaperPosition(candidate, { price: 0.5, size: 1000 }, 1, 2);
  assert.equal(candidate.entries, 0);
  assert.equal(candidate.positions[1], undefined);

  const excess = { id: "excess", positions: { 1: { shares: 10 } } };
  bot.state.markets.push(excess);
  bot.openPaperPosition(occupied[0], { price: 0.5, size: 1000 }, 2, 3);
  assert.equal(occupied[0].entries, 0);
  assert.equal(occupied[0].positions[2], undefined);

  bot.state.markets.splice(bot.state.markets.indexOf(excess), 1);
  occupied[0].positions = {};
  bot.openPaperPosition(candidate, { price: 0.5, size: 1000 }, 1, 2);
  assert.equal(candidate.entries, 1);
  assert.ok(candidate.positions[1]);
});

test.skip("legacy API-Tennis authentication handling is no longer used", async () => {
  const bot = new TennisPaperBot({
    apiKey: "test-key",
    file: "/tmp/tennis-api-error-test.json",
    fetch: async () => ({
      ok: true,
      json: async () => ({
        error: "1",
        result: [{ msg: "Wrong login credentials", cod: 1004 }],
      }),
    }),
  });
  await assert.rejects(bot.fetchLiveMatches(), /Wrong login credentials \(API-Tennis code 1004\)/);
});

test.skip("legacy API-Tennis quota handling is no longer used", async () => {
  let requests = 0;
  const bot = new TennisPaperBot({
    apiKey: "test-key",
    file: "/tmp/tennis-api-quota-test.json",
    fetch: async () => {
      requests++;
      return {
        ok: true,
        json: async () => ({
          error: "1",
          result: [{ msg: "Daily API call limit exceeded. Please upgrade your plan.", cod: 1007 }],
        }),
      };
    },
  });
  bot.state.running = true;
  await bot.tick();
  assert.match(bot.state.feed.error, /Daily API call limit exceeded/);
  assert.equal(bot.state.feed.retryAt, bot.apiRetryAt);
  await bot.tick();
  assert.equal(requests, 1);
});

test("maps only the active Polymarket match-winner market with both exact players", () => {
  const event = {
    title: "L. Draxl vs O. Jasika",
    active: true,
    closed: false,
    markets: [
      { question: "Completed Match: L. Draxl vs O. Jasika", outcomes: '["Yes","No"]', clobTokenIds: '["y","n"]' },
      { question: "L. Draxl vs O. Jasika", active: true, closed: false, outcomes: '["Liam Draxl","Omar Jasika"]', clobTokenIds: '["up","down"]' },
    ],
  };
  assert.equal(marketForPlayers(event, "L. Draxl", "O. Jasika").ids[0], "up");
  assert.equal(marketForPlayers(event, "L. Draxl", "Other Player"), null);
  assert.equal(marketForPlayers({ ...event, closed: true }, "L. Draxl", "O. Jasika"), null);
});

test("price target selection requires an ask strictly above 0.55 and chooses the higher ask", () => {
  assert.equal(chooseFavorite([{ bestAsk: { price: 0.55, size: 100 } }]), null);
  assert.equal(chooseFavorite([
    { bestAsk: { price: 0.56, size: 10 } },
    { bestAsk: { price: 0.61, size: 5 } },
  ]).index, 1);
  assert.equal(chooseFavorite([{ bestAsk: { price: 0.75, size: 0 } }]), null);
});

test("first scan targets only a player above the $0.55 price trigger", () => {
  assert.deepEqual(classifyFirstScan([{ bestAsk: { price: 0.73, size: 10 } }]), {
    selectionMode: "clob_price_ladder", index: 0, ask: 0.73,
  });
  assert.equal(classifyFirstScan([{ bestAsk: { price: 0.54, size: 10 } }]), null);
  assert.equal(classifyFirstScan([{ bestAsk: { price: 0.55, size: 10 } }]), null);
});

test("entries include 4-3 and 3-4, but stop beyond either score", () => {
  assert.equal(entryGameAllowed(4, 3), true);
  assert.equal(entryGameAllowed(3, 4), true);
  assert.equal(entryGameAllowed(4, 4), false);
  assert.equal(entryGameAllowed(5, 3), false);
});

test("recognizes completed tennis status without treating live sets as complete", () => {
  assert.equal(matchIsComplete({ event_status: "Finished" }), true);
  assert.equal(matchIsComplete({ event_status: "Retired" }), true);
  assert.equal(matchIsComplete({ event_status: "Set 2" }), false);
});

test("sweeps every share through bid depth using the 0.99 slippage limit", () => {
  const bot = new TennisPaperBot({ apiKey: "test", file: "/tmp/tennis-sweep-test.json" });
  bot.state.bankroll.availableCapital = 9950;
  const trade = { id: "sweep-trade", status: "open", shares: 100, stake: 50 };
  bot.state.trades.push(trade);
  const position = { shares: 100, stake: 50, entryPrice: 0.5, tranches: [{ tradeId: trade.id, shares: 100, stake: 50 }] };
  const market = {
    id: "sweep", positions: { 1: position }, currentSet: 1,
    bidDepth: [{ price: 0.6, size: 50 }, { price: 0.5, size: 50 }],
    breakCycle: { entrySet: 1 },
  };
  assert.equal(bot.trySweepExit(market, position, 1), true);
  assert.equal(trade.exitPrice, 0.55);
  assert.ok(Math.abs(trade.pnl - 5) < 1e-9);
  assert.equal(bot.state.bankroll.availableCapital, 10005);
  assert.equal(market.positions[1], undefined);
});

test("updates open unrealized P&L from the latest CLOB best bid", () => {
  const bot = new TennisPaperBot({ apiKey: "test", file: "/tmp/tennis-mark-test.json" });
  bot.state.bankroll.availableCapital = 9950;
  bot.state.markets = [{
    id: "marked", bestBid: { price: 0.4 },
    booksByToken: { selected: { bestBid: { price: 0.4 } } },
    positions: { 1: { tokenId: "selected", shares: 100, stake: 50, entryPrice: 0.5 } },
  }];
  const state = bot.snapshot();
  assert.equal(state.bankroll.unrealizedPnl, -10);
  assert.equal(state.markets[0].accounting.unrealizedPnl, -10);
});

test("aligns live point score to the selected player and opponent labels", async () => {
  const bot = new TennisPaperBot({
    apiKey: "test",
    file: "/tmp/tennis-score-alignment-test.json",
    fetch: async () => ({ ok: true, json: async () => ({ asks: [{ price: "0.6", size: "20" }], bids: [{ price: "0.5", size: "20" }] }) }),
  });
  const market = { id: "score", player: "Second Player", opponent: "First Player", tokenId: "selected", positions: {} };
  await bot.processMarket(market, [{
    event_first_player: "First Player", event_second_player: "Second Player",
    event_game_result: "15 - 30", event_status: "Set 1", event_serve: "Second Player",
    scores: [{ score_set: 1, score_first: 0, score_second: 0 }],
  }]);
  assert.deepEqual(market.currentPointScore, { player: 30, opponent: 15 });
  assert.equal(market.currentScore, "30–15");
});

test("keeps an exit pending rather than inventing fills when bid depth is short", () => {
  const bot = new TennisPaperBot({ apiKey: "test", file: "/tmp/tennis-partial-sweep-test.json" });
  const position = { shares: 100, stake: 50, entryPrice: 0.5 };
  const market = { positions: { 1: position }, bidDepth: [{ price: 0.6, size: 40 }] };
  assert.equal(bot.trySweepExit(market, position, 1), false);
  assert.equal(market.positions[1], position);
  assert.match(market.exitStatus, /60\.00 remaining/);
});

test("backs off a missing CLOB book per token and suppresses repeated 404 logs", async () => {
  const requests = new Map();
  let missing = true;
  const bot = new TennisPaperBot({
    apiKey: "test",
    file: "/tmp/tennis-book-404-backoff-test.json",
    fetch: async (url) => {
      const token = new URL(String(url)).searchParams.get("token_id");
      requests.set(token, (requests.get(token) || 0) + 1);
      if (token === "missing" && missing) return { ok: false, status: 404 };
      return { ok: true, json: async () => ({ asks: [{ price: "0.5", size: "10" }], bids: [{ price: "0.4", size: "10" }] }) };
    },
  });
  const market = { title: "Unavailable market" };
  for (let i = 0; i < 2; i += 1) {
    try {
      await bot.readBooks(["missing", "other"]);
    } catch (error) {
      assert.equal(bot.noteBookUnavailable(market, error), true);
    }
  }
  assert.equal(requests.get("missing"), 1);
  assert.equal(requests.get("other"), 1);
  assert.equal(bot.state.events.length, 1);

  await bot.readBooks(["healthy"]);
  assert.equal(requests.get("healthy"), 1);

  bot.book404Backoff.set("missing", { failures: 1, retryAt: Date.now() - 1 });
  missing = false;
  await bot.readBooks(["missing"]);
  assert.equal(requests.get("missing"), 2);
  assert.equal(bot.book404Backoff.has("missing"), false);
});

test.skip("legacy score-triggered auto-arming is replaced by the price-ladder strategy", async () => {
  const event = {
    title: "Court event: Julia Grabher vs Deborah Chiesa",
    slug: "wta-grabher-chiesa-live",
    id: "event-1",
    active: true,
    closed: false,
    markets: [{
      id: "winner-market",
      question: "Court event: Julia Grabher vs Deborah Chiesa",
      active: true,
      closed: false,
      outcomes: '["Julia Grabher","Deborah Chiesa"]',
      clobTokenIds: '["grabher-token","chiesa-token"]',
    }],
  };
  const bot = new TennisPaperBot({
    apiKey: "test",
    file: "/tmp/tennis-auto-discovery-test.json",
    fetch: async (url) => {
      const request = String(url);
      if (request.includes("/public-search")) return { ok: true, json: async () => ({ events: [event] }) };
      if (request.includes("grabher-token")) return { ok: true, json: async () => ({ asks: [{ price: "0.78", size: "100" }], bids: [{ price: "0.75", size: "100" }] }) };
      if (request.includes("chiesa-token")) return { ok: true, json: async () => ({ asks: [{ price: "0.34", size: "100" }], bids: [{ price: "0.31", size: "100" }] }) };
      throw new Error(`Unexpected test request: ${request}`);
    },
  });
  const liveMatch = {
    event_first_player: "J. Grabher",
    event_second_player: "D. Chiesa",
    event_game_result: "15 - 30",
    event_serve: "First Player",
    event_key: "live-1",
    event_status: "Set 2",
    scores: [
      { score_set: 1, score_first: 4, score_second: 6 },
      { score_set: 2, score_first: 3, score_second: 2 },
    ],
  };
  await bot.discoverLiveMarkets([liveMatch]);
  assert.equal(bot.state.markets.length, 1);
  assert.equal(bot.state.markets[0].player, "Julia Grabher");
  assert.equal(bot.state.markets[0].opponent, "Deborah Chiesa");
  assert.equal(bot.state.markets[0].selectionMode, "automatic_any_break");
  assert.equal(bot.state.markets[0].favoriteAskAtArm, null);
  assert.equal(bot.state.markets[0].tokenId, "grabher-token");
  assert.equal(bot.state.markets[0].strategyVersion, "breakback-single-entry-v3");
  assert.equal(bot.state.discovery.autoArmed, 1);
  assert.equal(bot.state.mode, "PAPER");
  await bot.processMarket(bot.state.markets[0], [liveMatch]);
  assert.equal(bot.state.markets[0].position, null);
  assert.equal(bot.state.markets[0].activeServeGame ?? null, null);
});

function servePointFixture(bids = { one: "0.60", two: "0.40" }) {
  const bot = new TennisPaperBot({
    apiKey: "test",
    file: "/tmp/tennis-serve-point-test.json",
    fetch: async (url) => {
      const token = new URL(String(url)).searchParams.get("token_id");
      const one = token === "one-token";
      const bid = Number(one ? bids.one : bids.two);
      return { ok: true, json: async () => ({
        asks: [{ price: String(bid + 0.02), size: "1000" }],
        bids: [{ price: String(bid), size: "1000" }],
      }) };
    },
  });
  const market = {
    id: "serve-point", title: "Serve point test", player: "Player One", opponent: "Player Two",
    outcomes: ["Player One", "Player Two"], tokenIds: ["one-token", "two-token"],
    tokenId: "one-token", strategyVersion: "serve-point-accumulator-v1",
    selectionMode: "automatic_serve_points", entries: 0, positions: {},
  };
  const score = (one, two, server, points = "0 - 0") => ({
    event_first_player: "Player One", event_second_player: "Player Two",
    event_serve: server, event_game_result: points, event_status: "Set 1",
    scores: [{ score_set: 1, score_first: one, score_second: two }],
  });
  return { bot, market, score, run: (event) => bot.processMarket(market, [event]) };
}

test("buys 10 shares at server 0-15 and 10 more at 0-30, then exits when that player holds", async () => {
  const { bot, market, score, run } = servePointFixture();
  await run(score(2, 2, "First Player"));
  await run(score(2, 2, "First Player", "0 - 15"));
  await run(score(2, 2, "First Player", "0 - 30"));
  assert.equal(market.activeServeGame.position.shares, 20);
  assert.deepEqual(bot.state.trades.map((trade) => trade.stage), ["0-30", "0-15"]);
  await run(score(3, 2, "Second Player"));
  assert.equal(Object.keys(market.positions).length, 0);
  assert.equal(bot.state.trades.every((trade) => trade.status === "closed"), true);
  assert.ok(Math.abs(bot.state.bankroll.availableCapital - 9999.6) < 1e-8);
});

test("accumulates shares after a lost serve game and exits only at average entry plus $0.10", async () => {
  const fixture = servePointFixture({ one: "0.60", two: "0.40" });
  const { bot, market, score, run } = fixture;
  await run(score(2, 2, "Second Player"));
  await run(score(2, 2, "Second Player", "15 - 0"));
  await run(score(2, 2, "Second Player", "30 - 0"));
  await run(score(3, 2, "First Player"));
  const bucket = market.positions["accumulated:playertwo"];
  assert.equal(bucket.shares, 20);
  assert.ok(Math.abs(bucket.entryPrice - 0.42) < 1e-8);
  assert.equal(bot.state.trades.every((trade) => trade.status === "open"), true);
  fixture.bot.fetch = async () => ({ ok: true, json: async () => ({
    asks: [{ price: "0.65", size: "1000" }],
    bids: [{ price: "0.53", size: "1000" }],
  }) });
  await run(score(3, 2, "First Player", "0 - 15"));
  assert.equal(market.positions["accumulated:playertwo"], undefined);
  assert.equal(bot.state.trades.filter((trade) => trade.status === "closed").length, 2);
});

test("allows same rules in Set 3 with set 2 eligibility unchanged", () => {
  assert.equal(mayTradeSet(1, false), true);
  assert.equal(mayTradeSet(2, false), false);
  assert.equal(mayTradeSet(2, true), true);
  assert.equal(mayTradeSet(3, false), true);
  assert.equal(mayTradeSet(3, true), true);
  assert.equal(mayTradeSet(4, true), false);
});

test("accepts Polymarket URLs and rejects unrelated hosts", () => {
  assert.equal(parseUrl("https://polymarket.com/event/tennis", "polymarket.com")?.hostname, "polymarket.com");
  assert.equal(parseUrl("https://fakepolymarket.com.attacker.example/event/tennis", "polymarket.com"), null);
});

test("paper fill respects visible ask depth and recycles net proceeds after exit", () => {
  const bot = new TennisPaperBot({ apiKey: "test", file: "/tmp/tennis-bot-test.json", fetch: async () => ({ ok: true, json: async () => ({}) }) });
  const market = {
    id: "m1", title: "Test Match", player: "Liam Draxl", entries: 0,
    setBankrolls: { 1: 500 }, positions: {}, currentSet: 1,
  };
  bot.openPaperPosition(market, { price: 0.5, size: 700 }, 1, 0);
  assert.equal(market.position.shares, 700);
  assert.equal(market.position.stake, 350);
  bot.closePaperPosition(market, { price: 0.6 }, "test exit", 1);
  assert.equal(bot.state.trades[0].pnl, 70);
  assert.equal(bot.state.bankroll.availableCapital, 10070);
  assert.equal(market.position, null);
});

test("all match cards draw from one $10,000 bankroll and return proceeds to it", () => {
  const bot = new TennisPaperBot({ apiKey: "test", file: "/tmp/tennis-bot-test.json" });
  const first = { id: "first", title: "First", player: "Player A", entries: 0, positions: {}, setBankrolls: { 1: 500 } };
  const second = { id: "second", title: "Second", player: "Player B", entries: 0, positions: {}, setBankrolls: { 1: 500 } };
  bot.state.markets = [first, second];
  bot.openPaperPosition(first, { price: 0.5, size: 1000 }, 1, 0);
  bot.openPaperPosition(second, { price: 0.4, size: 1000 }, 1, 0);
  assert.equal(bot.state.bankroll.availableCapital, 9100);
  assert.equal(bot.snapshot().bankroll.allocatedCapital, 900);
  bot.closePaperPosition(first, { price: 0.6 }, "test exit", 1);
  const summary = bot.snapshot().bankroll;
  assert.equal(summary.availableCapital, 9700);
  assert.equal(summary.realizedPnl, 100);
  assert.equal(summary.currentCapital, 10100);
  assert.equal(bot.snapshot().markets[0].accounting.totalPnl, 100);
});

test("cannot remove a match while a paper position is open", async () => {
  const bot = new TennisPaperBot({ apiKey: "test", file: "/tmp/tennis-bot-test.json" });
  bot.state.markets = [{ id: "open-market", positions: { 1: { stake: 50 } } }];
  await assert.rejects(bot.removeMarket("open-market"), /open paper position/);
  assert.equal(bot.state.markets.length, 1);
});

test("buys only once after a break, sells half on break-back and the rest after a hold", async () => {
  const bot = new TennisPaperBot({
    apiKey: "test",
    file: "/tmp/tennis-bot-test.json",
    fetch: async () => ({
      ok: true,
      json: async () => ({ asks: [{ price: "0.50", size: "1500" }], bids: [{ price: "0.48", size: "1500" }] }),
    }),
  });
  const market = {
    id: "entry-test", slug: "entry-test", title: "Entry test", player: "Liam Draxl",
    opponent: "Omar Jasika", tokenId: "selected-token", entries: 0,
    strategyVersion: "breakback-single-entry-v3", selectionMode: "automatic_favorite",
    positions: {}, currentSet: 1,
  };
  bot.state.markets.push(market);
  const score = (set, playerGames, opponentGames, server) => ({
    event_first_player: "L. Draxl",
    event_second_player: "O. Jasika",
    event_serve: server,
    event_game_result: "15 - 15",
    event_status: `Set ${set}`,
    scores: [
      { score_set: 1, score_first: set === 1 ? playerGames : 2, score_second: set === 1 ? opponentGames : 6 },
      ...(set === 2 ? [{ score_set: 2, score_first: playerGames, score_second: opponentGames }] : []),
    ],
  });
  const run = async (event) => bot.processMarket(market, [event]);
  await run(score(1, 2, 2, "First Player"));
  assert.equal(market.currentServer, "L. Draxl");
  await run(score(1, 2, 3, "Second Player"));
  assert.equal(market.position.shares, 250);
  assert.equal(market.breakCycle.stage, "await_player_breakback");
  await run(score(1, 2, 4, "First Player"));
  assert.equal(market.position.shares, 250);
  await run(score(1, 2, 4, "Second Player"));
  await run(score(1, 3, 4, "Second Player"));
  assert.equal(market.position.shares, 125);
  assert.equal(market.breakCycle.stage, "await_position_hold");
  assert.equal(bot.state.trades.filter((trade) => trade.status === "closed").length, 0);
  await run(score(1, 3, 4, "First Player"));
  await run(score(1, 4, 4, "First Player"));
  assert.equal(market.positions[1], undefined);
  assert.equal(market.breakCycle, null);
  assert.equal(bot.state.trades.filter((trade) => trade.status === "closed").length, 1);
  assert.equal(bot.snapshot().bankroll.availableCapital, 9995);
  assert.equal(bot.snapshot().bankroll.realizedPnl, -5);
  market.completedAt = Date.now();
  const finalMatch = bot.snapshot().markets.find((item) => item.id === market.id);
  assert.equal(finalMatch.accounting.totalPnl, -5);
  assert.ok(finalMatch.completedAt);
});

test("neutral first-scan mode buys whichever player was broken", async () => {
  const bot = new TennisPaperBot({
    apiKey: "test",
    file: "/tmp/tennis-neutral-break-test.json",
    fetch: async (url) => {
      const request = String(url);
      const playerTwoBook = request.includes("player-two-token");
      return {
        ok: true,
        json: async () => ({
          asks: [{ price: playerTwoBook ? "0.45" : "0.54", size: "1000" }],
          bids: [{ price: playerTwoBook ? "0.43" : "0.52", size: "1000" }],
        }),
      };
    },
  });
  const market = {
    id: "neutral-break", slug: "neutral-break", title: "Neutral break test",
    player: "Player One", opponent: "Player Two",
    outcomes: ["Player One", "Player Two"],
    tokenIds: ["player-one-token", "player-two-token"],
    tokenId: "player-one-token", entries: 0, positions: {}, lastObservedGames: {},
    strategyVersion: "breakback-single-entry-v3", selectionMode: "automatic_any_break",
  };
  const score = (one, two, server) => ({
    event_first_player: "Player One",
    event_second_player: "Player Two",
    event_serve: server,
    event_game_result: "15 - 15",
    event_status: "Set 1",
    scores: [{ score_set: 1, score_first: one, score_second: two }],
  });
  await bot.processMarket(market, [score(2, 2, "Second Player")]);
  await bot.processMarket(market, [score(3, 2, "First Player")]);
  assert.equal(market.activePlayer, "Player Two");
  assert.equal(market.tokenId, "player-two-token");
  assert.equal(market.position.shares, 250);
  assert.equal(bot.state.trades.at(-1).player, "Player Two");
  assert.equal(bot.state.trades.at(-1).entryPrice, 0.45);
  assert.deepEqual(market.lastObservedGames[1], {
    playerGames: 2, opponentGames: 3, serverSelected: false,
  });
});

test("stops opening new positions in a set after either player concedes two breaks", async () => {
  const bot = new TennisPaperBot({
    apiKey: "test",
    file: "/tmp/tennis-break-limit-test.json",
    fetch: async () => ({
      ok: true,
      json: async () => ({ asks: [{ price: "0.50", size: "1500" }], bids: [{ price: "0.48", size: "1500" }] }),
    }),
  });
  const market = {
    id: "break-limit", slug: "break-limit", title: "Break limit test",
    player: "Player One", opponent: "Player Two", tokenId: "selected-token",
    entries: 0, strategyVersion: "breakback-single-entry-v3",
    selectionMode: "automatic_favorite", positions: {},
    breaksConcededBySet: { 1: { player: 1, opponent: 0 } },
  };
  const score = (set, one, two, server) => ({
    event_first_player: "Player One",
    event_second_player: "Player Two",
    event_serve: server,
    event_game_result: "15 - 15",
    event_status: `Set ${set}`,
    scores: [
      { score_set: 1, score_first: set === 1 ? one : 2, score_second: set === 1 ? two : 6 },
      ...(set === 2 ? [{ score_set: 2, score_first: one, score_second: two }] : []),
    ],
  });
  const run = (event) => bot.processMarket(market, [event]);
  await run(score(1, 2, 2, "First Player"));
  await run(score(1, 2, 3, "Second Player"));
  assert.equal(market.breaksConcededBySet[1].player, 2);
  assert.equal(market.position ?? null, null);
  assert.equal(market.breakCycle ?? null, null);

  await run(score(2, 0, 0, "First Player"));
  await run(score(2, 0, 1, "Second Player"));
  assert.equal(market.position.shares, 250);
  assert.equal(market.breaksConcededBySet[2].player, 1);
});

test("keeps fixed 250-share tranches regardless of prior proceeds", () => {
  const bot = new TennisPaperBot({ apiKey: "test", file: "/tmp/tennis-compound-test.json" });
  const market = { id: "compound", title: "Compound match", player: "Player A", positions: {}, entries: 0, compoundBudget: 300 };
  const cycle = { entrySet: 1, stage: "await_opponent_hold", trancheShares: null };
  assert.equal(bot.openBreakTranche(market, { price: 0.5, size: 1000 }, cycle), true);
  assert.equal(cycle.trancheShares, 250);
  assert.equal(market.position.shares, 250);
});

test("does not use official Polymarket resolution when a match ends", async () => {
  let gammaRequests = 0;
  const bot = new TennisPaperBot({
    apiKey: "test",
    file: "/tmp/tennis-no-official-settlement-test.json",
    fetch: async (url) => {
      if (String(url).includes("gamma-api.polymarket.com")) gammaRequests += 1;
      throw new Error("Unexpected network request");
    },
  });
  const position = {
    tokenId: "draxl-token", shares: 100, stake: 50,
    tranches: [{ tradeId: "trade-1", shares: 100, stake: 50 }],
  };
  const market = {
    slug: "test-match", id: "test-match", title: "Test match",
    player: "Liam Draxl", opponent: "Omar Jasika",
    outcomes: ["Liam Draxl", "Omar Jasika"],
    tokenIds: ["draxl-token", "jasika-token"], tokenId: "draxl-token",
    positions: { 1: position }, currentSet: 2,
  };
  const trade = { id: "trade-1", marketId: market.id, player: "Liam Draxl", status: "open", pnl: 0 };
  bot.state.markets = [market];
  bot.state.trades.push(trade);
  bot.readBooks = async () => [
    { bestBid: { price: 0.97 }, bestAsk: { price: 0.98 }, bidDepth: [], askDepth: [] },
    { bestBid: { price: 0.03 }, bestAsk: { price: 0.04 }, bidDepth: [], askDepth: [] },
  ];
  await bot.processMarket(market, [{
    event_first_player: "Liam Draxl", event_second_player: "Omar Jasika",
    event_status: "Finished", event_game_result: null, scores: [],
  }]);
  assert.equal(gammaRequests, 0);
  assert.equal(market.positions[1], position);
  assert.equal(trade.status, "open");
});

test("settles as soon as either outcome best bid reaches $0.98", () => {
  const bot = new TennisPaperBot({ apiKey: "test", file: "/tmp/tennis-terminal-clob-test.json" });
  bot.state.bankroll.availableCapital = 50;
  const market = {
    title: "Kicker vs Mena",
    outcomes: ["N. Kicker", "F. Mena"],
    tokenIds: ["kicker-token", "mena-token"],
    completedAt: null,
    booksByToken: {
      "kicker-token": { bestBid: { price: 0.979 }, bestAsk: null },
      "mena-token": { bestBid: null, bestAsk: { price: 0.001 } },
    },
    positions: {
      kicker: {
        shares: 10, stake: 8.8,
        tranches: [{ tradeId: "kicker-win", shares: 10, stake: 8.8 }],
      },
      mena: {
        player: "F. Mena", tokenId: "mena-token", shares: 20, stake: 3.4,
        tranches: [
          { tradeId: "mena-loss-1", shares: 10, stake: 2 },
          { tradeId: "mena-loss-2", shares: 10, stake: 1.4 },
        ],
      },
    },
  };
  bot.state.trades = [
    { id: "kicker-win", status: "open", stake: 8.8, player: "N. Kicker" },
    { id: "mena-loss-1", status: "open", stake: 2, player: "F. Mena" },
    { id: "mena-loss-2", status: "open", stake: 1.4, player: "F. Mena" },
  ];
  assert.equal(bot.settleFromTerminalClobPrices(market), false);
  assert.equal(Object.keys(market.positions).length, 2);
  market.booksByToken["kicker-token"].bestBid.price = 0.98;
  assert.equal(bot.settleFromTerminalClobPrices(market), true);
  assert.deepEqual(market.positions, {});
  assert.equal(bot.state.trades.find((trade) => trade.id === "kicker-win").exitPrice, 1);
  assert.equal(bot.state.trades.find((trade) => trade.id === "mena-loss-1").exitPrice, 0);
  assert.equal(bot.state.trades.find((trade) => trade.id === "mena-loss-2").exitPrice, 0);
  assert.equal(bot.state.bankroll.availableCapital, 60);
  assert.equal(market.scoreStatus, "resolved_by_terminal_prices");
  assert.equal(market.clobWinnerIndex, 0);
  market.booksByToken["kicker-token"].bestBid.price = 0.90;
  assert.equal(bot.settleFromTerminalClobPrices(market), true);
});

test("terminal CLOB prices settle a match even while its score feed has not ended", async () => {
  const bot = new TennisPaperBot({ apiKey: "test", file: "/tmp/tennis-finished-feed-test.json" });
  bot.state.bankroll.availableCapital = 50;
  const trade = { id: "mena-trade", status: "open", stake: 3.4, player: "F. Mena" };
  const market = {
    id: "kicker-match", title: "Nicolas Kicker vs Facundo Mena",
    player: "Nicolas Kicker", opponent: "Facundo Mena",
    tokenIds: ["kicker-token", "mena-token"], tokenId: "kicker-token",
    positions: {
      "accumulated:fmena": {
        player: "F. Mena", tokenId: "mena-token", shares: 20, stake: 3.4,
        tranches: [{ tradeId: "mena-trade", shares: 20, stake: 3.4 }],
      },
    },
  };
  bot.state.markets = [market];
  bot.state.trades = [trade];
  bot.readBooks = async () => [
    { bestBid: { price: 0.98 }, bestAsk: null, bidDepth: [{ price: 0.98, size: 100 }], askDepth: [] },
    { bestBid: null, bestAsk: { price: 0.001 }, bidDepth: [], askDepth: [{ price: 0.001, size: 100 }] },
  ];
  await bot.processMarket(market, [{
    event_first_player: "Nicolas Kicker", event_second_player: "Facundo Mena",
    event_status: "In Progress", event_game_result: null, scores: [],
  }]);
  assert.equal(market.currentScore, "Winner determined by CLOB price");
  assert.equal(market.scoreStatus, "resolved_by_terminal_prices");
  assert.deepEqual(market.positions, {});
  assert.equal(trade.status, "closed");
  assert.equal(trade.exitPrice, 0);
});

test("a final take-profit sells only when full depth is available at $0.99 or better", () => {
  const bot = new TennisPaperBot({ apiKey: "test", file: "/tmp/tennis-final-tp-test.json" });
  bot.state.bankroll.availableCapital = 95;
  bot.state.trades = [{
    id: "tp-trade", status: "open", pnl: 0, realizedPnl: 0,
    remainingShares: 10,
  }];
  const position = {
    tradeId: "tp-trade", tokenId: "token", player: "Player A",
    shares: 10, stake: 5,
    tranches: [{ tradeId: "tp-trade", shares: 10, stake: 5 }],
  };
  const market = {
    positions: { accumulated: position },
    booksByToken: { token: {
      bestBid: { price: 0.99 },
      bidDepth: [{ price: 0.99, size: 10 }],
    } },
  };
  assert.equal(bot.tryFinalTakeProfitExits(market), 1);
  assert.equal(Object.keys(market.positions).length, 0);
  assert.equal(bot.state.trades[0].status, "closed");
  assert.equal(bot.state.trades[0].exitPrice, 0.99);
  assert.equal(bot.state.bankroll.availableCapital, 104.9);

  const stillOpen = {
    positions: { accumulated: { ...position, shares: 11, stake: 5.5,
      tranches: [{ tradeId: "tp-trade", shares: 11, stake: 5.5 }] } },
    booksByToken: { token: {
      bestBid: { price: 0.99 },
      bidDepth: [{ price: 0.99, size: 10 }],
    } },
  };
  assert.equal(bot.tryFinalTakeProfitExits(stillOpen), 0);
  assert.equal(stillOpen.positions.accumulated.shares, 11);
});

test.skip("legacy API-Tennis quota maintenance is replaced by Polymarket live scanning", async () => {
  const bot = new TennisPaperBot({ apiKey: "test", file: "/tmp/tennis-quota-maintenance-test.json" });
  const tokenPosition = { tokenId: "token", shares: 10, stake: 5 };
  bot.state.running = true;
  bot.schedulerActive = true;
  bot.apiRetryAt = Date.now() + 60_000;
  bot.state.markets = [{ positions: { accumulated: tokenPosition } }];
  bot.persist = async () => {};
  let processedMatches = null;
  let scheduledDelay = null;
  bot.fetchLiveMatches = async () => { throw new Error("must not poll score feed during quota backoff"); };
  bot.processMarket = async (_market, matches) => { processedMatches = matches; };
  bot.scheduleNextTick = (delay) => { scheduledDelay = delay; };
  await bot.tick();
  assert.deepEqual(processedMatches, []);
  assert.equal(scheduledDelay, 5_000);
  bot.stop();
});

test("fills shallow-book serve entries with a clearly marked paper shortfall up to the 1000% ceiling", () => {
  const bot = new TennisPaperBot({ apiKey: "test", file: "/tmp/tennis-shallow-ask-test.json" });
  const market = {
    id: "shallow", title: "Shallow book match", player: "Player A", opponent: "Player B",
    tokenId: "token-a", positions: {}, entries: 0,
  };
  const active = { key: "1:2:2:playera", server: "Player A", setNumber: 1, position: null };
  const book = {
    bestAsk: { price: 0.1, size: 4 },
    askDepth: [{ price: 0.1, size: 4 }, { price: 0.2, size: 3 }],
    bestBid: { price: 0.08, size: 100 },
  };

  assert.equal(bot.openServePointShares(market, active, "token-a", book, "0-15"), true);
  const trade = bot.state.trades[0];
  assert.equal(trade.shares, 10);
  assert.equal(trade.visibleShares, 7);
  assert.equal(trade.simulatedShares, 3);
  assert.equal(trade.simulatedPrice, 1);
  assert.equal(trade.fillModel, "visible_book_plus_simulated_shortfall");
  assert.equal(trade.stake, 4);
  assert.equal(trade.entryPrice, 0.4);
  assert.match(bot.state.events[0].message, /3\.00 shortfall shares paper-filled at \$1\.000/);
});

test("live discovery fetches Polymarket only and keeps only live events", async () => {
  let requested;
  const bot = new TennisPaperBot({
    file: "/tmp/tennis-polymarket-discovery-test.json",
    fetch: async (url) => {
      requested = new URL(String(url));
      return { ok: true, json: async () => ({ events: [
        { slug: "live-match", live: true, active: true },
        { slug: "upcoming-match", live: false, active: true },
      ] }) };
    },
  });
  const events = await bot.fetchLivePolymarketEvents();
  assert.equal(requested.hostname, "gamma-api.polymarket.com");
  assert.equal(requested.searchParams.get("q"), "tennis");
  assert.deepEqual(events.map((event) => event.slug), ["live-match"]);
});

test("price ladder buys 500 shares at entry and at each of three 5-cent pullbacks", async () => {
  let ask = 0.66;
  const bot = new TennisPaperBot({
    file: "/tmp/tennis-price-ladder-adds-test.json",
    fetch: async (url) => {
      const token = new URL(String(url)).searchParams.get("token_id");
      const p = token === "a" ? ask : 0.34;
      return { ok: true, json: async () => ({
        asks: [{ price: p.toFixed(2), size: "500" }],
        bids: [{ price: (p - 0.01).toFixed(2), size: "2500" }],
      }) };
    },
  });
  const market = {
    id: "ladder", slug: "ladder", title: "A vs B", player: "A", opponent: "B",
    outcomes: ["A", "B"], tokenIds: ["a", "b"], tokenId: null,
    strategyVersion: "clob-price-ladder-v1", positions: {}, entries: 0,
  };
  bot.state.markets = [market];
  const event = { slug: "ladder", live: true };
  for (const [price, expected] of [[0.66, 1], [0.61, 2], [0.56, 3], [0.51, 4]]) {
    ask = price;
    await bot.processPriceLadderMarket(market, [event]);
    assert.equal(market.positions.ladder.ladderBuys, expected);
    assert.equal(market.positions.ladder.shares, expected * 500);
  }
  assert.equal(bot.state.trades.length, 4);
  assert.equal(bot.state.trades.every((trade) => trade.shares === 500), true);
});

test("profit exit sells all shares and uses sale price minus five cents as the next entry pivot", async () => {
  let ask = 0.66;
  let bid = 0.65;
  let bidSize = 500;
  const bot = new TennisPaperBot({
    file: "/tmp/tennis-price-ladder-pivot-test.json",
    fetch: async (url) => {
      const token = new URL(String(url)).searchParams.get("token_id");
      const a = token === "a" ? ask : 0.34;
      const b = token === "a" ? bid : 0.33;
      return { ok: true, json: async () => ({
        asks: [{ price: a.toFixed(2), size: "500" }],
        bids: [{ price: b.toFixed(2), size: String(bidSize) }],
      }) };
    },
  });
  const market = {
    id: "pivot", slug: "pivot", title: "A vs B", player: "A", opponent: "B",
    outcomes: ["A", "B"], tokenIds: ["a", "b"], tokenId: null,
    strategyVersion: "clob-price-ladder-v1", positions: {}, entries: 0,
  };
  bot.state.markets = [market];
  const event = { slug: "pivot", live: true };
  await bot.processPriceLadderMarket(market, [event]);
  ask = 0.77; bid = 0.76; bidSize = 500;
  await bot.processPriceLadderMarket(market, [event]);
  assert.equal(market.positions.ladder, undefined);
  assert.equal(market.pivotPrice, 0.76);
  assert.equal(bot.state.trades[0].status, "closed");
  ask = 0.71; bid = 0.70;
  await bot.processPriceLadderMarket(market, [event]);
  assert.equal(market.positions.ladder.shares, 500);
});

test("a target bid at 45 cents closes the old side and switches to the player above 55 cents", async () => {
  const books = {
    a: { asks: [{ price: "0.46", size: "500" }], bids: [{ price: "0.45", size: "500" }] },
    b: { asks: [{ price: "0.60", size: "500" }], bids: [{ price: "0.59", size: "500" }] },
  };
  const bot = new TennisPaperBot({
    file: "/tmp/tennis-price-ladder-switch-test.json",
    fetch: async (url) => ({ ok: true, json: async () => books[new URL(String(url)).searchParams.get("token_id")] }),
  });
  const market = {
    id: "switch", slug: "switch", title: "A vs B", player: "A", opponent: "B",
    outcomes: ["A", "B"], tokenIds: ["a", "b"], tokenId: null,
    strategyVersion: "clob-price-ladder-v1", positions: {}, entries: 0,
  };
  bot.state.markets = [market];
  market.activePlayer = "A";
  market.tokenId = "a";
  bot.openPriceLadderBuy(market, { askDepth: [{ price: 0.60, size: 500 }] }, "test");
  books.a = { asks: [{ price: "0.46", size: "500" }], bids: [{ price: "0.45", size: "500" }] };
  await bot.processPriceLadderMarket(market, [{ slug: "switch", live: true }]);
  assert.equal(market.activePlayer, "B");
  assert.equal(market.tokenId, "b");
  assert.equal(market.positions.ladder.player, "B");
  assert.equal(bot.state.trades.find((trade) => trade.player === "A").status, "closed");
});
