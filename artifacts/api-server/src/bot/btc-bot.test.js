const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const config = require("./btc/config.js");
const Bot = require("./btc/wick-bot.js");
const marketData = require("./btc/wick-market-data.js");

test("BTC bot uses a strict $0.70 floor, inclusive $0.90 ceiling, 30-second checks, and a five-entry cap", () => {
  assert.equal(config.ENTRY_PRICE_THRESHOLD, 0.70);
  assert.equal(config.MAX_ENTRY_PRICE, 0.90);
  assert.equal(config.ENTRY_CHECK_INTERVAL_MS, 30_000);
  assert.equal(config.MAX_ENTRIES_PER_WINDOW, 5);
  assert.equal("MARTINGALE_EXIT_BID_THRESHOLD" in config, false);
  const dashboard = fs.readFileSync(path.join(__dirname, "../../public/btc.html"), "utf8");
  assert.match(dashboard, /<title>Thirty Seconds Bot<\/title>/);
  assert.match(dashboard, /Starting 30 seconds into each window, check UP and DOWN every 30 seconds/);
  assert.match(dashboard, /at or below \$0\.90/);
  assert.match(dashboard, /Maximum 5 total entries per window, including the base bet/);
  assert.match(dashboard, /id="countdown-\$\{k\}"/);
  assert.match(dashboard, /Next fire in/);
  assert.match(dashboard, /paintCountdown/);

  const bot = new Bot();
  const start = 1_800_000;
  const now = start + 30_000;
  bot.market = { id: "market", slug: "market", title: "market", start, tokens: { UP: "up", DOWN: "down" } };
  bot.openStrategyWindow(start, now);
  bot.liveQuotes = {
    UP: { status: "LIVE", updatedAt: now, bestAsk: 0.70, askSize: 100 },
    DOWN: { status: "LIVE", updatedAt: now, bestAsk: 0.90, askSize: 100 },
  };

  bot.processTimedEntries(start, now);
  assert.equal(bot.windowFiredEntries, 1);
  assert.equal(bot.positions.length, 1);
  assert.equal(bot.positions[0].side, "DOWN");
  assert.equal(bot.positions[0].shares, 100);
  assert.equal(bot.positions[0].avgEntry, 0.90);
});

test("checks before 30 seconds do not place entries and asks above $0.90 are skipped", () => {
  const bot = new Bot();
  const start = 1_800_000;
  bot.market = { id: "market", slug: "market", title: "market", start, tokens: { UP: "up", DOWN: "down" } };
  bot.openStrategyWindow(start, start);
  bot.liveQuotes = {
    UP: { status: "LIVE", updatedAt: start + 29_999, bestAsk: 0.80, askSize: 100 },
    DOWN: { status: "LIVE", updatedAt: start + 29_999, bestAsk: 0.91, askSize: 100 },
  };

  bot.processTimedEntries(start, start + 29_999);
  assert.equal(bot.positions.length, 0);

  const now = start + config.ENTRY_CHECK_INTERVAL_MS;
  bot.liveQuotes.UP = { status: "LIVE", updatedAt: now, bestAsk: 0.9001, askSize: 100 };
  bot.liveQuotes.DOWN = { status: "LIVE", updatedAt: now, bestAsk: 0.91, askSize: 100 };
  bot.processTimedEntries(start, now);
  assert.equal(bot.positions.length, 0);
  assert.ok(bot.windowOrders.every((order) => order.reason.includes("above the $0.90 maximum")));
});

test("successful entries stop at five total per window including the base bet", () => {
  const bot = new Bot();
  const start = 1_800_000;
  bot.cash = 10_000_000_000;
  bot.market = { id: "market", slug: "market", title: "market", start, tokens: { UP: "up", DOWN: "down" } };
  bot.openStrategyWindow(start, start);

  for (let checkpoint = 1; checkpoint <= 7; checkpoint += 1) {
    const now = start + checkpoint * config.ENTRY_CHECK_INTERVAL_MS;
    bot.liveQuotes = {
      UP: { status: "LIVE", updatedAt: now, bestAsk: 0.71, askSize: 1_000_000 },
      DOWN: { status: "LIVE", updatedAt: now, bestAsk: 0.71, askSize: 1_000_000 },
    };
    bot.processTimedEntries(start, now);
  }

  assert.equal(bot.windowFiredEntries, 5);
  assert.equal(bot.positions.length, 5);
  assert.deepEqual(bot.positions.map((position) => position.shares).reverse(), [100, 200, 400, 800, 1600]);
  assert.ok(bot.windowOrders.some((order) => order.reason?.includes("5-entry window limit")));
});

test("a best bid below $0.30 does not trigger a forced sale after the entry cap", async () => {
  const oldGetBook = marketData.getBook;
  marketData.getBook = async () => ({
    bids: [{ price: 0.29, size: 100 }],
    asks: [{ price: 0.30, size: 100 }],
  });
  try {
    const bot = new Bot();
    const start = 1_800_000;
    const now = start + 60_000;
    bot.market = { id: "market", slug: "market", title: "market", start, tokens: { UP: "up", DOWN: "down" } };
    bot.orderWindowStart = start;
    bot.windowFiredEntries = 5;
    bot.positions = ["UP", "DOWN"].map((side) => ({
      id: side,
      side,
      status: "OPEN",
      windowStart: start,
      shares: 100,
      totalCost: 80,
      fees: 0,
    }));

    await bot.refreshLiveQuotes(now);
    assert.deepEqual(bot.positions.map((position) => position.status), ["OPEN", "OPEN"]);
    assert.equal(bot.snapshot().strategy.martingaleExit, undefined);
    assert.equal(bot.events.some((event) => event.event.includes("MARTINGALE_EXIT")), false);
  } finally {
    marketData.getBook = oldGetBook;
  }
});
