const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const config = require("./btc/config.js");
const Bot = require("./btc/wick-bot.js");

function makeBot() {
  const bot = new Bot({
    priceFeed: {
      getTicks: () => [],
      snapshot: () => ({ status: "test" }),
      start() {},
      stop() {},
    },
  });
  const start = 1_800_000;
  bot.market = {
    id: "market",
    slug: "market",
    title: "market",
    start,
    tokens: { UP: "up-token", DOWN: "down-token" },
    feesEnabled: false,
  };
  bot.openStrategyWindow(start, start);
  return { bot, start };
}

test("no-merge bot uses independent 50-share limits every five seconds", () => {
  assert.equal(config.ENTRY_CHECK_INTERVAL_MS, 5_000);
  assert.equal(config.BASE_ENTRY_SHARES, 50);
  assert.equal(config.LIMIT_PRICE_OFFSET, 0.05);
  assert.equal("MERGE_LOT_SHARES" in config, false);

  const dashboard = fs.readFileSync(path.join(__dirname, "../../public/btc.html"), "utf8");
  assert.match(dashboard, /BTC No-Merge Paper Bot/);
  assert.match(dashboard, /Shares are never merged/);

  const { bot, start } = makeBot();
  const now = start + config.ENTRY_CHECK_INTERVAL_MS;
  bot.liveQuotes = {
    UP: { status: "LIVE", updatedAt: now, bestBid: 0.50, bestAsk: 0.60, mid: 0.55 },
    DOWN: { status: "LIVE", updatedAt: now, bestBid: 0.40, bestAsk: 0.50, mid: 0.45 },
  };

  bot.processTimedEntries(start, now);
  assert.equal(bot.windowOrders.length, 2);
  assert.deepEqual(bot.windowOrders.map(order => [order.side, order.limitPrice, order.shares]), [
    ["DOWN", 0.4, 50],
    ["UP", 0.5, 50],
  ]);
  assert.ok(bot.windowOrders.every(order => order.status === "PENDING"));
  assert.equal(bot.positions.length, 0);
  assert.equal(bot.snapshot().strategy.merge.enabled, false);
  assert.equal("mergeStatus" in bot.snapshot(), false);
  assert.equal("merges" in bot.snapshot(), false);
});

test("pending limits fill only on a later fresh ask at or below the limit and remain separate", () => {
  const { bot, start } = makeBot();
  const placedAt = start + 5_000;
  bot.liveQuotes = {
    UP: { status: "LIVE", updatedAt: placedAt, bestBid: 0.50, bestAsk: 0.60, mid: 0.55 },
    DOWN: { status: "LIVE", updatedAt: placedAt, bestBid: 0.40, bestAsk: 0.50, mid: 0.45 },
  };
  bot.processTimedEntries(start, placedAt);

  bot.liveQuotes.UP.updatedAt = placedAt + 500;
  bot.liveQuotes.UP.bestAsk = 0.51;
  bot.liveQuotes.DOWN.updatedAt = placedAt + 500;
  bot.liveQuotes.DOWN.bestAsk = 0.39;
  bot.processPendingLimitOrders(placedAt + 500);

  assert.equal(bot.positions.length, 1);
  assert.equal(bot.positions[0].side, "DOWN");
  assert.equal(bot.positions[0].shares, 50);
  assert.equal(bot.windowOrders.find(order => order.side === "UP").status, "PENDING");

  bot.liveQuotes.UP.updatedAt = placedAt + 1_000;
  bot.liveQuotes.UP.bestAsk = 0.50;
  bot.processPendingLimitOrders(placedAt + 1_000);

  assert.equal(bot.positions.length, 2);
  assert.deepEqual(new Set(bot.positions.map(position => position.side)), new Set(["UP", "DOWN"]));
  assert.ok(bot.positions.every(position => position.status === "OPEN" && position.shares === 50));
  assert.equal(bot.positions.reduce((sum, position) => sum + position.shares, 0), 100);
  assert.equal(bot.cash, 9_955);
});

test("unfilled limits expire at the window close and no merge routine is present", () => {
  const { bot, start } = makeBot();
  const placedAt = start + 5_000;
  bot.liveQuotes = {
    UP: { status: "LIVE", updatedAt: placedAt, bestBid: 0.50, bestAsk: 0.60, mid: 0.55 },
    DOWN: { status: "LIVE", updatedAt: placedAt, bestBid: 0.40, bestAsk: 0.50, mid: 0.45 },
  };
  bot.processTimedEntries(start, placedAt);
  bot.processPendingLimitOrders(start + config.WINDOW_MS_5M);

  assert.ok(bot.orders.filter(order => order.windowStart === start).every(order => order.status === "EXPIRED_UNFILLED"));
  assert.equal(bot.positions.length, 0);
  assert.equal(typeof bot.mergeMatchedPairs, "undefined");
});

test("a bid-based exit closes only that position; opposite-side shares stay open", () => {
  const { bot, start } = makeBot();
  bot.positions = [
    { id: "up", side: "UP", status: "OPEN", windowStart: start, shares: 50, totalCost: 25, fees: 0 },
    { id: "down", side: "DOWN", status: "OPEN", windowStart: start, shares: 50, totalCost: 20, fees: 0 },
  ];
  const exited = bot.positions[0];
  bot.finalizeExit(exited, 0.99, "TAKE_PROFIT_BID");

  assert.equal(exited.status, "SETTLED_EXIT");
  assert.equal(exited.proceeds, 49.5);
  assert.equal(exited.realizedPnl, 24.5);
  assert.equal(bot.positions[1].status, "OPEN");
  assert.equal(bot.positions[1].shares, 50);
  assert.equal(bot.cash, 10_049.5);
});

test("BTC regime remains informational and does not block new paper orders", () => {
  const { bot, start } = makeBot();
  bot.marketRegime = { state: "CHOPPY", reason: "test regime" };
  const now = start + config.ENTRY_CHECK_INTERVAL_MS;
  bot.liveQuotes = {
    UP: { status: "LIVE", updatedAt: now, bestBid: 0.50, bestAsk: 0.60, mid: 0.55 },
    DOWN: { status: "LIVE", updatedAt: now, bestBid: 0.40, bestAsk: 0.50, mid: 0.45 },
  };
  bot.processTimedEntries(start, now);

  assert.equal(bot.windowOrders.length, 2);
  assert.equal(bot.snapshot().strategy.regime.entryPolicy, "Informational only; BTC regime does not block entries");
});
