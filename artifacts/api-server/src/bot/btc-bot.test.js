const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const config = require("./btc/config.js");
const Bot = require("./btc/wick-bot.js");
const { takeProfitHit } = Bot._test;

function makeBot() {
  const start = 1_800_000;
  const bot = new Bot({
    timeframe: "5m",
    windowMs: config.WINDOW_MS_5M,
    priceFeed: {
      getTicks: () => [],
      getMinuteCandles: () => [],
      getHistoricalCandles: () => [],
      snapshot: () => ({ status: "test" }),
      start() {},
      stop() {},
    },
  });
  bot.market = {
    id: "market",
    slug: "btc-updown-5m-test",
    title: "BTC up or down",
    start,
    tokens: { UP: "up-token", DOWN: "down-token" },
    feesEnabled: false,
  };
  bot.openStrategyWindow(start, start);
  return { bot, start };
}

test("bot keeps its live quote refresh loop", () => {
  const { bot } = makeBot();
  assert.equal(typeof bot.refreshLiveQuotes, "function");
});

function quote(bot, side, ask, bid, at) {
  bot.liveQuotes[side] = {
    status: "LIVE",
    bestAsk: ask,
    askSize: 500,
    bestBid: bid,
    bidSize: 500,
    mid: (ask + bid) / 2,
    updatedAt: at,
  };
}

function observe(bot, start, at, { upAsk, downAsk, upBid, downBid } = {}) {
  if (upAsk != null) quote(bot, "UP", upAsk, upBid ?? upAsk - 0.01, at);
  if (downAsk != null) quote(bot, "DOWN", downAsk, downBid ?? downAsk - 0.01, at);
  bot.processClimbEntries(start, at);
}

test("config defines seven ascending 100-share rungs and an 85-cent take profit", () => {
  assert.deepEqual(config.CLIMB_RUNGS, [0.15, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75]);
  assert.equal(config.CLIMB_SHARES, 100);
  assert.equal(config.TAKE_PROFIT_PRICE, 0.85);
});

test("first rung buys on either upward or downward crossing of 15 cents", () => {
  const { bot, start } = makeBot();
  observe(bot, start, start + 1, { upAsk: 0.14, downAsk: 0.16 });
  assert.equal(bot.positions.length, 0);
  observe(bot, start, start + 2, { upAsk: 0.15, downAsk: 0.15 });
  assert.equal(bot.positions.length, 2);
  assert.deepEqual(bot.positions.map(position => position.side).sort(), ["DOWN", "UP"]);
  assert.ok(bot.positions.every(position => position.shares === 100 && position.rungPrice === 0.15));
});

test("higher rungs trigger only on upward crossings and do not duplicate", () => {
  const { bot, start } = makeBot();
  observe(bot, start, start + 1, { upAsk: 0.14 });
  observe(bot, start, start + 2, { upAsk: 0.15 });
  observe(bot, start, start + 3, { upAsk: 0.24 });
  assert.equal(bot.positions.length, 1);
  observe(bot, start, start + 4, { upAsk: 0.25 });
  observe(bot, start, start + 5, { upAsk: 0.26 });
  assert.equal(bot.positions.length, 2);
  assert.deepEqual(bot.positions.map(position => position.rungPrice), [0.25, 0.15]);
});

test("higher rungs wait until the 15-cent pivot has triggered", () => {
  const { bot, start } = makeBot();
  observe(bot, start, start + 1, { upAsk: 0.24 });
  observe(bot, start, start + 2, { upAsk: 0.25 });
  assert.equal(bot.positions.length, 0);
  observe(bot, start, start + 3, { upAsk: 0.14 });
  observe(bot, start, start + 4, { upAsk: 0.25 });
  assert.deepEqual(bot.positions.map(position => position.rungPrice), [0.25, 0.15]);
});

test("a price gap fills each crossed rung once at the observed ask", () => {
  const { bot, start } = makeBot();
  observe(bot, start, start + 1, { upAsk: 0.14 });
  observe(bot, start, start + 2, { upAsk: 0.46 });
  assert.deepEqual(bot.positions.map(position => position.rungPrice), [0.45, 0.35, 0.25, 0.15]);
  assert.ok(bot.positions.every(position => position.avgEntry === 0.46 && position.shares === 100));
  assert.equal(bot.cash, 10000 - 4 * 46);
});

test("rung triggers require fresh quotes and stay isolated by side", () => {
  const { bot, start } = makeBot();
  observe(bot, start, start + 1, { upAsk: 0.14 });
  quote(bot, "UP", 0.15, 0.14, start - 10_000);
  bot.processClimbEntries(start, start + 2);
  assert.equal(bot.positions.length, 0);
  observe(bot, start, start + 3, { downAsk: 0.14 });
  observe(bot, start, start + 4, { downAsk: 0.15 });
  assert.equal(bot.positions.length, 1);
  assert.equal(bot.positions[0].side, "DOWN");
});

test("85-cent take profit closes one position without clearing the other", () => {
  const { bot, start } = makeBot();
  const winner = {
    id: "winner", status: "OPEN", side: "UP", shares: 100, totalCost: 45,
    windowStart: start, entryType: "CLIMB_RUNG", openedAt: start,
  };
  const other = {
    id: "other", status: "OPEN", side: "DOWN", shares: 100, totalCost: 20,
    windowStart: start, entryType: "CLIMB_RUNG", openedAt: start,
  };
  bot.positions = [winner, other];
  assert.equal(takeProfitHit({ bestBid: 0.85, updatedAt: start + 100 }, start + 100), true);
  assert.equal(takeProfitHit({ bestBid: 0.84, updatedAt: start + 100 }, start + 100), false);
  assert.equal(takeProfitHit({ bestBid: 0.90, updatedAt: start - 6000 }, start + 100), false);
  bot.finalizePosition(winner, true, "TAKE_PROFIT_BID", 0.86);
  assert.equal(winner.status, "SETTLED_EXIT");
  assert.equal(winner.proceeds, 86);
  assert.equal(winner.realizedPnl, 41);
  assert.equal(other.status, "OPEN");
});

test("API snapshot exposes both active ladders and 85-cent exit settings", () => {
  const { bot, start } = makeBot();
  observe(bot, start, start + 1, { upAsk: 0.14, downAsk: 0.84 });
  observe(bot, start, start + 2, { upAsk: 0.15, downAsk: 0.15 });
  const snapshot = bot.snapshot();
  assert.equal(snapshot.strategy.entries.sideIndependent, true);
  assert.deepEqual(snapshot.strategy.entries.rungs.map(rung => rung.price), config.CLIMB_RUNGS);
  assert.equal(snapshot.strategy.entries.sharesPerRung, 100);
  assert.equal(snapshot.strategy.entries.takeProfitPrice, 0.85);
  assert.deepEqual(snapshot.strategy.entries.sideLadders.UP.triggeredRungs, [0.15]);
  assert.deepEqual(snapshot.strategy.entries.sideLadders.DOWN.triggeredRungs, [0.15]);
});

test("dashboard presents colorful side ladders and current strategy settings", () => {
  const html = fs.readFileSync(path.join(__dirname, "../../public/btc.html"), "utf8");
  assert.match(html, /BTC CLIMB/);
  assert.match(html, /PAPER ONLY · NO LIVE ORDERS/);
  assert.match(html, /15¢/);
  assert.match(html, /Take profit: 85¢/);
  assert.match(html, /linear-gradient/);
  assert.match(html, /refresh\(\);setInterval\(refresh,1000\)/);
});
