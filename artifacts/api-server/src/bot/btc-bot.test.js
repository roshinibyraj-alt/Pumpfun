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

test("dashboard presents hybrid setups, fallback direction, and unchanged execution rules", () => {
  const html = fs.readFileSync(path.join(__dirname, "../../public/probability.html"), "utf8");
  assert.match(html, /BTC HYBRID PAPER BOT/);
  assert.match(html, /PAPER ONLY/);
  assert.match(html, /500 SHARES \/ MINUTE/);
  assert.match(html, /Scenario A/);
  assert.match(html, /Scenario B/);
  assert.match(html, /latest closed 5m candle first/i);
  assert.match(html, /doji.*aligned 15m EMA200/i);
  assert.match(html, /15m EMA200/);
  assert.match(html, /Stoch RSI/);
  assert.match(html, /RSI\(7\) divergence/);
  assert.doesNotMatch(html, /Wilder RSI\(14\)|RSI telemetry|rsiChart|Latest closed 5m RSI/i);
  assert.match(html, /Fallback rule/);
  assert.match(html, /Selected signal rule/);
  assert.doesNotMatch(html, /MACD|histogram|\$0\.20|20–60¢/i);
  assert.doesNotMatch(html, /trendline|swing-structure|HH breakout|LL breakout/i);
  assert.match(html, /At 1, 2, 3 and 4 minutes/);
  assert.match(html, /price-filtered shares carry forward/);
  assert.match(html, /maximum planned volume is 2,000 shares per window/i);
  assert.match(html, /Completed-window performance &amp; global equity/);
  assert.match(html, /Window win rate/);
  assert.match(html, /Equity = cash \+ open positions marked at fresh own-side best bids/);
  assert.match(html, /No probability model/);
  assert.match(html, /Signal changes do not close existing positions/);
  assert.doesNotMatch(html, /WAIT EDGE RESET|MODEL PROBABILITY|P\(UP\) =/);
  assert.match(html, /TP uses a fresh own-side bid ≥ \$0.99/);
  assert.match(html, /SL uses a fresh own-side bid ≤ \$0.01/);
  assert.match(html, /TP\/SL are disabled before 295 seconds/);
  assert.match(html, /missing or stale bid does not trigger a sale/i);
  assert.match(html, /AWAITING SETTLEMENT/);
  assert.match(html, /Current active side/);
  assert.match(html, /Paper trade history/);
  assert.doesNotMatch(html, /Manual limit order/);
});

test("dashboard renders locked, skipped and observing states without probability or reversal dependencies", () => {
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
    activeSide: "UP", windowDecision: { status: "LOCKED" },
    entrySchedule: { nextEntryAt: 130000, due: true }, entryFilter: { allowed: true },
    quotes: { UP: { estimatedAverageAsk: .5 } },
  };
  context.renderSide("UP", state);
  context.renderSide("DOWN", state);
  assert.equal(elements.upProb.textContent, "LOCKED");
  assert.equal(elements.downProb.textContent, "OFF");
  assert.equal(elements.upSignal.textContent, "ENTRY SLOT");
  state.technicalSignal = {
    status: "READY", side: "UP", setup: "DIRECTIONAL_FALLBACK",
    fallbackRule: "15M_EMA200_TREND", confirmed: false,
  };
  context.renderSignalRule(state);
  assert.equal(elements.signalRule.textContent, "15M EMA200 TREND");
  assert.equal(elements.signalRuleHint.textContent, "Directional fallback");
  state.technicalSignal = {
    status: "READY", side: "UP", setup: "DIRECTIONAL_FALLBACK",
    fallbackRule: "15M_EMA200_TREND", confirmed: false,
    regime: "MIXED", score: null, reason: "No named setup confirmed; 15M_EMA200_TREND selected UP.",
    indicators: { volume: { status: "READY", direction: "UP", ratio: 1.6 } },
  };
  state.windowDecision.status = "FALLBACK";
  context.renderTechnical(state);
  context.renderSide("UP", state);
  assert.equal(elements.upProb.textContent, "FALLBACK");
  assert.equal(elements.technicalSetup.textContent, "DIRECTIONAL FALLBACK");
  assert.equal(elements.technicalFallbackRule.textContent, "15M EMA200 TREND");
  assert.match(elements.technicalReason.textContent, /selected UP/);
  state.technicalSignal.status = "STALE";
  context.renderSide("UP", state);
  assert.equal(elements.upSignal.textContent, "WAIT DATA");
  delete state.technicalSignal;
  context.renderPositions({});
  context.renderTrades([{ side: "UP", shares: 500, openedAt: 120000, scheduledAt: 120000, status: "OPEN" }]);
  assert.match(elements.trades.innerHTML, /Scheduled/);
  assert.match(elements.trades.innerHTML, /Price cap · carry/);
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
  state.activeSide = null;
  state.windowDecision.status = "SKIP_WINDOW";
  context.renderSide("UP", state);
  assert.equal(elements.upProb.textContent, "SKIP");
  state.windowDecision.status = "OBSERVING";
  context.renderSide("UP", state);
  assert.equal(elements.upProb.textContent, "WAIT");
});
