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

test("config defines five ascending 100-share rungs and a 75-cent take profit", () => {
  assert.deepEqual(config.CLIMB_RUNGS, [0.25, 0.35, 0.45, 0.55, 0.65]);
  assert.equal(config.CLIMB_SHARES, 100);
  assert.equal(config.TAKE_PROFIT_PRICE, 0.75);
  assert.equal(config.OPPOSITE_TAKE_PROFIT_PRICE, 0.99);
});

test("first rung buys on either upward or downward crossing of 25 cents", () => {
  const { bot, start } = makeBot();
  observe(bot, start, start + 1, { upAsk: 0.24, downAsk: 0.26 });
  assert.equal(bot.positions.length, 0);
  observe(bot, start, start + 2, { upAsk: 0.25, downAsk: 0.25 });
  assert.equal(bot.positions.length, 2);
  assert.deepEqual(bot.positions.map(position => position.side).sort(), ["DOWN", "UP"]);
  assert.ok(bot.positions.every(position => position.shares === 100 && position.rungPrice === 0.25));
});

test("higher rungs trigger only on upward crossings after the pivot", () => {
  const { bot, start } = makeBot();
  observe(bot, start, start + 1, { upAsk: 0.24 });
  observe(bot, start, start + 2, { upAsk: 0.25 });
  assert.equal(bot.positions.length, 1);
  observe(bot, start, start + 3, { upAsk: 0.34 });
  observe(bot, start, start + 4, { upAsk: 0.35 });
  assert.equal(bot.positions.length, 2);
  assert.deepEqual(bot.positions.map(position => position.rungPrice), [0.35, 0.25]);
});

test("higher rungs wait until the 25-cent pivot has triggered", () => {
  const { bot, start } = makeBot();
  observe(bot, start, start + 1, { upAsk: 0.34 });
  observe(bot, start, start + 2, { upAsk: 0.35 });
  assert.equal(bot.positions.length, 0);
  observe(bot, start, start + 3, { upAsk: 0.24 });
  observe(bot, start, start + 4, { upAsk: 0.35 });
  assert.deepEqual(bot.positions.map(position => position.rungPrice), [0.35, 0.25]);
});

test("a price gap fills each crossed rung once at the observed ask", () => {
  const { bot, start } = makeBot();
  observe(bot, start, start + 1, { upAsk: 0.24 });
  observe(bot, start, start + 2, { upAsk: 0.56 });
  assert.deepEqual(bot.positions.map(position => position.rungPrice), [0.55, 0.45, 0.35, 0.25]);
  assert.ok(bot.positions.every(position => position.avgEntry === 0.56 && position.shares === 100));
  assert.equal(bot.cash, 10000 - 4 * 56);
});

test("rung triggers require fresh quotes and stay isolated by side", () => {
  const { bot, start } = makeBot();
  observe(bot, start, start + 1, { upAsk: 0.24 });
  quote(bot, "UP", 0.25, 0.24, start - 10_000);
  bot.processClimbEntries(start, start + 2);
  assert.equal(bot.positions.length, 0);
  observe(bot, start, start + 3, { downAsk: 0.24 });
  observe(bot, start, start + 4, { downAsk: 0.25 });
  assert.equal(bot.positions.length, 1);
  assert.equal(bot.positions[0].side, "DOWN");
});

test("75-cent take profit closes one position without clearing the other", () => {
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
  assert.equal(takeProfitHit({ bestBid: 0.75, updatedAt: start + 100 }, start + 100), true);
  assert.equal(takeProfitHit({ bestBid: 0.74, updatedAt: start + 100 }, start + 100), false);
  assert.equal(takeProfitHit({ bestBid: 0.90, updatedAt: start - 6000 }, start + 100), false);
  bot.finalizePosition(winner, true, "TAKE_PROFIT_BID_0.75", 0.76);
  assert.equal(winner.status, "SETTLED_EXIT");
  assert.equal(winner.proceeds, 76);
  assert.equal(winner.realizedPnl, 31);
  assert.equal(other.status, "OPEN");
});

test("a 75-cent TP raises only the opposite side target to 99 cents", () => {
  const { bot, start } = makeBot();
  const up = { id: "up", status: "OPEN", side: "UP", shares: 100, totalCost: 50, windowStart: start };
  const down = { id: "down", status: "OPEN", side: "DOWN", shares: 100, totalCost: 50, windowStart: start };
  bot.positions = [up, down];
  quote(bot, "UP", 0.8, 0.75, start + 100);
  quote(bot, "DOWN", 0.8, 0.74, start + 100);
  bot.processTakeProfitExits(start + 100);
  assert.equal(up.status, "SETTLED_EXIT");
  assert.equal(down.status, "OPEN");
  assert.equal(bot.getTakeProfitTarget("DOWN"), 0.99);
  quote(bot, "DOWN", 0.99, 0.99, start + 200);
  bot.processTakeProfitExits(start + 200);
  assert.equal(down.status, "SETTLED_EXIT");
});

test("API snapshot exposes both active ladders and adaptive take profit settings", () => {
  const { bot, start } = makeBot();
  observe(bot, start, start + 1, { upAsk: 0.24, downAsk: 0.84 });
  observe(bot, start, start + 2, { upAsk: 0.25, downAsk: 0.25 });
  const snapshot = bot.snapshot();
  assert.equal(snapshot.strategy.entries.sideIndependent, true);
  assert.deepEqual(snapshot.strategy.entries.rungs.map(rung => rung.price), config.CLIMB_RUNGS);
  assert.equal(snapshot.strategy.entries.sharesPerRung, 100);
  assert.equal(snapshot.strategy.entries.takeProfitPrice, 0.75);
  assert.deepEqual(snapshot.strategy.entries.sideLadders.UP.triggeredRungs, [0.25]);
  assert.deepEqual(snapshot.strategy.entries.sideLadders.DOWN.triggeredRungs, [0.25]);
});

test("dashboard presents colorful side ladders and current strategy settings", () => {
  const html = fs.readFileSync(path.join(__dirname, "../../public/btc.html"), "utf8");
  assert.match(html, /BTC CLIMB/);
  assert.match(html, /PAPER ONLY · NO LIVE ORDERS/);
  assert.match(html, /25¢/);
  assert.match(html, /TP: 75¢/);
  assert.match(html, /linear-gradient/);
  assert.match(html, /refresh\(\);setInterval\(refresh,1000\)/);
});
