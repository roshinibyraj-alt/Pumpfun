const assert = require("node:assert/strict");
const test = require("node:test");
const config = require("./btc/config.js");
const Bot = require("./btc/wick-bot.js");
const marketData = require("./btc/wick-market-data.js");

test("BTC bot uses a strict $0.70 threshold, 15-second checks, and five total entries", () => {
  assert.equal(config.ENTRY_PRICE_THRESHOLD, 0.70);
  assert.equal(config.ENTRY_CHECK_INTERVAL_MS, 15_000);
  assert.equal(config.MAX_SUCCESSFUL_ENTRIES_PER_WINDOW, 5);
  assert.equal("MARTINGALE_EXIT_BID_THRESHOLD" in config, false);

  const bot = new Bot();
  const start = 1_800_000;
  const now = start + 15_000;
  bot.market = { id: "market", slug: "market", title: "market", start, tokens: { UP: "up", DOWN: "down" } };
  bot.openStrategyWindow(start, now);
  bot.liveQuotes = {
    UP: { status: "LIVE", updatedAt: now, bestAsk: 0.70, askSize: 100 },
    DOWN: { status: "LIVE", updatedAt: now, bestAsk: 0.7001, askSize: 100 },
  };

  bot.processTimedEntries(start, now);
  assert.equal(bot.windowFiredEntries, 1);
  assert.equal(bot.positions.length, 1);
  assert.equal(bot.positions[0].side, "DOWN");
  assert.equal(bot.positions[0].shares, 100);
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
