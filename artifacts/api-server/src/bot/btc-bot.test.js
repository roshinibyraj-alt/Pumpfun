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

test("dashboard focuses on the one-minute Renko strategy and archived analytics", () => {
  const html = fs.readFileSync(path.join(__dirname, "../../public/probability.html"), "utf8");
  assert.match(html, /BTC \/ 5 MIN · PAPER EXECUTION/);
  assert.match(html, /ONE-MINUTE RENKO · INTRAWINDOW REVERSALS · PAPER ONLY/);
  assert.match(html, /Renko box size · 1m ATR/);
  assert.match(html, /Taker orders · this window/);
  assert.match(html, /next tick/i);
  assert.match(html, /Taker fees · this window/);
  assert.match(html, /Taker buy and reversal-sell fees use the market’s fee schedule/i);
  assert.match(html, /strategyFeeDetails/);
  assert.match(html, /Current strategy performance and equity/);
  assert.match(html, /current-strategy history/);
  assert.match(html, /id="orders"/);
  assert.match(html, /id="nextOrder"/);
  assert.doesNotMatch(html, /\bScenario A\b|\bScenario B\b|\bEMA\d*\b|\bRSI\b|\bBollinger\b|\bStoch(?:astic)?\b|\bMACD\b|\bHybrid signal\b|\bindicators?\b/i);
  assert.match(html, /UP · ACCUMULATED POSITION/);
  assert.match(html, /DOWN · ACCUMULATED POSITION/);
  assert.match(html, /Average cost \/ share/);
  assert.match(html, /Current UP midpoint/);
  assert.match(html, /Current DOWN midpoint/);
  assert.match(html, /position-current-price/);
  assert.match(html, /Active window only/);
  assert.match(html, /Order history/);
  assert.match(html, /No new brick · hold direction/);
  assert.match(html, /official resolution/i);
  assert.doesNotMatch(html, /TP limit|take-profit limit/i);
  assert.doesNotMatch(html, /120 seconds|0\.80\+|two resting BUY limits|RESTING LIMITS/i);
  assert.doesNotMatch(html, /MACD|histogram|\$0\.20|20–60¢/i);
  assert.doesNotMatch(html, /trendline|swing-structure|HH breakout|LL breakout/i);
  assert.match(html, /Equity = cash \+ open positions marked at fresh own-side best bids/);
  assert.match(html, /Paper trade history/);
  assert.doesNotMatch(html, /Manual limit order/);
});

test("dashboard renders Renko direction, taker orders, inventory and analytics", () => {
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
    window: { start: 120000 },
    entrySideSelection: {
      status: "RENKO_BRICK_PRINTED", selectedSide: "UP", signalPrice: 101,
      referenceClose: 100, signalAt: 117000, rule: "RENKO_GREEN",
    },
    renko: {
      selectedSide: "UP", brickSize: 0.02, atrPeriod: 14,
      latestBrickAt: 120000, newBrickPrinted: true, bricksPrintedThisTick: 1,
    },
    quotes: {
      UP: { midpoint: .81, bestBid: .8, bestAsk: .82, updatedAt: 120000 },
      DOWN: { midpoint: .69, bestBid: .68, bestAsk: .7, updatedAt: 120000 },
    },
    orderSchedule: {
      status: "PARTIALLY_FILLED_REMAINDER_CANCELLED", signalSide: "UP", tradeSide: "UP",
      signalPrice: 101, referenceClose: 100, ordersPlaced: 1, buyOrders: 1, sellOrders: 0,
      openOrders: 0, filledShares: 20, heldSide: "UP",
    },
    entryOrders: [
      { side: "UP", action: "BUY", windowStart: 120000, orderType: "TAKER", requestedShares: 100, filledShares: 20, remainingShares: 0, averageFillPrice: .4, fees: .2, cancelledRemainderShares: 80, status: "PARTIALLY_FILLED_REMAINDER_CANCELLED", placedAt: 120000 },
      { side: "UP", action: "BUY", windowStart: 60000, orderType: "TAKER", requestedShares: 100, filledShares: 100, remainingShares: 0, averageFillPrice: .4, fees: 2, status: "FILLED", placedAt: 60000 },
    ],
  };
  context.renderMarket(state);
  context.renderSchedule(state);
  context.renderPositions({
    UP: { shares: 80, averageCost: .3, costBasis: 24, midpoint: .31 },
    DOWN: { midpoint: .69 },
  });
  context.renderPendingBySide(state.entryOrders, state.window.start);
  context.renderOrders(state.entryOrders.slice(0, 1));
  context.renderTrades([{ side: "UP", shares: 20, openedAt: 120000, entryPrice: .39, fees: .2, entryKind: "TAKER_MARKET", status: "OPEN" }]);
  assert.equal(elements.upRole.textContent, "RENKO DIRECTION");
  assert.equal(elements.downRole.textContent, "MONITORING");
  assert.match(elements.cheaperMid.textContent, /New 1 brick/);
  assert.equal(elements.expensiveSide.textContent, "$0.02");
  assert.equal(elements.nextOrder.textContent, "BUY PARTIAL");
  assert.match(elements.scheduleHint.textContent, /20 shares at \$0\.4000 average/);
  assert.equal(elements.restingSummary.textContent, "1");
  assert.equal(elements.upShares.textContent, "80 shares");
  assert.equal(elements.upCurrentPrice.textContent, "$0.3100");
  assert.equal(elements.downCurrentPrice.textContent, "$0.6900");
  assert.equal(elements.upAverageCost.textContent, "$0.3000");
  assert.equal(elements.upOpenOrders.textContent, "1");
  assert.equal(elements.upRestingShares.textContent, "20");
  assert.match(elements.orders.innerHTML, /PARTIAL · REMAINDER CANCELLED/);
  assert.doesNotMatch(elements.orders.innerHTML, /TAKE_PROFIT/);
  assert.match(elements.orders.innerHTML, /taker fee/);
  assert.equal(elements.windowTakerFees.textContent, "$0.2000");
  assert.match(elements.trades.innerHTML, /Average fill/);
  assert.match(elements.trades.innerHTML, /Settlement/);
  assert.doesNotMatch(elements.trades.innerHTML, /TP limit/);
  assert.doesNotMatch(elements.trades.innerHTML, /Model probability/);
  context.renderOrders([
    { side: "UP", action: "BUY", orderType: "TAKER", requestedShares: 500, filledShares: 20, remainingShares: 0, cancelledRemainderShares: 480, fees: .2, status: "PARTIALLY_FILLED_REMAINDER_CANCELLED", placedAt: 120000 },
  ]);
  assert.match(elements.orders.innerHTML, /PARTIAL · REMAINDER CANCELLED/);
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
  state.entrySideSelection.status = "WAITING_FOR_RENKO_BRICK";
  state.entrySideSelection.selectedSide = null;
  context.renderMarket(state);
  assert.equal(elements.upRole.textContent, "MONITORING");
});
