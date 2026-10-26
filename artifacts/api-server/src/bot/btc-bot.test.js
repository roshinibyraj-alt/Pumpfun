const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const config = require("./btc/config.js");
const Bot = require("./btc/wick-bot.js");
const MultiBot = require("./btc/multi-bot.js");
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
  assert.equal(config.ENTRY_ORDER_TTL_MS, 4_000);
  assert.equal(config.BASE_ENTRY_SHARES, 50);
  assert.equal(config.LIMIT_PRICE_OFFSET, 0.05);
  assert.equal(config.MIN_ENTRY_PRICE, 0.05);
  assert.equal("MERGE_LOT_SHARES" in config, false);

  const dashboard = fs.readFileSync(path.join(__dirname, "../../public/btc.html"), "utf8");
  assert.match(dashboard, /BTC No-Merge Paper Bot/);
  assert.match(dashboard, /Complete UP\/DOWN sets are never merged/);
  assert.match(dashboard, /All other positions in that window close at their own current bid/);
  assert.match(dashboard, /official market results are not used/i);
  assert.match(dashboard, /Current-window UP shares/);
  assert.match(dashboard, /cancels its pending entries/);
  assert.match(dashboard, /cancel after 4 seconds/i);
  assert.match(dashboard, /hard \$0\.05 minimum on both sides/i);
  assert.match(dashboard, /No shares carry into the next window/);
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

test("a 100-share UP imbalance places a 100-share DOWN rebalance order", () => {
  const { bot, start } = makeBot();
  bot.positions = [{
    id: "up-filled",
    side: "UP",
    status: "OPEN",
    windowStart: start,
    shares: 100,
    totalCost: 50,
  }];
  const now = start + config.ENTRY_CHECK_INTERVAL_MS;
  bot.liveQuotes = {
    UP: { status: "LIVE", updatedAt: now, bestBid: 0.50, bestAsk: 0.60, mid: 0.55 },
    DOWN: { status: "LIVE", updatedAt: now, bestBid: 0.40, bestAsk: 0.50, mid: 0.45 },
  };

  bot.processTimedEntries(start, now);

  assert.equal(bot.windowOrders.length, 1);
  assert.equal(bot.windowOrders[0].side, "DOWN");
  assert.equal(bot.windowOrders[0].shares, 100);
  assert.equal(bot.windowOrders[0].entryMode, "REBALANCE");
  assert.equal(bot.windowOrders[0].limitPrice, 0.4);
});

test("unfilled entries expire after four seconds and the next check rebalances actual fills", () => {
  const { bot, start } = makeBot();
  const placedAt = start + config.ENTRY_CHECK_INTERVAL_MS;
  bot.liveQuotes = {
    UP: { status: "LIVE", updatedAt: placedAt, bestBid: 0.50, bestAsk: 0.60, mid: 0.55 },
    DOWN: { status: "LIVE", updatedAt: placedAt, bestBid: 0.40, bestAsk: 0.50, mid: 0.45 },
  };
  bot.processTimedEntries(start, placedAt);
  const upOrder = bot.windowOrders.find(order => order.side === "UP");
  const downOrder = bot.windowOrders.find(order => order.side === "DOWN");

  bot.liveQuotes.UP.updatedAt = placedAt + 500;
  bot.liveQuotes.UP.bestAsk = 0.50;
  bot.processPendingLimitOrders(placedAt + 500);
  assert.equal(upOrder.status, "FILLED");
  assert.equal(bot.positions[0].shares, 50);

  bot.liveQuotes.DOWN.updatedAt = placedAt + config.ENTRY_ORDER_TTL_MS;
  bot.liveQuotes.DOWN.bestAsk = 0.39;
  bot.processPendingLimitOrders(placedAt + config.ENTRY_ORDER_TTL_MS);
  assert.equal(downOrder.status, "EXPIRED_UNFILLED_TIMEOUT");
  assert.equal(bot.positions.length, 1, "crossing quote at expiry must not fill");

  const nextCheck = start + 2 * config.ENTRY_CHECK_INTERVAL_MS;
  bot.liveQuotes.UP.updatedAt = nextCheck;
  bot.liveQuotes.DOWN.updatedAt = nextCheck;
  bot.liveQuotes.DOWN.bestAsk = 0.50;
  bot.processTimedEntries(start, nextCheck);
  const rebalance = bot.windowOrders.find(order => order.checkpoint === 2);
  assert.equal(rebalance.side, "DOWN");
  assert.equal(rebalance.shares, 50);
  assert.equal(rebalance.entryMode, "REBALANCE");
});

test("both sides skip sub-$0.05 limits and never fill while the ask is below $0.05", () => {
  const { bot, start } = makeBot();
  const placedAt = start + config.ENTRY_CHECK_INTERVAL_MS;
  bot.liveQuotes = {
    UP: { status: "LIVE", updatedAt: placedAt, bestBid: 0.03, bestAsk: 0.06, mid: 0.09 },
    DOWN: { status: "LIVE", updatedAt: placedAt, bestBid: 0.03, bestAsk: 0.06, mid: 0.09 },
  };
  bot.processTimedEntries(start, placedAt);
  assert.deepEqual(bot.windowOrders.map(order => order.status), [
    "SKIPPED_BELOW_MIN_PRICE",
    "SKIPPED_BELOW_MIN_PRICE",
  ]);
  assert.deepEqual(bot.windowOrders.map(order => order.calculatedLimitPrice), [0.04, 0.04]);

  const next = start + 2 * config.ENTRY_CHECK_INTERVAL_MS;
  bot.liveQuotes = {
    UP: { status: "LIVE", updatedAt: next, bestBid: 0.09, bestAsk: 0.11, mid: 0.15 },
    DOWN: { status: "LIVE", updatedAt: next, bestBid: 0.09, bestAsk: 0.11, mid: 0.15 },
  };
  bot.processTimedEntries(start, next);
  const pending = bot.windowOrders.filter(order => order.status === "PENDING");
  assert.equal(pending.length, 2);
  bot.liveQuotes.UP.updatedAt = next + 500;
  bot.liveQuotes.UP.bestAsk = 0.04;
  bot.liveQuotes.DOWN.updatedAt = next + 500;
  bot.liveQuotes.DOWN.bestAsk = 0.04;
  bot.processPendingLimitOrders(next + 500);
  assert.equal(bot.positions.length, 0);
  assert.ok(pending.every(order => order.limitPrice >= 0.05));
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

test("take profit completes the window and clears all same-window shares", async () => {
  const { bot, start } = makeBot();
  bot.positions = [
    { id: "up", side: "UP", status: "OPEN", windowStart: start, shares: 50, totalCost: 25, fees: 0 },
    { id: "down", side: "DOWN", status: "OPEN", windowStart: start, shares: 50, totalCost: 20, fees: 0 },
  ];
  bot.orders = [{ id: "pending", windowStart: start, status: "PENDING", remainingShares: 50 }];
  bot.cash -= 45;
  const exited = bot.positions[0];
  await bot.completeWindow(start, exited, true, "TAKE_PROFIT_BID", 0.99, start);

  assert.equal(exited.status, "SETTLED_EXIT");
  assert.equal(exited.payout, 1);
  assert.equal(exited.proceeds, 50);
  assert.equal(exited.exitFees, 0);
  assert.equal(exited.realizedPnl, 25);
  assert.equal(exited.tpTriggerQuote, 0.99);
  assert.equal(bot.snapshot().account.profitableExits, 1);
  assert.equal(bot.positions[1].status, "SETTLED_EXIT");
  assert.equal(bot.positions[1].settlementBasis, "WINDOW_EXIT_NO_BID");
  assert.equal(bot.positions[1].shares, 50);
  assert.equal(bot.cash, 10_005);
  assert.equal(bot.snapshot().inventory.UP.shares, 0);
  assert.equal(bot.snapshot().inventory.DOWN.shares, 0);
  assert.equal(bot.orders[0].status, "EXPIRED_WINDOW_COMPLETE");
  assert.equal(bot.snapshot().window.complete, true);
  const orderCount = bot.orders.length;
  bot.processTimedEntries(start, start + config.ENTRY_CHECK_INTERVAL_MS);
  assert.equal(bot.orders.length, orderCount);
});

test("window completion closes remaining shares at their own current CLOB bid", async () => {
  const { bot, start } = makeBot();
  const now = start + 30_000;
  const up = { id: "up", side: "UP", status: "OPEN", windowStart: start, shares: 50, totalCost: 25 };
  const down = { id: "down", side: "DOWN", status: "OPEN", windowStart: start, shares: 50, totalCost: 20 };
  bot.positions = [up, down];
  bot.cash -= 45;
  const originalGetBook = marketData.getBook;
  marketData.getBook = async tokenId => ({
    bids: [{ price: tokenId === "up-token" ? 0.99 : 0.45, size: 50 }],
    asks: [{ price: tokenId === "up-token" ? 0.995 : 0.5, size: 50 }],
  });
  try {
    await bot.refreshLiveQuotes(now);
  } finally {
    marketData.getBook = originalGetBook;
  }

  assert.equal(up.proceeds, 50);
  assert.equal(up.settlementBasis, "TAKE_PROFIT_BID");
  assert.equal(down.settlementBasis, "WINDOW_EXIT_BID");
  assert.equal(down.exitBid, 0.45);
  assert.equal(down.proceeds, 22.5);
  assert.equal(down.realizedPnl, 2.5);
  assert.equal(bot.snapshot().account.openPositions, 0);
  assert.equal(bot.snapshot().inventory.DOWN.shares, 0);
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

test("rollover clears previous-window shares and cancels pending orders", async () => {
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
  const oldStart = currentStart - bot.windowMs;
  bot.positions = [{
    id: "old-down-losing-side",
    side: "DOWN",
    status: "OPEN",
    windowStart: oldStart,
    windowMs: bot.windowMs,
    shares: 150,
    totalCost: 90,
    tokenId: "old-down",
  }];
  bot.orders = [{
    id: "old-pending",
    side: "DOWN",
    status: "PENDING",
    windowStart: oldStart,
    remainingShares: 50,
  }];
  bot.cash -= 90;
  const originalGetBook = marketData.getBook;
  marketData.getBook = async tokenId => ({
    bids: [{ price: tokenId === "old-down" ? 0.2 : 0.5, size: 150 }],
    asks: [],
  });

  try {
    await bot.tick();
  } finally {
    marketData.getBook = originalGetBook;
  }

  assert.equal(bot.positions[0].status, "SETTLED_EXIT");
  assert.equal(bot.positions[0].settlementBasis, "WINDOW_ROLLOVER_BID");
  assert.equal(bot.positions[0].shares, 150);
  assert.equal(bot.positions[0].proceeds, 30);
  assert.equal(bot.cash, bot.capital - 60);
  assert.equal(bot.snapshot().account.openPositions, 0);
  assert.equal(bot.snapshot().inventory.DOWN.shares, 0);
  assert.match(bot.snapshot().strategy.exit, /No shares carry over/);
  assert.equal(bot.orders[0].status, "EXPIRED_WINDOW_ROLLOVER");
  assert.equal(bot.orders[0].remainingShares, 0);
  assert.equal(bot.completedWindows.get(oldStart).reason, "WINDOW_ROLLOVER");
});

test("window rollover closes a position for $0 when its token has no bid", async () => {
  const { bot, start } = makeBot();
  bot.positions = [{
    id: "old-window-no-bid",
    side: "UP",
    status: "OPEN",
    windowStart: start,
    shares: 50,
    totalCost: 25,
    tokenId: "old-up",
  }];
  const originalGetBook = marketData.getBook;
  marketData.getBook = async () => ({ bids: [], asks: [] });

  try {
    await bot.closePreviousWindows(start + bot.windowMs, start + bot.windowMs);
  } finally {
    marketData.getBook = originalGetBook;
  }

  assert.equal(bot.positions[0].status, "SETTLED_EXIT");
  assert.equal(bot.positions[0].settlementBasis, "WINDOW_ROLLOVER_NO_BID");
  assert.equal(bot.positions[0].proceeds, 0);
  assert.equal(bot.completedWindows.get(start).reason, "WINDOW_ROLLOVER");
});

test("two consecutive completed windows settle independently without carrying shares", async () => {
  const { bot, start } = makeBot();
  const firstUp = {
    id: "first-up-tp",
    side: "UP",
    status: "OPEN",
    windowStart: start,
    shares: 50,
    totalCost: 25,
  };
  const firstDown = {
    id: "first-down-150",
    side: "DOWN",
    status: "OPEN",
    windowStart: start,
    shares: 150,
    totalCost: 90,
  };
  bot.positions = [firstUp, firstDown];
  bot.orders = [{ id: "first-pending", windowStart: start, status: "PENDING", remainingShares: 50 }];
  bot.cash -= firstUp.totalCost + firstDown.totalCost;
  bot.liveQuotes = {
    UP: { status: "LIVE", updatedAt: start + 60_000, bestBid: 0.99 },
    DOWN: { status: "LIVE", updatedAt: start + 60_000, bestBid: 0.2 },
  };

  await bot.completeWindow(start, firstUp, true, "TAKE_PROFIT_BID", 0.99, start + 60_000);

  assert.deepEqual([firstUp.status, firstDown.status], ["SETTLED_EXIT", "SETTLED_EXIT"]);
  assert.deepEqual([firstUp.proceeds, firstDown.proceeds], [50, 30]);
  assert.equal(firstDown.realizedPnl, -60);
  assert.equal(bot.orders[0].status, "EXPIRED_WINDOW_COMPLETE");
  assert.equal(bot.cash, bot.capital - 35);
  assert.equal(bot.snapshot().account.openPositions, 0);
  assert.deepEqual(bot.snapshot().inventory, {
    UP: { shares: 0, cost: 0, averageCost: null, positions: 0 },
    DOWN: { shares: 0, cost: 0, averageCost: null, positions: 0 },
  });

  const secondStart = start + bot.windowMs;
  bot.market = {
    ...bot.market,
    id: "second-window",
    slug: "second-window",
    start: secondStart,
    end: secondStart + bot.windowMs,
  };
  assert.equal(bot.snapshot().inventory.DOWN.shares, 0);
  const secondUp = {
    id: "second-up",
    side: "UP",
    status: "OPEN",
    windowStart: secondStart,
    shares: 150,
    totalCost: 75,
  };
  const secondDown = {
    id: "second-down-sl",
    side: "DOWN",
    status: "OPEN",
    windowStart: secondStart,
    shares: 50,
    totalCost: 20,
  };
  bot.positions.push(secondUp, secondDown);
  bot.orders.push({ id: "second-pending", windowStart: secondStart, status: "PENDING", remainingShares: 50 });
  bot.cash -= secondUp.totalCost + secondDown.totalCost;
  bot.liveQuotes = {
    UP: { status: "LIVE", updatedAt: secondStart + 60_000, bestBid: 0.35 },
    DOWN: { status: "LIVE", updatedAt: secondStart + 60_000, bestBid: 0.01 },
  };

  await bot.completeWindow(secondStart, secondDown, false, "STOP_LOSS_BID", 0.01, secondStart + 60_000);

  assert.deepEqual([secondUp.status, secondDown.status], ["SETTLED_EXIT", "SETTLED_EXIT"]);
  assert.deepEqual([secondUp.proceeds, secondDown.proceeds], [52.5, 0]);
  assert.equal(bot.orders[1].status, "EXPIRED_WINDOW_COMPLETE");
  assert.equal(bot.cash, bot.capital - 77.5);
  const final = bot.snapshot();
  assert.equal(final.account.openPositions, 0);
  assert.equal(final.account.settledTrades, 4);
  assert.equal(final.account.realizedPnl, -77.5);
  assert.equal(final.window.complete, true);
  assert.deepEqual([final.inventory.UP.shares, final.inventory.DOWN.shares], [0, 0]);
  assert.ok(bot.positions.every(position => position.status === "SETTLED_EXIT"));
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
    { side: "UP", status: "OPEN", windowStart: start, shares: 25, totalCost: 10 },
    { side: "UP", status: "OPEN", windowStart: start, shares: 75, totalCost: 45 },
    { side: "UP", status: "OPEN", windowStart: start, shares: 5, totalCost: 2.5 },
    { side: "DOWN", status: "OPEN", windowStart: start, shares: 50, totalCost: 20 },
    { side: "DOWN", status: "OPEN", windowStart: start, shares: 10, totalCost: 8 },
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

test("multi-timeframe snapshot exposes a completed window status", () => {
  const multiBot = new MultiBot();
  multiBot.bots["5m"].status = "window_complete";
  assert.equal(multiBot.snapshot().status, "window_complete");
});
