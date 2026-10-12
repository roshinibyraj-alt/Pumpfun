"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { TennisPaperBot, hasZeroThirty, matchScore, nameMatches, findLiveMatch, mayTradeSet, parseUrl } = require("./tennis-bot.js");

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

test("enters only on the selected server's 0-30 while game scores are level", async () => {
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
    setBankrolls: { 1: 500, 2: 500 }, positions: {}, currentSet: 1,
  };
  const score = { event_first_player: "L. Draxl", event_second_player: "O. Jasika", event_serve: "First Player", event_game_result: "0 - 30", event_status: "Set 1", scores: [{ score_set: 1, score_first: 2, score_second: 2 }] };
  await bot.processMarket(market, [score]);
  assert.equal(market.position.entryPrice, 0.5);
  assert.equal(market.position.stake, 500);
  assert.equal(market.position.shares, 1000);

  market.position = null;
  market.positions = {};
  market.setBankrolls[1] = 500;
  market.entries = 0;
  await bot.processMarket(market, [{ ...score, scores: [{ score_set: 1, score_first: 3, score_second: 2 }] }]);
  assert.equal(market.position, null);
  assert.equal(market.entries, 0);
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
