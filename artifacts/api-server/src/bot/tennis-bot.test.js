"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { TennisPaperBot, hasZeroThirty, matchScore, nameMatches, findLiveMatch, mayTradeSet, parseUrl, marketForPlayers, chooseFavorite, tennisScoreSnapshot, openingGame, entryGameAllowed } = require("./tennis-bot.js");

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

test("favorite selection requires an ask strictly above 0.60 and chooses the higher ask", () => {
  assert.equal(chooseFavorite([{ bestAsk: { price: 0.6, size: 100 } }]), null);
  assert.equal(chooseFavorite([
    { bestAsk: { price: 0.62, size: 10 } },
    { bestAsk: { price: 0.81, size: 5 } },
  ]).index, 1);
  assert.equal(chooseFavorite([{ bestAsk: { price: 0.75, size: 0 } }]), null);
});

test("only auto-selects favorites while the opening game is still at 0-0", () => {
  const opening = { event_status: "Set 1", scores: [{ score_set: 1, score_first: 0, score_second: 0 }] };
  assert.equal(openingGame(opening), true);
  assert.equal(openingGame({ ...opening, scores: [{ score_set: 1, score_first: 1, score_second: 0 }] }), false);
  assert.equal(openingGame({ ...opening, event_status: "Set 2" }), false);
  assert.equal(openingGame({ event_status: "Set 1", scores: [] }), false);
});

test("entries include 4-3 and 3-4, but stop beyond either score", () => {
  assert.equal(entryGameAllowed(4, 3), true);
  assert.equal(entryGameAllowed(3, 4), true);
  assert.equal(entryGameAllowed(4, 4), false);
  assert.equal(entryGameAllowed(5, 3), false);
});

test("auto-arms a live match for the Polymarket favorite above the ask threshold", async () => {
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
      if (request.includes("grabher-token")) return { ok: true, json: async () => ({ asks: [{ price: "0.68", size: "100" }], bids: [{ price: "0.65", size: "100" }] }) };
      if (request.includes("chiesa-token")) return { ok: true, json: async () => ({ asks: [{ price: "0.34", size: "100" }], bids: [{ price: "0.31", size: "100" }] }) };
      throw new Error(`Unexpected test request: ${request}`);
    },
  });
  await bot.discoverLiveMarkets([{
    event_first_player: "J. Grabher",
    event_second_player: "D. Chiesa",
    event_game_result: "0 - 0",
    event_serve: "First Player",
    event_key: "live-1",
    event_status: "Set 1",
    scores: [{ score_set: 1, score_first: 0, score_second: 0 }],
  }]);
  assert.equal(bot.state.markets.length, 1);
  assert.equal(bot.state.markets[0].player, "Julia Grabher");
  assert.equal(bot.state.markets[0].opponent, "Deborah Chiesa");
  assert.equal(bot.state.markets[0].selectionMode, "automatic_favorite");
  assert.equal(bot.state.markets[0].favoriteAskAtArm, 0.68);
  assert.equal(bot.state.markets[0].tokenId, "grabher-token");
  assert.equal(bot.state.markets[0].strategyVersion, "breakback-compound-v1");
  assert.equal(bot.state.discovery.autoArmed, 1);
  assert.equal(bot.state.mode, "PAPER");
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

test("buys on favorite break, adds on opponent hold, and sells after break-back next set", async () => {
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
    strategyVersion: "breakback-compound-v1", selectionMode: "automatic_favorite",
    positions: {}, currentSet: 1,
  };
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
  await run(score(1, 2, 3, "Second Player"));
  assert.equal(market.position.shares, 250);
  assert.equal(market.breakCycle.stage, "await_opponent_hold");
  await run(score(1, 2, 4, "First Player"));
  assert.equal(market.position.shares, 500);
  assert.equal(market.breakCycle.stage, "await_favorite_breakback");
  await run(score(1, 3, 4, "Second Player"));
  assert.equal(market.position.shares, 500);
  await run(score(2, 0, 0, "First Player"));
  await run(score(2, 1, 0, "Second Player"));
  await run(score(2, 2, 0, "First Player"));
  assert.equal(market.positions[1], undefined);
  assert.equal(market.breakCycle, null);
  assert.equal(bot.state.trades.filter((trade) => trade.status === "closed").length, 2);
  assert.equal(bot.snapshot().bankroll.availableCapital, 9990);
  assert.equal(bot.snapshot().bankroll.realizedPnl, -10);
  assert.equal(market.compoundBudget, 240);
});

test("compounds prior exit proceeds into larger equal tranches", () => {
  const bot = new TennisPaperBot({ apiKey: "test", file: "/tmp/tennis-compound-test.json" });
  const market = { id: "compound", title: "Compound match", player: "Player A", positions: {}, entries: 0, compoundBudget: 300 };
  const cycle = { entrySet: 1, stage: "await_opponent_hold", trancheShares: null };
  assert.equal(bot.openBreakTranche(market, { price: 0.5, size: 1000 }, cycle), true);
  assert.equal(cycle.trancheShares, 300);
  assert.equal(market.position.shares, 300);
  assert.equal(market.compoundBudget, null);
});

test("waits for official Polymarket resolution before finalizing an open position", async () => {
  const bot = new TennisPaperBot({
    apiKey: "test",
    file: "/tmp/tennis-bot-test.json",
    fetch: async () => ({
      ok: true,
      json: async () => [{ markets: [{ id: "winner-market", closed: true, outcomes: ["Liam Draxl", "Omar Jasika"], outcomePrices: ["1", "0"] }] }],
    }),
  });
  const position = { tradeId: "trade-1", shares: 100, stake: 50 };
  const market = {
    slug: "test-match", marketId: "winner-market", title: "Test match", player: "Liam Draxl",
    positions: { 1: position }, setBankrolls: { 1: 0 }, currentSet: 2,
  };
  bot.state.trades.push({ id: "trade-1", status: "open", pnl: 0 });
  await bot.checkOfficialSettlement(market);
  assert.equal(market.positions[1], undefined);
  assert.equal(bot.state.trades[0].status, "closed");
  assert.equal(bot.state.trades[0].exitPrice, 1);
  assert.equal(bot.state.trades[0].pnl, 50);
});
