const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const config = require("./btc/config.js");
const Bot = require("./btc/wick-bot.js");
const marketData = require("./btc/wick-market-data.js");

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
  assert.match(dashboard, /Complete UP\/DOWN sets are never merged/);
  assert.match(dashboard, /Market-side counts do not choose payout/);
  assert.match(dashboard, /official market results are not used/i);
  for (const id of ["upShares", "downShares", "upAverageCost", "downAverageCost", "upTotalCost", "downTotalCost", "upBid", "downBid", "upAsk", "downAsk"]) {
    assert.ok(dashboard.includes(`id="${id}"`), `dashboard should render ${id}`);
  }

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

test("take profit pays $1/share but is not labeled as an official market win", () => {
  const { bot, start } = makeBot();
  bot.positions = [
    { id: "up", side: "UP", status: "OPEN", windowStart: start, shares: 50, totalCost: 25, fees: 0 },
    { id: "down", side: "DOWN", status: "OPEN", windowStart: start, shares: 50, totalCost: 20, fees: 0 },
  ];
  bot.cash -= 45;
  const exited = bot.positions[0];
  bot.finalizePosition(exited, true, "TAKE_PROFIT_BID", 0.99);

  assert.equal(exited.status, "SETTLED_EXIT");
  assert.equal(exited.payout, 1);
  assert.equal(exited.proceeds, 50);
  assert.equal(exited.exitFees, 0);
  assert.equal(exited.realizedPnl, 25);
  assert.equal(exited.tpTriggerQuote, 0.99);
  assert.equal(bot.snapshot().account.profitableExits, 1);
  assert.equal(bot.positions[1].status, "OPEN");
  assert.equal(bot.positions[1].shares, 50);
  assert.equal(bot.cash, 10_005);
});

test("stop loss pays $0/share and is counted as a losing exit, not an official result", () => {
  const { bot, start } = makeBot();
  const stopped = {
    id: "stopped-up",
    side: "UP",
    status: "OPEN",
    windowStart: start,
    shares: 50,
    totalCost: 20,
    fees: 0,
  };
  bot.positions = [stopped];
  bot.cash -= stopped.totalCost;

  bot.finalizePosition(stopped, false, "STOP_LOSS_BID", 0.01);

  assert.equal(stopped.status, "SETTLED_EXIT");
  assert.equal(stopped.payout, 0);
  assert.equal(stopped.proceeds, 0);
  assert.equal(stopped.exitFees, 0);
  assert.equal(stopped.realizedPnl, -20);
  assert.equal(stopped.stopTriggerQuote, 0.01);
  assert.equal(bot.snapshot().account.losingExits, 1);
  assert.equal(bot.cash, 9_980);
});

test("combined threshold payouts deduct both sides' costs, even when the net is negative", () => {
  const { bot } = makeBot();
  const up = { id: "up", side: "UP", status: "OPEN", shares: 700, totalCost: 350 };
  const down = { id: "down", side: "DOWN", status: "OPEN", shares: 900, totalCost: 450 };
  bot.positions = [up, down];
  bot.cash -= up.totalCost + down.totalCost;

  bot.finalizePosition(up, true, "TAKE_PROFIT_BID", 0.99);
  bot.finalizePosition(down, false, "STOP_LOSS_BID", 0.01);

  const state = bot.snapshot();
  assert.equal(up.proceeds, 700);
  assert.equal(down.proceeds, 0);
  assert.equal(up.status, "SETTLED_EXIT");
  assert.equal(down.status, "SETTLED_EXIT");
  assert.equal(state.account.realizedPnl, -100);
  assert.equal(state.account.cash, 9_900);
  assert.equal(state.account.equity, 9_900);
  assert.equal(state.account.profitableExits, 1);
  assert.equal(state.account.losingExits, 1);
});

test("positions stay open after window close when neither threshold is reached", async () => {
  const { bot } = makeBot();
  const currentStart = Math.floor(Date.now() / bot.windowMs) * bot.windowMs;
  bot.market = {
    id: "current",
    slug: "current",
    start: currentStart,
    tokens: { UP: "current-up", DOWN: "current-down" },
  };
  bot.lastMarketAt = Date.now();
  bot.orderWindowStart = currentStart;
  bot.refreshLiveQuotes = async () => {};
  bot.updateMarketRegime = () => {};
  bot.processTimedEntries = () => {};
  bot.positions = [{
    id: "old-window",
    side: "UP",
    status: "OPEN",
    windowStart: currentStart - bot.windowMs,
    windowMs: bot.windowMs,
    shares: 50,
    totalCost: 20,
    tokenId: "old-up",
  }];

  await bot.tick();

  assert.equal(bot.positions[0].status, "OPEN");
  assert.equal(bot.snapshot().account.openPositions, 1);
  assert.equal(typeof bot.trySettle, "undefined");
});

test("old-window positions can still settle from their own token threshold", async () => {
  const { bot } = makeBot();
  const now = Date.now();
  const currentStart = Math.floor(now / bot.windowMs) * bot.windowMs;
  bot.market = {
    id: "current",
    slug: "current",
    start: currentStart,
    tokens: { UP: "current-up", DOWN: "current-down" },
  };
  const oldPosition = {
    id: "old-window",
    side: "UP",
    status: "OPEN",
    windowStart: currentStart - bot.windowMs,
    windowMs: bot.windowMs,
    shares: 50,
    totalCost: 20,
    tokenId: "old-up",
  };
  bot.positions = [oldPosition];
  const originalGetBook = marketData.getBook;
  marketData.getBook = async tokenId => ({
    bids: [{ price: tokenId === "old-up" ? 0.99 : 0.5, size: 50 }],
    asks: [],
  });

  try {
    await bot.refreshLiveQuotes(now);
  } finally {
    marketData.getBook = originalGetBook;
  }

  assert.equal(oldPosition.status, "SETTLED_EXIT");
  assert.equal(oldPosition.payout, 1);
  assert.equal(oldPosition.proceeds, 50);
  assert.equal(oldPosition.realizedPnl, 30);
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

test("snapshot reports weighted average cost for all open UP and DOWN shares", () => {
  const { bot, start } = makeBot();
  bot.positions = [
    { side: "UP", status: "OPEN", shares: 25, totalCost: 10 },
    { side: "UP", status: "OPEN", shares: 75, totalCost: 45 },
    { side: "UP", status: "OPEN", shares: 5, totalCost: 2.5 },
    { side: "DOWN", status: "OPEN", shares: 50, totalCost: 20 },
    { side: "DOWN", status: "OPEN", shares: 10, totalCost: 8 },
    { side: "DOWN", status: "SETTLED_EXIT", shares: 40, totalCost: 15 },
    ...Array.from({ length: 55 }, (_, index) => ({
      id: `settled-${index}`,
      side: "UP",
      status: "SETTLED_EXIT",
      shares: 100,
      totalCost: 90,
      settledAt: start + index,
    })),
  ];

  const inventory = bot.snapshot().inventory;
  assert.equal(inventory.UP.shares, 105);
  assert.equal(inventory.UP.cost, 57.5);
  assert.equal(inventory.UP.averageCost, 57.5 / 105);
  assert.equal(inventory.UP.positions, 3);
  assert.equal(inventory.DOWN.shares, 60);
  assert.equal(inventory.DOWN.cost, 28);
  assert.equal(inventory.DOWN.averageCost, 28 / 60);
  assert.equal(inventory.DOWN.positions, 2);
});
