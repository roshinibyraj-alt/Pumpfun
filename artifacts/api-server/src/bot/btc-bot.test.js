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

test("dashboard presents midpoint limit orders, visible inventory and preserved exits", () => {
  const html = fs.readFileSync(path.join(__dirname, "../../public/probability.html"), "utf8");
  assert.match(html, /BTC MIDPOINT LIMIT PAPER BOT/);
  assert.match(html, /PAPER ONLY/);
  assert.match(html, /100-share limits at the cheaper outcome’s midpoint/);
  assert.match(html, /300-share limits at the expensive outcome’s midpoint/);
  assert.match(html, /seconds 20, 40, 60, 80, 100 and 120/);
  assert.match(html, /seconds 140, 160, 180, 200, 220 and 240/);
  assert.match(html, /cancelled at window end/i);
  assert.doesNotMatch(html, /\bScenario A\b|\bScenario B\b|\bEMA\d*\b|\bRSI\b|\bBollinger\b|\bStoch(?:astic)?\b|\bMACD\b|\bHybrid signal\b|\bindicators?\b/i);
  assert.match(html, /UP · ACCUMULATED POSITION/);
  assert.match(html, /DOWN · ACCUMULATED POSITION/);
  assert.match(html, /Average cost \/ share/);
  assert.match(html, /Resting limit orders/);
  assert.match(html, /Filled shares only/);
  assert.doesNotMatch(html, /MACD|histogram|\$0\.20|20–60¢/i);
  assert.doesNotMatch(html, /trendline|swing-structure|HH breakout|LL breakout/i);
  assert.match(html, /Completed-window performance &amp; global equity/);
  assert.match(html, /Window win rate/);
  assert.match(html, /Equity = cash \+ open positions marked at fresh own-side best bids/);
  assert.doesNotMatch(html, /latest closed 5m candle|doji after .*consecutive|price-filter carry/i);
  assert.doesNotMatch(html, /WAIT EDGE RESET|MODEL PROBABILITY|P\(UP\) =/);
  assert.match(html, /TP uses a fresh own-side bid ≥ \$0.99/);
  assert.match(html, /SL uses a fresh own-side bid ≤ \$0.01/);
  assert.match(html, /TP\/SL are disabled before 295 seconds/);
  assert.match(html, /missing or stale bid does not trigger a sale/i);
  assert.match(html, /AWAITING SETTLEMENT/);
  assert.match(html, /Paper trade history/);
  assert.doesNotMatch(html, /Manual limit order/);
});

test("dashboard renders midpoint roles, schedule, filled inventory, resting orders and analytics", () => {
  const vm = require("node:vm");
  const html = fs.readFileSync(path.join(__dirname, "../../public/probability.html"), "utf8");
  const elements = Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map(m => [m[1], { style: {} }]));
  const context = {
    document: { getElementById(id) { assert.ok(elements[id], "Unknown element " + id); return elements[id]; } },
    window: {}, fetch: () => new Promise(() => {}), setTimeout() {},
  };
  vm.createContext(context);
  for (const script of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
    vm.runInContext(script[1], context);
  }
  const state = {
    now: 120000,
    midpointSelection: { status: "READY", cheapSide: "UP", expensiveSide: "DOWN", midpoints: { UP: .31, DOWN: .69 } },
    quotes: {
      UP: { midpoint: .31, bestBid: .3, bestAsk: .32, updatedAt: 120000 },
      DOWN: { midpoint: .69, bestBid: .68, bestAsk: .7, updatedAt: 120000 },
    },
    orderSchedule: { phase: "CHEAP", shares: 100, nextOrderAt: 120000, nextScheduledSeconds: 20, due: true },
    openOrders: [{ side: "UP", remainingShares: 80 }, { side: "DOWN", remainingShares: 300 }],
  };
  context.renderMarket(state);
  context.renderSchedule(state);
  context.renderPositions({ UP: { shares: 80, averageCost: .3, costBasis: 24 }, DOWN: {} });
  context.renderPendingBySide(state.openOrders);
  context.renderOrders([
    { side: "UP", phase: "CHEAP", limitPrice: .31, requestedShares: 100, filledShares: 20, remainingShares: 80, status: "PARTIALLY_FILLED", placedAt: 120000 },
  ]);
  context.renderTrades([{ side: "UP", phase: "CHEAP", shares: 20, openedAt: 120000, entryPrice: .3, entryPriceLimit: .31, status: "OPEN" }]);
  assert.equal(elements.upRole.textContent, "CHEAPER");
  assert.equal(elements.downRole.textContent, "EXPENSIVE");
  assert.match(elements.cheaperMid.textContent, /\$0\.3100/);
  assert.match(elements.nextOrder.textContent, /DUE NOW/);
  assert.equal(elements.restingSummary.textContent, "2");
  assert.equal(elements.upShares.textContent, "80 shares");
  assert.equal(elements.upAverageCost.textContent, "$0.3000");
  assert.equal(elements.upOpenOrders.textContent, "1");
  assert.equal(elements.upRestingShares.textContent, "80");
  assert.match(elements.orders.innerHTML, /PARTIALLY_FILLED/);
  assert.match(elements.trades.innerHTML, /Average fill/);
  assert.doesNotMatch(elements.trades.innerHTML, /Model probability/);
  context.renderAnalytics({
    windowPerformance: { completed: 3, wins: 2, losses: 1, flats: 0, winRate: 2 / 3, netPnl: 12.5 },
    equityHistory: [
      { ts: 1_800_000_000_000, accountSessionStartedAt: 1_800_000_000_000, equity: 10000 },
      { ts: 1_800_000_030_000, accountSessionStartedAt: 1_800_000_000_000, equity: 10012.5 },
    ],
  });
  assert.equal(elements.completedWindows.textContent, "3");
  assert.equal(elements.windowWinRate.textContent, "66.7%");
  assert.match(elements.equityChart.innerHTML, /<svg/);
  state.midpointSelection.status = "MIDPOINTS_TIED";
  context.renderMarket(state);
  assert.equal(elements.upRole.textContent, "TIED");
  assert.equal(elements.downRole.textContent, "TIED");
  state.midpointSelection.status = "WAITING_FOR_FRESH_MIDPOINTS";
  context.renderMarket(state);
  assert.equal(elements.upRole.textContent, "WAITING");
});
